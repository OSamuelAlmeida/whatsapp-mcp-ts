import {
  makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  DisconnectReason,
  proto,
  type WAMessage,
  isJidGroup,
  jidNormalizedUser,
  normalizeMessageContent,
} from "baileys";
import P from "pino";
import qrcode from "qrcode-terminal";
import fs from "node:fs";
import path from "node:path";

import {
  initializeDatabase,
  storeMessage,
  storeChat,
  storeContact,
  upsertMessageContact,
  type Message as DbMessage,
  storeReaction,
  storeUnparsedMessage,
  clearUnparsedMessage,
  getUnparsedTimestamp,
  messageExists,
  applyMessageEdit,
  type UnparsedMessage,
} from "./database.ts";
import { AUTH_DIR, IGNORE_GROUPS } from "./config.ts";

export type WhatsAppSocket = ReturnType<typeof makeWASocket>;

/**
 * Mutable handle to the live socket. Baileys hands us a *new* socket on every
 * reconnect, so callers must read `connection.socket` at call time rather than
 * capturing the socket once — otherwise a send after any reconnect would target
 * a dead socket.
 */
export interface WhatsAppConnection {
  socket: WhatsAppSocket | null;
}

/**
 * A reaction is a message whose payload points at another message. It never
 * becomes a row in `messages` (there is nothing to read), but it is what the
 * other person actually said about yours, so it gets its own table.
 */
function storeReactionIfAny(msg: WAMessage, content: proto.IMessage | null): boolean {
  const rx = content?.reactionMessage;
  if (!rx?.key?.id) return false;
  const chat = rx.key.remoteJid || msg.key.remoteJid;
  if (!chat) return false;
  const reactor = msg.key.fromMe
    ? "me"
    : jidNormalizedUser(msg.key.participant || msg.key.remoteJid || "");
  storeReaction({
    message_id: rx.key.id,
    chat_jid: chat,
    reactor,
    emoji: rx.text || "",
    is_from_me: !!msg.key.fromMe,
    timestamp: new Date(
      rx.senderTimestampMs ? Number(rx.senderTimestampMs) : Date.now(),
    ).toISOString(),
  });
  return true;
}

/**
 * Who sent this, in the form the `messages` table wants: null for our own 1:1
 * messages, the participant for groups, the chat itself for an incoming 1:1.
 */
function senderOf(msg: WAMessage): string | null {
  if (!msg.key?.remoteJid) return null;
  let senderJid: string | null | undefined = msg.key.participant;
  if (!msg.key.fromMe && !senderJid && !isJidGroup(msg.key.remoteJid)) {
    senderJid = msg.key.remoteJid;
  }
  if (msg.key.fromMe && !isJidGroup(msg.key.remoteJid)) {
    senderJid = null;
  }
  return senderJid ? jidNormalizedUser(senderJid) : null;
}

function timestampOf(msg: WAMessage, fallback?: Date): Date {
  // WhatsApp's own timestamp (seconds since epoch); handles number, bigint and
  // Long-like objects. A caller with a better answer than "now" — the row we
  // already have, the placeholder we recorded — passes it as `fallback`;
  // filing an old message under Date.now() puts it at the top of every
  // timeline and moves its chat to the top of the list.
  if (msg.messageTimestamp != null) {
    const seconds = Number(msg.messageTimestamp);
    const d = new Date(seconds * 1000);
    if (Number.isFinite(d.getTime())) return d;
  }
  return fallback ?? new Date();
}

