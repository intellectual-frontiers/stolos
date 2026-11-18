/**
 * Spec 117-adopted-in-status: every machine of the fleet in `stolos fleet status`, after the managed servers: the adopted machines
 * (paired, integrated), the SNMP devices and the network assets adopted through an integration. Each is one line (name, kind, how it
 * joined, operating system, last observation, policy result, tags; a network asset also the account it came through and its state) and
 * detail lines only for what is wrong (a failing policy, a warning with its fix) or waiting (what was not observed yet, once, with the
 * command that observes it). The lines are a function over data (`machineLine`, `lineText`); `showOtherMachines` loads and prints them.
 *
 * ```mermaid
 * flowchart LR
 *   a["loadAdopted (machine.ts, observed.ts)"] --> p["policies"]
 *   d["loadDevices (device.ts)"] --> q["devicePolicies"]
 *   n["loadNetwork (network.ts, the router's observation)"] --> r["assetPolicies"]
 *   p & q & r --> l["machineLine: one line, its detail lines"]
 *   l --> s["fleet status (a report)"]
 * ```
 *
 * @module
 */
// Spec: 117-adopted-in-status FR-001, FR-002, FR-003, FR-004

import { ui } from "../core/ui.ts";
import { joinedMark, wayOfJoining } from "../adopt/joining.ts";
import type { WayOfJoining } from "../ontology.auto.ts";
import { notObservedItem, type PolicyResult, readResult } from "../adopt/policy.ts";
import type { Observed } from "../adopt/adopt.ts";

/** One machine of the fleet that is not a managed host, as its line and its detail lines need it. */
export interface MachineLine {
  /** Its name in the fleet. */
  name: string;
  /** What it is, in words: `workstation`, `server`, `machine`, `device (router)`, `network asset (switch)`. */
  kind: string;
  /** How it joined (spec 107-pairing-and-query FR-007). */
  joined: WayOfJoining | undefined;
  /** Its operating system, or a device's model; empty where nothing was read. */
  os: string;
  /** When it was last observed (ISO time), where it was. */
  observedAt?: string;
  /** Its policy results. */
  results: readonly PolicyResult[];
  /** The command that observes it. */
  observe: string;
  /** A network asset: the connector, the account and the state at the controller. */
  via?: { connector: string; account: string; state: string };
  /** The ids of results said elsewhere (the Network phase says a network asset's presence and state), not repeated as warnings. */
  quiet?: readonly string[];
}

/**
 * Whether an adopted machine is a workstation or a server, from what its probe read: Windows, macOS and a Linux flavor of a desktop
 * distribution (Omarchy) are workstations, any other Linux is a server, and one never observed is only a machine.
 */
export function adoptedKind(o: Observed | undefined): string {
  if (!o) return "machine";
  const family = o.os.family.toLowerCase();
  return family.startsWith("windows") || family.startsWith("macos") || o.os.flavor
    ? "workstation"
    : "server";
}

/** The policy result in short form: `8 passing, 1 failing, 2 not observed yet` (the zero ones left out, except the passing). */
export function resultText(rs: readonly PolicyResult[]): string {
  if (!rs.length) return "no policies";
  const n = (f: (r: PolicyResult) => boolean) => rs.filter(f).length;
  const fail = n((r) => readResult(r) === "fail");
  const waiting = n((r) => readResult(r) === "not-observed");
  const warn = n((r) => r.status === "warn");
  const accepted = n((r) => r.status === "accepted");
  return [
    `${n((r) => r.status === "pass")} passing`,
    fail ? `${fail} failing` : "",
    warn ? `${warn} warning` : "",
    accepted ? `${accepted} accepted` : "",
    waiting ? `${waiting} not observed yet` : "",
  ]
    .filter(Boolean)
    .join(", ");
}

