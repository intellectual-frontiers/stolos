/**
 * Spec 069: the check-in code. `bin/integrate.sh` and `integrate.windows.ps1`
 * end by printing one line, `stolos1:<base64>`, that a person pastes into the
 * Stolos Console or the CLI: the machine's public facts (its account, names,
 * addresses, MAC addresses, public SSH host keys) and what its probe found.
 * It is how a machine reports in with no network path back to the PC, and how
 * the PC pins the machine's host keys without trusting the first connection.
 *
 * The payload is the probe's own format (`@section` then `key=value` lines),
 * with an `@checkin` and a `@hostkeys` section in front.
 *
 * @module
 */
// Spec: 069-integrate

import { type Observed, toObserved } from "./adopt.ts";
import { parseProbe } from "./probe.ts";

/** A check-in, read. */
export interface CheckIn {
  /** The fleet it was made for ("" for a plain discovery). */
  fleet: string;
  /** What the machine was prepared for: discover, adopt, osquery, server, workstation. */
  kinds: string[];
  /** The account the script ran as (the one the fleet signs in to). */
  user: string;
  /** Its SSH port (22 unless the script was told another). */
  port: number;
  /** The machine's hostname. */
  hostname: string;
  /** Its IPv4 addresses. */
  addresses: string[];
  /** Its MAC addresses. */
  macs: string[];
  /** Its public SSH host keys ("ssh-ed25519 AAAA..."), to pin. */
  hostKeys: string[];
  /** What the probe found, when it ran. */
  observed?: Observed;
}

const HOST_KEY =
  /^(ssh-ed25519|ecdsa-sha2-nistp(256|384|521)|ssh-rsa|sk-ssh-ed25519@openssh\.com) [A-Za-z0-9+/]+={0,3}$/;

/** Read a check-in code; throws with a plain reason when it is not one. */
export function parseCheckIn(code: string): CheckIn {
  const c = code.trim().replace(/\s+/g, "");
  if (!c.startsWith("stolos1:")) {
    throw new Error(
      "a check-in code starts with stolos1: (copy the whole last line the script printed)",
    );
  }
  if (c.length > 100_000) throw new Error("that check-in code is too long to be one");
  let text: string;
  try {
    text = new TextDecoder().decode(Uint8Array.from(atob(c.slice(8)), (ch) => ch.charCodeAt(0)));
  } catch {
    throw new Error("that check-in code is cut short or changed (copy the whole line again)");
  }
  const p = parseProbe(text);
  const ci = p["checkin"];
  if (!ci || ci["v"] !== "1") throw new Error("that is not a check-in code this Stolos reads");
  const words = (s?: string) => (s ?? "").split(/\s+/).filter(Boolean);
  const hostKeys = Object.values(p["hostkeys"] ?? {})
    .map((k) => k.trim())
    .filter((k) => HOST_KEY.test(k));
  const name = (ci["hostname"] ?? "").trim();
  if (!/^[A-Za-z0-9._-]{1,253}$/.test(name)) {
    throw new Error("the check-in code has no usable hostname");
  }
  return {
    fleet: ci["fleet"] ?? "",
    kinds: words(ci["kinds"]),
    user: ci["user"] ?? "",
    port: /^\d{1,5}$/.test(ci["port"] ?? "") ? Number(ci["port"]) : 22,
    hostname: name,
    addresses: words(ci["addresses"]).filter((a) => /^\d{1,3}(\.\d{1,3}){3}$/.test(a)),
    macs: words(ci["macs"])
      .map((m) => m.toLowerCase())
      .filter((m) => /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(m)),
    hostKeys,
    ...(p["os"] ? { observed: toObserved(p) } : {}),
  };
}

/** A machine name from a hostname: lowercase, a DNS label ("Alices-MacBook-Pro.local" → alices-macbook-pro). */
export function nameFor(hostname: string): string {
  return (
    (hostname.split(".")[0] ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .replace(/^(\d)/, "m-$1")
      .slice(0, 63) || "machine"
  );
}