/** Human-readable text for a message body, or null if we do not know the shape. */
function contentOf(m: proto.IMessage): string | null {
  if (m.conversation) return m.conversation;
  if (m.extendedTextMessage?.text) return m.extendedTextMessage.text;
  if (m.imageMessage) {
    // Media gets a placeholder even without a caption so it's stored (and thus
    // downloadable). Previously uncaptioned images were dropped entirely.
    return m.imageMessage.caption ? `[Image] ${m.imageMessage.caption}` : `[Image]`;
  }
  if (m.videoMessage) {
    return m.videoMessage.caption ? `[Video] ${m.videoMessage.caption}` : `[Video]`;
  }
  if (m.documentMessage) {
    return `[Document] ${
      m.documentMessage.caption || m.documentMessage.fileName || ""
    }`.trimEnd();
  }
  if (m.audioMessage) return m.audioMessage.ptt ? `[Voice]` : `[Audio]`;
  if (m.stickerMessage) return `[Sticker]`;
  if (m.locationMessage?.address) return `[Location] ${m.locationMessage.address}`;
  if (m.contactMessage?.displayName) return `[Contact] ${m.contactMessage.displayName}`;
  if (m.pollCreationMessage?.name) return `[Poll] ${m.pollCreationMessage.name}`;
  if (m.albumMessage) {
    // The header of a multi-item send. The items themselves arrive as their own
    // messages; this row is what makes them read as one album rather than a
    // burst of unrelated media.
    const imgs = Number(m.albumMessage.expectedImageCount ?? 0);
    const vids = Number(m.albumMessage.expectedVideoCount ?? 0);
    const parts = [
      imgs ? `${imgs} image${imgs === 1 ? "" : "s"}` : null,
      vids ? `${vids} video${vids === 1 ? "" : "s"}` : null,
    ].filter(Boolean);
    return `[Album]${parts.length ? ` ${parts.join(", ")}` : ""}`;
  }
  if (m.buttonsMessage) {
    // An interactive send. Its header may itself carry media, which we do not
    // make downloadable (media_meta only covers top-level media types) — but
    // the text is the part a human asked about.
    const text = m.buttonsMessage.contentText || m.buttonsMessage.text;
    return text ? `${text}` : `[Buttons]`;
  }
  return null;
}

/** Base64 protobuf of the media submessage, for later on-demand download. */
function mediaMetaOf(m: proto.IMessage): string | null {
  // Capture the decryption metadata (NOT the bytes) for downloadable media. We
  // protobuf-encode the whole submessage to base64 so the Uint8Array fields
  // (mediaKey, fileEncSha256, …) survive a round-trip — JSON.stringify would
  // corrupt them. The actual file stays on WhatsApp's CDN; get_media fetches it
  // on demand. Only these top-level media types are downloadable — which is why
  // this must run on the *unwrapped* message: a documentWithCaptionMessage has
  // no top-level documentMessage until the envelope is peeled.
  const MEDIA_TYPES = [
    "imageMessage",
    "videoMessage",
    "audioMessage",
    "documentMessage",
    "stickerMessage",
  ] as const;
  if (!MEDIA_TYPES.some((t) => (m as Record<string, unknown>)[t])) return null;
  try {
    return Buffer.from(proto.Message.encode(m).finish()).toString("base64");
  } catch {
    return null;
  }
}

export /**
 * Peel the envelopes WhatsApp wraps real content in. Baileys'
 * `normalizeMessageContent` covers documentWithCaption / viewOnce* / ephemeral /
 * edited; it does NOT cover `deviceSentMessage`, which the live decrypt path
 * strips upstream but the history-sync path does not — so peel that here too.
 */
function unwrap(m: proto.IMessage | null | undefined): proto.IMessage | null {
  let cur = m ?? null;
  for (let i = 0; i < 5 && cur?.deviceSentMessage?.message; i++) {
    cur = cur.deviceSentMessage.message;
  }
  return normalizeMessageContent(cur ?? undefined) ?? null;
}

