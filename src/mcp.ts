import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  jidNormalizedUser,
  proto,
  getContentType,
  downloadMediaMessage,
} from "baileys";
import fs from "node:fs";
import path from "node:path";

import {
  type Message as DbMessage,
  type Chat as DbChat,
  getMessages,
  getRecentMessages,
  getChats,
  getChat,
  getMessagesAround,
  getMessageMedia,
  getMessageRow,
  searchDbForContacts,
  searchMessages,
  getUnparsedMessages,
  countUnparsedMessages,
  type UnparsedMessage,
} from "./database.ts";

import {
  sendWhatsAppMessage,
  sendWhatsAppFile,
  type QuotedRef,
  type WhatsAppConnection,
  type WhatsAppSocket,
} from "./whatsapp.ts";
import { SEND_ALLOWLIST, DATA_DIR } from "./config.ts";
import { getTranscription, storeTranscription } from "./database.ts";
import { transcribeFile } from "./transcribe.ts";
import type P from "pino";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

/** Best-effort file extension from a media mimetype (e.g. "audio/ogg; codecs=opus" → "ogg"). */
function extFromMime(mime: string): string {
  const base = mime.split(";")[0].trim().toLowerCase();
  const map: Record<string, string> = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/gif": "gif",
    "audio/ogg": "ogg",
    "audio/mpeg": "mp3",
    "audio/mp4": "m4a",
    "audio/aac": "aac",
    "audio/amr": "amr",
    "video/mp4": "mp4",
    "video/3gpp": "3gp",
    "application/pdf": "pdf",
    "application/zip": "zip",
  };
  if (map[base]) return map[base];
  const sub = base.split("/")[1] || "bin";
  return sub.replace(/[^a-z0-9]/gi, "") || "bin";
}

/** Make a WhatsApp message id safe to use as a filename. */
function sanitizeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function formatDbMessageForJson(msg: DbMessage) {
  return {
    id: msg.id,
    chat_jid: msg.chat_jid,
    chat_name: msg.chat_name ?? "Unknown Chat",
    sender_jid: msg.sender ?? null,
    sender_name: msg.sender_name ?? null,
    // Prefer the resolved contact name; fall back to the JID prefix (an opaque
    // LID number for privacy-addressed senders) only when we have no name.
    sender_display: msg.is_from_me
      ? "Me"
      : msg.sender_name ?? (msg.sender ? msg.sender.split("@")[0] : "Unknown"),
    content: msg.content,
    timestamp: msg.timestamp.toISOString(),
    is_from_me: msg.is_from_me,
  };
}

function formatDbChatForJson(chat: DbChat) {
  return {
    jid: chat.jid,
    name: chat.name ?? chat.jid.split("@")[0] ?? "Unknown Chat",
    is_group: chat.jid.endsWith("@g.us"),
    last_message_time: chat.last_message_time?.toISOString() ?? null,
    last_message_preview: chat.last_message ?? null,
    last_sender_jid: chat.last_sender ?? null,
    last_sender_name: chat.last_sender_name ?? null,
    last_sender_display: chat.last_is_from_me
      ? "Me"
      : chat.last_sender_name ??
        (chat.last_sender ? chat.last_sender.split("@")[0] : null),
    last_is_from_me: chat.last_is_from_me ?? null,
  };
}

/**
 * Normalize a recipient JID and enforce the optional send allowlist. Shared by
 * send_message and send_file so the guard against messaging the wrong person
 * (LLM mistake / prompt injection) lives in exactly one place. Returns the
 * normalized JID, or a user-facing error string to return verbatim.
 */
function resolveRecipient(
  recipient: string,
  mcpLogger: P.Logger,
): { jid: string } | { error: string } {
  let jid: string;
  try {
    jid = jidNormalizedUser(recipient);
    if (!jid.includes("@")) throw new Error('JID must contain "@" symbol');
  } catch (err: any) {
    mcpLogger.error(
      `[MCP Tool Error] Invalid recipient JID format: ${recipient}. Error: ${err.message}`,
    );
    return {
      error: `Invalid recipient format: "${recipient}". Please provide a valid JID (e.g., number@s.whatsapp.net or group@g.us).`,
    };
  }
  if (
    SEND_ALLOWLIST.length > 0 &&
    !SEND_ALLOWLIST.some((allowed) => jid.includes(allowed))
  ) {
    mcpLogger.warn(`[MCP Tool] send blocked by allowlist: ${jid}`);
    return {
      error: `Refusing to send: "${jid}" is not in WHATSAPP_SEND_ALLOWLIST.`,
    };
  }
  return { jid };
}

// --- Socket-bound tool implementations ----------------------------------------
// These three tools need the live Baileys socket. They're factored out so they
// can run in two places: locally (the owner, against its own socket) and as the
// RPC dispatch the owner serves to followers. Followers never run them — they
// forward to the owner (see ToolOps / createLocalOps and src/control.ts).

