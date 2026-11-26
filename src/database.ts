import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import fs from "node:fs";
import { DATA_DIR } from "./config.ts";

const DB_PATH = path.join(DATA_DIR, "whatsapp.db");

export interface Chat {
  jid: string;
  name?: string | null;
  last_message_time?: Date | null;
  last_message?: string | null;
  last_sender?: string | null;
  last_sender_name?: string | null;
  last_is_from_me?: boolean | null;
}

export type Message = {
  id: string;
  chat_jid: string;
  sender?: string | null;
  content: string;
  timestamp: Date;
  is_from_me: boolean;
  chat_name?: string | null;
  // Resolved display name of the message's sender (contacts.name/notify/phone),
  // keyed by the sender JID — the piece the chat_name join can't give for a
  // group participant. Null when the sender is unknown / it's our own message.
  sender_name?: string | null;
  // Base64 protobuf of the media submessage (mediaKey + CDN path), null for
  // text messages. We persist the decryption *metadata*, never the bytes — the
  // file stays on WhatsApp's CDN and is fetched on demand by get_media.
  media_meta?: string | null;
};

let dbInstance: DatabaseSync | null = null;

function getDb(): DatabaseSync {
  if (!dbInstance) {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    dbInstance = new DatabaseSync(DB_PATH);
  }
  return dbInstance;
}

export function initializeDatabase(): DatabaseSync {
  const db = getDb();

  db.exec("PRAGMA journal_mode = WAL");

  db.exec(`
        CREATE TABLE IF NOT EXISTS chats (
            jid TEXT PRIMARY KEY,
            name TEXT,
            last_message_time TEXT -- Store dates as ISO strings
        );
    `);

  db.exec(`
        CREATE TABLE IF NOT EXISTS messages (
            id TEXT,
            chat_jid TEXT,
            sender TEXT,      -- JID of the sender (can be group participant or contact)
            content TEXT,
            timestamp TEXT, -- Store dates as ISO strings
            is_from_me INTEGER, -- Store booleans as 0 or 1
            PRIMARY KEY (id, chat_jid),
            FOREIGN KEY (chat_jid) REFERENCES chats(jid) ON DELETE CASCADE
        );
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS contacts (
        jid TEXT PRIMARY KEY,
        name TEXT,
        notify TEXT,
        phone_number TEXT
      );
    `);

  // Migration: media_meta holds the base64 protobuf of a media submessage so it
  // can be decrypted/downloaded later. Added after the original schema, so guard
  // with a column check (SQLite has no ADD COLUMN IF NOT EXISTS).
  const messageColumns = db.prepare(`PRAGMA table_info(messages)`).all() as {
    name: string;
  }[];
  if (!messageColumns.some((c) => c.name === "media_meta")) {
    db.exec(`ALTER TABLE messages ADD COLUMN media_meta TEXT`);
  }

  // Transcriptions live in their own table rather than a column on `messages`,
  // for the same reason `media_meta` is kept off the hot read path: every
  // list/search query would otherwise carry a blob of text no caller asked for.
  // Keyed on the message, so N sessions transcribing the same voice note
  // converge on one row instead of each running Whisper from scratch.
  db.exec(`
    CREATE TABLE IF NOT EXISTS transcriptions (
      message_id  TEXT,
      chat_jid    TEXT,
      text        TEXT NOT NULL,
      engine      TEXT,
      model       TEXT,
      language    TEXT,
      duration_ms INTEGER,
      created_at  TEXT NOT NULL,
      PRIMARY KEY (message_id, chat_jid)
    );
  `);

  // Reactions are messages too, but they are ABOUT another message; keying on
  // (message, chat, reactor) makes a changed reaction replace the old one and
  // an empty emoji (WhatsApp's "remove") delete the row.
  db.exec(`
    CREATE TABLE IF NOT EXISTS reactions (
      message_id TEXT,
      chat_jid   TEXT,
      reactor    TEXT,
      emoji      TEXT NOT NULL,
      is_from_me INTEGER,
      timestamp  TEXT,
      PRIMARY KEY (message_id, chat_jid, reactor)
    );
  `);
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages (timestamp);`,
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_messages_chat_jid ON messages (chat_jid);`,
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages (sender);`,
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_chats_last_message_time ON chats (last_message_time);`,
  );

  // Every message the parser could not turn into a row lands here instead of
  // being dropped. Silently skipping one is what made a delivered attachment
  // (a PDF certificate, 2026-08-20) read as "the client never sent it"
  // — the absence of a row was indistinguishable from the absence of a message.
  // `raw_payload` is the base64 protobuf of the whole `msg.message`, so a later
  // parser fix can reprocess these without asking WhatsApp for anything.
  db.exec(`
    CREATE TABLE IF NOT EXISTS unparsed_messages (
      id           TEXT NOT NULL,
      chat_jid     TEXT NOT NULL,
      sender       TEXT,
      timestamp    TEXT,
      is_from_me   INTEGER,
      reason       TEXT NOT NULL,
      message_keys TEXT,
      stub_type    INTEGER,
      raw_payload  TEXT,
      created_at   TEXT NOT NULL,
      PRIMARY KEY (id, chat_jid)
    );
  `);
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_unparsed_timestamp ON unparsed_messages (timestamp);`,
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_unparsed_chat_jid ON unparsed_messages (chat_jid);`,
  );

  return db;
}