export function parseMessageForDb(
  msg: WAMessage,
  fallbackTimestamp?: Date,
): DbMessage | null {
  if (!msg.message || !msg.key || !msg.key.remoteJid) {
    return null;
  }

  // WhatsApp wraps real content in envelopes — documentWithCaptionMessage,
  // viewOnce*, ephemeralMessage, editedMessage. Reading the outer keys, as this
  // used to, means a document sent with a caption looks like a type we have
  // never heard of and gets dropped. That is precisely what happened to the
  // PDF certificate a client sent on 2026-08-20. Baileys ships the peeler; use it.
  const m = unwrap(msg.message);
  if (!m) return null;

  const content = contentOf(m);
  if (!content) {
    return null;
  }

  return {
    id: msg.key.id!,
    chat_jid: msg.key.remoteJid,
    sender: senderOf(msg),
    content: content,
    timestamp: timestampOf(msg, fallbackTimestamp),
    is_from_me: msg.key.fromMe ?? false,
    media_meta: mediaMetaOf(m),
  };
}

/**
 * What happened to one incoming message. Every branch is accounted for: the
 * point of this type is that there is no fall-through that quietly does
 * nothing. `ignored` carries the reason, so "we chose not to store this" is a
 * decision on record rather than an absence.
 */
export type MessageOutcome =
  | { kind: "stored" }
  | { kind: "reaction" }
  | { kind: "edit"; applied: boolean }
  | { kind: "ignored"; reason: string }
  | { kind: "unparsed"; record: UnparsedMessage };

function protocolTypeName(type: number | null | undefined): string {
  const names = proto.Message.ProtocolMessage.Type as Record<string, unknown>;
  const hit = Object.keys(names).find((k) => names[k] === type);
  return hit ?? `UNKNOWN_${type}`;
}

/**
 * Handle a message that came in as a protocol envelope. Most of these are
 * plumbing (key shares, history-sync blobs, ephemeral settings) and are ignored
 * by name. `MESSAGE_EDIT` is the exception: it carries the message's *current*
 * text, so dropping it leaves the store showing what was said before the edit.
 */
function handleProtocolMessage(
  msg: WAMessage,
  p: proto.Message.IProtocolMessage,
  fallbackTimestamp?: Date,
): MessageOutcome {
  const typeName = protocolTypeName(p.type);
  if (p.type === proto.Message.ProtocolMessage.Type.MESSAGE_EDIT) {
    const targetId = p.key?.id;
    const chat = p.key?.remoteJid ?? msg.key?.remoteJid;
    const edited = unwrap(p.editedMessage ?? undefined);
    const text = edited ? contentOf(edited) : null;
    if (targetId && chat && text) {
      if (applyMessageEdit(targetId, chat, text)) {
        return { kind: "edit", applied: true };
      }
      // The edit points at a message we never stored. Dropping it would lose
      // the only copy of that text we will ever see, so keep it on record.
      const record: UnparsedMessage = {
        id: targetId,
        chat_jid: chat,
        sender: senderOf(msg),
        timestamp: timestampOf(msg, fallbackTimestamp).toISOString(),
        is_from_me: msg.key?.fromMe ?? false,
        reason: "edit-orphan",
        message_keys: "protocolMessage",
        stub_type: null,
        raw_payload: encodePayload(msg.message),
      };
      storeUnparsedMessage(record);
      return { kind: "unparsed", record };
    }
    return { kind: "ignored", reason: `protocol:${typeName}:incomplete` };
  }
  // REVOKE deliberately does NOT delete the stored row: "what did they say
  // before deleting it" is the question this store exists to answer, and a
  // deletion on WhatsApp's side is not a reason to lose our copy.
  return { kind: "ignored", reason: `protocol:${typeName}` };
}

/**
 * Decide what to do with one incoming message, and do it. Anything we cannot
 * turn into a row is persisted to `unparsed_messages` with its raw payload
 * rather than dropped — the old code logged a warning and moved on, which made
 * "we failed to read it" indistinguishable from "nobody sent anything".
 */
