# whatsapp-mcp

A single-process **WhatsApp MCP server** (stdio) over the WhatsApp Web multi-device
API via [Baileys](https://github.com/WhiskeySockets/Baileys). Lets an MCP client
(Claude Code, etc.) **read/search** your chats and contacts and **send free-form
messages** to people or groups. Messages and auth live **locally** under a
per-account data dir; nothing is sent anywhere except to the MCP client when it
calls a tool.

Forked from [jlucaso1/whatsapp-mcp-ts](https://github.com/jlucaso1/whatsapp-mcp-ts).

## Why this fork

| Change | Reason |
| --- | --- |
| **Per-account isolation via `WHATSAPP_MCP_DATA_DIR`** (`src/config.ts`) | Run *one* install as many independent accounts — auth, DB, and logs all live under that dir. Upstream hardcoded the paths, so two accounts collided. |
| **Local QR rendering to stderr** (`qrcode-terminal`) | Upstream shipped the pairing string to `quickchart.io` and opened a browser. Now it renders in-terminal, on **stderr** (never stdout — that carries the MCP protocol), works headless, leaks nothing. |
| **Groups included by default** | Upstream had `shouldIgnoreJid: isJidGroup`, silently dropping all live group messages while the tools/DB/send still claimed group support. Set `WHATSAPP_IGNORE_GROUPS=1` to opt back out. |
| **Reconnect holder fix** (`WhatsAppConnection`) | Baileys hands you a *new* socket on every reconnect; upstream captured the original once, so any send after a reconnect hit a dead socket. Callers now read the live socket from a mutable holder. |
| **Optional send allowlist** (`WHATSAPP_SEND_ALLOWLIST`) | Hard guard against an LLM / prompt-injection messaging the wrong person. |
| **Baileys `7.0.0-rc13`** | The pinned `@whiskeysockets/baileys@6.17.x` had a message-spoofing zero-day (GHSA-qvv5-jq5g-4cgg) and pulled `libsignal` from git. The maintained `baileys@7.0.0-rc13` fixes both. |
| **Compiles to `dist/`** | Matches the other MCPs in this workspace (run a built `dist/*.js`, no `.ts` at runtime). |

## Config (env vars)

| Var | Default | Meaning |
| --- | --- | --- |
| `WHATSAPP_MCP_DATA_DIR` | package root | Per-account root holding `auth_info/`, `data/whatsapp.db`, and `*-logs.txt`. **Set a distinct dir per account.** |
| `WHATSAPP_IGNORE_GROUPS` | unset | `1`/`true` → ignore group chats entirely. |
| `WHATSAPP_SEND_ALLOWLIST` | unset | Comma-separated JID substrings; if set, `send_message` refuses any non-matching recipient. |
| `LOG_LEVEL` | `info` | pino log level (logs go to files in the data dir, not the console). |

## Build

```sh
pnpm install                 # installs deps (you may see a one-time build-approval notice; deps still install)
./node_modules/.bin/tsc      # compile to dist/  — use this, not `pnpm build`*
```

\* `pnpm build`/`pnpm exec` trip this machine's global pnpm build-approval gate
(`baileys`/`protobufjs` ship prebuilt and are intentionally **not** built — see
`pnpm.ignoredBuiltDependencies`). Runtime never invokes pnpm, so this only
affects rebuilds; the direct `tsc` binary is the clean path.

## Linking an account (one-time QR scan)

```sh
./auth.sh personal     # links the personal number → ~/.whatsapp-mcp/personal
./auth.sh business     # links the business-app number → ~/.whatsapp-mcp/business
```

Scan the QR in WhatsApp → **Settings → Linked Devices → Link a device**. Once the
log shows `Connection opened`, press Ctrl-C. The session persists on disk and is
reused by the MCP server (re-link only every ~20 days or after logout).

## Tools

`search_contacts`, `list_chats`, `get_chat`, `list_messages`, `search_messages`,
`get_message_context`, `get_media`, `send_message`, `send_file`.

`send_file` sends a local file by path: images/videos/audio go inline, anything
else (PDF, zip, office docs, …) as a document attachment. It honours the same
`WHATSAPP_SEND_ALLOWLIST` guard as `send_message`.

## One connection across sessions

This is a stdio server, so every Claude Code session spawns its own process. To
avoid multiple sockets fighting over one WhatsApp identity, exactly one process
(the **owner**) holds the Baileys connection per account; the rest are
**followers** that read from the shared DB and forward sends/`get_media` to the
owner over a per-account unix socket. Each process also exits when its client
disconnects, so old instances don't linger. No setup needed — it's automatic.

## Registered instances (this machine)

| Name | Scope | Available in | `WHATSAPP_MCP_DATA_DIR` |
| --- | --- | --- | --- |
| `whatsapp-personal` | `local` (in `~/.claude.json`, keyed to `~/personal`) | `~/personal` **exact dir only** — local scope does not cascade to subfolders | `~/.whatsapp-mcp/personal` |
| `whatsapp-business` | `project` (`~/projects/.mcp.json`) | `~/projects` **and every subfolder** — Claude Code walks up to find `.mcp.json`, so one file covers all repos under it | `~/.whatsapp-mcp/business` |

Project-scope (`.mcp.json`) servers prompt for a one-time approval the first time
you launch `claude` in a given project dir (a trust gate for checked-in configs).
To skip that prompt everywhere, set `enableAllProjectMcpServers: true` in settings.

Enable an account in some other directory: `cd <dir> && claude mcp add whatsapp-<acct> -s local -e WHATSAPP_MCP_DATA_DIR=~/.whatsapp-mcp/<acct> -- <node> <repo>/dist/main.js` (or drop a `.mcp.json` at a parent dir to cover a whole tree).