export function storeChat(chat: Partial<Chat> & { jid: string }): void {
  const db = getDb();
  try {
    const stmt = db.prepare(`
            INSERT INTO chats (jid, name, last_message_time)
            VALUES (@jid, @name, @last_message_time)
            ON CONFLICT(jid) DO UPDATE SET
                name = COALESCE(excluded.name, name),
                last_message_time = COALESCE(excluded.last_message_time, last_message_time)
        `);
    stmt.run({
      jid: chat.jid,
      name: chat.name ?? null,
      last_message_time:
        chat.last_message_time instanceof Date
          ? chat.last_message_time.toISOString()
          : chat.last_message_time === null
            ? null
            : String(chat.last_message_time),
    });
  } catch (error) {
    console.error("Error storing chat:", error);
  }
}

/**
 * Returns false if the write failed. The caller needs to know: reporting
 * "stored" for a row that is not there is the same silent lie this whole change
 * exists to remove.
 */
export function storeMessage(message: Message): boolean {
  const db = getDb();
  try {
    storeChat({ jid: message.chat_jid, last_message_time: message.timestamp });

    const stmt = db.prepare(`
            INSERT OR REPLACE INTO messages (id, chat_jid, sender, content, timestamp, is_from_me, media_meta)
            VALUES (@id, @chat_jid, @sender, @content, @timestamp, @is_from_me, @media_meta)
        `);

    stmt.run({
      id: message.id,
      chat_jid: message.chat_jid,
      sender: message.sender ?? null,
      content: message.content,
      timestamp: message.timestamp.toISOString(),
      is_from_me: message.is_from_me ? 1 : 0,
      media_meta: message.media_meta ?? null,
    });

    const updateChatTimeStmt = db.prepare(`
            UPDATE chats
            SET last_message_time = MAX(COALESCE(last_message_time, '1970-01-01T00:00:00.000Z'), @timestamp)
            WHERE jid = @jid
        `);
    updateChatTimeStmt.run({
      timestamp: message.timestamp.toISOString(),
      jid: message.chat_jid,
    });
    return true;
  } catch (error) {
    console.error("Error storing message:", error);
    return false;
  }
}

function parseDateSafe(dateString: string | null | undefined): Date | null {
  if (!dateString) return null;
  try {
    const date = new Date(dateString);
    return isNaN(date.getTime()) ? null : date;
  } catch (e) {
    return null;
  }
}

function rowToMessage(row: any): Message {
  return {
    id: row.id,
    chat_jid: row.chat_jid,
    sender: row.sender,
    content: row.content,
    timestamp: parseDateSafe(row.timestamp)!,
    is_from_me: Boolean(row.is_from_me),
    chat_name: row.chat_name,
    sender_name: row.sender_name ?? null,
  };
}

