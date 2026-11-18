/**
 * Spec 111-network-posture FR-018, FR-019: the network's **change events**. A router's observation is a generated TypeScript file
 * committed in Git (`fleets/<fleet>/estate/<id>.ts`), so a difference between two of its versions is a recorded change (NIST SP 800-53
 * Rev 5 CM-3 configuration change control, CM-6 configuration settings). {@link diffObservations} says what differs between two
 * observations (a device added, gone, renamed or with new firmware; a Wi-Fi network added, removed or with another security; a network
 * added, removed or changed; a firewall rule added, removed or changed), and {@link networkChanges} walks the commits of the file since a
 * point of history, comparing each with the one before, with the reader and the date resolution `compliance drift` uses.
 *
 * ```mermaid
 * flowchart LR
 *   since["--since: a commit, or the last commit before a date"] --> log["git log: the commits that changed estate/&lt;id&gt;.ts"]
 *   log --> each["each version read at its commit (gitReader)"]
 *   each --> diff["diffObservations(before, after)"]
 *   diff --> ev["events: kind, subject, before, after, commit, time, SCF controls"]
 *   wt["the working tree, if it differs from HEAD"] --> diff
 * ```
 *
 * @example
 * ```ts
 * import { diffObservations } from "./network-changes.ts";
 * import type { Observation } from "./connector.ts";
 * const none = { provider: "unifi", account: "192.0.2.1", at: "2026-11-18T00:00:00Z", assets: [], gaps: [], posture: {} } as unknown as Observation;
 * diffObservations(none, none).length; // 0
 * ```
 *
 * @module
 */
// Spec: 111-network-posture FR-018, FR-019, FR-020

import { exportedLiteral } from "@intellectual-frontiers/commons/ts/kernel";
import type { ScfId } from "../compliance/scf.ts";
import { run } from "../core/exec.ts";
import { gitReader } from "../estate/snapshot.ts";
import type { Observation } from "./connector.ts";
import {
  observedDevices,
  observedFirewall,
  observedSsids,
  observedVlans,
} from "./network-asset.ts";

/** The kinds of change event, as the words the commands print (display words of this engine, spec 111-network-posture). */
export const NETWORK_CHANGE_KINDS = [
  "device-added",
  "device-gone",
  "device-renamed",
  "firmware-changed",
  "wifi-added",
  "wifi-removed",
  "wifi-security-changed",
  "network-added",
  "network-removed",
  "network-changed",
  "firewall-rule-added",
  "firewall-rule-removed",
  "firewall-rule-changed",
] as const;

/** A kind of change event. */
export type NetworkChangeKind = (typeof NETWORK_CHANGE_KINDS)[number];

/** The SCF controls each kind of change is evidence for (CM-3 and CM-6: CHG-03, CFG-02; and what it is a change of). */
export const CHANGE_SCF: Readonly<Record<NetworkChangeKind, readonly ScfId[]>> = {
  "device-added": ["AST-04", "CHG-03"],
  "device-gone": ["AST-04", "CHG-03"],
  "device-renamed": ["AST-04", "CFG-02"],
  "firmware-changed": ["VPM-08", "CHG-03"],
  "wifi-added": ["NET-24.1", "CHG-03"],
  "wifi-removed": ["NET-24.1", "CHG-03"],
  "wifi-security-changed": ["NET-24.1", "CFG-02"],
  "network-added": ["NET-10", "CHG-03"],
  "network-removed": ["NET-10", "CHG-03"],
  "network-changed": ["NET-10", "CFG-02"],
  "firewall-rule-added": ["NET-04", "CHG-03"],
  "firewall-rule-removed": ["NET-04", "CHG-03"],
  "firewall-rule-changed": ["NET-04", "CFG-02"],
};

/** One change between two observations. */
export interface NetworkDifference {
  /** What kind of change. */
  kind: NetworkChangeKind;
  /** What it is about: a device, a Wi-Fi network, a network, a firewall rule. */
  subject: string;
  /** What it was (absent for an addition). */
  before?: string;
  /** What it is (absent for a removal). */
  after?: string;
  /** The change in one phrase. */
  detail: string;
}

/** A recorded change: a difference, with the connector, the commit that recorded it and when. */
export interface NetworkChange extends NetworkDifference {
  /** The SCF controls it is evidence for. */
  scf: ScfId[];
  /** The connector whose observation changed. */
  connector: string;
  /** The commit that recorded it, or `working tree` for an observation not committed yet. */
  commit: string;
  /** When the commit was made (ISO), or now for the working tree. */
  at: string;
  /** The observation is not committed yet. */
  uncommitted?: true;
}

const byId = <T extends { id: string }>(xs: readonly T[]): Map<string, T> =>
  new Map(xs.map((x) => [x.id, x]));

/** The names the people-readable detail uses where a name is empty. */
const nameOf = (n: string, id: string): string => (n === "" ? id : n);

