/**
 * Spec 082: the cross-client summary. For each client, read separately in its
 * own scope, only numbers and dates: how many controls pass, fail, are
 * partial, have no evidence, or have stale evidence; how many changed since
 * the last day (and how many got worse); when anything was last observed; how
 * many POA&M items are open; and the date of its newest evidence bundle. No
 * machine, account, check, finding, or person of any client is in it.
 *
 * @module
 */

import { fs, path } from "@intellectual-frontiers/ifc-ts/runtime";
import { P } from "../core/paths.ts";
import type { FreshView } from "../compliance/freshness.ts";
import type { Evidence } from "../compliance/report.ts";
import type { Client } from "./registry.ts";
import { withClient } from "./scope.ts";

/** One client's numbers. */
export interface ClientSummary {
  /** The client's id. */
  client: string;
  /** The client's name, as the provider registered it. */
  title: string;
  /** Whether its checkout could be read; when not, the numbers are zero and `problem` says why. */
  readable: boolean;
  /** Why it could not be read, in general words (never what the checkout holds). */
  problem?: string;
  /** Controls by status; `stale` counts those with any stale evidence. */
  controls: { pass: number; fail: number; partial: number; noEvidence: number; stale: number };
  /** How many machines the fleet knows (managed, adopted, devices, clouds). */
  machines: number;
  /** Controls whose status changed since `since` (none: the history does not reach back). */
  drift?: { since: string; changed: number; worse: number };
  /** When the newest evidence was observed (ISO), if any has a time. */
  lastObservation?: string;
  /** Open POA&M items: failing checks, open risks in the register, open vulnerabilities. */
  poamOpen: number;
  /** The day the newest evidence bundle on this PC was written (YYYY-MM-DD). */
  evidenceBundle?: string;
  /** When the numbers were taken (ISO). */
  asOf: string;
}

/** What `summarize` adds to a client's compliance view. */
export interface SummaryExtras {
  /** How many machines. */
  machines: number;
  /** The drift's counts, when known. */
  drift?: { since: string; changed: number; worse: number };
  /** Open risks in the register, and open vulnerabilities (the rest of the POA&M). */
  openRisks?: number;
  /** Open vulnerabilities. */
  openVulnerabilities?: number;
  /** The newest bundle's day. */
  evidenceBundle?: string;
  /** When. */
  now?: Date;
}

/** The numbers of one client's compliance view: counts and dates only. */
export function summarize(
  c: Pick<Client, "id" | "title">,
  view: FreshView,
  x: SummaryExtras,
): ClientSummary {
  const count = (s: string) => view.controls.filter((k) => k.status === s).length;
  const all: Evidence[] = [...new Set(view.controls.flatMap((k) => k.evidence))];
  const times = all
    .map((e) => e.observedAt)
    .filter((t): t is string => !!t)
    .sort();
  return {
    client: c.id,
    title: c.title,
    readable: true,
    controls: {
      pass: count("pass"),
      fail: count("fail"),
      partial: count("partial"),
      noEvidence: count("no evidence"),
      stale: view.controls.filter((k) => k.freshness.stale > 0).length,
    },
    machines: x.machines,
    ...(x.drift ? { drift: x.drift } : {}),
    ...(times.length ? { lastObservation: times[times.length - 1] } : {}),
    poamOpen:
      all.filter((e) => e.status === "fail").length +
      (x.openRisks ?? 0) +
      (x.openVulnerabilities ?? 0),
    ...(x.evidenceBundle ? { evidenceBundle: x.evidenceBundle } : {}),
    asOf: (x.now ?? new Date()).toISOString(),
  };
}

/** A client that could not be read: zeros, and why in general words. */
export function unreadable(
  c: Pick<Client, "id" | "title">,
  problem: string,
  now = new Date(),
): ClientSummary {
  return {
    client: c.id,
    title: c.title,
    readable: false,
    problem,
    controls: { pass: 0, fail: 0, partial: 0, noEvidence: 0, stale: 0 },
    machines: 0,
    poamOpen: 0,
    asOf: now.toISOString(),
  };
}