export function ingestMessage(
  msg: WAMessage,
  fallbackTimestamp?: Date,
): MessageOutcome {
  const normalized = unwrap(msg.message);

  // Normalize BEFORE the reaction check: a reaction inside an ephemeral
  // (disappearing-messages) envelope is still a reaction.
  if (storeReactionIfAny(msg, normalized)) return { kind: "reaction" };

  const chatJid = msg.key?.remoteJid;
  const msgId = msg.key?.id;

  if (normalized?.protocolMessage) {
    return handleProtocolMessage(msg, normalized.protocolMessage, fallbackTimestamp);
  }

  const parsed = parseMessageForDb(msg, fallbackTimestamp);
  if (parsed) {
    if (storeMessage(parsed)) {
      storeSenderIdentity(msg);
      // A retry that decrypts supersedes the CIPHERTEXT placeholder we recorded.
      clearUnparsedMessage(parsed.id, parsed.chat_jid);
      return { kind: "stored" };
    }
    // The write failed. Saying "stored" here would be the same silent lie the
    // old skip-and-warn was — fall through and keep it as unparsed instead.
  }

  if (!chatJid || !msgId) {
    // No key at all — there is nothing to record it against. Not routine: a
    // message with content and no key is an anomaly worth seeing.
    return { kind: "ignored", reason: "no-key" };
  }

  // Anything that carries no `message` at all is a system notification
  // (someone was added to a group, the security code changed…) — except
  // CIPHERTEXT, which is WhatsApp saying "a real message arrived and I could
  // not decrypt it". That one is content, and it is the one we must not lose.
  const stubType = msg.messageStubType ?? null;
  if (!msg.message) {
    const isCiphertext =
      stubType === proto.WebMessageInfo.StubType.CIPHERTEXT;
    if (!isCiphertext) {
      return { kind: "ignored", reason: `stub:${stubType}` };
    }
  }

  const keys = normalized ? Object.keys(normalized) : null;
  const contentKey = keys?.find(
    (k) => k !== "messageContextInfo" && k !== "senderKeyDistributionMessage",
  );
  const record: UnparsedMessage = {
    id: msgId,
    chat_jid: chatJid,
    sender: senderOf(msg),
    timestamp: timestampOf(msg, fallbackTimestamp).toISOString(),
    is_from_me: msg.key?.fromMe ?? false,
    reason: msg.message
      ? `unsupported:${contentKey ?? "unknown"}`
      : "undecrypted",
    message_keys: msg.message ? Object.keys(msg.message).join(",") : null,
    stub_type: stubType,
    raw_payload: encodePayload(msg.message),
  };
  storeUnparsedMessage(record);
  storeSenderIdentity(msg);
  return { kind: "unparsed", record };
}

function encodePayload(m: proto.IMessage | null | undefined): string | null {
  if (!m) return null;
  try {
    return Buffer.from(proto.Message.encode(m).finish()).toString("base64");
  } catch {
    return null;
  }
}

/**
 * `messages.update` is NOT a second delivery of the message — it is a patch.
 * Routing it through `storeMessage` (an INSERT OR REPLACE) rewrites the whole
 * row: the timestamp resets to now and `media_meta` is lost. Both Baileys emit
 * sites that carry content make that fatal —
 *
 *   - MESSAGE_EDIT sends `messageTimestamp: protocolMsg.timestampMs`, in
 *     MILLISECONDS, which read as seconds lands the row in the year 58637 and
 *     pins it to the top of every `ORDER BY timestamp DESC`;
 *   - `updateMediaMessage` (get_media's own CDN-expired re-upload) re-emits the
 *     message with no timestamp at all, so merely *reading* old media would
 *     move it to today and wipe the metadata that made it downloadable.
 *
 * So: patch what we have, and only ingest when there is nothing to patch.
 */
