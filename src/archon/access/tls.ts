/**
 * Spec 100 FR-002 and FR-003: the console's DNS records, its certificate, and the addresses it may
 * listen on.
 *
 * - DNS (Cloudflare, the token of `boot web-setup`): an A record to this PC's LAN address (not
 *   proxied) for `<pc>.stolos.<domain>` and, on the primary, `stolos.<domain>`; and the heartbeat,
 *   a TXT record `_stolos-console.stolos.<domain>` = `"<pc> <ISO time>"`, every 5 minutes.
 * - The certificate (ACME, the DNS challenge): `<pc>.stolos.<domain>`, `*.stolos.<domain>`, and
 *   `stolos.<domain>` on the primary. It, its key and the ACME account are one secret in the vault
 *   (`console/tls.json`), renewed when 30 days or fewer remain.
 * - Article 28: only a private (RFC 1918) or mesh (100.64.0.0/10) address is ever bound.
 *
 * @module
 */

import {
  type ARecord,
  type Fetch,
  readRecords,
  type TxtRecord,
  upsertRecords,
} from "../web/cloudflare.ts";
import type { ConsoleNames } from "./names.ts";

/** How often the heartbeat is refreshed while the console serves (5 minutes). */
export const HEARTBEAT_MS = 5 * 60_000;

/** A heartbeat older than this means that controller stopped serving (two refreshes missed). */
export const HEARTBEAT_STALE_MS = 12 * 60_000;

/** Renew when this many days or fewer remain. */
export const RENEW_DAYS = 30;

/** The doctor warns (⚡) when fewer than this many days remain. */
export const EXPIRY_WARN_DAYS = 14;

/** The ports tried for HTTPS, in order. */
export const HTTPS_PORTS = [443, 8443];

/** The console's certificate as the vault keeps it (`console/tls.json`). */
export interface TlsMaterial {
  /** The certificate chain (PEM). */
  certificatePem: string;
  /** Its private key (PEM). A secret. */
  privateKeyPem: string;
  /** The ACME account's key, as the ACME client gave it. A secret. */
  accountKey: unknown;
  /** When it expires (ISO). */
  notAfter: string;
  /** The names it covers. */
  names: string[];
  /** The ACME directory that issued it (its issuer). */
  directory: string;
  /** When it was issued (ISO). */
  issued: string;
}

/** What an ACME client gives (commons' `acme.issue`), as this module uses it. */
export type AcmeIssue = (o: {
  directory: string;
  domains: string[];
  accountKey?: unknown;
  contact?: string[];
}) => Promise<
  | {
      kind: "ok";
      value: {
        certificatePem: string;
        privateKeyPem: string;
        accountKey: unknown;
        notAfter: Date | string | number;
      };
    }
  | { kind: "err"; error: string }
>;

/** The issuer's name, for people, from its directory. */
export function issuerName(directory: string): string {
  return /letsencrypt\.org/.test(directory)
    ? /staging/.test(directory)
      ? "Let's Encrypt (staging)"
      : "Let's Encrypt"
    : new URL(directory).host;
}

/** Whether the material must be issued again: none, other names, or 30 days or fewer left. */
export function needsNew(
  t: TlsMaterial | undefined,
  names: readonly string[],
  now: number,
  days = RENEW_DAYS,
): boolean {
  if (!t) return true;
  const want = [...names].sort().join(",");
  if ([...t.names].sort().join(",") !== want) return true;
  return Date.parse(t.notAfter) - now <= days * 86_400_000;
}

/** Days left on a certificate (negative once expired). */
export function daysLeft(notAfter: string, now: number): number {
  return Math.floor((Date.parse(notAfter) - now) / 86_400_000);
}