function rowToChat(row: any): Chat {
  return {
    jid: row.jid,
    name: row.name,
    last_message_time: parseDateSafe(row.last_message_time),
    last_message: row.last_message,
    last_sender: row.last_sender,
    last_sender_name: row.last_sender_name ?? null,
    last_is_from_me:
      row.last_is_from_me !== null ? Boolean(row.last_is_from_me) : null,
  };
}

export function getMessages(
  chatJid: string,
  limit: number = 20,
  page: number = 0,
): Message[] {
  const db = getDb();
  try {
    const offset = page * limit;
    const stmt = db.prepare(`
            SELECT m.*, c.name as chat_name,
                   COALESCE(cs.name, cs.notify, cs.phone_number) as sender_name
            FROM messages m
            JOIN chats c ON m.chat_jid = c.jid
            LEFT JOIN contacts cs ON m.sender = cs.jid
            WHERE m.chat_jid = ? -- Positional parameter 1
            ORDER BY m.timestamp DESC
            LIMIT ?             -- Positional parameter 2
            OFFSET ?            -- Positional parameter 3
        `);
    const rows = stmt.all(chatJid, limit, offset) as any[];
    return rows.map(rowToMessage);
  } catch (error) {
    console.error("Error getting messages:", error);
    return [];
  }
}

/**
 * Cross-chat message timeline: the latest messages across ALL chats within an
 * optional [after, before] time window, newest first. This is the one read that
 * the per-chat getMessages and the per-chat-last-message getChats can't give —
 * "what landed in my inbox over this period, regardless of which chat." Times are
 * compared as ISO strings (the column stores ISO-8601 UTC), which sorts
 * lexicographically the same as chronologically.
 */
export function getRecentMessages(opts: {
  after?: string | null;
  before?: string | null;
  limit?: number;
  fromMe?: boolean | null;
  includeGroups?: boolean;
} = {}): Message[] {
  const db = getDb();
  const {
    after = null,
    before = null,
    limit = 50,
    fromMe = null,
    includeGroups = true,
  } = opts;
  try {
    let sql = `
            SELECT m.*, COALESCE(c.name, ct.name, ct.notify, ct.phone_number) as chat_name,
                   COALESCE(cs.name, cs.notify, cs.phone_number) as sender_name
            FROM messages m
            JOIN chats c ON m.chat_jid = c.jid
            LEFT JOIN contacts ct ON c.jid = ct.jid
            LEFT JOIN contacts cs ON m.sender = cs.jid
            WHERE 1 = 1
        `;
    const params: (string | number)[] = [];
    if (after) {
      sql += ` AND m.timestamp >= ?`;
      params.push(after);
    }
    if (before) {
      sql += ` AND m.timestamp <= ?`;
      params.push(before);
    }
    if (fromMe !== null) {
      sql += ` AND m.is_from_me = ?`;
      params.push(fromMe ? 1 : 0);
    }
    if (!includeGroups) {
      sql += ` AND m.chat_jid NOT LIKE '%@g.us'`;
    }
    sql += ` ORDER BY m.timestamp DESC LIMIT ?`;
    params.push(limit);

    const rows = db.prepare(sql).all(...params) as any[];
    return rows.map(rowToMessage);
  } catch (error) {
    console.error("Error getting recent messages:", error);
    return [];
  }
}