async function doGetMedia(
  sock: WhatsAppSocket | null,
  { message_id, chat_jid }: { message_id: string; chat_jid?: string },
  mcpLogger: P.Logger,
  waLogger: P.Logger,
): Promise<CallToolResult> {
  mcpLogger.info(
    `[MCP Tool] Executing get_media for msg ${message_id}${
      chat_jid ? ` in ${chat_jid}` : ""
    }`,
  );
  if (!sock) {
    return {
      isError: true,
      content: [
        { type: "text", text: "Error: WhatsApp connection is not active." },
      ],
    };
  }
  try {
    const row = getMessageMedia(message_id, chat_jid ?? null);
    if (!row) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text:
              `Message ${message_id} not found${
                chat_jid ? ` in ${chat_jid}` : ""
              }. Note: only media received after the media upgrade is downloadable.` +
              (countUnparsedMessages({ chatJid: chat_jid ?? null })
                ? ` This chat has messages the bridge could not parse — check list_unparsed_messages before concluding it was never sent.`
                : ""),
          },
        ],
      };
    }
    if (!row.media_meta) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `Message ${message_id} has no downloadable media (it's a text message, an unsupported type, or it predates the media upgrade).`,
          },
        ],
      };
    }

    // Rebuild the minimal WAMessage Baileys needs: the protobuf content
    // (mediaKey + CDN path) plus the key (used only for the phone re-upload
    // fallback when the CDN copy has expired).
    const innerMessage = proto.Message.decode(
      Buffer.from(row.media_meta, "base64"),
    );
    const isGroup = row.chat_jid.endsWith("@g.us");
    const waMessage = {
      key: {
        remoteJid: row.chat_jid,
        id: row.id,
        fromMe: row.is_from_me,
        ...(isGroup && row.sender ? { participant: row.sender } : {}),
      },
      message: innerMessage,
    } as Parameters<typeof downloadMediaMessage>[0];

    const mediaType = getContentType(innerMessage);
    const inner =
      (innerMessage as Record<string, any>)[mediaType as string] ?? {};
    const mimetype: string = inner.mimetype || "application/octet-stream";

    let buffer: Buffer;
    try {
      buffer = (await downloadMediaMessage(
        waMessage,
        "buffer",
        {},
        {
          reuploadRequest: sock.updateMediaMessage,
          logger: waLogger,
        },
      )) as Buffer;
    } catch (dlErr: any) {
      mcpLogger.error(
        `[MCP Tool Error] get_media download failed for ${message_id}: ${dlErr.message}`,
      );
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `Could not download media for ${message_id}: ${dlErr.message}. The CDN copy has likely expired and the phone couldn't re-upload it (phone offline, or the message was deleted on the phone).`,
          },
        ],
      };
    }

    const sizeKb = (buffer.length / 1024).toFixed(1);

    // Images come back inline so they can actually be viewed. Everything else
    // (audio/video/document/sticker) is written to the per-account media/ dir on
    // demand and a path is returned — inline base64 of large binaries is
    // impractical and Claude can't consume them directly.
    if (mimetype.startsWith("image/")) {
      return {
        content: [
          {
            type: "text",
            text: `Image from message ${message_id} (${mimetype}, ${sizeKb} KB).`,
          },
          {
            type: "image",
            data: buffer.toString("base64"),
            mimeType: mimetype,
          },
        ],
      };
    }

    const ext = extFromMime(mimetype);
    const mediaDir = path.join(DATA_DIR, "media");
    fs.mkdirSync(mediaDir, { recursive: true });
    const savedPath = path.join(mediaDir, `${sanitizeId(message_id)}.${ext}`);
    fs.writeFileSync(savedPath, buffer);

    const kind = mediaType ? mediaType.replace("Message", "") : "media";
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              message_id,
              kind,
              mimetype,
              size_bytes: buffer.length,
              file_name: inner.fileName ?? null,
              saved_path: savedPath,
              note: "Downloaded on demand and saved to disk (media is never auto-downloaded on receive).",
            },
            null,
            2,
          ),
        },
      ],
    };
  } catch (error: any) {
    mcpLogger.error(
      `[MCP Tool Error] get_media failed for ${message_id}: ${error.message}`,
    );
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: `Error retrieving media for ${message_id}: ${error.message}`,
        },
      ],
    };
  }
}

// --- Socket-bound tools for a human-facing WhatsApp client ------------------
// Such a client reads the store directly but everything that touches the live
// connection must go through the single owner socket, so these are served
// over the control socket like send_message. None of them send a message on
// anyone's behalf; the one that comes closest (react) needs a human click.

/**
 * Messages the bridge received but could not turn into a row. These used to be
 * dropped with a warning nobody read, which made "we failed to parse it"
 * indistinguishable from "the client never sent anything" — that is how a
 * delivered attachment became a wrongful charge. Every read tool that returns a
 * window of messages now reports the unparsed ones falling in the same window,
 * so the gap is visible without opening a log file.
 */
function formatUnparsedForJson(u: UnparsedMessage & { sender_name?: string | null }) {
  return {
    id: u.id,
    chat_jid: u.chat_jid,
    timestamp: u.timestamp,
    is_from_me: u.is_from_me,
    sender: u.sender,
    sender_name: u.sender_name ?? null,
    reason: u.reason,
    message_keys: u.message_keys,
    stub_type: u.stub_type,
    reprocessable: u.raw_payload != null,
  };
}

/**
 * A leading content block warning that the result below has holes in it.
 * Returns null when there are none, so the common case is unchanged.
 *
 * The window is the one the tool ACTUALLY returned — bounded by the oldest and
 * newest row in the page, not by the caller's filters. Counting the whole chat
 * would warn about a gap in January on a page from June, and a warning that
 * cries wolf on every page is one nobody reads, which is how we got here.
 */
function unparsedNotice(q: {
  chatJid?: string | null;
  after?: string | null;
  before?: string | null;
}): { type: "text"; text: string } | null {
  const n = countUnparsedMessages(q);
  if (!n) return null;
  const scope = q.chatJid ? "in this chat" : "in this window";
  const window =
    q.after || q.before
      ? ` (between ${q.after ?? "-∞"} and ${q.before ?? "now"})`
      : "";
  return {
    type: "text",
    text:
      `⚠️ ${n} message${n === 1 ? "" : "s"} ${scope}${window} arrived but could NOT ` +
      `be parsed, so ${n === 1 ? "it is" : "they are"} missing from the results ` +
      `below. Do not read their absence as "nothing was sent" — call ` +
      `list_unparsed_messages with the same filters to see what they were.`,
  };
}

