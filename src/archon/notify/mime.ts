/**
 * Mail messages for archon notify (spec 025): RFC 5322 with MIME, a plain-text
 * part and a simple HTML part, and small attachments. Built here (TypeScript,
 * Article 4) so the boot machine on Windows and the hosts send the same thing.
 *
 * @module
 */

import { toBase64 } from "@intellectual-frontiers/commons/ts/kernel";

/** A file attached to a message. */
export interface Attachment {
  /** The file name the recipient sees (for example `apply.log`). */
  name: string;
  /** Its MIME type (for example `text/plain` or `application/gzip`). */
  type: string;
  /** Its contents, raw bytes (base64-encoded when the message is built). */
  data: Uint8Array;
}

/** One mail message, before it is encoded (buildMime). */
export interface Mail {
  /** The sender's address (for example `root+alpha.lab@example.com`). */
  from: string;
  /** Display name for From ("alpha (Archon)"). */
  fromName?: string;
  /** The recipient's address. */
  to: string;
  /** The subject line, any text (RFC 2047-encoded when not plain ASCII). */
  subject: string;
  /** The plain-text part. */
  text: string;
  /** The HTML part (the same content, simply styled). */
  html: string;
  /** Files to attach; none by default. */
  attachments?: Attachment[];
  /** Extra headers (for example `Reply-To`), values encoded like the subject. */
  headers?: Record<string, string>;
}

const enc = new TextEncoder();

/** A header value, RFC 2047-encoded when it is not plain ASCII. */
export function headerValue(s: string): string {
  return /^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${toBase64(enc.encode(s))}?=`;
}

/** A display name: quoted when plain ASCII (RFC 5322), RFC 2047-encoded otherwise. */
export function displayName(s: string): string {
  return /^[\x20-\x7e]*$/.test(s) ? `"${s.replace(/["\\]/g, "\\$&")}"` : headerValue(s);
}

const wrap = (b64: string): string => b64.replace(/.{1,76}/g, "$&\r\n");

/** Escape `&`, `<` and `>` for HTML text (not for attribute values: quotes are kept). */
export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * The body as one MIME entity (CRLF line ends): its Content-Type header, a
 * blank line, then a multipart/mixed body (plain text and HTML as
 * multipart/alternative, base64), then each attachment. buildMime puts the
 * message headers in front; spec 092 encrypts it whole (S/MIME).
 */
export function mimeEntity(
  m: Pick<Mail, "text" | "html" | "attachments">,
  boundarySeed: string = crypto.randomUUID(),
): string {
  const mixed = `archon-mixed-${boundarySeed}`;
  const alt = `archon-alt-${boundarySeed}`;
  const parts = [
    `Content-Type: multipart/mixed; boundary="${mixed}"`,
    "",
    `--${mixed}`,
    `Content-Type: multipart/alternative; boundary="${alt}"`,
    "",
    `--${alt}`,
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    wrap(toBase64(enc.encode(m.text))),
    `--${alt}`,
    "Content-Type: text/html; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    wrap(toBase64(enc.encode(m.html))),
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
      wrap(toBase64(a.data)),
    );
  }
  parts.push(`--${mixed}--`, "");
  return parts.join("\r\n");
}

/**
 * The whole message as RFC 5322 text with CRLF line ends: headers, a
 * multipart/alternative body (plain text and HTML, base64), then each
 * attachment. `boundarySeed` names the MIME boundaries (random by default;
 * fixed in tests). Date and Message-ID are set here.
 */
export function buildMime(m: Mail, boundarySeed = crypto.randomUUID()): string {
  const head = [
    `From: ${m.fromName ? `${displayName(m.fromName)} <${m.from}>` : m.from}`,
    `To: ${m.to}`,
    `Subject: ${headerValue(m.subject)}`,
    `Date: ${new Date().toUTCString().replace("GMT", "+0000")}`,
    `Message-ID: <${crypto.randomUUID()}@archon>`,
    "MIME-Version: 1.0",
    ...Object.entries(m.headers ?? {}).map(([k, v]) => `${k}: ${headerValue(v)}`),
  ];
  return [...head, mimeEntity(m, boundarySeed)].join("\r\n");
}