export function getChats(
  limit: number = 20,
  page: number = 0,
  sortBy: "last_active" | "name" = "last_active",
  query?: string | null,
  includeLastMessage: boolean = true,
): Chat[] {
  const db = getDb();
  try {
    const offset = page * limit;
    let sql = `
            SELECT
                c.jid,
                COALESCE(c.name, ct.name, ct.notify, ct.phone_number) as name,
                c.last_message_time
                ${
                  includeLastMessage
                    ? `,
                (SELECT m.content FROM messages m WHERE m.chat_jid = c.jid ORDER BY m.timestamp DESC LIMIT 1) as last_message,
                (SELECT m.sender FROM messages m WHERE m.chat_jid = c.jid ORDER BY m.timestamp DESC LIMIT 1) as last_sender,
                (SELECT COALESCE(cs.name, cs.notify, cs.phone_number)
                   FROM messages m LEFT JOIN contacts cs ON m.sender = cs.jid
                  WHERE m.chat_jid = c.jid ORDER BY m.timestamp DESC LIMIT 1) as last_sender_name,
                (SELECT m.is_from_me FROM messages m WHERE m.chat_jid = c.jid ORDER BY m.timestamp DESC LIMIT 1) as last_is_from_me
                `
                    : ""
                }
            FROM chats c
            LEFT JOIN contacts ct ON c.jid = ct.jid
        `;

    const params: (string | number)[] = [];

    if (query) {
      sql += ` WHERE (LOWER(COALESCE(c.name, ct.name, ct.notify, ct.phone_number)) LIKE LOWER(?) OR c.jid LIKE ?)`;
      params.push(`%${query}%`, `%${query}%`);
    }

    const orderByClause =
      sortBy === "last_active"
        ? "c.last_message_time DESC NULLS LAST"
        : "COALESCE(c.name, ct.name, ct.notify, ct.phone_number) ASC";
    sql += ` ORDER BY ${orderByClause}, c.jid ASC`;

    sql += ` LIMIT ? OFFSET ?`;
    params.push(limit, offset);

    const stmt = db.prepare(sql);
    const rows = stmt.all(...params) as any[];
    return rows.map(rowToChat);
  } catch (error) {
    console.error("Error getting chats:", error);
    return [];
  }
}

export function getChat(
  jid: string,
  includeLastMessage: boolean = true,
): Chat | null {
  const db = getDb();
  try {
    let sql = `
            SELECT
                c.jid,
                COALESCE(c.name, ct.name, ct.notify, ct.phone_number) as name,
                c.last_message_time
                ${
                  includeLastMessage
                    ? `,
                (SELECT m.content FROM messages m WHERE m.chat_jid = c.jid ORDER BY m.timestamp DESC LIMIT 1) as last_message,
                (SELECT m.sender FROM messages m WHERE m.chat_jid = c.jid ORDER BY m.timestamp DESC LIMIT 1) as last_sender,
                (SELECT COALESCE(cs.name, cs.notify, cs.phone_number)
                   FROM messages m LEFT JOIN contacts cs ON m.sender = cs.jid
                  WHERE m.chat_jid = c.jid ORDER BY m.timestamp DESC LIMIT 1) as last_sender_name,
                (SELECT m.is_from_me FROM messages m WHERE m.chat_jid = c.jid ORDER BY m.timestamp DESC LIMIT 1) as last_is_from_me
                `
                    : ""
                }
            FROM chats c
            LEFT JOIN contacts ct ON c.jid = ct.jid
            WHERE c.jid = ? -- Positional parameter 1
        `;

    const stmt = db.prepare(sql);
    const row = stmt.get(jid) as any | undefined;
    return row ? rowToChat(row) : null;
  } catch (error) {
    console.error("Error getting chat:", error);
    return null;
  }
}

export function getMessagesAround(
  messageId: string,
  before: number = 5,
  after: number = 5,
): { before: Message[]; target: Message | null; after: Message[] } {
  const db = getDb();
  const result: {
    before: Message[];
    target: Message | null;
    after: Message[];
  } = { before: [], target: null, after: [] };

  try {
    const targetStmt = db.prepare(`
             SELECT m.*, c.name as chat_name,
                    COALESCE(cs.name, cs.notify, cs.phone_number) as sender_name
             FROM messages m
             JOIN chats c ON m.chat_jid = c.jid
             LEFT JOIN contacts cs ON m.sender = cs.jid
             WHERE m.id = ? -- Positional parameter 1
        `);
    const targetRow = targetStmt.get(messageId) as any | undefined;

    if (!targetRow) {
      return result;
    }
    result.target = rowToMessage(targetRow);
    const targetTimestamp = result.target.timestamp.toISOString();
    const chatJid = result.target.chat_jid;

    const beforeStmt = db.prepare(`
            SELECT m.*, c.name as chat_name,
                   COALESCE(cs.name, cs.notify, cs.phone_number) as sender_name
            FROM messages m
            JOIN chats c ON m.chat_jid = c.jid
            LEFT JOIN contacts cs ON m.sender = cs.jid
            WHERE m.chat_jid = ? AND m.timestamp < ? -- Positional params 1, 2
            ORDER BY m.timestamp DESC
            LIMIT ?                                  -- Positional param 3
        `);
    const beforeRows = beforeStmt.all(
      chatJid,
      targetTimestamp,
      before,
    ) as any[];
    result.before = beforeRows.map(rowToMessage).reverse();

    const afterStmt = db.prepare(`
            SELECT m.*, c.name as chat_name,
                   COALESCE(cs.name, cs.notify, cs.phone_number) as sender_name
            FROM messages m
            JOIN chats c ON m.chat_jid = c.jid
            LEFT JOIN contacts cs ON m.sender = cs.jid
            WHERE m.chat_jid = ? AND m.timestamp > ? -- Positional params 1, 2
            ORDER BY m.timestamp ASC
            LIMIT ?                                  -- Positional param 3
        `);
    const afterRows = afterStmt.all(chatJid, targetTimestamp, after) as any[];
    result.after = afterRows.map(rowToMessage);

    return result;
  } catch (error) {
    console.error("Error getting messages around:", error);
    return result;
  }
}