/** What differs between two observations of one router: each difference once, sorted by kind then subject. */
export function diffObservations(before: Observation, after: Observation): NetworkDifference[] {
  const out: NetworkDifference[] = [];
  const add = (d: NetworkDifference): void => {
    out.push(d);
  };

  const dBefore = byId(observedDevices(before));
  const dAfter = byId(observedDevices(after));
  for (const [id, d] of dAfter) {
    const b = dBefore.get(id);
    if (b === undefined) {
      add({
        kind: "device-added",
        subject: nameOf(d.name, id),
        after: d.model,
        detail: `${d.model || "a device"} (${d.class}) was added`,
      });
      continue;
    }
    if (b.name !== d.name) {
      add({
        kind: "device-renamed",
        subject: nameOf(d.name, id),
        before: b.name,
        after: d.name,
        detail: `renamed from ${b.name} to ${d.name}`,
      });
    }
    if (b.firmware !== d.firmware) {
      add({
        kind: "firmware-changed",
        subject: nameOf(d.name, id),
        before: b.firmware,
        after: d.firmware,
        detail: `firmware ${b.firmware || "(not given)"} to ${d.firmware || "(not given)"}`,
      });
    }
  }
  for (const [id, b] of dBefore) {
    if (!dAfter.has(id)) {
      add({
        kind: "device-gone",
        subject: nameOf(b.name, id),
        before: b.model,
        detail: `${b.model || "a device"} is no longer reported`,
      });
    }
  }

  const sBefore = byId(observedSsids(before));
  const sAfter = byId(observedSsids(after));
  for (const [id, s] of sAfter) {
    const b = sBefore.get(id);
    if (b === undefined) {
      add({
        kind: "wifi-added",
        subject: nameOf(s.name, id),
        after: s.security,
        detail: `Wi-Fi network added (${s.security || "security not read"}${s.guest ? ", guest" : ""})`,
      });
    } else if (b.security !== s.security) {
      add({
        kind: "wifi-security-changed",
        subject: nameOf(s.name, id),
        before: b.security,
        after: s.security,
        detail: `security ${b.security || "(not read)"} to ${s.security || "(not read)"}`,
      });
    }
  }
  for (const [id, b] of sBefore) {
    if (!sAfter.has(id)) {
      add({
        kind: "wifi-removed",
        subject: nameOf(b.name, id),
        before: b.security,
        detail: "Wi-Fi network removed",
      });
    }
  }

  const vBefore = byId(observedVlans(before));
  const vAfter = byId(observedVlans(after));
  for (const [id, v] of vAfter) {
    const b = vBefore.get(id);
    if (b === undefined) {
      add({
        kind: "network-added",
        subject: nameOf(v.name, id),
        after: `VLAN ${v.vlanId}`,
        detail: `network added (VLAN ${v.vlanId})`,
      });
      continue;
    }
    const changes: string[] = [];
    if (b.vlanId !== v.vlanId) changes.push(`VLAN ${b.vlanId} to ${v.vlanId}`);
    if (b.enabled !== v.enabled) changes.push(v.enabled ? "enabled" : "disabled");
    if (b.isolated !== undefined && v.isolated !== undefined && b.isolated !== v.isolated) {
      changes.push(v.isolated ? "isolated" : "no longer isolated");
    }
    if (changes.length) {
      add({
        kind: "network-changed",
        subject: nameOf(v.name, id),
        before: `VLAN ${b.vlanId}${b.enabled ? "" : " (disabled)"}`,
        after: `VLAN ${v.vlanId}${v.enabled ? "" : " (disabled)"}`,
        detail: changes.join(", "),
      });
    }
  }
  for (const [id, b] of vBefore) {
    if (!vAfter.has(id)) {
      add({
        kind: "network-removed",
        subject: nameOf(b.name, id),
        before: `VLAN ${b.vlanId}`,
        detail: `network removed (VLAN ${b.vlanId})`,
      });
    }
  }

  const fBefore = byId(observedFirewall(before));
  const fAfter = byId(observedFirewall(after));
  for (const [id, f] of fAfter) {
    const b = fBefore.get(id);
    if (b === undefined) {
      add({
        kind: "firewall-rule-added",
        subject: nameOf(f.name, id),
        after: f.action,
        detail: `firewall rule added (${f.action}${f.enabled ? "" : ", disabled"})`,
      });
      continue;
    }
    const changes: string[] = [];
    if (b.action !== f.action) changes.push(`action ${b.action} to ${f.action}`);
    if (b.enabled !== f.enabled) changes.push(f.enabled ? "enabled" : "disabled");
    if (b.name !== f.name) changes.push(`renamed from ${b.name}`);
    if (changes.length) {
      add({
        kind: "firewall-rule-changed",
        subject: nameOf(f.name, id),
        before: `${b.action}${b.enabled ? "" : ", disabled"}`,
        after: `${f.action}${f.enabled ? "" : ", disabled"}`,
        detail: changes.join(", "),
      });
    }
  }
  for (const [id, b] of fBefore) {
    if (!fAfter.has(id)) {
      add({
        kind: "firewall-rule-removed",
        subject: nameOf(b.name, id),
        before: b.action,
        detail: "firewall rule removed",
      });
    }
  }

  const order = (k: NetworkChangeKind): number => NETWORK_CHANGE_KINDS.indexOf(k);
  return out.sort(
    (a, b) =>
      order(a.kind) - order(b.kind) || (a.subject < b.subject ? -1 : a.subject > b.subject ? 1 : 0),
  );
}