/** The span the returned rows actually cover, for scoping the notice to them. */
function spanOf(
  messages: { timestamp: Date }[],
): { after: string | null; before: string | null } {
  if (!messages.length) return { after: null, before: null };
  const times = messages.map((m) => m.timestamp.getTime());
  return {
    after: new Date(Math.min(...times)).toISOString(),
    before: new Date(Math.max(...times)).toISOString(),
  };
}

const ok = (data: unknown): CallToolResult => ({
  content: [{ type: "text", text: JSON.stringify(data) }],
});
const fail = (text: string): CallToolResult => ({
  isError: true,
  content: [{ type: "text", text }],
});

/** Mark messages as read (blue ticks), like opening the chat on the phone. */
async function doMarkRead(
  sock: WhatsAppSocket | null,
  {
    chat_jid,
    messages,
  }: { chat_jid: string; messages: Array<{ id: string; sender?: string | null; from_me?: boolean }> },
  mcpLogger: P.Logger,
): Promise<CallToolResult> {
  if (!sock) return fail("Error: WhatsApp connection is not active.");
  const r = resolveRecipient(chat_jid, mcpLogger);
  if ("error" in r) return fail(r.error);
  const isGroup = r.jid.endsWith("@g.us");
  const keys = (messages ?? []).map((m) => ({
    remoteJid: r.jid,
    id: m.id,
    fromMe: !!m.from_me,
    ...(isGroup && m.sender ? { participant: m.sender } : {}),
  }));
  if (!keys.length) return ok({ read: 0 });
  await sock.readMessages(keys);
  mcpLogger.info(`[MCP Tool] mark_read ${keys.length} in ${r.jid}`);
  return ok({ read: keys.length, chat_jid: r.jid });
}

/** Typing / recording indicator. `paused` clears it. */
async function doPresence(
  sock: WhatsAppSocket | null,
  { jid, state }: { jid: string; state: "composing" | "recording" | "paused" | "available" | "unavailable" },
  mcpLogger: P.Logger,
): Promise<CallToolResult> {
  if (!sock) return fail("Error: WhatsApp connection is not active.");
  const r = resolveRecipient(jid, mcpLogger);
  if ("error" in r) return fail(r.error);
  const allowed = ["composing", "recording", "paused", "available", "unavailable"];
  if (!allowed.includes(state)) return fail(`Invalid presence state: ${state}`);
  await sock.sendPresenceUpdate(state, r.jid);
  return ok({ jid: r.jid, state });
}

/** React to a message with one emoji (empty string removes the reaction). */
async function doReact(
  sock: WhatsAppSocket | null,
  {
    chat_jid,
    message_id,
    emoji,
    sender,
    from_me,
  }: { chat_jid: string; message_id: string; emoji: string; sender?: string | null; from_me?: boolean },
  mcpLogger: P.Logger,
): Promise<CallToolResult> {
  if (!sock) return fail("Error: WhatsApp connection is not active.");
  const r = resolveRecipient(chat_jid, mcpLogger);
  if ("error" in r) return fail(r.error);
  const isGroup = r.jid.endsWith("@g.us");
  const key = {
    remoteJid: r.jid,
    id: message_id,
    fromMe: !!from_me,
    ...(isGroup && sender ? { participant: sender } : {}),
  };
  const result = await sock.sendMessage(r.jid, { react: { text: emoji ?? "", key } });
  mcpLogger.info(`[MCP Tool] react ${JSON.stringify(emoji)} on ${message_id} in ${r.jid}`);
  return ok({ chat_jid: r.jid, message_id, emoji, reaction_id: result?.key.id ?? null });
}

/** Profile picture URL (WhatsApp CDN, short-lived) — null when none/hidden. */
async function doProfilePicture(
  sock: WhatsAppSocket | null,
  { jid, type }: { jid: string; type?: "preview" | "image" },
  mcpLogger: P.Logger,
): Promise<CallToolResult> {
  if (!sock) return fail("Error: WhatsApp connection is not active.");
  let target: string;
  try {
    target = jidNormalizedUser(jid);
  } catch {
    return fail(`Invalid JID: ${jid}`);
  }
  try {
    // Baileys waits indefinitely when the server never answers (privacy
    // settings, some LIDs); a hard ceiling keeps the socket RPC responsive.
    const url = await Promise.race([
      sock.profilePictureUrl(target, type === "preview" ? "preview" : "image", 8000),
      new Promise<undefined>((_, rej) => setTimeout(() => rej(new Error("profile picture timeout")), 10000)),
    ]);
    return ok({ jid: target, url: url ?? null });
  } catch (e: any) {
    // 404 / not-authorized are the normal "no picture visible" answers.
    mcpLogger.info(`[MCP Tool] profile_picture none for ${target}: ${e?.message ?? e}`);
    return ok({ jid: target, url: null });
  }
}

/**
 * Group subject + participant count. Baileys' chats.upsert does not always
 * carry the subject (a group created while this device was offline arrives
 * with none), so the store can hold a group that reads as a bare JID. This is
 * the only way to name it without waiting for someone to rename the group.
 */
async function doGroupInfo(
  sock: WhatsAppSocket | null,
  { jid }: { jid: string },
  mcpLogger: P.Logger,
): Promise<CallToolResult> {
  if (!sock) return fail("Error: WhatsApp connection is not active.");
  if (!jid.endsWith("@g.us")) return fail(`Not a group JID: ${jid}`);
  try {
    const md = await Promise.race([
      sock.groupMetadata(jid),
      new Promise<never>((_, rej) =>
        setTimeout(() => rej(new Error("groupMetadata timeout")), 15000),
      ),
    ]);
    return ok({
      jid,
      subject: md?.subject ?? null,
      owner: md?.owner ?? null,
      participants: md?.participants?.length ?? null,
      creation: md?.creation ?? null,
      desc: md?.desc ?? null,
    });
  } catch (e: any) {
    mcpLogger.info(`[MCP Tool] group_info failed for ${jid}: ${e?.message ?? e}`);
    return ok({ jid, subject: null, error: String(e?.message ?? e).slice(0, 200) });
  }
}

