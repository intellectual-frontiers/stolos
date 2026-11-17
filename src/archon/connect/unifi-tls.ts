/**
 * Spec 109-integrations-api FR-012: how a connector trusts a controller whose certificate no public authority signed (a UniFi
 * controller's own, usually). TLS verification is never switched off: a connection is made only to a server that is
 *
 * - **pinned**: its leaf certificate has exactly the SHA-256 fingerprint the person approved (the chain is not checked: a self-signed
 *   certificate has none; the exact certificate is the trust, which is stronger than a chain), or
 * - **in a CA set**: its certificate verifies against the CA certificates given in the connector's settings, host name included
 *   (Node's own verification, `ca`), or
 * - **public**: where neither is given, it verifies against the system's roots.
 *
 * The check is made on the TLS socket **before any byte of the request is written**, so the API key never reaches a server that is not
 * the trusted one. `fetch` takes no per-host certificate options on both runtimes, so the request is written here, over that socket
 * (HTTP/1.1, `Connection: close`, no compression), and the answer is read to its end; the result is a `fetch` for the runtime's
 * `liveTransport`, so the guard, the backoff and the credential policy of spec 089 still apply to it.
 *
 * {@link probeCertificate} is what `stolos connect` uses to show a certificate to a person (trust on first use, as SSH host keys): it
 * reads the certificate and closes, and sends nothing.
 *
 * ```mermaid
 * sequenceDiagram
 *   participant C as stolos connect / observe
 *   participant U as the controller
 *   C->>U: TCP + TLS handshake (no request yet)
 *   U-->>C: certificate
 *   alt pinned
 *     C->>C: SHA-256 of the certificate = the pin?
 *   else CA set / public
 *     C->>C: chain and host name verify?
 *   end
 *   C-->>U: nothing, and the socket closes, if not
 *   C->>U: GET /integration/v1/... with X-API-KEY (only now)
 *   U-->>C: the answer, to the end of the connection
 * ```
 *
 * @module
 */
// Spec: 109-integrations-api FR-012, FR-020

import { createHash } from "node:crypto";
import { isIP } from "node:net";
import tls from "node:tls";

/** How the controller's certificate is trusted (see the module's description). */
export type TlsTrust =
  | { readonly mode: "pinned"; readonly sha256: string }
  | { readonly mode: "ca"; readonly ca: string }
  | { readonly mode: "system" };

/** A SHA-256 fingerprint as one comparable word: lower-case hex, no separators (`AA:BB:...` and `aabb...` are the same). */
export function normalizeFingerprint(f: string): string {
  return f
    .trim()
    .toLowerCase()
    .replace(/[^0-9a-f]/g, "");
}

/** Whether a text is a SHA-256 fingerprint: 64 hex digits, with or without colons. */
export function isFingerprint(f: string): boolean {
  return /^[0-9a-f]{64}$/.test(normalizeFingerprint(f)) && /^[0-9a-fA-F:\s]+$/.test(f.trim());
}

/** A fingerprint as people write it: upper-case pairs, colons between. */
export function showFingerprint(f: string): string {
  return (normalizeFingerprint(f).match(/../g) ?? []).join(":").toUpperCase();
}

/** The trust a credential asks for: its pinned fingerprint, else its CA set, else the system's roots. */
export function trustOf(cred: Readonly<Record<string, string>>): TlsTrust {
  const pin = (cred["fingerprint"] ?? "").trim();
  if (pin !== "") {
    if (!isFingerprint(pin)) throw new Error("the fingerprint is not a SHA-256 (64 hex digits)");
    return { mode: "pinned", sha256: normalizeFingerprint(pin) };
  }
  const ca = (cred["ca"] ?? "").trim();
  if (ca !== "") {
    if (!ca.includes("BEGIN CERTIFICATE")) throw new Error("the CA is not a PEM certificate");
    return { mode: "ca", ca };
  }
  return { mode: "system" };
}

/** The certificate on the other end is not the pinned one: the controller's certificate changed, or this is not the controller. */
export class CertificateChanged extends Error {
  /** What was pinned. */
  readonly expected: string;
  /** What the server presented. */
  readonly actual: string;
  constructor(host: string, expected: string, actual: string) {
    super(
      `the certificate of ${host} is not the pinned one (expected ${showFingerprint(expected)}, got ${showFingerprint(actual)}); if you changed it, run stolos connect to pin the new one`,
    );
    this.name = "CertificateChanged";
    this.expected = expected;
    this.actual = actual;
  }
}

