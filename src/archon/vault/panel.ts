/**
 * The backup panel (spec 029, Article 19 and 22): one framed panel, amber, red
 * when anything has been unbacked for more than 7 days or host identity keys
 * were never backed up. Shown at the end of any command that changed a
 * secret, and at the start of `boot serve` and `boot status`, until the
 * secrets are backed up. Names only.
 *
 * @module
 */

import { labelFor } from "../model/secret-inventory.ts";
import type { Assessment } from "./state.ts";

/** Visible width: emoji and other wide characters take two columns. */
export function width(s: string): number {
  let w = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    w += c >= 0x1f000 || (c >= 0x2e80 && c <= 0xa4cf) || (c >= 0xff00 && c <= 0xff60)
      ? 2
      : c === 0xfe0f
      ? 0
      : 1;
  }
  return w;
}

const pad = (s: string, n: number) => s + " ".repeat(Math.max(0, n - width(s)));

function when(iso: string, now: Date): string {
  const d = new Date(iso);
  const hm = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  const days = Math.floor(
    (now.setHours(0, 0, 0, 0) - new Date(iso).setHours(0, 0, 0, 0)) / 86_400_000,
  );
  return days === 0 ? `today ${hm}` : days === 1 ? `yesterday ${hm}` : `${days} days ago`;
}

function ago(iso: string | undefined, now: number): string {
  if (!iso) return "";
  const days = Math.floor((now - Date.parse(iso)) / 86_400_000);
  return days === 0 ? "today" : days === 1 ? "yesterday" : `${days} days ago`;
}

/** The panel's lines (without color), or undefined when everything is backed up. */
export function panelLines(a: Assessment, pc: string, now = Date.now()): string[] | undefined {
  if (a.severity === "ok") return undefined;
  // Public halves travel with their keys: counted, not listed.
  const secret = a.unbacked.filter((s) => !s.name.endsWith(".pub"));
  const pubs = a.unbacked.length - secret.length;
  const n = secret.length || a.unbacked.length;
  const head = a.backupCheck?.state === "unverifiable" && a.lastBackup
    ? `Your last backup (${ago(a.lastBackup.at, now)}) cannot be checked: ${a.backupCheck.why}.`
    : a.lastBackup
    ? `${n} secret${n === 1 ? " is" : "s are"} newer than your last vault backup (${
      ago(a.lastBackup.at, now)
    }):`
    : a.backupCheck?.state === "missing"
    ? `The recorded backup is gone (${a.backupCheck.why}); ${n} secret${
      n === 1 ? " is" : "s are"
    } not backed up:`
    : `${n} secret${n === 1 ? " has" : "s have"} never been backed up:`;
  const listed = secret.length ? secret : a.unbacked;
  const rows = listed.slice(0, 8).map((s) => [
    s.name,
    s.ref ? labelFor(s.ref, s.name) : "(not in the inventory)",
    when(s.changedAt, new Date(now)),
  ]);
  const w0 = Math.max(...rows.map((r) => width(r[0])), 10);
  const w1 = Math.max(...rows.map((r) => width(r[1])), 10);
  const body = [
    head,
    ...rows.map((r) => `   • ${pad(r[0], w0)}  ${pad(r[1], w1)}  ${r[2]}`),
    ...(listed.length > 8
      ? [`   and ${listed.length - 8} more (deno task boot vault status)`]
      : []),
    ...(pubs && secret.length
      ? [`   (and ${pubs} public key${pubs === 1 ? "" : "s"} that go with them)`]
      : []),
    ...(a.removed.length
      ? [`${a.removed.length} backed-up secret(s) were removed since: back up again.`]
      : []),
    "",
    `If ${pc} failed now, these would have to be recreated.`,
    "Unlock OneDrive ▸ Personal Vault, then run:",
    "",
    a.backupCheck?.state === "unverifiable"
      ? "    deno task boot vault status   (or vault backup)"
      : "    deno task boot vault backup",
  ];
  const title = " 🔐  Secrets changed: back them up ";
  const inner = Math.max(...body.map(width), width(title) + 2) + 4;
  return [
    `╭─${title}${"─".repeat(inner - width(title) - 1)}╮`,
    ...body.map((l) => `│  ${pad(l, inner - 2)}│`),
    `╰${"─".repeat(inner)}╯`,
  ];
}
