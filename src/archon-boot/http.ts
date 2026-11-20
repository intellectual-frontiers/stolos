/**
 * A small HTTP/1.1 server for archon-boot (spec 004), on raw TCP. A web server's
 * `Headers` keep names in lowercase, which HTTP allows, but GRUB's HTTP client compares
 * "Content-Length: " case-sensitively and then reads every file as empty.
 * This transport writes canonical header names, keeps connections alive
 * (GRUB sends HEAD then GET on one connection), and streams bodies.
 *
 * @module
 */
// Spec: 004-install
// Spec: 103-three-ports FR-001, FR-004, FR-011

import { tcp } from "@intellectual-frontiers/net";
import { standardPort } from "../archon/core/listeners.ts";

/** Answers one request; `from` is the client's address. */
export type Handler = (req: Request, from: string) => Promise<Response>;

const CANON: Record<string, string> = {
  "content-type": "Content-Type",
  "content-length": "Content-Length",
  "content-range": "Content-Range",
  "accept-ranges": "Accept-Ranges",
  connection: "Connection",
  date: "Date",
  location: "Location",
};

const canonical = (name: string): string =>
  CANON[name] ?? name.replace(/(^|-)([a-z])/g, (_m, d: string, c: string) => d + c.toUpperCase());

const REASON: Record<number, string> = {
  200: "OK",
  206: "Partial Content",
  400: "Bad Request",
  403: "Forbidden",
  404: "Not Found",
  500: "Internal Server Error",
};

const enc = new TextEncoder();
const dec = new TextDecoder();

function indexOfCrlfCrlf(buf: Uint8Array, len: number): number {
  for (let i = 0; i + 3 < len; i++) {
    if (buf[i] === 13 && buf[i + 1] === 10 && buf[i + 2] === 13 && buf[i + 3] === 10) return i;
  }
  return -1;
}

/** A connection's bytes as they come, kept until a request has used them. */
class Incoming {
  private buf = new Uint8Array(16384);
  private len = 0;
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  constructor(readable: ReadableStream<Uint8Array>) {
    this.reader = readable.getReader();
  }
  /** Read once more into the buffer; false at the end of the connection or past 1 MB. */
  private async more(): Promise<boolean> {
    const r = await this.reader.read();
    if (r.done) return false;
    if (this.len + r.value.length > this.buf.length) {
      if (this.len + r.value.length > 1 << 20) return false;
      const bigger = new Uint8Array(Math.max(this.buf.length * 2, this.len + r.value.length));
      bigger.set(this.buf.subarray(0, this.len));
      this.buf = bigger;
    }
    this.buf.set(r.value, this.len);
    this.len += r.value.length;
    return true;
  }
  /** One request head (without its blank line), or undefined where the connection ended first. */
  async head(): Promise<string | undefined> {
    let end = indexOfCrlfCrlf(this.buf, this.len);
    while (end < 0) {
      if (!(await this.more())) return undefined;
      end = indexOfCrlfCrlf(this.buf, this.len);
    }
    const head = dec.decode(this.buf.subarray(0, end));
    this.take(end + 4);
    return head;
  }
  /** The next `n` bytes (a small request body), or undefined where the connection ended first. */
  async bytes(n: number): Promise<Uint8Array<ArrayBuffer> | undefined> {
    while (this.len < n) if (!(await this.more())) return undefined;
    const out = this.buf.slice(0, n);
    this.take(n);
    return out;
  }
  private take(n: number): void {
    this.buf.copyWithin(0, n, this.len);
    this.len -= n;
  }
  /** Stop reading. */
  release(): void {
    this.reader.releaseLock();
  }
}

async function serveConn(conn: tcp.Conn, handler: Handler, port: number): Promise<void> {
  const from = conn.remoteAddr.hostname;
  const incoming = new Incoming(conn.readable);
  const out = conn.writable.getWriter();
  try {
    while (true) {
      // Read one request head.
      const head = await incoming.head();
      if (head === undefined) return;
      const [requestLine = "", ...lines] = head.split("\r\n");
      const [method = "GET", target = "/"] = requestLine.split(" ");
      const headers = new Headers();
      for (const l of lines) {
        const i = l.indexOf(":");
        if (i > 0) headers.append(l.slice(0, i).trim(), l.slice(i + 1).trim());
      }
      // A small request body (the installer's POST .../done).
      const body = await incoming.bytes(Number(headers.get("content-length") ?? 0));
      if (body === undefined) return;

      const host = headers.get("host") ?? `localhost:${port}`;
      const req = new Request(`http://${host}${target}`, {
        method,
        headers,
        ...(method === "GET" || method === "HEAD" ? {} : { body }),
      });
      const res = await handler(req, from);
      // UEFI's HTTP driver (which Ubuntu's GRUB uses after HTTP Boot) waits
      // for a body after HEAD on a kept-alive connection; close after HEAD so
      // its next request starts on a fresh connection.
      const keepAlive =
        method !== "HEAD" && (headers.get("connection") ?? "").toLowerCase() !== "close";
      let head2 = `HTTP/1.1 ${res.status} ${REASON[res.status] ?? "OK"}\r\n`;
      const resHeaders = new Headers(res.headers);
      let bodyBytes: Uint8Array | undefined;
      if (!resHeaders.has("content-length") && res.body) {
        bodyBytes = new Uint8Array(await res.arrayBuffer());
        resHeaders.set("content-length", String(bodyBytes.length));
      }
      if (!res.body) resHeaders.set("content-length", "0");
      resHeaders.set("connection", keepAlive ? "keep-alive" : "close");
      resHeaders.set("date", new Date().toUTCString());
      for (const [k, v] of resHeaders) head2 += `${canonical(k)}: ${v}\r\n`;
      await out.write(enc.encode(head2 + "\r\n"));
      if (method !== "HEAD") {
        if (bodyBytes) await out.write(bodyBytes);
        else if (res.body) {
          for await (const chunk of res.body) await out.write(chunk);
        }
      } else await res.body?.cancel();
      if (!keepAlive) return;
    }
  } catch {
    // Client went away mid-transfer; nothing to do.
  } finally {
    incoming.release();
    out.releaseLock();
    conn.close();
  }
}

/**
 * Listen on `port` on `hostname` (every IPv4 address by default: the machines being installed
 * reach this PC over the LAN) and serve each connection with `handler` in the background. An
 * undefined `port` is the standard one, the ontology's `boot-http` (TCP 8080, Article 29); any other
 * is the caller's explicit choice. Returns the listener so the caller can close it.
 */
export async function listen(
  port: number | undefined,
  handler: Handler,
  hostname = "0.0.0.0",
): Promise<tcp.Listener> {
  const bound = port ?? standardPort("boot-http");
  const listener = await tcp.listen({ port: bound, hostname });
  void (async (): Promise<void> => {
    try {
      for await (const conn of listener) void serveConn(conn, handler, bound);
    } catch {
      /* closed */
    }
  })();
  return listener;
}