/** Time to complete the TLS handshake, and the most an answer may hold. */
const CONNECT_MS = 10_000;
const MAX_BODY = 32 * 1024 * 1024;

/** The SHA-256 of a certificate's DER bytes, as the normalized fingerprint. */
function fingerprintOf(cert: { raw?: Buffer }): string {
  if (cert.raw === undefined) throw new Error("the server presented no certificate");
  return createHash("sha256").update(cert.raw).digest("hex");
}

/** A connection that has been trusted, or an Error saying why it was not (nothing has been written to it). */
function trustedSocket(
  host: string,
  port: number,
  trust: TlsTrust,
  signal?: AbortSignal | null,
): Promise<tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    const options: tls.ConnectionOptions = {
      host,
      port,
      ALPNProtocols: ["http/1.1"],
      // An address has no server name (RFC 6066 section 3).
      ...(isIP(host) === 0 ? { servername: host } : {}),
      // Pinned: the certificate chain is not what is trusted, the exact certificate is, and it is compared below, before any write.
      ...(trust.mode === "pinned" ? { rejectUnauthorized: false } : {}),
      ...(trust.mode === "ca" ? { ca: trust.ca } : {}),
    };
    const socket = tls.connect(options);
    const fail = (e: Error): void => {
      clearTimeout(timer);
      socket.destroy();
      reject(e);
    };
    const timer = setTimeout(
      () => fail(new Error(`no TLS handshake with ${host}:${port} in ${CONNECT_MS / 1000} s`)),
      CONNECT_MS,
    );
    signal?.addEventListener(
      "abort",
      () => fail(new Error(`${host}:${port}: the request timed out`)),
      {
        once: true,
      },
    );
    socket.once("error", fail);
    socket.once("secureConnect", () => {
      clearTimeout(timer);
      if (trust.mode === "pinned") {
        const got = fingerprintOf(socket.getPeerCertificate());
        if (got !== trust.sha256)
          return fail(new CertificateChanged(`${host}:${port}`, trust.sha256, got));
      }
      socket.off("error", fail);
      resolve(socket);
    });
  });
}

/** What a certificate says of itself, for a person to approve. */
export interface CertificateInfo {
  /** The host and port that presented it. */
  readonly host: string;
  /** Its SHA-256 fingerprint (normalized). */
  readonly sha256: string;
  /** Its subject's common name, when it has one. */
  readonly subject: string;
  /** Its issuer's common name (the same as the subject's for a self-signed certificate). */
  readonly issuer: string;
  /** When it expires. */
  readonly validTo: string;
  /** Whether the system's roots trust it (then there is nothing to pin). */
  readonly trusted: boolean;
}

/** The common name of a certificate's subject or issuer (Node gives one name, or several when the certificate repeats it). */
function commonName(n: { CN?: string | string[] } | undefined): string {
  const cn = n?.CN;
  return (Array.isArray(cn) ? cn.join(", ") : cn) ?? "(no name)";
}

/** Open a connection only to read its certificate, and close it: nothing is sent. */
function readCertificate(
  host: string,
  port: number,
  verify: boolean,
): Promise<tls.PeerCertificate> {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({
      host,
      port,
      ...(isIP(host) === 0 ? { servername: host } : {}),
      rejectUnauthorized: verify,
    });
    const fail = (e: Error): void => {
      clearTimeout(timer);
      socket.destroy();
      reject(e);
    };
    const timer = setTimeout(
      () => fail(new Error(`no TLS handshake with ${host}:${port} in ${CONNECT_MS / 1000} s`)),
      CONNECT_MS,
    );
    socket.once("error", fail);
    socket.once("secureConnect", () => {
      clearTimeout(timer);
      const cert = socket.getPeerCertificate();
      socket.destroy();
      resolve(cert);
    });
  });
}

/**
 * The certificate a controller presents, and whether the system's roots trust it, without sending anything. Verification is not
 * switched off for any request: this only reads, to show the person what they would be trusting.
 */
export async function probeCertificate(host: string, port: number): Promise<CertificateInfo> {
  const describe = (c: tls.PeerCertificate, trusted: boolean): CertificateInfo => ({
    host: `${host}:${port}`,
    sha256: fingerprintOf(c),
    subject: commonName(c.subject),
    issuer: commonName(c.issuer),
    validTo: c.valid_to,
    trusted,
  });
  try {
    return describe(await readCertificate(host, port, true), true);
  } catch (verified) {
    // Not trusted by the roots (or not reachable: the second read says which).
    try {
      return describe(await readCertificate(host, port, false), false);
    } catch {
      throw verified;
    }
  }
}

