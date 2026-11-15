/**
 * Spec 095-proposals: `archon drift` on a server. It reads what the
 * collectors stored in `archon.sql` (the daily report, every apply, and
 * `archon drift --collect` collect), computes drift against the plan and the
 * birth snapshot, and prints each item with who changed it, when, and the
 * model change that would adopt it. Read-only, so it is also an MCP tool.
 *
 * @module
 */

import { proc, stdio } from "@intellectual-frontiers/ifc-ts/runtime";
import { P } from "../core/paths.ts";
import { getRecord, listRecords } from "../state/store.ts";
import type { HostDef } from "../model/types.ts";
import {
  type Birth,
  computeDrift,
  driftText,
  type Hold,
  type HostState,
  type SentProposal,
  unproposed,
} from "./drift.ts";
import type { Alert, DriftItem, Observation, ProposalDecisions } from "./types.ts";

/** Everything stored about drift on this host, and the drift computed from it. */
export interface DriftView {
  /** The drift items. */
  items: DriftItem[];
  /** Modified package files (security alerts). */
  alerts: Alert[];
  /** The birth snapshot, if taken. */
  birth?: Birth;
  /** The latest state, if collected. */
  state?: HostState;
  /** Every stored observation. */
  observations: Observation[];
  /** Proposals sent from this host. */
  proposals: SentProposal[];
  /** Decisions in Git about them. */
  decisions: ProposalDecisions;
  /** Holds on managed items. */
  holds: Hold[];
}

/** Drift from what archon.sql holds (nothing is collected here). */
export async function loadDrift(
  host: HostDef,
  dir: string = P.state,
  now = new Date(),
): Promise<DriftView> {
  const birth = (await getRecord<Birth>(host.name, "birth", "birth", dir))?.body;
  const state = (await getRecord<HostState>(host.name, "snapshot", "state", dir))?.body;
  const observations = (await listRecords<Observation>(host.name, "observation", dir)).map(
    (r) => r.body,
  );
  const alerts = (await listRecords<Alert>(host.name, "alert", dir)).map((r) => r.body);
  const proposals = (await listRecords<SentProposal>(host.name, "proposal", dir)).map(
    (r) => r.body,
  );
  const holds = (await listRecords<Hold>(host.name, "hold", dir)).map((r) => r.body);
  const { loadProposalDecisions } = await import("./decisions.ts");
  const decisions = await loadProposalDecisions(host.name);
  if (!birth || !state) {
    return {
      items: [],
      alerts,
      ...(birth === undefined ? {} : { birth }),
      ...(state === undefined ? {} : { state }),
      observations,
      proposals,
      decisions,
      holds,
    };
  }
  const { planFor } = await import("../build.ts");
  const { planView } = await import("./collect.ts");
  const items = computeDrift({
    plan: planView(await planFor(host)),
    birth,
    state,
    observations,
    proposals,
    decisions,
    holds,
    now,
  });
  return { items, alerts, birth, state, observations, proposals, decisions, holds };
}

/** `archon drift [--all] [--collect]`: print drift (and collect first, as root, with --collect). */
export async function driftCommand(
  host: HostDef,
  opts: { all?: boolean; collect?: boolean; json?: boolean },
): Promise<number> {
  if (opts.collect) {
    if (!proc.isRoot()) {
      throw new Error("archon drift --collect runs as root (it elevates through sudo)");
    }
    const { collect } = await import("./collect.ts");
    const c = await collect(host);
    if (!opts.json) {
      stdio.stderr.writeSync(
        `collected ${c.observations} observation(s)${
          Object.keys(c.failed).length ? `; not read: ${Object.keys(c.failed).join(", ")}` : ""
        }${c.birthTakenLate ? "; birth snapshot taken now (late)" : ""}\n`,
      );
    }
  }
  const v = await loadDrift(host);
  const items = opts.all ? v.items : unproposed(v.items);
  const { groupItems } = await import("./group.ts");
  const { recordings } = await import("./propose.ts");
  const intents = groupItems(items, v.observations, await recordings(host.name));
  if (opts.json) {
    stdio.stdout.writeSync(
      `${JSON.stringify(
        { host: host.name, collected: v.state?.at, items, intents, alerts: v.alerts },
        null,
        2,
      )}\n`,
    );
    return 0;
  }
  if (!v.state || !v.birth) {
    stdio.stdout.writeSync(
      `nothing collected on ${host.name} yet: sudo archon drift --collect (the daily report collects too)\n`,
    );
    return 0;
  }
  stdio.stdout.writeSync(
    `${driftText(host.name, v.items, v.alerts, {
      all: opts.all,
      birthLate: v.birth.late,
      collected: v.state.at,
    })}\n`,
  );
  if (intents.length) {
    stdio.stdout.writeSync("\nChange sessions (archon propose --intent <id>):\n");
    for (const i of intents) {
      stdio.stdout.writeSync(
        `  ${i.id}${i.who ? ` ${i.who}` : ""} ${i.from.slice(0, 16).replace("T", " ")}${
          i.reason ? ` "${i.reason}"` : ""
        }: ${i.items.join(", ")}\n`,
      );
    }
  }
  return v.alerts.length ? 1 : 0;
}
