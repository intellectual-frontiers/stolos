/**
 * Spec 073: compliance drift. `stolos compliance drift [--since <date|commit>]
 * [--notify]` compares each SCF control's status now with its status at a
 * past commit of the fleet repository, and lists the controls whose status
 * changed, with the evidence that changed under them. With `--notify` it
 * mails a summary to the fleet's mailbox (`fleet.mail.to`) through the fleet's
 * notify path: control ids, subjects, checks, and statuses only, never what a
 * check found, so no secret can be in it.
 *
 * Both sides are computed the same way, from what the repository holds (the
 * observations Stolos commits: adopted machines, devices, connected accounts),
 * each held to the cadences as of its own time (the past side as of its
 * commit's time), so evidence that went stale is drift too. Managed servers'
 * verifies live in this PC's state, not in Git, so they are not compared.
 *
 * ```mermaid
 * flowchart LR
 *   past["The repository at --since (a commit, or the last commit before a date)"] --> a["Evidence, held to the cadences then"]
 *   now["The working tree"] --> b["Evidence, held to the cadences now"]
 *   a & b --> cmp["Per SCF control: status then and now"]
 *   cmp -- "--notify" --> mail["fleet.mail.to"]
 * ```
 *
 * It is made to run on a schedule, by this PC's own scheduler (see the
 * compliance guide, `mod.ts`).
 *
 * @module
 */
// Spec: 073-freshness
// Spec: 117-adopted-in-status FR-006, FR-007
// Spec: 111-network-posture FR-014, FR-019

import { assess, exportedLiteral, type Json } from "@intellectual-frontiers/commons/ts/kernel";
import { stdio } from "@intellectual-frontiers/commons/ts/runtime";
import { run } from "../core/exec.ts";
import type { RepoReader } from "../estate/snapshot.ts";
import type { PcFacts } from "../console/pc.ts";
import type { AdoptedDef, Observed } from "../adopt/adopt.ts";
import type { DeviceDef, DeviceObserved } from "../device/device.ts";
import type { Connector, Observation } from "../connect/connector.ts";
import type { NetworkAssetDef, NetworkConfig } from "../connect/network-asset.ts";
import type { NetworkChange } from "../connect/network-changes.ts";
import type { Event } from "../notify/notify.ts";
import type { ScfCatalog } from "./catalog.ts";
import type { ComplianceView, Coverage, Evidence } from "./report.ts";
import { type Cadences, fleetFreshView, type FreshView } from "./freshness.ts";
import { isNotObserved, NO_EVIDENCE_CODE, notObservedWords } from "./not-observed.ts";
import { changeLine } from "../connect/network-changes.ts";

