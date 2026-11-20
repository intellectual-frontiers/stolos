/**
 * Spec 112-machine-reported-tags FR-005, FR-010: what a machine says about itself, on both sides of the wire. On the machine: its
 * `/etc/machine-info` is read as data (never sourced). On the PC: what a machine reported is kept in the PC's own observation cache
 * (its `archon.sql`, the kind `reported`), so no observation makes a commit, and is read again with the fleet's current `tags.ts`.
 *
 * @module
 */
// Spec: 112-machine-reported-tags FR-005, FR-010

import { fs } from "@intellectual-frontiers/system";
import { type MachineReport, parseMachineInfo, sanitizeReport } from "../model/reported.ts";
import { getRecord, putRecord, recordsNamed, stateDir } from "./store.ts";

/** The most of `/etc/machine-info` read: it is a small file, and this is a machine's own word. */
const MACHINE_INFO_BYTES = 16_384;

/** The machine's own `/etc/machine-info` (DEPLOYMENT, LOCATION, CHASSIS, TAGS) as bounded text, or none where it has no such file. */
export async function readMachineInfo(file: string): Promise<Record<string, string> | undefined> {
  const text = await fs.readTextOr(file).catch(() => undefined);
  if (text === undefined) return undefined;
  const mi = parseMachineInfo(text.slice(0, MACHINE_INFO_BYTES));
  return Object.keys(mi).length ? mi : undefined;
}

/** Keep what a machine reported in the PC's observation cache (replacing the last), bounded. Returns whether it kept anything. */
export async function keepReport(
  host: string,
  report: unknown,
  dir = stateDir(),
): Promise<boolean> {
  const clean = sanitizeReport(report);
  if (!clean) return false;
  await putRecord(host, "reported", "latest", clean, dir, clean.at);
  return true;
}

/** What the PC last read from a machine (bounded again on the way out: the cache is a file a person can edit), or none. */
export async function lastReport(
  host: string,
  dir = stateDir(),
): Promise<MachineReport | undefined> {
  const r = await getRecord<unknown>(host, "reported", "latest", dir).catch(() => undefined);
  return r ? sanitizeReport(r.body, r.at) : undefined;
}

/** What the PC last read from every machine, by name (one read of the cache). */
export async function lastReports(dir = stateDir()): Promise<Record<string, MachineReport>> {
  const out: Record<string, MachineReport> = {};
  for (const r of await recordsNamed<unknown>("reported", "latest", dir).catch(() => [])) {
    const clean = sanitizeReport(r.body, r.at);
    if (clean) out[r.host] = clean;
  }
  return out;
}