/** The one line of a machine: name, kind, how it joined, operating system, last observation, policy result, tags. */
export function lineText(l: MachineLine, tags: string): string {
  return [
    `${l.kind} · ${joinedMark(l.joined)}`,
    l.via ? `via ${l.via.connector}, account ${l.via.account || "?"}, ${l.via.state}` : "",
    l.os,
    l.observedAt ? `observed ${l.observedAt.slice(0, 16).replace("T", " ")}` : "not observed yet",
    resultText(l.results),
    tags,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** Print one machine: its failing policies and what is not observed yet as detail lines, then its line. */
export function showMachine(l: MachineLine, tags: string): void {
  const p = ui.phase(l.name);
  for (const r of l.results) {
    if (readResult(r) !== "fail" || l.quiet?.includes(r.id)) continue;
    p.warn(
      `${r.title}: ${r.detail} [${r.scf.join(", ")}]`,
      r.fix ?? "",
      `P067-${r.id.toUpperCase()}`,
    );
  }
  const waiting = notObservedItem(l.results, l.observe);
  if (waiting) p.pending(waiting.message, waiting.fix, waiting.code);
  p.done(lineText(l, tags));
}

/** Every adopted machine but the controller (its line is shown first), as lines. */
async function adoptedLines(now: number): Promise<MachineLine[]> {
  const { loadAdopted } = await import("../adopt/adopt.ts");
  const { policies } = await import("../adopt/policy.ts");
  return (await loadAdopted())
    .filter((a) => a.machine.role !== "controller")
    .map(({ machine: m, observed: o }) => ({
      name: m.name,
      kind: adoptedKind(o),
      joined: wayOfJoining({ kind: "adopted", ...(m.joined ? { joined: m.joined } : {}) }),
      os: o ? `${o.os.name} ${o.os.version}`.trim() : "",
      ...(o ? { observedAt: o.at } : {}),
      results: policies(m, o, now),
      observe: `bun run stolos host observe ${m.name}`,
    }));
}

/** Every SNMP device, as lines. */
async function deviceLines(now: number): Promise<MachineLine[]> {
  const { loadDevices, devicePolicies } = await import("../device/device.ts");
  return (await loadDevices()).map(({ device: d, observed: o }) => ({
    name: d.name,
    kind: `device (${d.kind})`,
    joined: wayOfJoining({ kind: "device" }),
    os: o?.model ?? "",
    ...(o ? { observedAt: o.at } : {}),
    results: devicePolicies(d, o, now),
    observe: `bun run stolos device observe ${d.name}`,
  }));
}

/** Every network asset adopted through an integration, as lines (its state is the controller's last word). */
async function assetLines(): Promise<MachineLine[]> {
  const { loadNetwork } = await import("../connect/network-commands.ts");
  const { assetPolicies } = await import("../connect/network-asset.ts");
  const { CLASS_LABEL } = await import("../connect/network-class.ts");
  const { view } = await loadNetwork();
  return view.assets.map((s) => {
    const a = s.asset;
    const at = view.connectors.find((c) => c.id === a.via)?.at;
    return {
      name: a.name,
      kind: `network asset (${CLASS_LABEL[a.class].toLowerCase()})`,
      joined: wayOfJoining({ kind: "device", joined: "integration" }),
      os: s.device?.model ?? a.model,
      ...(at ? { observedAt: at } : {}),
      results: assetPolicies(s),
      observe: `bun run stolos estate observe ${a.via}`,
      via: {
        connector: a.via,
        account: a.account,
        state:
          s.presence === "present"
            ? s.device?.state || "state not given"
            : s.presence === "gone"
              ? "gone from the integration"
              : "not read yet",
      },
      quiet: ["network-asset-present", "network-asset-online"],
    };
  });
}

/**
 * Every machine the fleet knows beyond its managed hosts and the controller, in the order of spec 117-adopted-in-status FR-001: the
 * adopted machines, the SNMP devices, the network assets. A source that cannot be read gives none (a courtesy: the hosts are still shown).
 */
export async function otherMachines(now = Date.now()): Promise<MachineLine[]> {
  const out: MachineLine[] = [];
  for (const load of [() => adoptedLines(now), () => deviceLines(now), assetLines]) {
    try {
      out.push(...(await load()));
    } catch {
      // A fleet whose devices or router cannot be read still shows what it can.
    }
  }
  return out;
}

/** Print the other machines of the fleet, each with its tags (`tagsOf`: the text of spec 108-tags FR-015, or empty). */
export async function showOtherMachines(tagsOf: (name: string) => string): Promise<number> {
  const lines = await otherMachines();
  for (const l of lines) showMachine(l, tagsOf(l.name));
  return lines.length;
}