/** The observation a generated file holds, or undefined where there is none (or the file was edited by hand). */
export function observationOf(text: string | undefined): Observation | undefined {
  if (text === undefined) return undefined;
  const v = exportedLiteral(text, "observed");
  return v.kind === "ok" ? (v.value as unknown as Observation) : undefined;
}

/** The most commits one history walk compares (a very long history is cut, and says so). */
const MAX_COMMITS = 200;
/** The time limit of each git command (milliseconds). */
const GIT_LIMIT = 60_000;

/** What `stolos network changes` found. */
export interface NetworkHistory {
  /** The point of history it started from. */
  since: { rev: string; at: string };
  /** The recorded changes, oldest first. */
  changes: NetworkChange[];
  /** The connectors whose file was read, and the ones whose first version is a baseline (no event). */
  connectors: string[];
  /** Set where the walk was cut at {@link MAX_COMMITS} commits. */
  cut?: true;
}

/**
 * The change events of the routers' observation files between a point of the history of the fleet repository and now. Each commit that
 * changed `fleets/<fleet>/estate/<id>.ts` is compared with the version before it; the first version of a file is the baseline and gives
 * no event; an observation in the working tree that is not committed is compared with the last one and its events are `uncommitted`.
 */
export async function networkChanges(o: {
  /** The fleet repository. */
  repo: string;
  /** The fleet's id. */
  fleet: string;
  /** The connectors that are routers. */
  connectors: readonly string[];
  /** A commit, or a date Git understands. */
  since: string;
  /** Now (epoch milliseconds). */
  now?: number;
}): Promise<NetworkHistory | { error: string }> {
  const { resolveSince } = await import("../compliance/drift.ts");
  const s = await resolveSince(o.repo, o.since);
  if ("error" in s) return s;
  const now = o.now ?? Date.now();
  const changes: NetworkChange[] = [];
  let cut = false;
  const git = (args: string[]) =>
    run(["git", "-C", o.repo, ...args], { signal: AbortSignal.timeout(GIT_LIMIT) });
  for (const id of o.connectors) {
    const file = `fleets/${o.fleet}/estate/${id}.ts`;
    let previous = observationOf(await gitReader(o.repo, s.rev).read(file));
    const log = await git(["log", "--reverse", "--format=%H%x09%cI", `${s.rev}..HEAD`, "--", file]);
    const commits = log.ok
      ? log.stdout
          .split("\n")
          .filter(Boolean)
          .map((l) => {
            const [sha = "", when = ""] = l.split("\t");
            return { sha, at: new Date(when).toISOString() };
          })
      : [];
    if (commits.length > MAX_COMMITS) cut = true;
    for (const c of commits.slice(0, MAX_COMMITS)) {
      const next = observationOf(await gitReader(o.repo, c.sha).read(file));
      if (next === undefined) continue;
      if (previous !== undefined) {
        for (const d of diffObservations(previous, next)) {
          changes.push({
            ...d,
            scf: [...CHANGE_SCF[d.kind]],
            connector: id,
            commit: c.sha,
            at: c.at,
          });
        }
      }
      previous = next;
    }
    // An observation written and not committed yet.
    const head = await gitReader(o.repo, "HEAD").read(file);
    const work = await gitReader(o.repo).read(file);
    if (work !== undefined && work !== head) {
      const next = observationOf(work);
      if (next !== undefined && previous !== undefined) {
        for (const d of diffObservations(previous, next)) {
          changes.push({
            ...d,
            scf: [...CHANGE_SCF[d.kind]],
            connector: id,
            commit: "working tree",
            at: new Date(now).toISOString(),
            uncommitted: true,
          });
        }
      }
    }
  }
  changes.sort((a, b) => a.at.localeCompare(b.at) || a.connector.localeCompare(b.connector));
  return {
    since: s,
    changes,
    connectors: [...o.connectors],
    ...(cut ? { cut: true as const } : {}),
  };
}

/** A change as one line of the mailed message: kind and subject only, never what a value was (spec 111-network-posture FR-019). */
export function changeLine(c: Pick<NetworkChange, "kind" | "subject" | "connector">): string {
  return `${c.kind}: ${c.subject} (${c.connector})`;
}