/** The evidence a fleet repository holds, through a reader (now, or at a commit), as of `now`. */
export async function repoEvidence(
  r: RepoReader,
  fleet: string,
  o: {
    now: number;
    connectors: Connector[];
    cadences?: Cadences;
    catalog?: ScfCatalog;
    /**
     * Spec 074: the fleet's own control packs, run over what this side holds;
     * their results are kept as evidence (source "control pack").
     */
    packs?: (i: {
      adopted: PcFacts["adopted"];
      devices: PcFacts["devices"];
      connectors: Array<{ connector: string; observed: Observation }>;
    }) => Promise<NonNullable<PcFacts["controls"]>>;
  },
): Promise<FreshView> {
  const base = `fleets/${fleet}`;
  const lit = async <T>(path: string, name: string): Promise<T | undefined> => {
    const text = await r.read(path);
    if (text === undefined) return undefined;
    const v = exportedLiteral(text, name);
    // Edited by hand: not a literal Stolos wrote.
    return v.kind === "ok" ? (v.value as T) : undefined;
  };
  const { policies } = await import("../adopt/policy.ts");
  const { devicePolicies } = await import("../device/device.ts");
  const adopted: PcFacts["adopted"] = [];
  for (const n of await r.list(`${base}/adopted`)) {
    const machine = await lit<AdoptedDef>(`${base}/adopted/${n}/machine.ts`, "machine");
    if (!machine) continue;
    const observed = await lit<Observed>(`${base}/adopted/${n}/observed.ts`, "observed");
    adopted.push({
      machine,
      ...(observed ? { observed } : {}),
      results: policies(machine, observed, o.now),
    });
  }
  const devices: PcFacts["devices"] = [];
  for (const n of await r.list(`${base}/devices`)) {
    const device = await lit<DeviceDef>(`${base}/devices/${n}/device.ts`, "device");
    if (!device) continue;
    const observed = await lit<DeviceObserved>(`${base}/devices/${n}/observed.ts`, "observed");
    devices.push({
      device,
      ...(observed ? { observed } : {}),
      results: devicePolicies(device, observed, o.now),
    });
  }
  const clouds: PcFacts["clouds"] = [];
  for (const c of o.connectors) {
    const observed = await lit<Observation>(`${base}/estate/${c.id}.ts`, "observed");
    if (!observed) continue;
    clouds.push({
      id: c.id,
      title: c.title,
      logo: c.logo,
      connected: true,
      observed,
      results: c.policies(observed, o.now),
    });
  }
  // Spec 111-network-posture FR-014: the network's posture as the repository records it (the routers' observations, the network
  // assets and the adopted machines a client may match). Tags are not read from a commit, so ownership is not judged here.
  let networkPosture: PcFacts["networkPosture"];
  {
    const routers = new Set(
      o.connectors.filter((c) => c.integrationKinds?.includes("router")).map((c) => c.id),
    );
    const observations = clouds.flatMap((c) =>
      c.observed && routers.has(c.id) ? [c.observed] : [],
    );
    if (observations.length) {
      const { evaluateNetworkPosture } = await import("../connect/network-posture.ts");
      const { buildNetworkView } = await import("../connect/network-view.ts");
      const assets: NetworkAssetDef[] = [];
      for (const n of await r.list(`${base}/adopted`)) {
        const a = await lit<NetworkAssetDef>(`${base}/adopted/${n}/network.ts`, "asset");
        if (a) assets.push(a);
      }
      const machines = adopted.map((a) => ({
        name: a.machine.name,
        ...(a.machine.macs?.length ? { macs: a.machine.macs } : {}),
        address: a.machine.ssh.address,
      }));
      const view = buildNetworkView({ observations, assets, machines });
      const config = await lit<NetworkConfig>(`${base}/network.ts`, "network");
      networkPosture = evaluateNetworkPosture({ observations, assets, view, config, now: o.now });
    }
  }
  const controls = o.packs
    ? await o.packs({
        adopted,
        devices,
        connectors: clouds.flatMap((c) =>
          c.observed ? [{ connector: c.id, observed: c.observed }] : [],
        ),
      })
    : undefined;
  const facts: PcFacts = {
    fleet: { id: fleet, title: fleet, repo: "" },
    machines: [],
    adopted,
    clouds,
    devices,
    ...(networkPosture ? { networkPosture } : {}),
    ...(controls ? { controls } : {}),
    signers: [],
    git: { dirty: [], unapproved: [], log: [] },
  };
  const v = fleetFreshView(facts, o.catalog, {
    now: o.now,
    ...(o.cadences ? { cadences: o.cadences } : {}),
  });
  // Only what the repository records: the repository's own checks need this PC's state.
  const keep = (e: Evidence) =>
    e.source === "adopted" ||
    e.source === "device" ||
    e.source === "cloud" ||
    e.source === "network" ||
    (!!o.packs && e.source === "control pack");
  const { combine } = await import("./report.ts");
  return {
    ...v,
    controls: v.controls.map((c) => {
      const evidence = c.evidence.filter(keep);
      return { ...c, evidence, status: combine(evidence.map((e) => e.status)) };
    }),
  };
}

