#!/usr/bin/env bash
#
# One-time WhatsApp linking for an account.
#
#   ./auth.sh personal     # links the personal number
#   ./auth.sh business      # links the WhatsApp Business-app number
#
# Runs the server standalone so the QR renders in THIS terminal. On your phone:
# WhatsApp → Settings → Linked Devices → Link a device, and scan it. Once the
# log prints "Connection opened. WA user: ...", press Ctrl-C — the session is
# saved under ~/.whatsapp-mcp/<account>/auth_info and reused by the MCP server.
#
set -euo pipefail
acct="${1:?usage: ./auth.sh <account>   (e.g. personal | business)}"
here="$(cd "$(dirname "$0")" && pwd)"
dir="$HOME/.whatsapp-mcp/$acct"
mkdir -p "$dir"
echo "Linking account '$acct' — data dir: $dir"
echo "Watch for the QR below, then Ctrl-C once you see 'Connection opened'."
echo
WHATSAPP_MCP_DATA_DIR="$dir" exec node "$here/dist/main.js"