export function handleMessageUpdate(msg: WAMessage): MessageOutcome {
  const id = msg.key?.id;
  const chat = msg.key?.remoteJid;
  if (!id || !chat) return { kind: "ignored", reason: "update:no-key" };

  if (messageExists(id, chat)) {
    const body = unwrap(msg.message);
    const inner = body?.protocolMessage?.editedMessage
      ? unwrap(body.protocolMessage.editedMessage)
      : body;
    const text = inner ? contentOf(inner) : null;
    if (!text) return { kind: "ignored", reason: "update:no-content" };
    return { kind: "edit", applied: applyMessageEdit(id, chat, text) };
  }

  // Nothing to patch: this is the decrypted retry for a message we only have as
  // a placeholder. Its timestamp is the placeholder's, not now.
  const placeholder = getUnparsedTimestamp(id, chat);
  const fallback = placeholder ? new Date(placeholder) : undefined;
  return ingestMessage(
    msg,
    fallback && Number.isFinite(fallback.getTime()) ? fallback : undefined,
  );
}

/**
 * Record the sender's display name from a live or history message. WhatsApp now
 * addresses many chats by a privacy-preserving LID (`…@lid`) while the address
 * book is keyed by the phone JID, so name resolution missed them. Baileys carries
 * both `pushName` and the paired phone JID (`key.remoteJidAlt` for 1:1s,
 * `key.participantAlt` for group members) on every message — feed both into the
 * contacts table so LID chats/senders resolve to a real name.
 */
function storeSenderIdentity(msg: WAMessage): void {
  const key = msg.key;
  if (!key?.remoteJid || key.fromMe) return;
  const pushName = msg.pushName ?? null;

  if (isJidGroup(key.remoteJid)) {
    // Group: name the participant (the group's own name comes from chat sync).
    if (key.participant) {
      upsertMessageContact({
        jid: jidNormalizedUser(key.participant),
        pushName,
        phoneJid: key.participantAlt ?? null,
      });
    }
  } else {
    // 1:1: name the chat/sender itself (the JID is frequently a LID).
    upsertMessageContact({
      jid: key.remoteJid,
      pushName,
      phoneJid: key.remoteJidAlt ?? null,
    });
  }
}