/** Where a controller is, from its address as a person writes it (`192.0.2.1`, `https://unifi.example.net/`). */
export function controllerOf(address: string): URL {
  const text = address.trim();
  const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`);
  if (u.protocol !== "https:") throw new Error("the controller is read over https only");
  return u;
}

/** The status line, headers and body of a response held in memory. */
function parse(raw: Buffer): {
  status: number;
  statusText: string;
  headers: Headers;
  body: Buffer;
} {
  const end = raw.indexOf("\r\n\r\n");
  if (end < 0) throw new Error("the controller answered with no header");
  const head = raw.subarray(0, end).toString("latin1").split("\r\n");
  const m = /^HTTP\/1\.[01] (\d{3})\s?(.*)$/.exec(head[0] ?? "");
  if (!m?.[1]) throw new Error("the controller did not answer in HTTP");
  const headers = new Headers();
  for (const line of head.slice(1)) {
    const i = line.indexOf(":");
    if (i > 0) headers.append(line.slice(0, i).trim(), line.slice(i + 1).trim());
  }
  let body: Buffer<ArrayBufferLike> = raw.subarray(end + 4);
  if ((headers.get("transfer-encoding") ?? "").toLowerCase().includes("chunked")) {
    const parts: Buffer[] = [];
    let at = 0;
    for (;;) {
      const eol = body.indexOf("\r\n", at);
      if (eol < 0) break;
      const size = parseInt(body.subarray(at, eol).toString("latin1").split(";")[0] ?? "", 16);
      if (!Number.isFinite(size) || size === 0) break;
      parts.push(body.subarray(eol + 2, eol + 2 + size));
      at = eol + 2 + size + 2;
    }
    body = Buffer.concat(parts);
  } else {
    const n = Number(headers.get("content-length"));
    if (Number.isInteger(n) && n >= 0 && n <= body.length) body = body.subarray(0, n);
  }
  return { status: Number(m[1]), statusText: m[2] ?? "", headers, body };
}

/**
 * A `fetch` that trusts as `trust` says (see the module's description): https only, a time limit on the handshake and the whole request,
 * the answer read to its end. It is for `http.liveTransport({ fetch })`, which adds the guard's neighbours (backoff, the time limit).
 */
export function trustedFetch(trust: TlsTrust): typeof fetch {
  const send = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const u = controllerOf(input instanceof Request ? input.url : String(input));
    const port = u.port === "" ? 443 : Number(u.port);
    const host = u.hostname.replace(/^\[|\]$/g, "");
    const signal = init?.signal ?? null;
    const socket = await trustedSocket(host, port, trust, signal);
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? init.body : undefined;
    const headers = new Headers(init?.headers);
    const lines = [`${method} ${u.pathname}${u.search} HTTP/1.1`, `Host: ${u.host}`];
    for (const [k, v] of headers) {
      if (["host", "connection", "content-length", "accept-encoding"].includes(k.toLowerCase()))
        continue;
      lines.push(`${k}: ${v}`);
    }
    lines.push("Accept-Encoding: identity", "Connection: close");
    if (body !== undefined) lines.push(`Content-Length: ${Buffer.byteLength(body)}`);
    return await new Promise<Response>((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      const fail = (e: Error): void => {
        socket.destroy();
        reject(e);
      };
      signal?.addEventListener(
        "abort",
        () => fail(new Error(`${host}:${port}: the request timed out`)),
        {
          once: true,
        },
      );
      socket.on("data", (d: Buffer) => {
        size += d.length;
        if (size > MAX_BODY)
          return fail(new Error(`${host}:${port}: the answer is over ${MAX_BODY} bytes`));
        chunks.push(d);
      });
      socket.once("error", fail);
      socket.once("close", () => {
        try {
          const r = parse(Buffer.concat(chunks));
          const none = method === "HEAD" || [204, 205, 304].includes(r.status);
          resolve(
            new Response(none ? null : new Uint8Array(r.body), {
              status: r.status,
              statusText: r.statusText,
              headers: r.headers,
            }),
          );
        } catch (e) {
          reject(e instanceof Error ? e : new Error(String(e)));
        }
      });
      socket.write(`${lines.join("\r\n")}\r\n\r\n${body ?? ""}`);
    });
  };
  // `fetch` of the runtime has statics of its own (`preconnect` on Bun); a transport calls only the function.
  return Object.assign(send, { preconnect: () => undefined });
}