async function doSendMessage(
  sock: WhatsAppSocket | null,
  { recipient, message, quoted }: { recipient: string; message: string; quoted?: QuotedRef | null },
  mcpLogger: P.Logger,
  waLogger: P.Logger,
): Promise<CallToolResult> {
  mcpLogger.info(`[MCP Tool] Executing send_message to ${recipient}`);
  if (!sock) {
    mcpLogger.error(
      "[MCP Tool Error] send_message failed: WhatsApp socket is not available.",
    );
    return {
      isError: true,
      content: [
        { type: "text", text: "Error: WhatsApp connection is not active." },
      ],
    };
  }

  const resolved = resolveRecipient(recipient, mcpLogger);
  if ("error" in resolved) {
    return { isError: true, content: [{ type: "text", text: resolved.error }] };
  }
  const normalizedRecipient = resolved.jid;

  try {
    const result = await sendWhatsAppMessage(
      waLogger,
      sock,
      normalizedRecipient,
      message,
      quoted ?? null,
    );

    if (result && result.key && result.key.id) {
      return {
        content: [
          {
            type: "text",
            text: `Message sent successfully to ${normalizedRecipient} (ID: ${result.key.id}).`,
          },
        ],
      };
    } else {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `Failed to send message to ${normalizedRecipient}. See server logs for details.`,
          },
        ],
      };
    }
  } catch (error: any) {
    mcpLogger.error(
      `[MCP Tool Error] send_message failed for ${recipient}: ${error.message}`,
    );
    return {
      isError: true,
      content: [
        { type: "text", text: `Error sending message: ${error.message}` },
      ],
    };
  }
}

async function doSendFile(
  sock: WhatsAppSocket | null,
  {
    recipient,
    path: filePath,
    caption,
    filename,
    as_document,
    ptt,
  }: {
    recipient: string;
    path: string;
    caption?: string;
    filename?: string;
    as_document?: boolean;
    ptt?: boolean;
  },
  mcpLogger: P.Logger,
  waLogger: P.Logger,
): Promise<CallToolResult> {
  mcpLogger.info(`[MCP Tool] Executing send_file to ${recipient}: ${filePath}`);
  if (!sock) {
    mcpLogger.error(
      "[MCP Tool Error] send_file failed: WhatsApp socket is not available.",
    );
    return {
      isError: true,
      content: [
        { type: "text", text: "Error: WhatsApp connection is not active." },
      ],
    };
  }

  if (!fs.existsSync(filePath)) {
    return {
      isError: true,
      content: [{ type: "text", text: `File not found: ${filePath}` }],
    };
  }

  const resolved = resolveRecipient(recipient, mcpLogger);
  if ("error" in resolved) {
    return { isError: true, content: [{ type: "text", text: resolved.error }] };
  }

  try {
    const result = await sendWhatsAppFile(waLogger, sock, resolved.jid, filePath, {
      caption,
      fileName: filename,
      asDocument: as_document,
      ptt,
    });

    if (result && result.key && result.key.id) {
      return {
        content: [
          {
            type: "text",
            text: `File sent successfully to ${resolved.jid} (${path.basename(
              filePath,
            )}, ID: ${result.key.id}).`,
          },
        ],
      };
    }
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: `Failed to send file to ${resolved.jid}. See server logs for details.`,
        },
      ],
    };
  } catch (error: any) {
    mcpLogger.error(
      `[MCP Tool Error] send_file failed for ${recipient}: ${error.message}`,
    );
    return {
      isError: true,
      content: [{ type: "text", text: `Error sending file: ${error.message}` }],
    };
  }
}

/**
 * The socket-bound tools, keyed by name. The owner runs these directly; the
 * owner's RPC dispatch and a follower's proxy both route through these names.
 */
/**
 * Transcribe a voice note, caching the result.
 *
 * On demand, never automatic: a list_messages that silently ran Whisper over
 * every audio it returned would burn minutes of CPU nobody asked for. But the
 * audio is immutable, so once transcribed the answer is permanent — the cache
 * is what stops triage and each orchestrate session re-transcribing the same
 * clip. Measured on the Linux box: ~13.5s of CPU per short clip, per session,
 * before this existed.
 *
 * Runs owner-side (it is in SOCKET_TOOLS) so N followers forward here instead
 * of each spawning their own Whisper.
 */
