/**
 * How mail leaves (spec 025, spec 027): Cloudflare Email Service's
 * authenticated SMTP submission, smtp.mx.cloudflare.net:465 with implicit TLS,
 * user "api_token", the password a Cloudflare API token with Email Sending:
 * Edit. Cloudflare signs with DKIM for the onboarded sending domain.
 *
 * archon's own messages go straight there with curl (Cloudflare's own example
 * client), so archon keeps its queue, dedupe, and outage summary. Everything
 * else on a server (apps, cron, unattended-upgrades) goes through Postfix,
 * which relays to the same place with the same token (capabilities/mail.ts).
 * curl reads its configuration, token included, on stdin (`-K -`): never in
 * argv, never in a process listing.
 *
 * @module
 */

import { run } from "../core/exec.ts";

/** The SMTP relay, host:port, when the fleet names none (`fleet.mail.relay`): Cloudflare, implicit TLS. */
export const DEFAULT_RELAY = "smtp.mx.cloudflare.net:465";
/** Cloudflare's SMTP user name: the literal string api_token. */
export const RELAY_USER = "api_token";

/**
 * A machine's sender (spec 027): <user>+<host>[.<tag>]@<domain>, one onboarded
 * domain for the whole fleet, the machine in the subaddress (RFC 5233).
 */
export function senderAddress(
  mail: { domain: string; tag?: string },
  host: string,
  user: string,
): string {
  return `${user}+${hostLabel(mail, host)}@${mail.domain}`;
}

/** The detail part of the subaddress: alpha.lab. */
export const hostLabel = (mail: { tag?: string }, host: string): string =>
  mail.tag ? `${host}.${mail.tag}` : host;

/** The credential: a Cloudflare API token with the Email Sending: Edit permission. */
export interface Credential {
  /** The API token (the SMTP password). A secret: never logged or sent. */
  token: string;
  /** When it was made (ISO 8601); empty when read back from sasl_passwd. */
  created: string;
}

/** Every secret string a credential holds (for redaction). */
export function secretsOf(c: Credential | undefined): string[] {
  return c ? [c.token] : [];
}

const quote = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

/** Split `host:port`; the port is 465 when missing or not a number. */
export function relayParts(relay = DEFAULT_RELAY): { host: string; port: number } {
  const [host, port] = relay.split(":");
  return { host, port: Number(port) || 465 };
}

/** curl's configuration for one SMTP session with the relay (token included: stdin only). */
export function smtpConfig(
  c: Credential,
  o: { relay?: string; ipv4: boolean; from?: string; to?: string; file?: string },
): string {
  const { host, port } = relayParts(o.relay);
  const lines = [
    `url = ${quote(`smtps://${host}:${port}`)}`,
    `user = ${quote(`${RELAY_USER}:${c.token}`)}`,
    "ssl-reqd",
    "silent",
    "show-error",
    "connect-timeout = 10",
    "max-time = 120",
  ];
  if (o.ipv4) lines.push("ipv4");
  if (o.file) {
    lines.push(
      `mail-from = ${quote(o.from!)}`,
      `mail-rcpt = ${quote(o.to!)}`,
      `upload-file = ${quote(o.file)}`,
    );
  } else {
    // No message: EHLO, AUTH, then NOOP (curl authenticates before the command).
    lines.push(`request = "NOOP"`);
  }
  return lines.join("\n") + "\n";
}

/** A plausible email address (one @, a dot in the domain, no spaces or angle brackets). */
export const EMAIL: RegExp = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;

/**
 * What a failed SMTP session means, in plain words: the step that failed (log
 * in, the sender, the recipient, the message), what was tried there, the
 * server's reply code, and the likely fix. curl reports the step and the code
 * ("RCPT failed: 500"); the token is never part of it.
 */