export async function startWhatsAppConnection(
  logger: P.Logger,
  connection: WhatsAppConnection = { socket: null }
): Promise<WhatsAppConnection> {
  initializeDatabase();

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version, isLatest } = await fetchLatestBaileysVersion();
  logger.info(`Using WA v${version.join(".")}, isLatest: ${isLatest}`);

  const sock = makeWASocket({
    version,
    logger,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    generateHighQualityLinkPreview: true,
    // Groups are included by default; set WHATSAPP_IGNORE_GROUPS=1 to drop them.
    ...(IGNORE_GROUPS
      ? { shouldIgnoreJid: (jid: string) => isJidGroup(jid) }
      : {}),
  });
  connection.socket = sock;

  sock.ev.process(async (events) => {
    if (events["connection.update"]) {
      const update = events["connection.update"];
      const { connection: connState, lastDisconnect, qr } = update;

      if (qr) {
        logger.info({ qrCodeData: qr }, "QR code received; awaiting scan.");
        // Render locally to stderr (never stdout — that carries the MCP
        // protocol). Visible both when run standalone for auth and in the
        // Claude Code MCP server log. No third-party services involved.
        qrcode.generate(qr, { small: true }, (art) => {
          // Baileys refreshes the QR every ~20s. Clear the screen + scrollback
          // on each refresh so only the CURRENT code is ever visible — scanning
          // a stale one is the usual cause of "couldn't link device". Clear only
          // on a real terminal; under the MCP stdio server stderr is a log file.
          const clear = process.stderr.isTTY ? "\x1b[2J\x1b[3J\x1b[H" : "\n";
          process.stderr.write(
            `${clear}[whatsapp-mcp] ⟳ NEW QR — scan within ~20s ` +
              `(WhatsApp → Settings → Linked Devices → Link a device):\n\n${art}\n`
          );
        });
      }

      if (connState === "close") {
        const statusCode = (lastDisconnect?.error as any)?.output?.statusCode;
        logger.warn(
          { err: lastDisconnect?.error },
          `Connection closed. Reason: ${
            DisconnectReason[statusCode as number] || "Unknown"
          }`
        );
        if (statusCode !== DisconnectReason.loggedOut) {
          logger.info("Reconnecting...");
          // Reuse the same holder so callers see the new socket in place.
          startWhatsAppConnection(logger, connection);
        } else {
          logger.error(
            "Connection closed: Logged Out. Please delete auth_info and restart."
          );
          process.exit(1);
        }
      } else if (connState === "open") {
        logger.info(`Connection opened. WA user: ${sock.user?.name}`);
      }
    }

    if (events["creds.update"]) {
      await saveCreds();
      logger.info("Credentials saved.");
    }

    if (events["messaging-history.set"]) {
      const { chats, contacts, messages, isLatest, progress, syncType } =
        events["messaging-history.set"];
      if (contacts.length > 0) {
        logger.info(`Storing ${contacts.length} contacts from history sync.`);
        contacts.forEach((c) =>
          storeContact({
            jid: c.id,
            name: c.name ?? null,
            notify: c.notify ?? null,
            phoneNumber: (c as any).phoneNumber ?? null,
          })
        );
        logger.info(`Stored ${contacts.length} contacts from history sync.`);
      }

      logger.info(`Storing ${chats.length} chats from history sync.`);
      chats.forEach((chat) =>
        storeChat({
          jid: chat.id!,
          name: chat.name,
          last_message_time: chat.conversationTimestamp
            ? new Date(Number(chat.conversationTimestamp) * 1000)
            : undefined,
        })
      );

      let storedCount = 0;
      let unparsedCount = 0;
      let ignoredCount = 0;
      let erroredCount = 0;
      messages.forEach((msg) => {
        // One bad message must not abort the sync. `sock.ev.process` has no
        // handler above this, so a throw here would take the connection down.
        try {
          const outcome = ingestMessage(msg);
          if (outcome.kind === "stored") storedCount++;
          if (outcome.kind === "unparsed") unparsedCount++;
          if (outcome.kind === "ignored") ignoredCount++;
        } catch (err) {
          erroredCount++;
          logger.error(
            { err, msgId: msg.key?.id, chatId: msg.key?.remoteJid },
            "Ingest threw on a history-sync message"
          );
        }
      });
      logger.info(
        { storedCount, unparsedCount, ignoredCount, erroredCount },
        `Stored ${storedCount} messages from history sync` +
          (unparsedCount
            ? `; ${unparsedCount} could not be parsed and were kept in unparsed_messages.`
            : ".")
      );
    }

    if (events["messages.upsert"]) {
      const { messages, type } = events["messages.upsert"];
      logger.info(
        { type, count: messages.length },
        "Received messages.upsert event"
      );

      if (type === "notify" || type === "append") {
        for (const msg of messages) {
          let outcome: MessageOutcome;
          try {
            outcome = ingestMessage(msg);
          } catch (err) {
            // Never let one message kill the connection: sock.ev.process has no
            // handler above this and there is no unhandledRejection guard.
            logger.error(
              { err, msgId: msg.key?.id, chatId: msg.key?.remoteJid },
              "Ingest threw — message NOT stored"
            );
            continue;
          }
          switch (outcome.kind) {
            case "stored":
              logger.info(
                { msgId: msg.key?.id, chatId: msg.key?.remoteJid },
                "Stored message"
              );
              break;
            case "unparsed":
              // Loud on purpose. The old code logged this and threw the message
              // away; now the row exists in unparsed_messages and the read
              // tools surface it, so a caller asking "did the client send the
              // attachment?" gets an answer instead of silence.
              logger.error(
                {
                  msgId: outcome.record.id,
                  chatId: outcome.record.chat_jid,
                  reason: outcome.record.reason,
                  messageKeys: outcome.record.message_keys,
                  stubType: outcome.record.stub_type,
                  hasRawPayload: outcome.record.raw_payload != null,
                },
                "Could not parse message — kept in unparsed_messages for reprocessing"
              );
              break;
            case "edit":
              logger.info(
                { msgId: msg.key?.id, chatId: msg.key?.remoteJid, applied: outcome.applied },
                outcome.applied
                  ? "Applied message edit"
                  : "Message edit for a message we never stored"
              );
              break;
            case "ignored": {
              // Known plumbing (`protocol:*`, a named `stub:<n>`) is noise and
              // stays at debug. Anything else is an outcome nobody predicted,
              // and at the default LOG_LEVEL=info debug is not written at all —
              // so it would be exactly as invisible as the bug we are fixing.
              const routine =
                outcome.reason.startsWith("protocol:") ||
                /^stub:\d+$/.test(outcome.reason) ||
                outcome.reason === "update:no-content";
              const log = routine ? logger.debug : logger.error;
              log.call(
                logger,
                { msgId: msg.key?.id, chatId: msg.key?.remoteJid, reason: outcome.reason },
                routine
                  ? "Ignored non-message event"
                  : "Message neither stored nor recorded"
              );
              break;
            }
          }
        }
      }
    }

    if (events["messages.update"]) {
      // A message can arrive twice: once as an undecryptable CIPHERTEXT stub
      // and again, through this event, once the retry decrypts. Without this
      // handler the second half never lands and the placeholder is all we ever
      // have. (Verified path: the stub. The retry itself is Baileys' documented
      // behaviour, not something observed in this account's logs.)
      for (const { key, update } of events["messages.update"]) {
        if (!update?.message || !key?.id || !key?.remoteJid) continue;
        // `key` LAST: Baileys puts a `key` inside `update` on some emissions,
        // and the event-level key is the authoritative one — letting the inner
        // one win would write the patch to the wrong row.
        try {
          const outcome = handleMessageUpdate({ ...update, key } as WAMessage);
          logger.info(
            { msgId: key.id, chatId: key.remoteJid, outcome: outcome.kind },
            "Processed messages.update"
          );
        } catch (err) {
          logger.error(
            { err, msgId: key.id, chatId: key.remoteJid },
            "messages.update threw"
          );
        }
      }
    }

    if (events["chats.update"]) {
      logger.info(
        { count: events["chats.update"].length },
        "Received chats.update event"
      );
      for (const chatUpdate of events["chats.update"]) {
        storeChat({
          jid: chatUpdate.id!,
          name: chatUpdate.name,
          last_message_time: chatUpdate.conversationTimestamp
            ? new Date(Number(chatUpdate.conversationTimestamp) * 1000)
            : undefined,
        });
      }
    }
  });

  return connection;
}