async function doTranscribeMessage(
  sock: WhatsAppSocket | null,
  {
    message_id,
    chat_jid,
    language,
    force,
  }: {
    message_id: string;
    chat_jid?: string;
    language?: string;
    force?: boolean;
  },
  mcpLogger: P.Logger,
  waLogger: P.Logger,
): Promise<CallToolResult> {
  if (!force) {
    const hit = getTranscription(message_id, chat_jid ?? null);
    if (hit) {
      mcpLogger.info(`[MCP Tool] transcribe_message cache HIT for ${message_id}`);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              { message_id, cached: true, ...hit },
              null,
              2,
            ),
          },
        ],
      };
    }
  }

  mcpLogger.info(
    `[MCP Tool] transcribe_message cache MISS for ${message_id} — downloading + transcribing`,
  );

  // Reuse get_media rather than re-implementing the download: it already
  // handles the CDN copy expiring and asking the phone to re-upload.
  const dl = await doGetMedia(sock, { message_id, chat_jid }, mcpLogger, waLogger);
  if (dl.isError) return dl;

  let savedPath: string | undefined;
  let mimetype = "";
  for (const c of dl.content as any[]) {
    if (c.type !== "text") continue;
    try {
      const j = JSON.parse(c.text);
      savedPath = j.saved_path;
      mimetype = j.mimetype ?? "";
    } catch {
      /* not the JSON block */
    }
  }
  if (!savedPath) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: `Message ${message_id} has no downloadable audio file (images come back inline and are not transcribable).`,
        },
      ],
    };
  }
  if (mimetype && !mimetype.startsWith("audio/") && !mimetype.startsWith("video/")) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: `Message ${message_id} is ${mimetype}, not audio — nothing to transcribe.`,
        },
      ],
    };
  }

  try {
    const r = await transcribeFile(savedPath, { language: language ?? null });
    storeTranscription({
      message_id,
      chat_jid: chat_jid ?? "",
      text: r.text,
      engine: r.engine,
      model: r.model,
      language: r.language,
      duration_ms: r.durationMs,
    });
    mcpLogger.info(
      `[MCP Tool] transcribe_message stored ${r.text.length} chars for ${message_id} via ${r.engine} in ${r.durationMs}ms`,
    );
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              message_id,
              cached: false,
              text: r.text,
              engine: r.engine,
              model: r.model,
              language: r.language,
              took_ms: r.durationMs,
            },
            null,
            2,
          ),
        },
      ],
    };
  } catch (e: any) {
    mcpLogger.error(`[MCP Tool Error] transcribe_message failed for ${message_id}: ${e.message}`);
    return {
      isError: true,
      content: [{ type: "text", text: `Transcription failed: ${e.message}` }],
    };
  }
}

const SOCKET_TOOLS: Record<
  string,
  (
    sock: WhatsAppSocket | null,
    params: any,
    mcpLogger: P.Logger,
    waLogger: P.Logger,
  ) => Promise<CallToolResult>
> = {
  get_media: doGetMedia,
  transcribe_message: doTranscribeMessage,
  send_message: doSendMessage,
  send_file: doSendFile,
  mark_read: doMarkRead,
  presence: doPresence,
  react: doReact,
  profile_picture: doProfilePicture,
  group_info: doGroupInfo,
};

/** Abstraction the MCP tools use to run a socket-bound call — either locally
 *  (owner) or by forwarding to the owner (follower). */
export interface ToolOps {
  invoke(method: string, params: any): Promise<CallToolResult>;
}

/** Owner-side ops: run the socket tools against the live connection. The same
 *  function doubles as the RPC dispatch served to followers (see main.ts). */
export function createLocalOps(
  connection: WhatsAppConnection,
  mcpLogger: P.Logger,
  waLogger: P.Logger,
): ToolOps {
  return {
    invoke: (method, params) => {
      const impl = SOCKET_TOOLS[method];
      if (!impl) {
        return Promise.reject(new Error(`Unknown socket tool: ${method}`));
      }
      return impl(connection.socket, params, mcpLogger, waLogger);
    },
  };
}

