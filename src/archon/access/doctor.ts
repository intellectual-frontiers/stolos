/**
 * Spec 100 FR-012: what `boot doctor` says about remote access: the LAN listener, the
 * certificate's expiry, devices unused for 90 days, and the firewall rule the HTTPS port needs.
 * Each step that is the operator's is ⚡ (an action, never a failure), with its command.
 *
 * @module
 */
// Spec: 100-remote-access FR-012

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
}

/** One line of the doctor's "Remote access" phase. */
export interface DoctorLine {
  /** ok (a note), action (⚡), or pending (⏳, not set up yet). */
  level: "ok" | "action" | "pending";
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
  return os === "windows"
    ? `New-NetFirewallRule -DisplayName "Stolos Console (HTTPS)" -Direction Inbound -Protocol TCP -LocalPort ${port} -Profile Private,Domain -Action Allow (PowerShell as Administrator)`
    : `sudo ufw allow from 10.0.0.0/8 to any port ${port} proto tcp (and 172.16.0.0/12, 192.168.0.0/16: your LAN, never the internet)`;
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
      level: "pending",
      msg: "the Stolos Console answers on this PC only (no remote access set up)",
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
      msg: `the firewall may block the console's HTTPS port (${f.listening?.port ?? 443}/tcp) on the LAN`,
      fix: consoleFirewallCommand(os, f.listening?.port ?? 443),
    });
  }
  return out;
}
