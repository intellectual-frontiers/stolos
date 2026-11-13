// Never send a secret (spec 025, Article 13): everything that goes into a
// message (body, subject, attachments that are text) passes through here.

const PATTERNS: Array<[RegExp, string]> = [
  [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    "[redacted private key]",
  ],
  [/\bgh[pousr]_[A-Za-z0-9]{30,}\b/g, "[redacted GitHub token]"],
  [/\bgithub_pat_[A-Za-z0-9_]{40,}\b/g, "[redacted GitHub token]"],
  [/\bsk-ant-[A-Za-z0-9_-]{20,}\b/g, "[redacted Anthropic key]"],
  [/\$(?:6|y|2[aby]|gy)\$[^\s:"']{8,}/g, "[redacted password hash]"],
  [/\bya29\.[A-Za-z0-9._-]{20,}/g, "[redacted Google access token]"],
  [/\b1\/\/[A-Za-z0-9_-]{30,}/g, "[redacted Google refresh token]"],
  [/\bGOCSPX-[A-Za-z0-9_-]{20,}/g, "[redacted Google client secret]"],
  // Cloudflare's scannable API tokens (account cfat_, user cfut_), and Postfix's sasl_passwd form.
  [/\bcf[au]t_[A-Za-z0-9_-]{20,}/g, "[redacted Cloudflare API token]"],
  [/(api_token:)\S+/g, "$1[redacted]"],
  [/(Authorization:\s*Bearer\s+)\S+/gi, "$1[redacted]"],
  [
    /("?(?:refresh_token|access_token|client_secret|app_?password|password|token)"?\s*[:=]\s*"?)[^"\s,}]{6,}/gi,
    "$1[redacted]",
  ],
  [/([A-Z][A-Z0-9_]*_(?:OAUTH_TOKEN|API_KEY)=)\S+/g, "$1[redacted]"],
];

/** Redact known secret shapes, and these exact strings (for example the credential in use). */
export function redact(text: string, exact: string[] = []): string {
  let out = text;
  for (const s of exact.filter((x) => x && x.length >= 8)) out = out.split(s).join("[redacted]");
  for (const [re, by] of PATTERNS) out = out.replace(re, by);
  return out;
}