/** One piece of evidence whose result changed. */
export interface EvidenceChange {
  /** Where it came from. */
  source: Evidence["source"];
  /** What it is about. */
  subject: string;
  /** The check. */
  check: string;
  /** Its result then (undefined: there was none). */
  from?: Evidence["status"];
  /** Its result now (undefined: there is none). */
  to?: Evidence["status"];
  /** Stale now. */
  stale?: boolean;
}

/** One control whose status changed. */
export interface ControlChange {
  /** The SCF control id. */
  id: string;
  /** Its name. */
  name: string;
  /** Its status then. */
  from: Coverage;
  /** Its status now. */
  to: Coverage;
  /** Worse now than then. */
  worse: boolean;
  /** The evidence that changed under it. */
  evidence: EvidenceChange[];
}

const RANK: Record<Coverage, number> = { fail: 0, "no evidence": 1, partial: 2, pass: 3 };

/** Evidence by its source, subject, and check: what drift compares (kernel `assess.drift`). */
function evidenceView(evidence: readonly Evidence[]): Map<string, Json> {
  return new Map(
    evidence.map((e) => [
      keyOf(e),
      { source: e.source, subject: e.subject, check: e.check, status: e.status, stale: !!e.stale },
    ]),
  );
}

const keyOf = (e: Evidence): string => JSON.stringify([e.source, e.subject, e.check]);
const keyed = (evidence: readonly Evidence[]): Map<string, Evidence> =>
  new Map(evidence.map((e) => [keyOf(e), e]));

/** The controls whose status differs between two views, worse first; each with the evidence that changed under it. */
export function compareViews(before: ComplianceView, after: ComplianceView): ControlChange[] {
  const out: ControlChange[] = [];
  for (const a of after.controls) {
    const b = before.controls.find((x) => x.control.id === a.control.id);
    const from: Coverage = b?.status ?? "no evidence";
    if (from === a.status) continue;
    const then = keyed(b?.evidence ?? []);
    const now = keyed(a.evidence);
    const d = assess.drift(evidenceView(b?.evidence ?? []), evidenceView(a.evidence));
    const evidence: EvidenceChange[] = [];
    for (const { key } of d.removed) {
      const x = then.get(key);
      if (x)
        evidence.push({ source: x.source, subject: x.subject, check: x.check, from: x.status });
    }
    for (const { key } of d.added) {
      const y = now.get(key);
      if (!y) continue;
      evidence.push({
        source: y.source,
        subject: y.subject,
        check: y.check,
        to: y.status,
        ...(y.stale ? { stale: true } : {}),
      });
    }
    for (const { key, changes } of d.changed) {
      const x = then.get(key);
      const y = now.get(key);
      if (!x || !y || !changes.some((c) => c.field === "$.status")) continue;
      evidence.push({
        source: y.source,
        subject: y.subject,
        check: y.check,
        from: x.status,
        to: y.status,
        ...(y.stale ? { stale: true } : {}),
      });
    }
    out.push({
      id: a.control.id,
      name: a.control.name,
      from,
      to: a.status,
      worse: RANK[a.status] < RANK[from],
      evidence,
    });
  }
  return out.sort((x, y) => Number(y.worse) - Number(x.worse) || x.id.localeCompare(y.id));
}

/** A drift between two points in the repository's history. */
export interface Drift {
  /** The fleet. */
  fleet: string;
  /** The past side: its commit and that commit's time. */
  since: { rev: string; at: string };
  /** The present side: the working tree, as of this time. */
  now: { at: string };
  /** The controls whose status changed. */
  changes: ControlChange[];
  /**
   * Spec 111-network-posture FR-019: the network's change events of the same period (a device added, gone, renamed or updated; a
   * Wi-Fi network, a network or a firewall rule added, removed or changed), from the history of the routers' observation files. Events,
   * never a status; absent where no router is connected.
   */
  network?: NetworkChange[];
}