/** The day the newest bundle in `dir` was written, or undefined. */
export async function newestBundle(dir: string): Promise<string | undefined> {
  let best = 0;
  try {
    for await (const e of fs.readDir(dir)) {
      if (!e.isFile || !e.name.endsWith(".zip")) continue;
      const m = (await fs.stat(path.join(dir, e.name))).mtime?.getTime() ?? 0;
      if (m > best) best = m;
    }
  } catch {
    /* no bundles */
  }
  return best ? new Date(best).toISOString().slice(0, 10) : undefined;
}

/** What one client's summary and report are made from, read in its scope. */
export interface ClientRead {
  /** Its compliance view, with freshness. */
  view: FreshView;
  /** Its numbers. */
  summary: ClientSummary;
}

/**
 * Read one client, in its own scope: its facts, its compliance view, its drift
 * since `since` (default one day), its register and vulnerabilities, and its
 * newest bundle. A client that cannot be read gives `unreadable`, never an error.
 */
export async function readClient(
  c: Client,
  o: { since?: string; now?: Date } = {},
): Promise<ClientRead | { summary: ClientSummary }> {
  const now = o.now ?? new Date();
  if (!(await fs.exists(c.path))) return { summary: unreadable(c, "its checkout is missing", now) };
  if (!(await fs.exists(path.join(c.path, "fleets", c.fleet, "fleet.ts")))) {
    return { summary: unreadable(c, "its fleet is missing from its checkout", now) };
  }
  try {
    return await withClient(c, async () => {
      const { pcFacts } = await import("../console/pc.ts");
      const { fleetFreshView, loadCadences } = await import("../compliance/freshness.ts");
      const cadences = await loadCadences();
      const f = await pcFacts();
      const view = fleetFreshView(f, undefined, { cadences, now: now.getTime() });
      const { loadRisks } = await import("../risk/register.ts");
      const risks = (await loadRisks().catch(() => undefined)) ?? [];
      const { loadObservations } = await import("../connect/commands.ts");
      const { openVulnerabilities } = await import("../connect/vulnerability.ts");
      const vulns = openVulnerabilities(await loadObservations().catch(() => []));
      let drift: ClientSummary["drift"];
      try {
        const { drift: compare } = await import("../compliance/drift.ts");
        const d = await compare({
          repo: P.repo,
          fleet: P.fleetId,
          since: o.since ?? "1 day ago",
          cadences,
          now: now.getTime(),
        });
        if (!("error" in d)) {
          drift = {
            since: d.since.at,
            changed: d.changes.length,
            worse: d.changes.filter((x) => x.worse).length,
          };
        }
      } catch {
        /* no history to compare: no drift numbers */
      }
      const bundle = await newestBundle(path.join(P.state, "evidence"));
      return {
        view,
        summary: summarize(c, view, {
          machines: f.machines.filter((m) => m.kind !== "discovered").length,
          ...(drift ? { drift } : {}),
          openRisks: risks.filter((r) => r.status === "open").length,
          openVulnerabilities: vulns.length,
          ...(bundle ? { evidenceBundle: bundle } : {}),
          now,
        }),
      };
    });
  } catch {
    return {
      summary: unreadable(c, `it could not be read (stolos --client ${c.id} where)`, now),
    };
  }
}

/** Every client's numbers, each read on its own, in id order. */
export async function clientSummaries(
  clients: Client[],
  o: { since?: string; now?: Date } = {},
): Promise<ClientSummary[]> {
  const out: ClientSummary[] = [];
  for (const c of [...clients].sort((a, b) => a.id.localeCompare(b.id))) {
    out.push((await readClient(c, o)).summary);
  }
  return out;
}

/** The totals across clients (numbers only). */
export function totals(list: ClientSummary[]): {
  clients: number;
  unreadable: number;
  failing: number;
  stale: number;
  poamOpen: number;
  drifted: number;
} {
  return {
    clients: list.length,
    unreadable: list.filter((s) => !s.readable).length,
    failing: list.reduce((n, s) => n + s.controls.fail, 0),
    stale: list.reduce((n, s) => n + s.controls.stale, 0),
    poamOpen: list.reduce((n, s) => n + s.poamOpen, 0),
    drifted: list.filter((s) => (s.drift?.changed ?? 0) > 0).length,
  };
}
