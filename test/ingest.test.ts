/**
 * Regression tests for the message-ingest path.
 *
 * The bug these exist for: a document sent with a caption arrives wrapped in a
 * `documentWithCaptionMessage` envelope. The parser read the *outer* keys, found
 * nothing it knew, logged a warning at level 40 and threw the message away — so
 * a delivered attachment (a PDF certificate a client sent on 2026-08-20)
 * was indistinguishable from one that was never sent.
 *
 * The payloads here are BUILT with the Baileys protobuf, not captured from the
 * wire — the lost messages were dropped before anything could be saved. Their
 * shapes come from the instrumented production log
 * (~/.whatsapp-mcp/business/wa-logs.txt, 2026-09-01..2026-09-07), which named
 * every type that actually fell through: documentWithCaptionMessage,
 * albumMessage, buttonsMessage, reactionMessage, protocolMessage, and
 * stub-only messages with stubType CIPHERTEXT / GROUP_CREATE.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "wa-mcp-test-"));
process.env.WHATSAPP_MCP_DATA_DIR = dataDir;

const { proto, getContentType } = await import("baileys");
const {
  initializeDatabase,
  getMessages,
  getMessageMedia,
  getUnparsedMessages,
  countUnparsedMessages,
  getChats,
} = await import("../src/database.ts");
const { ingestMessage, handleMessageUpdate } = await import(
  "../src/whatsapp.ts"
);

const CHAT = "100000000000001@lid";
let seq = 0;
const nextId = () => `TESTMSG${(seq++).toString().padStart(4, "0")}`;

function incoming(
  message: any,
  extra: Record<string, unknown> = {},
): any {
  return {
    key: { remoteJid: CHAT, id: nextId(), fromMe: false },
    messageTimestamp: 1757000000,
    pushName: "Arthur",
    message,
    ...extra,
  };
}

before(() => {
  initializeDatabase();
});

after(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("a document sent with a caption is stored, not dropped", () => {
  const msg = incoming({
    messageContextInfo: {},
    documentWithCaptionMessage: {
      message: {
        documentMessage: {
          fileName: "certificate.pdf",
          mimetype: "application/pdf",
          caption: "Segue o certificado",
          mediaKey: new Uint8Array([1, 2, 3, 4]),
          directPath: "/v/t62.7119-24/fake",
          fileEncSha256: new Uint8Array([5, 6, 7, 8]),
          fileSha256: new Uint8Array([9, 10, 11, 12]),
        },
      },
    },
  });

  const outcome = ingestMessage(msg);
  assert.equal(outcome.kind, "stored");

  const stored = getMessages(CHAT, 5, 0).find((m) => m.id === msg.key.id);
  assert.ok(stored, "the message must exist in the store");
  assert.match(stored!.content, /certificado/i);

  // The envelope must be peeled BEFORE media_meta is encoded, or get_media
  // rebuilds a documentWithCaptionMessage that downloadMediaMessage cannot read.
  const media = getMessageMedia(msg.key.id, CHAT);
  assert.ok(media?.media_meta, "media must stay downloadable");
  const decoded = proto.Message.decode(
    Buffer.from(media!.media_meta!, "base64"),
  );
  assert.equal(getContentType(decoded), "documentMessage");
  assert.equal(decoded.documentMessage?.fileName, "certificate.pdf");
});

test("a view-once image is stored", () => {
  const msg = incoming({
    viewOnceMessageV2: {
      message: {
        imageMessage: {
          caption: "olha isso",
          mimetype: "image/jpeg",
          mediaKey: new Uint8Array([1]),
          directPath: "/v/fake",
        },
      },
    },
  });
  const outcome = ingestMessage(msg);
  assert.equal(outcome.kind, "stored");
  const stored = getMessages(CHAT, 5, 0).find((m) => m.id === msg.key.id);
  assert.match(stored!.content, /\[Image\] olha isso/);
});

test("an album header is stored with its expected counts", () => {
  const msg = incoming({
    messageContextInfo: {},
    albumMessage: { expectedImageCount: 3, expectedVideoCount: 1 },
  });
  assert.equal(ingestMessage(msg).kind, "stored");
  const stored = getMessages(CHAT, 5, 0).find((m) => m.id === msg.key.id);
  assert.equal(stored!.content, "[Album] 3 images, 1 video");
});

test("a buttons message keeps its text", () => {
  const msg = incoming({
    messageContextInfo: {},
    buttonsMessage: { contentText: "Escolha uma opção", footerText: "rodapé" },
  });
  assert.equal(ingestMessage(msg).kind, "stored");
  const stored = getMessages(CHAT, 5, 0).find((m) => m.id === msg.key.id);
  assert.equal(stored!.content, "Escolha uma opção");
});

test("an edit rewrites the original's content and keeps its media_meta", () => {
  const original = incoming({
    documentWithCaptionMessage: {
      message: {
        documentMessage: {
          fileName: "nota.pdf",
          mimetype: "application/pdf",
          caption: "versao errada",
          mediaKey: new Uint8Array([1, 2]),
          directPath: "/v/fake",
        },
      },
    },
  });
  ingestMessage(original);
  const before = getMessages(CHAT, 50, 0).find((m) => m.id === original.key.id)!;
  const beforeMedia = getMessageMedia(original.key.id, CHAT)!;
  assert.ok(beforeMedia.media_meta, "precondition: the original has media");

  const edit = incoming({
    protocolMessage: {
      type: proto.Message.ProtocolMessage.Type.MESSAGE_EDIT,
      key: { remoteJid: CHAT, id: original.key.id, fromMe: false },
      editedMessage: { conversation: "versao certa" },
    },
  });
  const outcome = ingestMessage(edit);
  assert.equal(outcome.kind, "edit");
  assert.equal((outcome as any).applied, true);

  const after = getMessages(CHAT, 50, 0).find((m) => m.id === original.key.id)!;
  assert.equal(after.content, "versao certa");
  assert.equal(
    getMessageMedia(original.key.id, CHAT)!.media_meta,
    beforeMedia.media_meta,
  );
  assert.equal(after.timestamp.toISOString(), before.timestamp.toISOString());
});

test("protocol plumbing is ignored by name, not silently", () => {
  const msg = incoming({
    senderKeyDistributionMessage: {},
    messageContextInfo: {},
    protocolMessage: {
      type: proto.Message.ProtocolMessage.Type.APP_STATE_SYNC_KEY_SHARE,
    },
  });
  const outcome = ingestMessage(msg);
  assert.equal(outcome.kind, "ignored");
  assert.equal((outcome as any).reason, "protocol:APP_STATE_SYNC_KEY_SHARE");
});

test("a system stub (group created) is ignored by name", () => {
  const msg = {
    key: { remoteJid: "120000000000000001@g.us", id: nextId(), fromMe: false },
    messageTimestamp: 1757000000,
    messageStubType: proto.WebMessageInfo.StubType.GROUP_CREATE,
  } as any;
  const outcome = ingestMessage(msg);
  assert.equal(outcome.kind, "ignored");
  assert.equal((outcome as any).reason, "stub:20");
});

test("an undecryptable message is recorded, and superseded when it decrypts", () => {
  const id = nextId();
  const stub = {
    key: { remoteJid: CHAT, id, fromMe: false },
    messageTimestamp: 1757000000,
    messageStubType: proto.WebMessageInfo.StubType.CIPHERTEXT,
  } as any;

  const outcome = ingestMessage(stub);
  assert.equal(outcome.kind, "unparsed");
  assert.equal((outcome as any).record.reason, "undecrypted");
  assert.equal(countUnparsedMessages({ chatJid: CHAT }), 1);

  // The retry arrives via messages.update with the decrypted body.
  const retry = {
    key: { remoteJid: CHAT, id, fromMe: false },
    messageTimestamp: 1757000000,
    message: { conversation: "finalmente" },
  } as any;
  assert.equal(ingestMessage(retry).kind, "stored");
  assert.equal(
    countUnparsedMessages({ chatJid: CHAT }),
    0,
    "the placeholder must be cleared once the real message lands",
  );
});

test("an unknown message shape is persisted with its raw payload", () => {
  const msg = incoming({
    messageContextInfo: {},
    // A shape the parser has no branch for. The point is that it survives.
    pollUpdateMessage: {
      pollCreationMessageKey: { remoteJid: CHAT, id: "SOMEPOLL" },
    },
  });
  const outcome = ingestMessage(msg);
  assert.equal(outcome.kind, "unparsed");

  const rows = getUnparsedMessages({ chatJid: CHAT });
  const row = rows.find((r) => r.id === msg.key.id);
  assert.ok(row, "the unreadable message must still be on record");
  assert.equal(row!.reason, "unsupported:pollUpdateMessage");
  assert.ok(row!.raw_payload, "the raw payload must be kept for reprocessing");

  // Reprocessable means exactly that: the bytes round-trip.
  const decoded = proto.Message.decode(Buffer.from(row!.raw_payload!, "base64"));
  assert.equal(
    decoded.pollUpdateMessage?.pollCreationMessageKey?.id,
    "SOMEPOLL",
  );
});

test("a reaction still goes to the reactions table, not to messages", () => {
  const msg = incoming({
    reactionMessage: {
      key: { remoteJid: CHAT, id: "SOMEMSG", fromMe: false },
      text: "👍",
      senderTimestampMs: 1757000000000,
    },
  });
  assert.equal(ingestMessage(msg).kind, "reaction");
  assert.equal(
    getMessages(CHAT, 50, 0).some((m) => m.id === msg.key.id),
    false,
  );
});

// --- messages.update: a patch, never a re-delivery ------------------------
//
// Baileys emits `messages.update` with content from exactly two places, and
// routing either through storeMessage (INSERT OR REPLACE) destroys the row.
// Both shapes below are copied from the Baileys source, not invented:
//   process-message.js:364  (MESSAGE_EDIT, messageTimestamp in MILLISECONDS)
//   messages-send.js:1050   (updateMediaMessage, no timestamp at all)

function storedDoc(caption: string) {
  const msg = incoming({
    documentWithCaptionMessage: {
      message: {
        documentMessage: {
          fileName: "certificado.pdf",
          mimetype: "application/pdf",
          caption,
          mediaKey: new Uint8Array([1, 2, 3]),
          directPath: "/v/fake",
        },
      },
    },
  });
  assert.equal(ingestMessage(msg).kind, "stored");
  return msg;
}

test("get_media's CDN re-upload does not move the message to today", () => {
  const msg = storedDoc("original");
  const before = getMessages(CHAT, 200, 0).find((m) => m.id === msg.key.id)!;
  const beforeMedia = getMessageMedia(msg.key.id, CHAT)!.media_meta;

  // updateMediaMessage re-emits the whole message with NO messageTimestamp.
  const outcome = handleMessageUpdate({
    key: msg.key,
    message: msg.message,
  } as any);
  assert.notEqual(outcome.kind, "stored");

  const after = getMessages(CHAT, 200, 0).find((m) => m.id === msg.key.id)!;
  assert.equal(
    after.timestamp.toISOString(),
    before.timestamp.toISOString(),
    "reading media must not rewrite when the message arrived",
  );
  assert.equal(
    getMessageMedia(msg.key.id, CHAT)!.media_meta,
    beforeMedia,
    "reading media must not destroy the metadata that makes it readable",
  );
});

test("an edit arriving via messages.update keeps timestamp and media", () => {
  const msg = storedDoc("versao errada");
  const before = getMessages(CHAT, 200, 0).find((m) => m.id === msg.key.id)!;
  const beforeMedia = getMessageMedia(msg.key.id, CHAT)!.media_meta;

  const outcome = handleMessageUpdate({
    key: msg.key,
    message: { editedMessage: { message: { conversation: "versao certa" } } },
    // Baileys sends protocolMsg.timestampMs here — MILLISECONDS. Read as
    // seconds it lands in the year 58637 and pins the row to the top of every
    // ORDER BY timestamp DESC.
    messageTimestamp: 1757000000000,
  } as any);
  assert.equal(outcome.kind, "edit");
  assert.equal((outcome as any).applied, true);

  const after = getMessages(CHAT, 200, 0).find((m) => m.id === msg.key.id)!;
  assert.equal(after.content, "versao certa");
  assert.equal(after.timestamp.toISOString(), before.timestamp.toISOString());
  assert.equal(after.timestamp.getUTCFullYear(), 2025);
  assert.equal(getMessageMedia(msg.key.id, CHAT)!.media_meta, beforeMedia);
});

test("a decrypted retry is filed at the placeholder's time, not now", () => {
  const id = nextId();
  const stub = {
    key: { remoteJid: CHAT, id, fromMe: false },
    messageTimestamp: 1757000000,
    messageStubType: proto.WebMessageInfo.StubType.CIPHERTEXT,
  } as any;
  assert.equal(ingestMessage(stub).kind, "unparsed");

  // The retry carries no timestamp of its own.
  const outcome = handleMessageUpdate({
    key: { remoteJid: CHAT, id, fromMe: false },
    message: { conversation: "finalmente" },
  } as any);
  assert.equal(outcome.kind, "stored");

  const row = getMessages(CHAT, 200, 0).find((m) => m.id === id)!;
  assert.equal(row.content, "finalmente");
  assert.equal(
    row.timestamp.toISOString(),
    new Date(1757000000 * 1000).toISOString(),
    "a year-old message must not be filed as if it arrived today",
  );
  assert.equal(
    getUnparsedMessages({ chatJid: CHAT }).some((r) => r.id === id),
    false,
    "the placeholder must be cleared once the real message lands",
  );
});

test("an update's inner key never overrides the event key", () => {
  const msg = storedDoc("alvo");
  // Baileys' REVOKE emission puts a `key` inside `update`. The event-level key
  // is authoritative; letting the inner one win writes to the wrong row.
  const merged = {
    key: { remoteJid: "OTHER@s.whatsapp.net", id: "SPOOF", fromMe: true },
    message: { conversation: "sequestrado" },
  };
  const outcome = handleMessageUpdate({
    ...merged,
    key: msg.key,
  } as any);
  assert.equal(outcome.kind, "edit");
  const after = getMessages(CHAT, 200, 0).find((m) => m.id === msg.key.id)!;
  assert.equal(after.content, "sequestrado");
  assert.equal(
    getMessages(CHAT, 200, 0).some((m) => m.id === "SPOOF"),
    false,
  );
});

test("an edit for a message we never stored is kept, not lost", () => {
  const edit = incoming({
    protocolMessage: {
      type: proto.Message.ProtocolMessage.Type.MESSAGE_EDIT,
      key: { remoteJid: CHAT, id: "NEVERSTORED", fromMe: false },
      editedMessage: { conversation: "texto novo importante" },
    },
  });
  const outcome = ingestMessage(edit);
  assert.equal(outcome.kind, "unparsed");
  const row = getUnparsedMessages({ chatJid: CHAT }).find(
    (r) => r.id === "NEVERSTORED",
  );
  assert.ok(row, "an orphan edit must leave a trace");
  assert.equal(row!.reason, "edit-orphan");
  assert.ok(row!.raw_payload);
});

test("a reaction inside an ephemeral envelope is still a reaction", () => {
  const msg = incoming({
    ephemeralMessage: {
      message: {
        reactionMessage: {
          key: { remoteJid: CHAT, id: "SOMEMSG2", fromMe: false },
          text: "❤️",
          senderTimestampMs: 1757000000000,
        },
      },
    },
  });
  assert.equal(ingestMessage(msg).kind, "reaction");
});

test("a deviceSentMessage is unwrapped, not filed as unreadable", () => {
  const msg = incoming({
    deviceSentMessage: {
      destinationJid: CHAT,
      message: { conversation: "do meu outro aparelho" },
    },
  });
  assert.equal(ingestMessage(msg).kind, "stored");
  const row = getMessages(CHAT, 200, 0).find((m) => m.id === msg.key.id)!;
  assert.equal(row.content, "do meu outro aparelho");
});

test("an unparsed message creates its chat, so the chat is not invisible", () => {
  const NEW_CHAT = "5599999999999@s.whatsapp.net";
  const msg = {
    key: { remoteJid: NEW_CHAT, id: nextId(), fromMe: false },
    messageTimestamp: 1757000000,
    message: {
      messageContextInfo: {},
      scheduledCallCreationMessage: { scheduledTimestampMs: 1 },
    },
  } as any;
  assert.equal(ingestMessage(msg).kind, "unparsed");
  const chats = getChats(200, 0);
  assert.ok(
    chats.some((c) => c.jid === NEW_CHAT),
    "a contact whose first message we cannot read must still appear in list_chats",
  );
});