/**
 * The message for the fleet's mailbox: what changed, by control, with
 * subjects, checks, and statuses only (never what a check found, which could
 * hold anything an account returned), and the commands to run next.
 */
export function driftEvent(d: Drift): Event {
  // Spec 117-adopted-in-status FR-006: a control nothing was observed for is waiting for an observation, not worse.
  const worse = d.changes.filter((c) => c.worse && !isNotObserved(c));
  const lines = [
    `Compliance drift in fleet ${d.fleet}, from ${d.since.rev.slice(0, 10)} (${d.since.at
      .slice(0, 16)
      .replace("T", " ")} UTC) to now (${d.now.at.slice(0, 16).replace("T", " ")} UTC):`,
    "",
  ];
  for (const c of d.changes) {
    lines.push(
      isNotObserved(c)
        ? notObservedWords(c).text
        : `${c.id} ${c.name}: ${c.from} -> ${c.to}${c.worse ? " (worse)" : ""}`,
    );
    for (const e of c.evidence.slice(0, 10)) {
      lines.push(
        `  ${e.subject} (${e.source}): ${e.check}: ${e.from ?? "none"} -> ${e.to ?? "none"}${
          e.stale ? " (stale)" : ""
        }`,
      );
    }
    if (c.evidence.length > 10) lines.push(`  and ${c.evidence.length - 10} more`);
  }
  // Spec 111-network-posture FR-019: the network's changes by kind and subject only, never what a value was.
  if (d.network?.length) {
    lines.push("", `Network changes (${d.network.length}):`);
    for (const c of d.network.slice(0, 20)) lines.push(`  ${changeLine(c)}`);
    if (d.network.length > 20) lines.push(`  and ${d.network.length - 20} more`);
  }
  return {
    event: `compliance drift: ${d.changes.length} control(s) changed${
      worse.length ? `, ${worse.length} worse` : ""
    }${d.network?.length ? `, ${d.network.length} network change(s)` : ""}`,
    level: worse.some((c) => c.to === "fail") ? "fail" : worse.length ? "warn" : "info",
    what: lines.join("\n"),
    todo: "Run bun run stolos compliance on the PC: each failing check names its fix; stale evidence names the command that observes it again.",
    key: `compliance-drift-${d.fleet}-${d.since.rev.slice(0, 12)}-${d.changes
      .map((c) => `${c.id}:${c.to}`)
      .join(",")}${d.network?.length ? `-net${d.network.length}` : ""}`,
  };
}

/**
 * The commit `since` names: a commit (hash, branch, tag, `HEAD~3`), else the
 * last commit before a date Git understands ("2026-11-01", "1 day ago").
 */
export async function resolveSince(
  repo: string,
  since: string,
): Promise<{ rev: string; at: string } | { error: string }> {
  const git = (args: string[]) => run(["git", "-C", repo, ...args]);
  let rev = "";
  if (!since.startsWith("-")) {
    const r = await git(["rev-parse", "--verify", "--quiet", `${since}^{commit}`]);
    if (r.ok) rev = r.stdout.trim();
  }
  if (!rev) {
    const r = await git(["rev-list", "-1", `--before=${since}`, "HEAD"]);
    rev = r.ok ? r.stdout.trim() : "";
  }
  if (!rev) return { error: `no commit at or before ${since}` };
  const at = (await git(["show", "-s", "--format=%cI", rev])).stdout.trim();
  return { rev, at: new Date(at).toISOString() };
}