export async function startMcpServer(
  ops: ToolOps,
  mcpLogger: P.Logger,
  waLogger: P.Logger,
): Promise<void> {
  mcpLogger.info("Initializing MCP server...");

  const server = new McpServer({
    name: "whatsapp-baileys-ts",
    version: "0.1.0",
  });

  server.tool(
    "search_contacts",
    {
      query: z
        .string()
        .min(1)
        .describe("Search term for contact name or phone number part of JID"),
    },
    async ({ query }) => {
      mcpLogger.info(
        `[MCP Tool] Executing search_contacts with query: "${query}"`,
      );
      try {
        const contacts = searchDbForContacts(query, 20);
        const formattedContacts = contacts.map((c) => ({
          jid: c.jid,
          name: c.name ?? c.jid.split("@")[0],
        }));
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(formattedContacts, null, 2),
            },
          ],
        };
      } catch (error: any) {
        mcpLogger.error(
          `[MCP Tool Error] search_contacts failed: ${error.message}`,
        );
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Error searching contacts: ${error.message}`,
            },
          ],
        };
      }
    },
  );

  server.tool(
    "list_messages",
    {
      chat_jid: z
        .string()
        .describe(
          "The JID of the chat (e.g., '123456@s.whatsapp.net' or 'group@g.us')",
        ),
      limit: z
        .number()
        .int()
        .positive()
        .optional()
        .default(20)
        .describe("Max messages per page (default 20)"),
      page: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .default(0)
        .describe("Page number (0-indexed, default 0)"),
    },
    async ({ chat_jid, limit, page }) => {
      mcpLogger.info(
        `[MCP Tool] Executing list_messages for chat ${chat_jid}, limit=${limit}, page=${page}`,
      );
      try {
        const messages = getMessages(chat_jid, limit, page);
        if (!messages.length && page === 0) {
          const emptyNotice = unparsedNotice({ chatJid: chat_jid });
          return {
            content: [
              ...(emptyNotice ? [emptyNotice] : []),
              { type: "text", text: `No messages found for chat ${chat_jid}.` },
            ],
          };
        } else if (!messages.length) {
          return {
            content: [
              {
                type: "text",
                text: `No more messages found on page ${page} for chat ${chat_jid}.`,
              },
            ],
          };
        }
        const formattedMessages = messages.map(formatDbMessageForJson);
        const notice = unparsedNotice({
          chatJid: chat_jid,
          after: spanOf(messages).after,
          // Page 0 is "the most recent", so its window has no upper bound —
          // otherwise a message dropped AFTER the newest one we can read falls
          // outside the span and goes unmentioned, which is the worst case of
          // all: the gap is at the end of the conversation, where the answer is.
          before: page === 0 ? null : spanOf(messages).before,
        });
        return {
          content: [
            ...(notice ? [notice] : []),
            {
              type: "text",
              text: JSON.stringify(formattedMessages, null, 2),
            },
          ],
        };
      } catch (error: any) {
        mcpLogger.error(
          `[MCP Tool Error] list_messages failed for ${chat_jid}: ${error.message}`,
        );
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Error listing messages for ${chat_jid}: ${error.message}`,
            },
          ],
        };
      }
    },
  );

  server.tool(
    "list_recent_messages",
    {
      after: z
        .string()
        .optional()
        .describe(
          "Only messages at/after this time. ISO 8601 (e.g. '2026-06-22T00:00:00Z'); a bare date 'YYYY-MM-DD' is treated as 00:00:00 that day. Times are UTC.",
        ),
      before: z
        .string()
        .optional()
        .describe(
          "Only messages at/before this time. ISO 8601; a bare date 'YYYY-MM-DD' is treated as 23:59:59 that day. Times are UTC.",
        ),
      limit: z
        .number()
        .int()
        .positive()
        .optional()
        .default(50)
        .describe("Max messages to return, newest first (default 50)."),
      from_me: z
        .boolean()
        .optional()
        .describe(
          "Filter by direction: true = only your messages, false = only incoming. Omit for both.",
        ),
      include_groups: z
        .boolean()
        .optional()
        .default(true)
        .describe("Include group chats (default true). Set false for 1:1 chats only."),
    },
    async ({ after, before, limit, from_me, include_groups }) => {
      // A bare date means "the whole day" — expand to day bounds so `before`
      // is inclusive of messages later that day (an ISO timestamp sorts after
      // the bare date string, so an un-expanded `before:2026-06-29` would drop
      // everything on the 29th).
      const dateOnly = /^\d{4}-\d{2}-\d{2}$/;
      const afterIso = after
        ? dateOnly.test(after)
          ? `${after}T00:00:00.000Z`
          : after
        : null;
      const beforeIso = before
        ? dateOnly.test(before)
          ? `${before}T23:59:59.999Z`
          : before
        : null;
      mcpLogger.info(
        `[MCP Tool] Executing list_recent_messages: after=${afterIso}, before=${beforeIso}, limit=${limit}, from_me=${from_me}, include_groups=${include_groups}`,
      );
      try {
        const messages = getRecentMessages({
          after: afterIso,
          before: beforeIso,
          limit,
          fromMe: from_me ?? null,
          includeGroups: include_groups,
        });
        if (!messages.length) {
          const emptyNotice = unparsedNotice({
            after: afterIso,
            before: beforeIso,
          });
          return {
            content: [
              ...(emptyNotice ? [emptyNotice] : []),
              {
                type: "text",
                text: `No messages found${
                  afterIso || beforeIso
                    ? ` in range [${afterIso ?? "-∞"}, ${beforeIso ?? "now"}]`
                    : ""
                }. Note: results reflect what has synced locally, not a live query.`,
              },
            ],
          };
        }
        const formattedMessages = messages.map(formatDbMessageForJson);
        const span = spanOf(messages);
        const notice = unparsedNotice({
          after: afterIso ?? span.after,
          // No explicit `before` means "up to now" — leave it open for the same
          // reason as list_messages page 0.
          before: beforeIso,
        });
        return {
          content: [
            ...(notice ? [notice] : []),
            {
              type: "text",
              text: JSON.stringify(formattedMessages, null, 2),
            },
          ],
        };
      } catch (error: any) {
        mcpLogger.error(
          `[MCP Tool Error] list_recent_messages failed: ${error.message}`,
        );
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Error listing recent messages: ${error.message}`,
            },
          ],
        };
      }
    },
  );

  server.tool(
    "list_chats",
    {
      limit: z
        .number()
        .int()
        .positive()
        .optional()
        .default(20)
        .describe("Max chats per page (default 20)"),
      page: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .default(0)
        .describe("Page number (0-indexed, default 0)"),
      sort_by: z
        .enum(["last_active", "name"])
        .optional()
        .default("last_active")
        .describe("Sort order: 'last_active' (default) or 'name'"),
      query: z
        .string()
        .optional()
        .describe("Optional filter by chat name or JID"),
      include_last_message: z
        .boolean()
        .optional()
        .default(true)
        .describe("Include last message details (default true)"),
    },
    async ({ limit, page, sort_by, query, include_last_message }) => {
      mcpLogger.info(
        `[MCP Tool] Executing list_chats: limit=${limit}, page=${page}, sort=${sort_by}, query=${query}, lastMsg=${include_last_message}`,
      );
      try {
        const chats = getChats(
          limit,
          page,
          sort_by,
          query ?? null,
          include_last_message,
        );
        if (!chats.length && page === 0) {
          return {
            content: [
              {
                type: "text",
                text: `No chats found${query ? ` matching "${query}"` : ""}.`,
              },
            ],
          };
        } else if (!chats.length) {
          return {
            content: [
              {
                type: "text",
                text: `No more chats found on page ${page}${
                  query ? ` matching "${query}"` : ""
                }.`,
              },
            ],
          };
        }
        const formattedChats = chats.map(formatDbChatForJson);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(formattedChats, null, 2),
            },
          ],
        };
      } catch (error: any) {
        mcpLogger.error(`[MCP Tool Error] list_chats failed: ${error.message}`);
        return {
          isError: true,
          content: [
            { type: "text", text: `Error listing chats: ${error.message}` },
          ],
        };
      }
    },
  );

  server.tool(
    "get_chat",
    {
      chat_jid: z.string().describe("The JID of the chat to retrieve"),
      include_last_message: z
        .boolean()
        .optional()
        .default(true)
        .describe("Include last message details (default true)"),
    },
    async ({ chat_jid, include_last_message }) => {
      mcpLogger.info(
        `[MCP Tool] Executing get_chat for ${chat_jid}, lastMsg=${include_last_message}`,
      );
      try {
        const chat = getChat(chat_jid, include_last_message);
        if (!chat) {
          return {
            isError: true,
            content: [
              { type: "text", text: `Chat with JID ${chat_jid} not found.` },
            ],
          };
        }
        const formattedChat = formatDbChatForJson(chat);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(formattedChat, null, 2),
            },
          ],
        };
      } catch (error: any) {
        mcpLogger.error(
          `[MCP Tool Error] get_chat failed for ${chat_jid}: ${error.message}`,
        );
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Error retrieving chat ${chat_jid}: ${error.message}`,
            },
          ],
        };
      }
    },
  );

  server.tool(
    "get_message_context",
    {
      message_id: z
        .string()
        .describe("The ID of the target message to get context around"),
      before: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .default(5)
        .describe("Number of messages before (default 5)"),
      after: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .default(5)
        .describe("Number of messages after (default 5)"),
    },
    async ({ message_id, before, after }) => {
      mcpLogger.info(
        `[MCP Tool] Executing get_message_context for msg ${message_id}, before=${before}, after=${after}`,
      );
      try {
        const context = getMessagesAround(message_id, before, after);
        if (!context.target) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: `Message with ID ${message_id} not found.`,
              },
            ],
          };
        }
        const formattedContext = {
          target: formatDbMessageForJson(context.target),
          before: context.before.map(formatDbMessageForJson),
          after: context.after.map(formatDbMessageForJson),
        };
        const ctxNotice = unparsedNotice({
          chatJid: context.target.chat_jid,
          ...spanOf([...context.before, context.target, ...context.after]),
        });
        return {
          content: [
            ...(ctxNotice ? [ctxNotice] : []),
            {
              type: "text",
              text: JSON.stringify(formattedContext, null, 2),
            },
          ],
        };
      } catch (error: any) {
        mcpLogger.error(
          `[MCP Tool Error] get_message_context failed for ${message_id}: ${error.message}`,
        );
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Error retrieving context for message ${message_id}: ${error.message}`,
            },
          ],
        };
      }
    },
  );

  server.tool(
    "get_media",
    {
      message_id: z
        .string()
        .describe(
          "The ID of a message that carries media (image/audio/video/document/sticker). Get it from list_messages/search_messages — media messages show as [Image]/[Audio]/[Video]/[Document]/[Sticker].",
        ),
      chat_jid: z
        .string()
        .optional()
        .describe(
          "Optional chat JID to disambiguate the message id (recommended; ids are only unique within a chat).",
        ),
    },
    async ({ message_id, chat_jid }) =>
      ops.invoke("get_media", { message_id, chat_jid }),
  );

  server.tool(
    "transcribe_message",
    {
      message_id: z
        .string()
        .describe(
          "ID of an audio/voice message to transcribe. Get it from list_messages/search_messages — voice notes show as [Audio].",
        ),
      chat_jid: z
        .string()
        .optional()
        .describe(
          "Chat JID to disambiguate the message id (recommended; ids are only unique within a chat).",
        ),
      language: z
        .string()
        .optional()
        .describe("ISO code to force, e.g. 'pt' or 'en'. Omit to auto-detect."),
      force: z
        .boolean()
        .optional()
        .describe(
          "Re-transcribe even if a cached transcript exists. Only useful after changing model or language — the audio itself never changes.",
        ),
    },
    async ({ message_id, chat_jid, language, force }) =>
      ops.invoke("transcribe_message", {
        message_id,
        chat_jid,
        language,
        force,
      }),
  );

  server.tool(
    "send_message",
    {
      recipient: z
        .string()
        .describe(
          "Recipient JID (user or group, e.g., '12345@s.whatsapp.net' or 'group123@g.us')",
        ),
      message: z.string().min(1).describe("The text message to send"),
      reply_to_message_id: z
        .string()
        .optional()
        .describe("Quote this message (WhatsApp reply) — id from list_messages, in the same chat"),
    },
    async ({ recipient, message, reply_to_message_id }) => {
      let quoted: QuotedRef | null = null;
      if (reply_to_message_id) {
        const row = getMessageRow(reply_to_message_id, recipient);
        if (!row) return { isError: true, content: [{ type: "text", text: `Message ${reply_to_message_id} not found in ${recipient}` }] };
        quoted = { id: row.id, sender: row.sender, from_me: !!row.is_from_me, text: row.content };
      }
      return ops.invoke("send_message", { recipient, message, quoted });
    },
  );

  server.tool(
    "send_file",
    {
      recipient: z
        .string()
        .describe(
          "Recipient JID (user or group, e.g., '12345@s.whatsapp.net' or 'group123@g.us')",
        ),
      path: z
        .string()
        .min(1)
        .describe(
          "Absolute path to a local file to send. Images/videos/audio are sent inline; everything else (PDF, zip, office docs, …) is sent as a document attachment.",
        ),
      caption: z
        .string()
        .optional()
        .describe("Optional caption (applies to images, videos, and documents)."),
      filename: z
        .string()
        .optional()
        .describe(
          "Optional display filename for document sends (defaults to the file's basename).",
        ),
      as_document: z
        .boolean()
        .optional()
        .describe(
          "Force sending as a document attachment even for image/audio/video types (default: auto-detect by file type).",
        ),
    },
    async ({ recipient, path, caption, filename, as_document }) =>
      ops.invoke("send_file", {
        recipient,
        path,
        caption,
        filename,
        as_document,
      }),
  );

  server.tool(
    "search_messages",
    {
      query: z
        .string()
        .min(1)
        .describe("The text content to search for within messages"),
      chat_jid: z
        .string()
        .optional()
        .describe(
          "Optional: The JID of a specific chat to search within (e.g., '123...net' or 'group@g.us'). If omitted, searches all chats.",
        ),
      limit: z
        .number()
        .int()
        .positive()
        .optional()
        .default(10)
        .describe("Max messages per page (default 10)"),
      page: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .default(0)
        .describe("Page number (0-indexed, default 0)"),
    },
    async ({ chat_jid, query, limit, page }) => {
      const searchScope = chat_jid ? `in chat ${chat_jid}` : "across all chats";
      mcpLogger.info(
        `[MCP Tool] Executing search_messages ${searchScope}, query="${query}", limit=${limit}, page=${page}`,
      );
      try {
        const messages = searchMessages(query, chat_jid, limit, page);

        if (!messages.length && page === 0) {
          const emptyNotice = unparsedNotice({ chatJid: chat_jid ?? null });
          return {
            content: [
              ...(emptyNotice ? [emptyNotice] : []),
              {
                type: "text",
                text: `No messages found containing "${query}" in chat ${chat_jid}.`,
              },
            ],
          };
        } else if (!messages.length) {
          return {
            content: [
              {
                type: "text",
                text: `No more messages found containing "${query}" on page ${page} for chat ${chat_jid}.`,
              },
            ],
          };
        }

        const formattedMessages = messages.map(formatDbMessageForJson);
        // A search that finds nothing is exactly the moment someone concludes
        // "the client never sent it". Warn on the whole scope here: unlike a
        // time window, a search has no span to bound the answer to.
        const notice = unparsedNotice({ chatJid: chat_jid ?? null });
        return {
          content: [
            ...(notice ? [notice] : []),
            {
              type: "text",
              text: JSON.stringify(formattedMessages, null, 2),
            },
          ],
        };
      } catch (error: any) {
        mcpLogger.error(
          `[MCP Tool Error] search_messages_in_chat failed for ${chat_jid} / "${query}": ${error.message}`,
        );
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Error searching messages in chat ${chat_jid}: ${error.message}`,
            },
          ],
        };
      }
    },
  );

  server.tool(
    "list_unparsed_messages",
    {
      chat_jid: z
        .string()
        .optional()
        .describe("Only messages from this chat. Omit for all chats."),
      after: z
        .string()
        .optional()
        .describe(
          "Only at/after this time. ISO 8601; a bare 'YYYY-MM-DD' means 00:00:00 that day. UTC.",
        ),
      before: z
        .string()
        .optional()
        .describe(
          "Only at/before this time. ISO 8601; a bare 'YYYY-MM-DD' means 23:59:59 that day. UTC.",
        ),
      limit: z
        .number()
        .int()
        .positive()
        .optional()
        .default(50)
        .describe("Max rows, newest first (default 50)."),
    },
    async ({ chat_jid, after, before, limit }) => {
      const dateOnly = /^\d{4}-\d{2}-\d{2}$/;
      const afterIso = after
        ? dateOnly.test(after)
          ? `${after}T00:00:00.000Z`
          : after
        : null;
      const beforeIso = before
        ? dateOnly.test(before)
          ? `${before}T23:59:59.999Z`
          : before
        : null;
      mcpLogger.info(
        `[MCP Tool] Executing list_unparsed_messages: chat=${chat_jid}, after=${afterIso}, before=${beforeIso}`,
      );
      try {
        const rows = getUnparsedMessages({
          chatJid: chat_jid ?? null,
          after: afterIso,
          before: beforeIso,
          limit,
        });
        if (!rows.length) {
          return {
            content: [
              {
                type: "text",
                text:
                  "No unparsed messages recorded for these filters. Note this only " +
                  "covers messages received by a build that records them — anything " +
                  "dropped before this landed left no trace, so this is not proof " +
                  "that nothing was lost.",
              },
            ],
          };
        }
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(rows.map(formatUnparsedForJson), null, 2),
            },
            {
              type: "text",
              text:
                "`reason` says why it could not be read: `unsupported:<type>` is a " +
                "message shape the parser does not handle; `undecrypted` is a message " +
                "WhatsApp could not decrypt for this device. Rows with " +
                "`reprocessable: true` kept the raw protobuf, so a parser fix can " +
                "recover their content without asking WhatsApp for anything.",
            },
          ],
        };
      } catch (error: any) {
        mcpLogger.error(
          `[MCP Tool Error] list_unparsed_messages failed: ${error.message}`,
        );
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Error listing unparsed messages: ${error.message}`,
            },
          ],
        };
      }
    },
  );

  server.resource("db_schema", "schema://whatsapp/main", async (uri) => {
    mcpLogger.info(`[MCP Resource] Request for ${uri.href}`);
    const schemaText = `
TABLE chats (jid TEXT PK, name TEXT, last_message_time TIMESTAMP)
TABLE messages (id TEXT, chat_jid TEXT, sender TEXT, content TEXT, timestamp TIMESTAMP, is_from_me BOOLEAN, media_meta TEXT /* base64 protobuf of media submessage for get_media; null for text */, PK(id, chat_jid), FK(chat_jid) REFERENCES chats(jid))
TABLE unparsed_messages (id TEXT, chat_jid TEXT, sender TEXT, timestamp TIMESTAMP, is_from_me BOOLEAN, reason TEXT, message_keys TEXT, stub_type INTEGER, raw_payload TEXT /* base64 protobuf of the whole msg.message, for reprocessing */, created_at TIMESTAMP, PK(id, chat_jid)) -- messages received but not parseable; read via list_unparsed_messages
            `.trim();
    return {
      contents: [
        {
          uri: uri.href,
          text: schemaText,
        },
      ],
    };
  });

  const transport = new StdioServerTransport();
  mcpLogger.info("MCP server configured. Connecting stdio transport...");

  try {
    await server.connect(transport);
    mcpLogger.info(
      "MCP transport connected. Server is ready and listening via stdio.",
    );
  } catch (error: any) {
    mcpLogger.error(
      `[FATAL] Failed to connect MCP transport: ${error.message}`,
      error,
    );
    process.exit(1);
  }

  mcpLogger.info(
    "MCP Server setup complete. Waiting for requests from client...",
  );
}