export function searchDbForContacts(
  query: string,
  limit: number = 20
): { jid: string; name: string | null }[] {
  const db = getDb();
  try {
    const pattern = `%${query}%`;

    const stmt = db.prepare(`
      SELECT
        jid,
        COALESCE(name, notify, phone_number, jid) AS display_name
      FROM contacts
      WHERE
        LOWER(COALESCE(name, notify, phone_number, jid)) LIKE LOWER(?)
      LIMIT ?
    `);

    const rows = stmt.all(pattern, limit) as {
      jid: string;
      display_name: string | null;
    }[];

    return rows.map((r) => ({
      jid: r.jid,
      name: r.display_name,
    }));
  } catch (error) {
    console.error("Error searching contacts:", error);
    return [];
  }
}

export function searchMessages(
  searchQuery: string,
  chatJid?: string | null,
  limit: number = 10,
  page: number = 0,
): Message[] {
  const db = getDb();
  try {
    const offset = page * limit;
    const searchPattern = `%${searchQuery}%`;
    let sql = `
            SELECT m.*, COALESCE(c.name, ct.name, ct.notify, ct.phone_number) as chat_name,
                   COALESCE(cs.name, cs.notify, cs.phone_number) as sender_name
            FROM messages m
            JOIN chats c ON m.chat_jid = c.jid
            LEFT JOIN contacts ct ON c.jid = ct.jid
            LEFT JOIN contacts cs ON m.sender = cs.jid
            WHERE LOWER(m.content) LIKE LOWER(?) -- Param 1: searchPattern
        `;
    const params: (string | number | null)[] = [searchPattern];

    if (chatJid) {
      sql += ` AND m.chat_jid = ?`;
      params.push(chatJid);
    }

    sql += ` ORDER BY m.timestamp DESC`;
    sql += ` LIMIT ?`;
    params.push(limit);
    sql += ` OFFSET ?`;
    params.push(offset);

    const stmt = db.prepare(sql);
    const rows = stmt.all(...params) as any[];
    return rows.map(rowToMessage);
  } catch (error) {
    console.error("Error searching messages:", error);
    return [];
  }
}

/**
 * Fetch the stored media metadata for one message (plus the few fields needed to
 * rebuild its key for a re-upload request). Returns null if the message is not in
 * the DB; `media_meta` is null when the message carries no downloadable media.
 * `media_meta` is deliberately NOT part of the normal Message read path so the
 * base64 blob never bloats list/search results.
 */
/** One message row by id, for building a quote (WhatsApp reply). Any of the
 *  chat's twin jids is accepted, since the caller may hold the @lid form. */
export function getMessageRow(
  messageId: string,
  chatJid?: string | null,
): { id: string; chat_jid: string; sender: string | null; is_from_me: boolean; content: string | null } | null {
  const db = getDb();
  try {
    let sql = `SELECT id, chat_jid, sender, is_from_me, content FROM messages WHERE id = ?`;
    const params: string[] = [messageId];
    if (chatJid) {
      sql += ` AND chat_jid = ?`;
      params.push(chatJid);
    }
    const row = db.prepare(sql + ` LIMIT 1`).get(...params) as any;
    return row ? { ...row, is_from_me: !!row.is_from_me } : null;
  } catch {
    return null;
  }
}

