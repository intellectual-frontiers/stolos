/**
 * Mail messages for archon notify (spec 025): RFC 5322 with MIME, a plain-text
 * part and a simple HTML part, and small attachments. Built here (TypeScript,
 * Article 4) so the boot machine on Windows and the hosts send the same thing.
 *
 * @module
 */

export interface Attachment {
  name: string;
  type: string;
  data: Uint8Array;
}

export interface Mail {
  from: string;
  /** Display name for From ("alpha (Archon)"). */
  fromName?: string;
  to: string;
  subject: string;
  text: string;
  html: string;
  attachments?: Attachment[];
  headers?: Record<string, string>;
}

const enc = new TextEncoder();

export function base64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

export const base64url = (bytes: Uint8Array) =>
  base64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** A header value, RFC 2047-encoded when it is not plain ASCII. */
export function headerValue(s: string): string {
  return /^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${base64(enc.encode(s))}?=`;
}

/** A display name: quoted when plain ASCII (RFC 5322), RFC 2047-encoded otherwise. */
export function displayName(s: string): string {
  return /^[\x20-\x7e]*$/.test(s) ? `"${s.replace(/["\\]/g, "\\$&")}"` : headerValue(s);
}

const wrap = (b64: string) => b64.replace(/.{1,76}/g, "$&\r\n");

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function buildMime(m: Mail, boundarySeed = crypto.randomUUID()): string {
  const mixed = `archon-mixed-${boundarySeed}`;
  const alt = `archon-alt-${boundarySeed}`;
  const head = [
    `From: ${m.fromName ? `${displayName(m.fromName)} <${m.from}>` : m.from}`,
    `To: ${m.to}`,
    `Subject: ${headerValue(m.subject)}`,
    `Date: ${new Date().toUTCString().replace("GMT", "+0000")}`,
    `Message-ID: <${crypto.randomUUID()}@archon>`,
    "MIME-Version: 1.0",
    ...Object.entries(m.headers ?? {}).map(([k, v]) => `${k}: ${headerValue(v)}`),
    `Content-Type: multipart/mixed; boundary="${mixed}"`,
  ];
  const parts = [
    `--${mixed}`,
    `Content-Type: multipart/alternative; boundary="${alt}"`,
    "",
    `--${alt}`,
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    wrap(base64(enc.encode(m.text))),
    `--${alt}`,
    "Content-Type: text/html; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    wrap(base64(enc.encode(m.html))),
    `--${alt}--`,
    "",
  ];
  for (const a of m.attachments ?? []) {
    parts.push(
      `--${mixed}`,
      `Content-Type: ${a.type}; name="${a.name}"`,
      `Content-Disposition: attachment; filename="${a.name}"`,
      "Content-Transfer-Encoding: base64",
      "",
      wrap(base64(a.data)),
    );
  }
  parts.push(`--${mixed}--`, "");
  return [...head, "", ...parts].join("\r\n");
}
