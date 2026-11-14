/**
 * A small HTTP/1.1 server for archon-boot (spec 004). Deno.serve sends header
 * names in lowercase, which HTTP allows, but GRUB's HTTP client compares
 * "Content-Length: " case-sensitively and then reads every file as empty.
 * This transport writes canonical header names, keeps connections alive
 * (GRUB sends HEAD then GET on one connection), and streams bodies.
 *
 * @module
 */

/** Answers one request; `from` is the client's address. */
export type Handler = (req: Request, from: string) => Promise<Response>;

const CANON: Record<string, string> = {
  "content-type": "Content-Type",
  "content-length": "Content-Length",
  "content-range": "Content-Range",
  "accept-ranges": "Accept-Ranges",
  "connection": "Connection",
  "date": "Date",
  "location": "Location",
};

const canonical = (name: string) =>
  CANON[name] ?? name.replace(/(^|-)([a-z])/g, (_m, d, c) => d + c.toUpperCase());

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

async function writeAll(conn: Deno.Conn, data: Uint8Array) {
  let off = 0;
  while (off < data.length) off += await conn.write(data.subarray(off));
}

async function serveConn(conn: Deno.Conn, handler: Handler, port: number) {
  const from = (conn.remoteAddr as Deno.NetAddr).hostname;
  let buf = new Uint8Array(16384);
  let len = 0;
  try {
    while (true) {
      // Read one request head.
      let end = indexOfCrlfCrlf(buf, len);
      while (end < 0) {
        if (len === buf.length) {
          if (buf.length > 1 << 20) return;
          const bigger = new Uint8Array(buf.length * 2);
          bigger.set(buf.subarray(0, len));
          buf = bigger;
        }
        const n = await conn.read(buf.subarray(len));
        if (n === null) return;
        len += n;
        end = indexOfCrlfCrlf(buf, len);
      }
      const head = dec.decode(buf.subarray(0, end));
      let rest = buf.slice(end + 4, len);
      const [requestLine, ...lines] = head.split("\r\n");
      const [method, target] = requestLine.split(" ");
      const headers = new Headers();
      for (const l of lines) {
        const i = l.indexOf(":");
        if (i > 0) headers.append(l.slice(0, i).trim(), l.slice(i + 1).trim());
      }
      // A small request body (the installer's POST .../done).
      const bodyLen = Number(headers.get("content-length") ?? 0);
      while (rest.length < bodyLen) {
        const more = new Uint8Array(bodyLen - rest.length);
        const n = await conn.read(more);
        if (n === null) return;
        const joined = new Uint8Array(rest.length + n);
        joined.set(rest);
        joined.set(more.subarray(0, n), rest.length);
        rest = joined;
      }
      const body = rest.subarray(0, bodyLen);
      const leftover = rest.subarray(bodyLen);
      buf = new Uint8Array(Math.max(16384, leftover.length));
      buf.set(leftover);
      len = leftover.length;

      const host = headers.get("host") ?? `localhost:${port}`;
      const req = new Request(`http://${host}${target}`, {
        method,
        headers,
        body: method === "GET" || method === "HEAD" ? undefined : body,
      });
      const res = await handler(req, from);
      // UEFI's HTTP driver (which Ubuntu's GRUB uses after HTTP Boot) waits
      // for a body after HEAD on a kept-alive connection; close after HEAD so
      // its next request starts on a fresh connection.
      const keepAlive = method !== "HEAD" &&
        (headers.get("connection") ?? "").toLowerCase() !== "close";
      let out = `HTTP/1.1 ${res.status} ${REASON[res.status] ?? "OK"}\r\n`;
      const resHeaders = new Headers(res.headers);
      let bodyBytes: Uint8Array | undefined;
      if (!resHeaders.has("content-length") && res.body) {
        bodyBytes = new Uint8Array(await res.arrayBuffer());
        resHeaders.set("content-length", String(bodyBytes.length));
      }
      if (!res.body) resHeaders.set("content-length", "0");
      resHeaders.set("connection", keepAlive ? "keep-alive" : "close");
      resHeaders.set("date", new Date().toUTCString());
      for (const [k, v] of resHeaders) out += `${canonical(k)}: ${v}\r\n`;
      await writeAll(conn, enc.encode(out + "\r\n"));
      if (method !== "HEAD") {
        if (bodyBytes) await writeAll(conn, bodyBytes);
        else if (res.body) { for await (const chunk of res.body) await writeAll(conn, chunk); }
      } else await res.body?.cancel();
      if (!keepAlive) return;
    }
  } catch {
    // Client went away mid-transfer; nothing to do.
  } finally {
    try {
      conn.close();
    } catch { /* already closed */ }
  }
}

/**
 * Listen on `port` on every IPv4 address and serve each connection with
 * `handler` in the background. Returns the listener so the caller can close it.
 */
export function listen(port: number, handler: Handler): Deno.Listener {
  const listener = Deno.listen({ port, hostname: "0.0.0.0" });
  (async () => {
    for await (const conn of listener) serveConn(conn, handler, port);
  })();
  return listener;
}
