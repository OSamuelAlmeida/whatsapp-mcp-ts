import net from "node:net";
import fs from "node:fs";
import type P from "pino";

/**
 * Single-owner coordination over a per-account unix domain socket.
 *
 * The problem: this MCP is a stdio server, so Claude Code spawns one process
 * per client/session. Each one used to open its own Baileys socket on the SAME
 * WhatsApp identity, and WhatsApp only allows one socket per linked device — so
 * the sockets evict each other in a loop (the "flip-flop" / account-ban risk).
 *
 * The fix: exactly one process — the OWNER — binds `CONTROL_SOCK` and holds the
 * single Baileys connection. Every other process is a FOLLOWER: it opens no
 * Baileys socket, serves read tools from the shared SQLite DB, and forwards the
 * socket-bound tools (send_message / send_file / get_media) to the owner over
 * this channel. Ownership is claimed atomically by listening on the socket; a
 * socket file left by a dead owner is detected (connect fails) and reclaimed.
 */

export type RpcRequest = { id: number; method: string; params: unknown };
export type RpcResult =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: string };

/** Owner-side dispatch: run a forwarded tool call against the live connection. */
export type RpcHandler = (method: string, params: unknown) => Promise<unknown>;

export interface OwnerHandle {
  role: "owner";
}
export interface FollowerHandle {
  role: "follower";
  /** Forward a socket-bound call to the owner; resolves with its result. */
  call: (method: string, params: unknown) => Promise<unknown>;
  /** Register a callback fired if the owner connection drops. */
  onOwnerLost: (cb: () => void) => void;
}
export type ControlHandle = OwnerHandle | FollowerHandle;

function listenOnce(sockPath: string): Promise<net.Server | null> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(null)); // EADDRINUSE (or perms) → not us
    server.listen(sockPath, () => {
      server.removeAllListeners("error");
      resolve(server);
    });
  });
}

function canConnect(sockPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const c = net.connect(sockPath);
    const done = (alive: boolean) => {
      c.removeAllListeners();
      c.destroy();
      resolve(alive);
    };
    c.once("connect", () => done(true));
    c.once("error", () => done(false)); // ECONNREFUSED / ENOENT → stale or gone
  });
}

/**
 * Try to become the owner. Returns an OwnerHandle if we now hold the socket, or
 * a FollowerHandle wired to talk to the live owner. `handler` is only used by
 * the owner (to serve forwarded calls).
 */
export async function acquireControl(
  sockPath: string,
  handler: RpcHandler,
  logger: P.Logger,
): Promise<ControlHandle> {
  let server = await listenOnce(sockPath);

  if (!server) {
    // Something holds the path. If a live owner answers, we're a follower.
    if (await canConnect(sockPath)) {
      logger.info("Another instance owns the WhatsApp connection — following.");
      return makeFollower(sockPath, logger);
    }
    // Stale socket from a dead owner: remove it and retry once.
    logger.warn("Stale control socket found; reclaiming ownership.");
    try {
      fs.unlinkSync(sockPath);
    } catch {
      /* ignore */
    }
    server = await listenOnce(sockPath);
    if (!server) {
      // Lost a race to another reclaimer — follow it.
      return makeFollower(sockPath, logger);
    }
  }

  logger.info("This instance owns the WhatsApp connection.");
  serveOwner(server, handler, logger);
  const cleanup = () => {
    try {
      fs.unlinkSync(sockPath);
    } catch {
      /* ignore */
    }
  };
  process.once("exit", cleanup);
  return { role: "owner" };
}

/** Owner: accept follower connections and dispatch their RPC requests. */
function serveOwner(server: net.Server, handler: RpcHandler, logger: P.Logger) {
  server.on("connection", (sock) => {
    let buf = "";
    sock.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        let req: RpcRequest;
        try {
          req = JSON.parse(line);
        } catch {
          continue;
        }
        handler(req.method, req.params)
          .then((result) => respond(sock, { id: req.id, ok: true, result }))
          .catch((err) =>
            respond(sock, {
              id: req.id,
              ok: false,
              error: err?.message ?? String(err),
            }),
          );
      }
    });
    sock.on("error", () => sock.destroy());
  });
  server.on("error", (err) => logger.error({ err }, "control server error"));
}

function respond(sock: net.Socket, res: RpcResult) {
  if (sock.writable) sock.write(JSON.stringify(res) + "\n");
}

/** Follower: a persistent connection to the owner with id-matched requests. */
function makeFollower(sockPath: string, logger: P.Logger): FollowerHandle {
  let client: net.Socket | null = null;
  let nextId = 1;
  const pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  const lostCbs: Array<() => void> = [];

  const drop = (reason: string) => {
    if (client) {
      client.removeAllListeners();
      client.destroy();
      client = null;
    }
    for (const [, p] of pending) p.reject(new Error(reason));
    pending.clear();
    for (const cb of lostCbs) cb();
  };

  const ensure = (): Promise<net.Socket> =>
    new Promise((resolve, reject) => {
      if (client && !client.destroyed) return resolve(client);
      const c = net.connect(sockPath);
      let buf = "";
      c.once("connect", () => {
        client = c;
        resolve(c);
      });
      c.once("error", (err) => {
        if (!client) reject(err);
        else drop("owner connection error");
      });
      c.on("close", () => {
        if (client === c) drop("owner connection closed");
      });
      c.on("data", (chunk) => {
        buf += chunk.toString("utf8");
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          if (!line.trim()) continue;
          let res: RpcResult;
          try {
            res = JSON.parse(line);
          } catch {
            continue;
          }
          const p = pending.get(res.id);
          if (!p) continue;
          pending.delete(res.id);
          if (res.ok) p.resolve(res.result);
          else p.reject(new Error(res.error));
        }
      });
    });

  const call = async (method: string, params: unknown): Promise<unknown> => {
    const c = await ensure();
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      c.write(JSON.stringify({ id, method, params }) + "\n");
    });
  };

  return {
    role: "follower",
    call,
    onOwnerLost: (cb) => lostCbs.push(cb),
  };
}