export function getMessageMedia(
  messageId: string,
  chatJid?: string | null,
): {
  id: string;
  chat_jid: string;
  sender: string | null;
  is_from_me: boolean;
  media_meta: string | null;
} | null {
  const db = getDb();
  try {
    let sql = `SELECT id, chat_jid, sender, is_from_me, media_meta FROM messages WHERE id = ?`;
    const params: (string | number)[] = [messageId];
    if (chatJid) {
      sql += ` AND chat_jid = ?`;
      params.push(chatJid);
    }
    sql += ` LIMIT 1`;
    const row = db.prepare(sql).get(...params) as any | undefined;
    if (!row) return null;
    return {
      id: row.id,
      chat_jid: row.chat_jid,
      sender: row.sender ?? null,
      is_from_me: Boolean(row.is_from_me),
      media_meta: row.media_meta ?? null,
    };
  } catch (error) {
    console.error("Error getting message media:", error);
    return null;
  }
}

export function closeDatabase(): void {
  if (dbInstance) {
    try {
      dbInstance.close();
      dbInstance = null;
      console.log("Database connection closed.");
    } catch (error) {
      console.error("Error closing database:", error);
    }
  }
}

export function storeContact(contact: {
  jid: string;
  name?: string | null;
  notify?: string | null;
  phoneNumber?: string | null;
}): void {
  const db = getDb();
  try {
    const stmt = db.prepare(`
      INSERT INTO contacts (jid, name, notify, phone_number)
      VALUES (@jid, @name, @notify, @phone_number)
      ON CONFLICT(jid) DO UPDATE SET
        name = COALESCE(excluded.name, name),
        notify = COALESCE(excluded.notify, notify),
        phone_number = COALESCE(excluded.phone_number, phone_number)
    `);

    stmt.run({
      jid: contact.jid,
      name: contact.name ?? null,
      notify: contact.notify ?? null,
      phone_number: contact.phoneNumber ?? null,
    });
  } catch (error) {
    console.error("Error storing contact:", error);
  }
}

/**
 * Persist a display name for a message's sender/1:1-chat using the two things
 * Baileys hands us on every message but the pipeline previously ignored:
 *   - `pushName` — the sender's WhatsApp display name → stored as contacts.notify
 *   - the paired phone JID (`key.remoteJidAlt` / `key.participantAlt`) — lets a
 *     privacy-preserving `@lid` chat inherit the address-book name that was saved
 *     under the phone JID (contacts synced from the address book are keyed by the
 *     `…@s.whatsapp.net` JID, so a `@lid` chat never matched the resolution join).
 *
 * Writes a contacts row keyed by the (often `@lid`) sender JID so the existing
 * `COALESCE(c.name, ct.name, ct.notify, ct.phone_number)` resolution starts
 * matching for LID chats. storeContact COALESCEs, so repeated calls only enrich —
 * a null (e.g. an unknown address-book name) never clobbers a good stored value.
 */
export function upsertMessageContact(opts: {
  jid: string;
  pushName?: string | null;
  phoneJid?: string | null;
}): void {
  try {
    let addressBookName: string | null = null;
    let phoneNumber: string | null = null;
    if (opts.phoneJid) {
      phoneNumber = opts.phoneJid.split("@")[0] || null;
      // Borrow the saved address-book name from the phone-JID-keyed contact, so a
      // known person shows their real name rather than just their pushName.
      const row = getDb()
        .prepare(`SELECT name FROM contacts WHERE jid = ?`)
        .get(opts.phoneJid) as { name?: string | null } | undefined;
      addressBookName = row?.name ?? null;
    }
    if (!opts.pushName && !addressBookName && !phoneNumber) return;
    storeContact({
      jid: opts.jid,
      name: addressBookName,
      notify: opts.pushName ?? null,
      phoneNumber,
    });
  } catch (error) {
    console.error("Error upserting message contact:", error);
  }
}

/** Cached transcript for a voice note, or null if never transcribed. A hit is
 *  authoritative — the audio is immutable, so re-transcribing is pure waste. */
