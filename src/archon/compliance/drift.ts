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

import { run } from "../core/exec.ts";
import { exportedLiteral } from "../core/ts-literal.ts";
import type { RepoReader } from "../estate/snapshot.ts";
import type { PcFacts } from "../console/pc.ts";
import type { AdoptedDef, Observed } from "../adopt/adopt.ts";
import type { DeviceDef, DeviceObserved } from "../device/device.ts";
import type { Connector, Observation } from "../connect/connector.ts";
import type { Event } from "../notify/notify.ts";
import type { ScfCatalog } from "./catalog.ts";
import type { ComplianceView, Coverage, Evidence } from "./report.ts";
import { type Cadences, fleetFreshView, type FreshView } from "./freshness.ts";

/** The evidence a fleet repository holds, through a reader (now, or at a commit), as of `now`. */
export async function repoEvidence(
  r: RepoReader,
  fleet: string,
  o: { now: number; connectors: Connector[]; cadences?: Cadences; catalog?: ScfCatalog },
): Promise<FreshView> {
  const base = `fleets/${fleet}`;
  const lit = async <T>(path: string, name: string): Promise<T | undefined> => {
    const text = await r.read(path);
    if (text === undefined) return undefined;
    try {
      return exportedLiteral(text, name) as T;
    } catch {
      return undefined; // Edited by hand: not a literal Stolos wrote.
    }
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
  const facts: PcFacts = {
    fleet: { id: fleet, title: fleet, repo: "" },
    machines: [],
    adopted,
    clouds,
    devices,
    signers: [],
    git: { dirty: [], unapproved: [], log: [] },
  };
  const v = fleetFreshView(facts, o.catalog, {
    now: o.now,
    ...(o.cadences ? { cadences: o.cadences } : {}),
  });
  // Only what the repository records: the repository's own checks need this PC's state.
  const keep = (e: Evidence) =>
    e.source === "adopted" || e.source === "device" || e.source === "cloud";
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

/** The controls whose status differs between two views, worse first. */
export function compareViews(before: ComplianceView, after: ComplianceView): ControlChange[] {
  const out: ControlChange[] = [];
  const key = (e: Evidence) => `${e.source}\u0000${e.subject}\u0000${e.check}`;
  for (const a of after.controls) {
    const b = before.controls.find((x) => x.control.id === a.control.id);
    const from: Coverage = b?.status ?? "no evidence";
    if (from === a.status) continue;
    const then = new Map((b?.evidence ?? []).map((e) => [key(e), e]));
    const now = new Map(a.evidence.map((e) => [key(e), e]));
    const evidence: EvidenceChange[] = [];
    for (const k of new Set([...then.keys(), ...now.keys()])) {
      const x = then.get(k);
      const y = now.get(k);
      if (x && y && x.status === y.status) continue;
      const e = (y ?? x)!;
      evidence.push({
        source: e.source,
        subject: e.subject,
        check: e.check,
        ...(x ? { from: x.status } : {}),
        ...(y ? { to: y.status } : {}),
        ...(y?.stale ? { stale: true } : {}),
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
}

/**
 * The message for the fleet's mailbox: what changed, by control, with
 * subjects, checks, and statuses only (never what a check found, which could
 * hold anything an account returned), and the commands to run next.
 */
export function driftEvent(d: Drift): Event {
  const worse = d.changes.filter((c) => c.worse);
  const lines = [
    `Compliance drift in fleet ${d.fleet}, from ${d.since.rev.slice(0, 10)} (${
      d.since.at.slice(0, 16).replace("T", " ")
    } UTC) to now (${d.now.at.slice(0, 16).replace("T", " ")} UTC):`,
    "",
  ];
  for (const c of d.changes) {
    lines.push(`${c.id} ${c.name}: ${c.from} -> ${c.to}${c.worse ? " (worse)" : ""}`);
    for (const e of c.evidence.slice(0, 10)) {
      lines.push(
        `  ${e.subject} (${e.source}): ${e.check}: ${e.from ?? "none"} -> ${e.to ?? "none"}${
          e.stale ? " (stale)" : ""
        }`,
      );
    }
    if (c.evidence.length > 10) lines.push(`  and ${c.evidence.length - 10} more`);
  }
  return {
    event: `compliance drift: ${d.changes.length} control(s) changed${
      worse.length ? `, ${worse.length} worse` : ""
    }`,
    level: worse.some((c) => c.to === "fail") ? "fail" : worse.length ? "warn" : "info",
    what: lines.join("\n"),
    todo:
      "Run deno task stolos compliance on the PC: each failing check names its fix; stale evidence names the command that observes it again.",
    key: `compliance-drift-${d.fleet}-${d.since.rev.slice(0, 12)}-${
      d.changes.map((c) => `${c.id}:${c.to}`).join(",")
    }`,
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
  const connectors = o.connectors ?? (await import("../connect/commands.ts")).CONNECTORS;
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
  return {
    fleet: o.fleet,
    since: s,
    now: { at: new Date(now).toISOString() },
    changes: compareViews(before, after),
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
    p.fail("no fleet chosen", "deno task stolos fleet use <id>");
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
    console.log(JSON.stringify(d, null, 2));
  } else {
    for (const c of d.changes) {
      const msg = `${c.id} ${c.name}: ${c.from} -> ${c.to}`;
      if (c.worse) p.warn(msg, "deno task stolos compliance");
      else p.ok(msg);
      for (const e of c.evidence.slice(0, 10)) {
        p.note(
          `${e.subject} (${e.source}): ${e.check}: ${e.from ?? "none"} -> ${e.to ?? "none"}${
            e.stale ? " (stale)" : ""
          }`,
        );
      }
    }
  }
  if (o.notify && d.changes.length) {
    const { notify } = await import("../notify/events.ts");
    const r = await notify(driftEvent(d));
    if (r === "queued") p.ok("queued for the fleet's mailbox (fleet.mail.to)");
    else p.note(`not mailed: ${r}`);
  }
  p.done(
    d.changes.length
      ? `${d.changes.length} control(s) changed since ${d.since.rev.slice(0, 10)} (${
        d.since.at.slice(0, 10)
      })`
      : `no control changed since ${d.since.rev.slice(0, 10)} (${d.since.at.slice(0, 10)})`,
  );
  return 0;
}