/** Compare the repository at `since` with the working tree. */
export async function drift(o: {
  repo: string;
  fleet: string;
  since: string;
  now?: number;
  connectors?: Connector[];
  cadences?: Cadences;
  catalog?: ScfCatalog;
}): Promise<Drift | { error: string }> {
  const s = await resolveSince(o.repo, o.since);
  if ("error" in s) return s;
  const { gitReader } = await import("../estate/snapshot.ts");
  const connectors =
    o.connectors ?? (await (await import("../connect/commands.ts")).allConnectors());
  const now = o.now ?? Date.now();
  const common = {
    connectors,
    ...(o.cadences ? { cadences: o.cadences } : {}),
    ...(o.catalog ? { catalog: o.catalog } : {}),
  };
  const before = await repoEvidence(gitReader(o.repo, s.rev), o.fleet, {
    ...common,
    now: Date.parse(s.at),
  });
  const after = await repoEvidence(gitReader(o.repo), o.fleet, { ...common, now });
  // Spec 111-network-posture FR-019: the network's change events of the same period.
  const { networkChanges } = await import("../connect/network-changes.ts");
  const routers = connectors.filter((c) => c.integrationKinds?.includes("router")).map((c) => c.id);
  const history = routers.length
    ? await networkChanges({ repo: o.repo, fleet: o.fleet, connectors: routers, since: s.rev, now })
    : undefined;
  return {
    fleet: o.fleet,
    since: s,
    now: { at: new Date(now).toISOString() },
    changes: compareViews(before, after),
    ...(history && !("error" in history) ? { network: history.changes } : {}),
  };
}

/** `stolos compliance drift`: print the drift; with `notify`, mail it to the fleet's mailbox. */
export async function driftCommand(
  o: { since?: string; notify?: boolean; json?: boolean } = {},
): Promise<number> {
  const { ui } = await import("../core/ui.ts");
  const { P } = await import("../core/paths.ts");
  const { loadCadences } = await import("./freshness.ts");
  const p = ui.phase("Compliance drift");
  if (!P.fleetId) {
    p.fail("no fleet chosen", "bun run stolos fleet use <id>");
    return 1;
  }
  const d = await drift({
    repo: P.repo,
    fleet: P.fleetId,
    since: o.since ?? "1 day ago",
    cadences: await loadCadences(),
  });
  if ("error" in d) {
    p.fail(d.error, "--since takes a commit, or a date with a commit before it");
    return 1;
  }
  if (o.json) {
    stdio.stdout.writeSync(`${JSON.stringify(d, null, 2)}\n`);
  } else {
    for (const c of d.changes) {
      const msg = `${c.id} ${c.name}: ${c.from} -> ${c.to}`;
      if (isNotObserved(c)) {
        const w = notObservedWords(c);
        p.pending(w.text, w.fix, NO_EVIDENCE_CODE);
      } else if (c.worse) p.warn(msg, "bun run stolos compliance");
      else p.ok(msg);
      for (const e of c.evidence.slice(0, 10)) {
        p.note(
          `${e.subject} (${e.source}): ${e.check}: ${e.from ?? "none"} -> ${e.to ?? "none"}${
            e.stale ? " (stale)" : ""
          }`,
        );
      }
    }
    // Spec 111-network-posture FR-019: the network's recorded changes, as events (CM-3, CM-6).
    for (const c of d.network ?? []) {
      ui.say(
        `network change ${c.at.slice(0, 10)} ${c.commit.slice(0, 10)}: ${c.kind}: ${c.subject}: ${c.detail}${c.uncommitted ? " (uncommitted)" : ""} [${c.scf.join(", ")}]`,
      );
    }
  }
  if (o.notify && (d.changes.length || d.network?.length)) {
    const { notify } = await import("../notify/events.ts");
    const r = await notify(driftEvent(d));
    if (r === "queued") p.ok("queued for the fleet's mailbox (fleet.mail.to)");
    else p.note(`not mailed: ${r}`);
  }
  const netNote = d.network?.length ? `; ${d.network.length} network change(s)` : "";
  p.done(
    d.changes.length
      ? `${d.changes.length} control(s) changed since ${d.since.rev.slice(0, 10)} (${d.since.at.slice(
          0,
          10,
        )})${netNote}`
      : `no control changed since ${d.since.rev.slice(0, 10)} (${d.since.at.slice(0, 10)})${netNote}`,
  );
  return 0;
}