/** The material from the vault's text, or undefined. */
export function parseTls(text: string | undefined): TlsMaterial | undefined {
  if (!text) return undefined;
  try {
    const t = JSON.parse(text) as TlsMaterial;
    return t.certificatePem && t.privateKeyPem && t.notAfter ? t : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The certificate for these names: the vault's while it is good, else a new one from ACME (kept in
 * the vault through `write`, owner only). Returns it and whether it was issued now, or why not.
 */
export async function ensureCertificate(o: {
  names: string[];
  directory: string;
  issue: AcmeIssue;
  read: () => Promise<string | undefined>;
  write: (text: string) => Promise<void>;
  now?: number;
  contact?: string[];
}): Promise<{ tls: TlsMaterial; issued: boolean } | { why: string; tls?: TlsMaterial }> {
  const now = o.now ?? Date.now();
  const had = parseTls(await o.read());
  if (!needsNew(had, o.names, now)) return { tls: had as TlsMaterial, issued: false };
  const r = await o.issue({
    directory: o.directory,
    domains: o.names,
    ...(had?.accountKey !== undefined ? { accountKey: had.accountKey } : {}),
    ...(o.contact ? { contact: o.contact } : {}),
  });
  if (r.kind === "err") {
    // A certificate still valid keeps serving; a failed renewal is said, and tried again tomorrow.
    return had && Date.parse(had.notAfter) > now ? { why: r.error, tls: had } : { why: r.error };
  }
  const tls: TlsMaterial = {
    certificatePem: r.value.certificatePem,
    privateKeyPem: r.value.privateKeyPem,
    accountKey: r.value.accountKey,
    notAfter: new Date(r.value.notAfter).toISOString(),
    names: [...o.names],
    directory: o.directory,
    issued: new Date(now).toISOString(),
  };
  await o.write(JSON.stringify(tls, null, 2) + "\n");
  return { tls, issued: true };
}

/** The A records this controller keeps: its own name and, on the primary, the base name. */
export function consoleRecords(n: ConsoleNames, address: string): ARecord[] {
  return n.served.map((name) => ({ type: "A", name, content: address }));
}

/** The heartbeat's value: "<pc> <ISO time>". */
export function heartbeatValue(pc: string, now: number): string {
  return `${pc} ${new Date(now).toISOString()}`;
}

/** A heartbeat read back: who serves and when it said so, or undefined. */
export function parseHeartbeat(v: string): { pc: string; at: string } | undefined {
  const m = v.trim().match(/^([a-z0-9-]+) (\d{4}-\d\d-\d\dT[\d:.]+Z)$/);
  return m?.[1] && m[2] ? { pc: m[1], at: m[2] } : undefined;
}

/** Another controller's live heartbeat (not this PC's, and fresh), or undefined. */
export function otherController(
  values: readonly string[],
  pc: string,
  now: number,
): { pc: string; at: string } | undefined {
  for (const v of values) {
    const h = parseHeartbeat(v);
    if (h && h.pc !== pc && now - Date.parse(h.at) < HEARTBEAT_STALE_MS) return h;
  }
  return undefined;
}

/** Keep the console's records in Cloudflare: the A records and the heartbeat. */
export async function keepDns(o: {
  token: string;
  zone: string;
  names: ConsoleNames;
  address: string;
  now?: number;
  fetch?: Fetch;
}): Promise<{ other?: { pc: string; at: string } }> {
  const now = o.now ?? Date.now();
  const f = o.fetch ?? fetch;
  // Before writing ours: another controller's live heartbeat (the page says "also open on <pc>").
  const seen = await readRecords(o.token, o.zone, "TXT", o.names.heartbeat, f).catch(() => []);
  const other = otherController(seen, o.names.pc, now);
  const records: Array<ARecord | TxtRecord> = [...consoleRecords(o.names, o.address)];
  // The primary owns the heartbeat; another controller writes it only when none is live.
  if (o.names.primary || !other) {
    records.push({
      type: "TXT",
      name: o.names.heartbeat,
      content: heartbeatValue(o.names.pc, now),
    });
  }
  await upsertRecords(o.token, o.zone, records, "stolos console (spec 100)", f);
  return other ? { other } : {};
}

const toInt = (ip: string): number => ip.split(".").reduce((n, o) => (n << 8) + Number(o), 0) >>> 0;
const inCidr = (ip: string, base: string, bits: number): boolean =>
  ((toInt(ip) ^ toInt(base)) & (bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0)) === 0;

/** Article 28: a private (RFC 1918) or mesh (100.64.0.0/10) IPv4 address. */
export function trustedAddress(ip: string): boolean {
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return false;
  return (
    inCidr(ip, "10.0.0.0", 8) ||
    inCidr(ip, "172.16.0.0", 12) ||
    inCidr(ip, "192.168.0.0", 16) ||
    inCidr(ip, "100.64.0.0", 10)
  );
}

/** The address to listen on: the first trusted one, LAN adapters first; undefined when none. */
export function listenAddress(addresses: readonly string[]): string | undefined {
  return addresses.find(trustedAddress);
}
