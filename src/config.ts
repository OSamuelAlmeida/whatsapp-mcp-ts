import path from "node:path";
import fs from "node:fs";

/**
 * Per-account isolation.
 *
 * Point WHATSAPP_MCP_DATA_DIR at a distinct directory per WhatsApp account
 * (e.g. ~/.whatsapp-mcp/personal vs ~/.whatsapp-mcp/business). Everything that
 * identifies a session — auth creds, the message DB, and logs — lives under it,
 * so two registrations of this single install never collide.
 *
 * Defaults to the package root (one level up from compiled dist/ or src/) for
 * simple single-account use.
 */
const ROOT = process.env.WHATSAPP_MCP_DATA_DIR
  ? path.resolve(process.env.WHATSAPP_MCP_DATA_DIR)
  : path.join(import.meta.dirname, "..");

export const ROOT_DIR = ROOT;
export const AUTH_DIR = path.join(ROOT, "auth_info");
export const DATA_DIR = path.join(ROOT, "data");
export const LOG_DIR = ROOT;

// Unix socket used to elect the single connection owner per account and let
// followers forward socket-bound calls to it. Lives under DATA_DIR so it's
// naturally per-account (one owner per WhatsApp identity). See src/control.ts.
export const CONTROL_SOCK = path.join(DATA_DIR, "control.sock");

// Ensure the dirs the loggers and DB write to exist before anything opens them.
// (auth_info is created by Baileys' useMultiFileAuthState.)
for (const dir of [ROOT, DATA_DIR]) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

const truthy = (v: string | undefined) =>
  v === "1" || v?.toLowerCase() === "true";

/** Ignore group chats entirely (default: include them). */
export const IGNORE_GROUPS = truthy(process.env.WHATSAPP_IGNORE_GROUPS);

/**
 * Optional send guard. Set WHATSAPP_SEND_ALLOWLIST to a comma-separated list of
 * JID substrings (e.g. a phone number, or a group id) and send_message will
 * refuse any recipient that matches none of them. Empty/unset = no allowlist
 * (Claude Code's per-call permission prompt still gates every send).
 */
export const SEND_ALLOWLIST = (process.env.WHATSAPP_SEND_ALLOWLIST || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
