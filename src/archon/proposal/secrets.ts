/**
 * Spec 095-proposals, Article 13: no secret ever leaves a server in a
 * proposal. A path in the secret inventory (by its file name), a path that is
 * secret on every host (`/etc/shadow`, SSH host keys, `/var/lib/archon-keys`),
 * and content that looks like a key are sent as a SHA-256 hash only. A file's
 * content is sent only when it is small, text, and not secret.
 *
 * @module
 */

import { redact } from "../notify/redact.ts";
import { patternOf, SECRET_INVENTORY } from "../model/secret-inventory.ts";
import type { FileEvidence } from "./types.ts";

/** The largest file whose content a proposal carries. */
export const MAX_CONTENT = 16_384;

/** Paths that are secret on every host. */
const HOST_SECRETS: RegExp[] = [
  /^\/etc\/g?shadow-?$/,
  /^\/etc\/ssh\/ssh_host_[a-z0-9]+_key$/,
  /^\/etc\/ssl\/private\//,
  /^\/var\/lib\/archon-keys\//,
  /^\/etc\/postfix\/sasl_passwd/,
  /^\/etc\/archon\/.*(credential|token|secret|password|key)/i,
  /^\/root\/\.ssh\//,
  /\/\.ssh\/id_[a-z0-9]+$/,
  /\.(key|pem|p12|pfx|jks|keystore|kdbx)$/i,
  /(secret|token|passw(or)?d|credential|private)[^/]*$/i,
];

/** Whether a path is secret: on every host, or by its file name in the secret inventory. */
export function isSecretPath(path: string): boolean {
  if (HOST_SECRETS.some((re) => re.test(path))) return true;
  const base = path.split("/").pop() ?? "";
  return SECRET_INVENTORY.some((s) => {
    const last = s.path.split("/").pop() ?? "";
    return !last.includes(" ") && patternOf(last).test(base);
  });
}

/** Text that looks like it holds a key, a token, or a password (redaction would change it, or a long random string). */
export function looksSecret(text: string): boolean {
  if (redact(text) !== text) return true;
  if (/BEGIN [A-Z ]*(PRIVATE KEY|OPENSSH)/.test(text)) return true;
  // A long run of base64-like characters with digits and mixed case: a key or token.
  for (const m of text.matchAll(/[A-Za-z0-9+/_=-]{40,}/g)) {
    const s = m[0];
    if (/[0-9]/.test(s) && /[a-z]/.test(s) && /[A-Z]/.test(s)) return true;
  }
  return false;
}

/** SHA-256 of bytes, as hex. */
export async function sha256Hex(data: Uint8Array | string): Promise<string> {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const d = await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * A file's evidence: always its hash and size; its content (and diff) only for
 * a small text file that is not secret by path or by content.
 */
export async function fileEvidence(
  path: string,
  data: Uint8Array,
  meta: { mode?: string; owner?: string; group?: string; diff?: string } = {},
): Promise<FileEvidence> {
  const base: FileEvidence = {
    path,
    sha256: await sha256Hex(data),
    size: data.length,
    ...(meta.mode ? { mode: meta.mode } : {}),
    ...(meta.owner ? { owner: meta.owner } : {}),
    ...(meta.group ? { group: meta.group } : {}),
  };
  if (isSecretPath(path)) return { ...base, withheld: "a secret path (hash only, Article 13)" };
  if (data.length > MAX_CONTENT) return { ...base, withheld: `larger than ${MAX_CONTENT} bytes` };
  if (data.includes(0)) return { ...base, withheld: "not text" };
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(data);
  } catch {
    return { ...base, withheld: "not UTF-8 text" };
  }
  if (looksSecret(text)) return { ...base, withheld: "looks like it holds a secret (hash only)" };
  const diff = meta.diff && !looksSecret(meta.diff) ? meta.diff : undefined;
  return { ...base, content: text, ...(diff ? { diff } : {}) };
}