/** What a quoted reply points at. Baileys wants the original WAMessage to
 *  build the context info; a stub with the key and the text is enough for a
 *  text message, and it is all the store keeps. */
export interface QuotedRef {
  id: string;
  sender?: string | null;
  from_me?: boolean;
  text?: string | null;
}

export async function sendWhatsAppMessage(
  logger: P.Logger,
  sock: WhatsAppSocket | null,
  recipientJid: string,
  text: string,
  quoted?: QuotedRef | null
): Promise<WAMessage | undefined> {
  if (!sock || !sock.user) {
    logger.error(
      "Cannot send message: WhatsApp socket not connected or initialized."
    );
    return;
  }
  if (!recipientJid) {
    logger.error("Cannot send message: Recipient JID is missing.");
    return;
  }
  if (!text) {
    logger.error("Cannot send message: Message text is empty.");
    return;
  }

  try {
    logger.info(
      `Sending message to ${recipientJid}: ${text.substring(0, 50)}...`
    );
    const normalizedJid = jidNormalizedUser(recipientJid);
    const opts = quoted?.id
      ? {
          quoted: {
            key: {
              remoteJid: normalizedJid,
              id: quoted.id,
              fromMe: !!quoted.from_me,
              ...(normalizedJid.endsWith("@g.us") && quoted.sender ? { participant: quoted.sender } : {}),
            },
            message: { conversation: quoted.text || "" },
          } as WAMessage,
        }
      : undefined;
    const result = await sock.sendMessage(normalizedJid, { text: text }, opts);
    logger.info({ msgId: result?.key.id }, "Message sent successfully");
    return result;
  } catch (error) {
    logger.error({ err: error, recipientJid }, "Failed to send message");
    return;
  }
}

