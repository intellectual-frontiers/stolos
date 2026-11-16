/**
 * Spec 100 FR-003: the Stolos Console's HTTPS listener on the LAN. The same handler as the
 * 127.0.0.1 listener, behind TLS with the console's certificate; a renewed certificate replaces the
 * old one in place (no restart). commons' `serve` has no TLS yet, so this is the engine's own, on
 * `node:https` (Bun and Node both have it), shaped like commons' `serve`.
 *
 * @module
 */
// Spec: 100-remote-access FR-003

import { createServer, type Server as HttpsServer } from "node:https";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import type { Server, ServeHandler } from "@intellectual-frontiers/commons/ts/runtime";

/** The certificate and key the listener serves (PEM). */
export interface TlsPair {
  /** The certificate chain. */
  cert: string;
  /** Its private key. */
  key: string;
}

/** A running HTTPS listener: commons' Server, and the way to change its certificate. */
export interface TlsServer extends Server {
  /** Serve a new certificate from now on (a renewal). */
  setCertificate(t: TlsPair): Promise<void>;
}

const NO_BODY = new Set(["GET", "HEAD"]);

function toRequest(
  req: IncomingMessage,
  host: string,
): { request: Request; abort: AbortController } {
  const abort = new AbortController();
  const headers = new Headers();
  for (let i = 0; i + 1 < req.rawHeaders.length; i += 2) {
    headers.append(req.rawHeaders[i] ?? "", req.rawHeaders[i + 1] ?? "");
  }
  const method = req.method ?? "GET";
  const url = new URL(req.url ?? "/", `https://${req.headers.host ?? host}`);
  const init: RequestInit & { duplex?: "half" } = { method, headers, signal: abort.signal };
  if (!NO_BODY.has(method)) {
    init.body = Readable.toWeb(req) as ReadableStream<Uint8Array>;
    init.duplex = "half";
  }
  return { request: new Request(url, init), abort };
}

async function send(res: ServerResponse, response: Response, head: boolean): Promise<void> {
  res.statusCode = response.status;
  const cookies = response.headers.getSetCookie();
  response.headers.forEach((value, key) => {
    if (key !== "set-cookie") res.setHeader(key, value);
  });
  if (cookies.length > 0) res.setHeader("set-cookie", cookies);
  // HTTPS only: a browser that came here once comes back over HTTPS.
  res.setHeader("strict-transport-security", "max-age=31536000");
  if (response.body === null || head) {
    await response.body?.cancel();
    res.end();
    return;
  }
  res.flushHeaders();
  const reader = response.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!res.write(value)) await new Promise<void>((r) => res.once("drain", r));
      if (res.destroyed) break;
    }
  } finally {
    reader.releaseLock();
    res.end();
  }
}

/** One node:https server with this certificate, answering with `handler`. */
function tlsServer(t: TlsPair, host: string, handler: ServeHandler): HttpsServer {
  return createServer({ cert: t.cert, key: t.key, minVersion: "TLSv1.2" }, (req, res) => {
    const { request, abort } = toRequest(req, host);
    res.on("close", () => {
      if (!res.writableFinished) abort.abort();
    });
    const remoteAddr = {
      hostname: (req.socket.remoteAddress ?? "").replace(/^::ffff:/, ""),
      port: req.socket.remotePort ?? 0,
    };
    void (async () => {
      let response: Response;
      try {
        response = await handler(request, { remoteAddr });
      } catch {
        response = new Response("internal server error\n", { status: 500 });
      }
      await send(res, response, request.method === "HEAD").catch(() => res.destroy());
    })();
  });
}

function listen(server: HttpsServer, port: number, hostname: string): Promise<AddressInfo> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, hostname, () => {
      server.off("error", reject);
      resolve(server.address() as AddressInfo);
    });
  });
}

/**
 * Listen with TLS on `hostname:port`; rejects when the port is taken or not allowed. A new
 * certificate is put in place without a restart of the console: in place where the runtime can
 * (Node's `setSecureContext`), else by listening again on the same port with it (Bun), the
 * connections already open finishing on the old one.
 */
export async function serveTls(
  o: { hostname: string; port: number } & TlsPair,
  handler: ServeHandler,
): Promise<TlsServer> {
  const host = `${o.hostname}:${o.port}`;
  let server = tlsServer(o, host, handler);
  const a = await listen(server, o.port, o.hostname);
  let done: () => void = () => undefined;
  const finished = new Promise<void>((resolve) => (done = resolve));
  let stopped = false;
  const shutdown = async (): Promise<void> => {
    stopped = true;
    const closed = new Promise<void>((r) => server.once("close", () => r()));
    if (server.listening) {
      server.close();
      server.closeAllConnections();
      await closed;
    }
    done();
    await finished;
  };
  return {
    addr: { hostname: a.address, port: a.port },
    finished,
    shutdown,
    async setCertificate(t) {
      if (stopped) return;
      const inPlace = (server as { setSecureContext?: (c: TlsPair) => void }).setSecureContext;
      if (typeof inPlace === "function") return inPlace.call(server, t);
      const old = server;
      // It stops listening now; its open connections (a live page) finish on their own.
      old.close();
      server = tlsServer(t, host, handler);
      await listen(server, a.port, o.hostname);
    },
  };
}
