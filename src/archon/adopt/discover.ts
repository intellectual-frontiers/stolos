/**
 * Spec 067: discovered machines: seen, not yet managed or adopted. Stolos
 * looks where it already can, without scanning anything: this PC's
 * neighbor table (machines it has talked to on the local network) and the
 * cloud observations in Git (servers and instances no fleet machine owns).
 * It prints them with the command that would adopt each; it records nothing.
 *
 * @module
 */

import { proc } from "@intellectual-frontiers/commons/ts/runtime";
import { run } from "../core/exec.ts";

/** One machine seen but not in the fleet. */
export interface Discovered {
  /** Where it was seen: lan, or the cloud provider. */
  source: string;
  /** Its address. */
  address: string;
  /** Its MAC address (on the local network), or the cloud's name for it. */
  id: string;
  /** Its name, when known. */
  name?: string;
}

/** Neighbors from `ip neigh` (Linux), `arp -an` (macOS), or `arp -a` (Windows). */
export function parseNeighbors(text: string): Array<{ address: string; mac: string }> {
  const out: Array<{ address: string; mac: string }> = [];
  // macOS prints octets without leading zeros (0:1e:c9:...); pad them.
  const mac = /\b([0-9a-f]{1,2}[:-]){5}[0-9a-f]{1,2}\b/i;
  for (const line of text.split("\n")) {
    const ip = line.match(/\b(\d{1,3}(?:\.\d{1,3}){3})\b/)?.[1];
    const m = line.match(mac)?.[0];
    if (!ip || !m || /FAILED|incomplete/i.test(line)) continue;
    const norm = m
      .toLowerCase()
      .split(/[:-]/)
      .map((o) => o.padStart(2, "0"))
      .join(":");
    if (norm === "ff:ff:ff:ff:ff:ff" || norm.startsWith("01:00:5e") || ip.endsWith(".255")) {
      continue;
    }
    out.push({ address: ip, mac: norm });
  }
  return out.filter((n, i, all) => all.findIndex((x) => x.address === n.address) === i);
}

/** This PC's neighbor table. */
export async function neighbors(): Promise<Array<{ address: string; mac: string }>> {
  const cmd =
    proc.build.os === "linux"
      ? ["ip", "neigh"]
      : proc.build.os === "windows"
        ? ["arp", "-a"]
        : ["arp", "-an"];
  const r = await run(cmd);
  return r.ok ? parseNeighbors(r.stdout) : [];
}

/** Everything seen that the fleet does not know (by MAC, address, or name). */
export function unknownMachines(
  seen: Discovered[],
  known: { macs: string[]; addresses: string[]; names: string[] },
): Discovered[] {
  const macs = new Set(known.macs.map((m) => m.toLowerCase()));
  const addrs = new Set(known.addresses);
  const names = new Set(known.names);
  return seen.filter(
    (d) =>
      !macs.has(d.id.toLowerCase()) &&
      !addrs.has(d.address) &&
      !(d.name && names.has(d.name.split(".")[0] ?? "")),
  );
}
