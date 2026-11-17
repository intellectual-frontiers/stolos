/**
 * Spec 100 FR-012: what `boot doctor` says about remote access: the LAN listener, the
 * certificate's expiry, devices unused for 90 days, and the firewall rule the HTTPS port needs.
 * Each step that is the operator's is ⚡ (an action, never a failure), with its command.
 *
 * @module
 */
// Spec: 100-remote-access FR-012
// Spec: 103-three-ports FR-009

import { firewallRule, standardPort } from "../core/listeners.ts";
import { listenRefusal } from "./holder.ts";
import { EXPIRY_WARN_DAYS, daysLeft, HEARTBEAT_STALE_MS } from "./tls.ts";
import { UNUSED_DAYS } from "./devices.ts";

/** What the doctor reads (on this PC, no network). */
export interface AccessFacts {
  /** The fleet names the console (web.domain and stolos.console). */
  configured: boolean;
  /** The listener as the running console last recorded it. */
  listening?: { address: string; port: number; at: string };
  /** The certificate's expiry (ISO). */
  notAfter?: string;
  /** Devices with no sign-in for 90 days. */
  unused: number;
  /** Approved devices. */
  devices: number;
  /** TCP 443 cannot be bound on this PC (the error's code), and what holds it where that could be found (spec 103-three-ports). */
  blocked?: { port: number; code: string; holder?: string | undefined };
}

/** One line of the doctor's "Remote access" phase. */
export interface DoctorLine {
  /** ok (a note), action (⚡), pending (⏳, waiting on time or someone else) or hint (👉, an optional feature that is merely off, spec 105-calm-output FR-008). */
  level: "ok" | "action" | "pending" | "hint";
  /** What it found. */
  msg: string;
  /** The next step. */
  fix?: string;
}

/**
 * The exact command that allows the console's HTTPS port on Private and Domain networks only
 * (never Public): Windows Defender Firewall, else ufw.
 */
export function consoleFirewallCommand(os: string, port: number): string {
  return firewallRule(os, "tcp", port, "Console (HTTPS)");
}

/** The doctor's lines for remote access. `firewall` is what the firewall check said for the port. */
export function accessDoctor(
  f: AccessFacts,
  now: number,
  firewall: readonly string[],
  os: string,
): DoctorLine[] {
  const out: DoctorLine[] = [];
  if (!f.configured) {
    out.push({
      level: "hint",
      msg: "The Stolos Console answers on this PC only: remote access is not set up.",
      fix: "bun run stolos console --lan (it proposes the names under the web domain)",
    });
    return out;
  }
  const live = f.listening && now - Date.parse(f.listening.at) < HEARTBEAT_STALE_MS;
  out.push({
    level: "ok",
    msg: live
      ? `LAN listener on: https on ${f.listening?.address}:${f.listening?.port}`
      : "LAN listener off (the console is not running with --lan)",
  });
  if (!live && f.blocked) {
    const r = listenRefusal({ ...f.blocked, os });
    out.push({ level: "action", msg: r.why, fix: r.fix });
  }
  if (f.notAfter) {
    const left = daysLeft(f.notAfter, now);
    if (left < EXPIRY_WARN_DAYS) {
      out.push({
        level: "action",
        msg: `the console's certificate ${left < 0 ? "expired" : `expires in ${left} day(s)`} (${f.notAfter.slice(0, 10)})`,
        fix: "bun run stolos console --lan (it renews the certificate at start)",
      });
    } else out.push({ level: "ok", msg: `certificate valid until ${f.notAfter.slice(0, 10)}` });
  } else {
    out.push({
      level: "pending",
      msg: "no certificate for the console yet",
      fix: "bun run stolos console --lan (it asks Let's Encrypt for one)",
    });
  }
  if (f.unused) {
    out.push({
      level: "action",
      msg: `${f.unused} of ${f.devices} device(s) unused for ${UNUSED_DAYS} days: review or revoke`,
      fix: "the console's Remote Access page, or bun run stolos devices revoke <id>",
    });
  }
  if (firewall.length) {
    out.push({
      level: "action",
      msg: `the firewall may block the console's HTTPS port (${f.listening?.port ?? standardPort("console-https")}/tcp) on the LAN`,
      fix: consoleFirewallCommand(os, f.listening?.port ?? standardPort("console-https")),
    });
  }
  return out;
}