export function smtpError(
  exit: number,
  stderr: string,
  ctx: { from?: string; to?: string; relay?: string } = {},
): string {
  const msg = stderr.trim().replace(/^curl: \(\d+\) /, "");
  const relay = ctx.relay ?? DEFAULT_RELAY;
  const code = msg.match(/failed: (\d{3})/)?.[1];
  const said = code ? ` (the server answered ${code})` : "";
  if (exit === 67 || /535|Login denied/i.test(msg)) {
    return `logging in to ${relay} failed: Cloudflare refused the API token${said}. It is revoked, expired, or lacks Email Sending: Edit; make a new one: deno task stolos boot mail-setup`;
  }
  if (/RCPT failed/i.test(msg)) {
    const to = ctx.to ?? "?";
    return EMAIL.test(to)
      ? `${relay} refused the recipient ${to}${said}: check the address in fleet.mail.to (fleets/<fleet>/fleet.ts) for a typo, or a mailbox that does not exist`
      : `${relay} refused the recipient ${
        JSON.stringify(to)
      }${said}: it is not an email address. Set fleet.mail.to in fleets/<fleet>/fleet.ts to the shared mailbox (for example ops@example.com)`;
  }
  if (/MAIL failed|\b550\b/i.test(msg)) {
    const domain = ctx.from?.split("@")[1] ?? "the sender's domain";
    return `${relay} refused the sender ${
      ctx.from ?? "?"
    }${said}: is ${domain} onboarded for Email Sending in Cloudflare (Compute > Email Service > Email Sending)?`;
  }
  if (/DATA failed|upload|\b55[24]\b/i.test(msg)) {
    return `${relay} refused the message itself${said}: too large, or its content was rejected (${msg})`;
  }
  if (exit === 6) return `${relay}'s name could not be resolved: check this machine's DNS (${msg})`;
  if (exit === 7) {
    return `could not connect to ${relay}: the network or a firewall blocks it (outbound port ${
      relayParts(relay).port
    }) (${msg})`;
  }
  if (exit === 28) return `${relay} did not answer in time: check the network (${msg})`;
  if (exit === 35 || exit === 60) return `the TLS connection to ${relay} failed (${msg})`;
  return `sending through ${relay} failed: ${msg || `curl exit ${exit}`}`;
}

/** Send one RFC 5322 message (CRLF line ends) through the relay. */
export async function sendSmtp(
  c: Credential,
  o: { relay?: string; ipv4: boolean; from: string; to: string },
  mime: string,
): Promise<string> {
  const file = await Deno.makeTempFile({ prefix: "archon-mail-", suffix: ".eml" });
  try {
    await Deno.writeTextFile(file, mime, { mode: 0o600 });
    const r = await run(["curl", "-K", "-"], { stdin: smtpConfig(c, { ...o, file }) });
    if (!r.ok) throw new Error(smtpError(r.code, r.stderr, o));
    return "sent";
  } finally {
    await Deno.remove(file).catch(() => {});
  }
}

/** Log in to the relay and leave, sending nothing (archon doctor, mail-setup). */
export async function probeSmtp(
  c: Credential,
  o: { relay?: string; ipv4: boolean },
): Promise<void> {
  const r = await run(["curl", "-K", "-"], { stdin: smtpConfig(c, o) });
  if (!r.ok) throw new Error(smtpError(r.code, r.stderr, o));
}

// ------------------------------------------------------------- on hosts

/** Postfix's SMTP client credential: one line, root only (capabilities/mail.ts). */
export const SASL_PASSWD = "/etc/postfix/sasl_passwd";

/**
 * The text of Postfix's sasl_passwd for this credential: a comment, then
 * `[host]:port api_token:<token>`. It holds the token: write it root only.
 */
export function saslPasswd(c: Credential, relay = DEFAULT_RELAY): string {
  const { host, port } = relayParts(relay);
  return `# Written by archon mail credential (spec 027). Root only.\n[${host}]:${port} ${RELAY_USER}:${c.token}\n`;
}

/** The token back out of Postfix's file (archon's own sends use the same one). */
export function parseSaslPasswd(text: string): Credential | undefined {
  const m = text.match(/^\[[^\]]+\]:\d+\s+api_token:(\S+)\s*$/m);
  return m ? { token: m[1], created: "" } : undefined;
}
