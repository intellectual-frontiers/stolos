/**
 * Spec 069: integrate. The PC writes the one line a person runs on the machine
 * (`bin/integrate.sh` or `bin/integrate.windows.ps1`, at this engine's release,
 * with the fleet's public data filled in), and reads the check-in code the
 * machine prints back: a discovered machine is recorded in Git; an adopted one
 * is pinned (its host keys come from the code, not from a first connection) and
 * observed.
 *
 * @module
 */

import { exists, readTextOr } from "../core/fsx.ts";
import { join } from "../core/path.ts";
import { P } from "../core/paths.ts";
import { tsLiteral } from "../core/ts-literal.ts";
import { VERSION } from "../version.ts";
import { PROBE_SCRIPT, PROBE_SCRIPT_WINDOWS } from "./probe.ts";
import type { CheckIn } from "./checkin.ts";

/** What a machine can be prepared for. */
export const INTEGRATIONS = ["discover", "adopt", "osquery", "server", "workstation"] as const;

/** One integration. */
export type Integration = typeof INTEGRATIONS[number];

/** Where the engine's release files are. */
export const RAW = "https://raw.githubusercontent.com/intellectual-frontiers/stolos/";

async function sha256(text: string): Promise<string> {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

/** Quote one word for sh (single quotes). */
const q = (s: string) => /^[A-Za-z0-9_@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;

/** The lines a person runs on the machine, for each OS that applies. */
export async function integrateLines(o: {
  as: Integration[];
  fleet: string;
  key?: string;
  github?: string;
  repo?: string;
  tag?: string;
}): Promise<{ posix: string; windows?: string }> {
  const tag = o.tag ?? `v${VERSION}`;
  const flags = o.as.map((k) => `--${k}`);
  const common = [
    ...(o.fleet ? ["--fleet", o.fleet] : []),
    ...(o.key ? ["--key", o.key.trim().split(/\s+/).slice(0, 2).join(" ")] : []),
    "--engine",
    tag,
  ];
  const posixArgs = [
    ...flags,
    ...common,
    ...(o.as.includes("adopt") ? ["--probe-sha256", await sha256(PROBE_SCRIPT)] : []),
    ...(o.github ? ["--github", o.github] : []),
    ...(o.repo ? ["--repo", o.repo] : []),
  ];
  const posix = `curl -fsSL ${RAW}${tag}/bin/integrate.sh | sh -s -- ${
    posixArgs.map((a) => a.startsWith("--") ? a : q(a)).join(" ")
  }`;
  // Windows has no --server or --workstation (a Windows workstation is WSL: the line above, in Ubuntu).
  const winOk = o.as.every((k) => k === "discover" || k === "adopt" || k === "osquery");
  const winArgs = [
    ...flags,
    ...common,
    ...(o.as.includes("adopt") ? ["--probe-sha256", await sha256(PROBE_SCRIPT_WINDOWS)] : []),
  ];
  const windows = winOk
    ? `& ([scriptblock]::Create((irm ${RAW}${tag}/bin/integrate.windows.ps1))) ${
      winArgs.map((a) =>
        a.startsWith("--") || /^[A-Za-z0-9_.-]+$/.test(a) ? a : `'${a.replace(/'/g, "''")}'`
      ).join(" ")
    }`
    : undefined;
  return { posix, ...(windows ? { windows } : {}) };
}

/** A machine seen and recorded, not yet adopted or managed (fleets/<fleet>/discovered.ts). */
export interface DiscoveredDef {
  /** Its proposed name in the fleet. */
  name: string;
  /** Its hostname, as it said. */
  hostname: string;
  /** Where it was seen: check-in, or a cloud provider. */
  source: string;
  /** When it was recorded (ISO). */
  at: string;
  /** Its addresses. */
  addresses: string[];
  /** Its MAC addresses. */
  macs: string[];
  /** The account its check-in ran as. */
  user?: string;
  /** Its public SSH host keys (to pin when it is adopted). */
  hostKeys: string[];
  /** Its operating system, when known. */
  os?: string;
  /** Its serial number, when known. */
  serial?: string;
  /** Who it belongs to, when someone said. */
  owner?: string;
}

/** Where discovered machines are recorded. */
export function discoveredFile(): string {
  return join(P.fleetDir, "discovered.ts");
}

/** Every recorded discovered machine. */
export async function loadDiscovered(): Promise<DiscoveredDef[]> {
  const f = discoveredFile();
  if (!(await exists(f))) return [];
  const { toFileUrl } = await import("../core/path.ts");
  return ((await import(toFileUrl(f).href + `?t=${Date.now()}`)).discovered ??
    []) as DiscoveredDef[];
}

/** discovered.ts's text. */
export function discoveredSource(list: DiscoveredDef[]): string {
  return `// Machines seen and recorded, not yet adopted or managed (spec 069). Written by
// \`stolos discover --import <check-in code>\`; adopting or adding one removes it from here.

import type { DiscoveredDef } from "@stolos/archon/adopt/integrate.ts";

export const discovered: DiscoveredDef[] = ${tsLiteral(list)};
`;
}

/** Record (or replace, by name) discovered machines; returns the list. */
export async function saveDiscovered(
  add: DiscoveredDef[],
  remove: string[] = [],
): Promise<DiscoveredDef[]> {
  const names = new Set([...add.map((d) => d.name), ...remove]);
  const list = [...(await loadDiscovered()).filter((d) => !names.has(d.name)), ...add]
    .sort((a, b) => a.name.localeCompare(b.name));
  if (!list.length && !(await readTextOr(discoveredFile()))) return list;
  await Deno.writeTextFile(discoveredFile(), discoveredSource(list));
  return list;
}

/** A check-in as a discovered machine. */
export function fromCheckIn(c: CheckIn, name: string, now = new Date()): DiscoveredDef {
  return {
    name,
    hostname: c.hostname,
    source: "check-in",
    at: now.toISOString().replace(/\.\d+Z$/, "Z"),
    addresses: c.addresses,
    macs: c.macs,
    ...(c.user ? { user: c.user } : {}),
    hostKeys: c.hostKeys,
    ...(c.observed ? { os: `${c.observed.os.name} ${c.observed.os.version}`.trim() } : {}),
    ...(c.observed?.os.serial ? { serial: c.observed.os.serial } : {}),
  };
}