export function getTranscription(
  messageId: string,
  chatJid: string | null,
): {
  text: string;
  engine: string | null;
  model: string | null;
  language: string | null;
  created_at: string;
} | null {
  const db = initializeDatabase();
  const row = chatJid
    ? db
        .prepare(
          `SELECT text, engine, model, language, created_at FROM transcriptions WHERE message_id = ? AND chat_jid = ?`,
        )
        .get(messageId, chatJid)
    : db
        .prepare(
          `SELECT text, engine, model, language, created_at FROM transcriptions WHERE message_id = ? LIMIT 1`,
        )
        .get(messageId);
  return (row as any) ?? null;
}

/** Store (or replace) a transcript. REPLACE rather than IGNORE so a re-run with
 *  a better model can correct an earlier one. */
export function storeTranscription(t: {
  message_id: string;
  chat_jid: string;
  text: string;
  engine?: string | null;
  model?: string | null;
  language?: string | null;
  duration_ms?: number | null;
}): void {
  const db = initializeDatabase();
  db.prepare(
    `INSERT OR REPLACE INTO transcriptions
       (message_id, chat_jid, text, engine, model, language, duration_ms, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    t.message_id,
    t.chat_jid,
    t.text,
    t.engine ?? null,
    t.model ?? null,
    t.language ?? null,
    t.duration_ms ?? null,
    new Date().toISOString(),
  );
}

export interface Reaction {
  message_id: string;
  chat_jid: string;
  reactor: string;
  emoji: string;
  is_from_me: boolean;
  timestamp: string;
}

export function storeReaction(r: Reaction): void {
  const db = getDb();
  if (!r.emoji) {
    db.prepare(
      `DELETE FROM reactions WHERE message_id = ? AND chat_jid = ? AND reactor = ?`,
    ).run(r.message_id, r.chat_jid, r.reactor);
    return;
  }
  db.prepare(
    `INSERT INTO reactions (message_id, chat_jid, reactor, emoji, is_from_me, timestamp)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(message_id, chat_jid, reactor) DO UPDATE SET
       emoji = excluded.emoji, is_from_me = excluded.is_from_me, timestamp = excluded.timestamp`,
  ).run(r.message_id, r.chat_jid, r.reactor, r.emoji, r.is_from_me ? 1 : 0, r.timestamp);
}

export interface UnparsedMessage {
  id: string;
  chat_jid: string;
  sender?: string | null;
  timestamp: string;
  is_from_me: boolean;
  /** Why the parser gave up: `unsupported:<messageType>`, `undecrypted`, … */
  reason: string;
  /** `Object.keys(msg.message)` at receive time, comma-joined. */
  message_keys?: string | null;
  stub_type?: number | null;
  /** Base64 protobuf of `msg.message`, for reprocessing. Null for stub-only. */
  raw_payload?: string | null;
}

export function storeUnparsedMessage(u: UnparsedMessage): boolean {
  const db = getDb();
  try {
    // The chat row matters as much as the message row: without it a contact
    // whose FIRST message we cannot parse never appears in list_chats at all,
    // which is the same invisibility in a different place.
    storeChat({ jid: u.chat_jid, last_message_time: new Date(u.timestamp) });
  } catch {
    // A bad timestamp must not cost us the message record below.
  }
  try {
    db.prepare(
    `INSERT INTO unparsed_messages
       (id, chat_jid, sender, timestamp, is_from_me, reason, message_keys,
        stub_type, raw_payload, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id, chat_jid) DO UPDATE SET
       reason = excluded.reason,
       message_keys = excluded.message_keys,
       stub_type = excluded.stub_type,
       raw_payload = COALESCE(excluded.raw_payload, unparsed_messages.raw_payload)`,
    ).run(
      u.id,
      u.chat_jid,
      u.sender ?? null,
      u.timestamp,
      u.is_from_me ? 1 : 0,
      u.reason,
      u.message_keys ?? null,
      u.stub_type ?? null,
      u.raw_payload ?? null,
      new Date().toISOString(),
    );
    return true;
  } catch (error) {
    console.error("Error storing unparsed message:", error);
    return false;
  }
}

/**
 * Drop the placeholder once the real message lands. A `CIPHERTEXT` stub is
 * WhatsApp saying "a message arrived that I could not decrypt yet"; when the
 * retry decrypts, the row in `messages` is the answer and the placeholder is
 * noise.
 */
export function clearUnparsedMessage(id: string, chatJid: string): void {
  const db = getDb();
  try {
    db.prepare(
      `DELETE FROM unparsed_messages WHERE id = ? AND chat_jid = ?`,
    ).run(id, chatJid);
  } catch (error) {
    console.error("Error clearing unparsed message:", error);
  }
}

/** The timestamp we recorded for an unparsed placeholder, if we have one. */
export function getUnparsedTimestamp(
  id: string,
  chatJid: string,
): string | null {
  const db = getDb();
  try {
    const row = db
      .prepare(
        `SELECT timestamp FROM unparsed_messages WHERE id = ? AND chat_jid = ?`,
      )
      .get(id, chatJid) as { timestamp: string } | undefined;
    return row?.timestamp ?? null;
  } catch {
    return null;
  }
}

export function messageExists(id: string, chatJid: string): boolean {
  const db = getDb();
  try {
    return (
      db
        .prepare(`SELECT 1 FROM messages WHERE id = ? AND chat_jid = ?`)
        .get(id, chatJid) != null
    );
  } catch {
    return false;
  }
}

export interface UnparsedQuery {
  chatJid?: string | null;
  after?: string | null;
  before?: string | null;
  limit?: number;
}

function unparsedWhere(q: UnparsedQuery): { sql: string; params: any[] } {
  const clauses: string[] = [];
  const params: any[] = [];
  if (q.chatJid) {
    clauses.push("u.chat_jid = ?");
    params.push(q.chatJid);
  }
  if (q.after) {
    clauses.push("u.timestamp >= ?");
    params.push(q.after);
  }
  if (q.before) {
    clauses.push("u.timestamp <= ?");
    params.push(q.before);
  }
  return {
    sql: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "",
    params,
  };
}

export function getUnparsedMessages(
  q: UnparsedQuery = {},
): (UnparsedMessage & { chat_name?: string | null; sender_name?: string | null })[] {
  const db = getDb();
  const { sql, params } = unparsedWhere(q);
  try {
  const rows = db
    .prepare(
      `SELECT u.*, c.name as chat_name,
              COALESCE(cs.name, cs.notify, cs.phone_number) as sender_name
       FROM unparsed_messages u
       LEFT JOIN chats c ON u.chat_jid = c.jid
       LEFT JOIN contacts cs ON u.sender = cs.jid
       ${sql}
       ORDER BY u.timestamp DESC
       LIMIT ?`,
    )
    .all(...params, q.limit ?? 50) as any[];
    return rows.map((r) => ({ ...r, is_from_me: !!r.is_from_me }));
  } catch (error) {
    console.error("Error listing unparsed messages:", error);
    return [];
  }
}

export function countUnparsedMessages(q: UnparsedQuery = {}): number {
  const db = getDb();
  const { sql, params } = unparsedWhere(q);
  try {
    const row = db
      .prepare(`SELECT COUNT(*) as n FROM unparsed_messages u ${sql}`)
      .get(...params) as { n: number } | undefined;
    return row?.n ?? 0;
  } catch {
    // An older DB without the table must not break a read tool.
    return 0;
  }
}

/**
 * Apply a WhatsApp message edit (`protocolMessage` of type `MESSAGE_EDIT`) to
 * the row it points at. Deliberately an UPDATE of `content` only — the original
 * row keeps its timestamp and `media_meta`, so an edited caption does not cost
 * us the ability to download the file. Returns false when the original was
 * never stored, so the caller can decide what to do with the orphan.
 */
export function applyMessageEdit(
  id: string,
  chatJid: string,
  content: string,
): boolean {
  const db = getDb();
  try {
    const res = db
      .prepare(`UPDATE messages SET content = ? WHERE id = ? AND chat_jid = ?`)
      .run(content, id, chatJid);
    return Number(res.changes) > 0;
  } catch (error) {
    console.error("Error applying message edit:", error);
    return false;
  }
}
