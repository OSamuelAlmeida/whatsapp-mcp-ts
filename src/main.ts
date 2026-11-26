import pino from "pino";
import { LOG_DIR, CONTROL_SOCK } from "./config.ts";
import { initializeDatabase } from "./database.ts";
import {
  startWhatsAppConnection,
  type WhatsAppConnection,
} from "./whatsapp.ts";
import { startMcpServer, createLocalOps, type ToolOps } from "./mcp.ts";
import { acquireControl } from "./control.ts";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

const waLogger = pino(
  {
    level: process.env.LOG_LEVEL || "info",
    timestamp: pino.stdTimeFunctions.isoTime,
  },
  pino.destination(`${LOG_DIR}/wa-logs.txt`)
);

const mcpLogger = pino(
  {
    level: process.env.LOG_LEVEL || "info",
    timestamp: pino.stdTimeFunctions.isoTime,
  },
  pino.destination(`${LOG_DIR}/mcp-logs.txt`)
);

async function main() {
  mcpLogger.info("Starting WhatsApp MCP Server...");

  // The Baileys socket is held by at most ONE process (the owner) per account.
  // Followers leave this null and forward socket-bound tools to the owner.
  const connection: WhatsAppConnection = { socket: null };
  const localOps = createLocalOps(connection, mcpLogger, waLogger);

  // Stable handle the MCP server holds. Its target swaps if a follower later
  // gets promoted to owner (e.g. when the previous owner exits).
  let active: ToolOps = localOps;
  const ops: ToolOps = { invoke: (m, p) => active.invoke(m, p) };

  // Elect ownership: bind the per-account control socket (owner) or follow the
  // instance that already holds it. Re-runs on owner loss to promote/re-follow.
  async function elect(): Promise<void> {
    const control = await acquireControl(
      CONTROL_SOCK,
      (method, params) => localOps.invoke(method, params),
      mcpLogger,
    );
    if (control.role === "owner") {
      active = localOps;
      mcpLogger.info("Owner: opening the single WhatsApp connection.");
      await startWhatsAppConnection(waLogger, connection);
    } else {
      mcpLogger.info(
        "Follower: serving reads locally; forwarding sends/get_media to the owner.",
      );
      active = {
        invoke: (m, p) => control.call(m, p) as Promise<CallToolResult>,
      };
      control.onOwnerLost(() => {
        mcpLogger.warn("Connection owner went away; re-electing.");
        elect().catch((e) =>
          mcpLogger.error({ err: e }, "Re-election after owner loss failed"),
        );
      });
    }
  }

  try {
    mcpLogger.info("Initializing database...");
    initializeDatabase();
    mcpLogger.info("Database initialized successfully.");

    await elect();
  } catch (error: any) {
    mcpLogger.fatal(
      { err: error },
      "Failed during initialization or ownership election",
    );
    process.exit(1);
  }

  try {
    mcpLogger.info("Starting MCP server...");
    await startMcpServer(ops, mcpLogger, waLogger);
    mcpLogger.info("MCP Server started and listening.");
  } catch (error: any) {
    mcpLogger.fatal({ err: error }, "Failed to start MCP server");
    process.exit(1);
  }

  // Reap this process when its MCP client (Claude Code) disconnects. Each stdio
  // client spawns its own server; without this, old instances linger holding a
  // Baileys socket and fight the live one over the same WhatsApp identity (the
  // "flip-flop" / ban risk). stdin EOF/close = the client went away.
  const exitOnDisconnect = (why: string) => {
    mcpLogger.info(`MCP client disconnected (${why}); exiting.`);
    waLogger.flush();
    mcpLogger.flush();
    process.exit(0);
  };
  process.stdin.on("close", () => exitOnDisconnect("stdin close"));
  process.stdin.on("end", () => exitOnDisconnect("stdin end"));

  mcpLogger.info("Application setup complete. Running...");
}

async function shutdown(signal: string) {
  mcpLogger.info(`Received ${signal}. Shutting down gracefully...`);

  waLogger.flush();
  mcpLogger.flush();

  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

main().catch((error) => {
  mcpLogger.fatal({ err: error }, "Unhandled error during application startup");
  waLogger.flush();
  mcpLogger.flush();
  process.exit(1);
});