/** Map a file extension to a mimetype so WhatsApp shows the right kind/preview.
 *  Unknown extensions fall back to a generic binary, sent as a document. */
const MIME_BY_EXT: Record<string, string> = {
  // images
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
  // audio
  ogg: "audio/ogg",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  aac: "audio/aac",
  amr: "audio/amr",
  wav: "audio/wav",
  // video
  mp4: "video/mp4",
  "3gp": "video/3gpp",
  mov: "video/quicktime",
  // documents
  pdf: "application/pdf",
  zip: "application/zip",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  txt: "text/plain",
  csv: "text/csv",
};

export interface SendFileOptions {
  /** Optional caption — applied to image, video, and document sends. */
  caption?: string;
  /** Display filename for document sends (defaults to the file's basename). */
  fileName?: string;
  /** Force a document/attachment send even for image/audio/video types. */
  asDocument?: boolean;
  /** Send audio as a voice note (push-to-talk bubble) instead of an audio file. */
  ptt?: boolean;
}

/**
 * Send a local file. The mimetype is derived from the extension and decides how
 * WhatsApp renders it — image/video/audio inline, everything else (PDF, zip,
 * office docs, …) as a document attachment. Reads the bytes from disk and hands
 * the right Baileys content shape to `sock.sendMessage`.
 */
export async function sendWhatsAppFile(
  logger: P.Logger,
  sock: WhatsAppSocket | null,
  recipientJid: string,
  filePath: string,
  opts: SendFileOptions = {}
): Promise<WAMessage | undefined> {
  if (!sock || !sock.user) {
    logger.error(
      "Cannot send file: WhatsApp socket not connected or initialized."
    );
    return;
  }
  if (!recipientJid) {
    logger.error("Cannot send file: Recipient JID is missing.");
    return;
  }
  if (!filePath || !fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }

  const buffer = fs.readFileSync(filePath);
  const baseName = path.basename(filePath);
  const ext = path.extname(filePath).slice(1).toLowerCase();
  const mimetype = MIME_BY_EXT[ext] ?? "application/octet-stream";
  const { caption, fileName, asDocument, ptt } = opts;

  let content: Parameters<WhatsAppSocket["sendMessage"]>[1];
  if (!asDocument && mimetype.startsWith("image/")) {
    content = { image: buffer, mimetype, ...(caption ? { caption } : {}) };
  } else if (!asDocument && mimetype.startsWith("video/")) {
    content = { video: buffer, mimetype, ...(caption ? { caption } : {}) };
  } else if (!asDocument && mimetype.startsWith("audio/")) {
    content = { audio: buffer, mimetype, ptt: !!ptt };
  } else {
    content = {
      document: buffer,
      mimetype,
      fileName: fileName ?? baseName,
      ...(caption ? { caption } : {}),
    };
  }

  try {
    logger.info(
      `Sending file to ${recipientJid}: ${baseName} (${mimetype}, ${buffer.length} bytes)`
    );
    const normalizedJid = jidNormalizedUser(recipientJid);
    const result = await sock.sendMessage(normalizedJid, content);
    logger.info({ msgId: result?.key.id }, "File sent successfully");
    return result;
  } catch (error) {
    logger.error({ err: error, recipientJid, filePath }, "Failed to send file");
    throw error;
  }
}
