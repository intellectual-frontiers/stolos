/**
 * Spec 111-network-posture FR-013, FR-016, FR-018: `stolos network check | inventory | changes`. The check runs the posture pack
 * ({@link evaluateNetworkPosture}) over the last observation, the fleet's assets, its tags, its `network.ts` and its accepted risks, and
 * prints a report; the inventory writes the CM-8 listing; `changes` lists what the history of the observation files recorded. All three
 * read Git and this PC's files and ask the controller nothing.
 *
 * ```mermaid
 * flowchart LR
 *   load["loadPosture: observations, assets, tags, network.ts, accepted.ts"] --> eval["evaluateNetworkPosture"]
 *   eval --> check["network check: a report, --json, exit 1 on a failure"]
 *   eval --> ev["compliance evidence (source network)"]
 *   load --> inv["network inventory: Markdown or JSON"]
 *   git["git history of estate/&lt;id&gt;.ts"] --> chg["network changes"]
 * ```
 *
 * @module
 */
// Spec: 111-network-posture FR-003, FR-010, FR-013, FR-015, FR-016, FR-018, FR-020

import { fs, path, stdio } from "@intellectual-frontiers/system";
import { P } from "../core/paths.ts";
import { ui } from "../core/ui.ts";
import type { FleetTags } from "../fleet/tags.ts";
import { loadNetwork } from "./network-commands.ts";
import { loadNetworkConfig } from "./network-asset.ts";
import { buildInventory, inventoryJson, inventoryMarkdown } from "./network-inventory.ts";
import {
  evaluateNetworkPosture,
  failing,
  type NetworkPolicyResult,
  type PostureInput,
  type PostureRun,
  postureCounts,
  postureWaiting,
} from "./network-posture.ts";
import { networkChanges } from "./network-changes.ts";

/** What `--tag`, `--any-tag` and `--select` were given. */
export interface NetworkSelectionArgs {
  /** Repeatable: every tag. */
  tag?: unknown;
  /** Repeatable: any tag. */
  "any-tag"?: unknown;
  /** An expression. */
  select?: unknown;
}

/** The posture of the network now, or why it could not be worked out. */
export interface LoadedPosture {
  /** The run, when the pack could run. */
  run?: PostureRun;
  /** The connectors that are connected (a router with a credential). */
  connected: string[];
  /** Why not (a choice that names no tag, or no asset). */
  error?: { message: string; fix: string };
}

/** The tags of the fleet, as the pack and the inventory read them: the dimensions, and what each asset holds. */
async function tagsOf(assetNames: readonly string[]): Promise<{
  dimensions: string[];
  held: Map<string, string[]>;
  machines: FleetTags["machines"];
  set: FleetTags["set"];
  loaded: boolean;
}> {
  try {
    const { loadFleetTags } = await import("../fleet/tags.ts");
    const ft = await loadFleetTags();
    const held = new Map<string, string[]>();
    for (const m of ft.machines) {
      if (assetNames.includes(m.name))
        held.set(
          m.name,
          m.resolved.tags.map((t) => t.id),
        );
    }
    return {
      dimensions: ft.set ? Object.keys(ft.set.dimensions) : [],
      held,
      machines: ft.machines,
      set: ft.set,
      loaded: ft.error === undefined,
    };
  } catch {
    return { dimensions: [], held: new Map(), machines: [], set: undefined, loaded: false };
  }
}

/**
 * The posture of the network now: the pack run over what this PC and the repository hold. `args` choose the network assets to look at
 * (spec 108-tags: `--tag`, `--any-tag`, `--select`); none checks the whole network.
 */
export async function loadPosture(args: NetworkSelectionArgs = {}): Promise<LoadedPosture> {
  const net = await loadNetwork();
  if (!net.connected.length) return { connected: [] };
  const { config } = await loadNetworkConfig();
  const t = await tagsOf(net.assets.map((a) => a.name));
  let scope: Set<string> | undefined;
  const { selectionFromArgs, chosen, selectionText } = await import("../fleet/tags.ts");
  const sel = selectionFromArgs(args, t.set);
  if (sel.error) {
    return {
      connected: net.connected,
      error: {
        message: sel.error,
        fix: "for example: --tag env:prod, --select 'env:prod and not role:database' (stolos tag list)",
      },
    };
  }
  if (sel.selection) {
    const names = new Set(net.assets.map((a) => a.name));
    scope = new Set(
      chosen(t.machines, sel.selection)
        .map((m) => m.name)
        .filter((n) => names.has(n)),
    );
    if (!scope.size) {
      return {
        connected: net.connected,
        error: {
          message: `no network asset has ${selectionText(sel.selection)}`,
          fix: "stolos tag list shows which machines hold which tags; stolos network status lists the assets",
        },
      };
    }
  }
  let accepted: PostureInput["accepted"];
  try {
    const { loadAccepted } = await import("../controls/run.ts");
    accepted = await loadAccepted();
  } catch {
    // A controls/accepted.ts that does not load is reported by `stolos controls check`; here nothing is accepted.
  }
  const input: PostureInput = {
    observations: net.observations,
    assets: net.assets,
    view: net.view,
    config,
    tags: t.loaded ? { dimensions: t.dimensions, held: t.held } : undefined,
    accepted,
    scope,
    now: Date.now(),
  };
  return { run: evaluateNetworkPosture(input), connected: net.connected };
}

/** The run again over the same data, for the machines a choice keeps (spec 111-network-posture FR-014: compliance scoped by tags). */
export function rescopePosture(run: PostureRun, keep: ReadonlySet<string>): PostureRun {
  const names = new Set(run.input.assets.map((a) => a.name));
  const scope = new Set([...keep].filter((n) => names.has(n)));
  return evaluateNetworkPosture({ ...run.input, scope });
}

/** A result as data (`--json`). */
function resultJson(r: NetworkPolicyResult): Record<string, unknown> {
  return {
    id: r.id,
    title: r.title,
    status: r.status === "unknown" ? "not-observed" : r.status,
    detail: r.detail,
    scf: r.scf,
    code: r.code,
    ...(r.fix === undefined ? {} : { fix: r.fix }),
    items: r.items,
    fields: r.fields,
  };
}

/** The run as data: what `--json` prints and what the console's card draws. */
export function postureJson(run: PostureRun): Record<string, unknown> {
  const waiting = postureWaiting(run);
  return {
    subject: run.subject,
    connector: run.connector,
    ...(run.at === undefined ? {} : { observed: run.at }),
    ...(run.scope === undefined ? {} : { scope: run.scope }),
    counts: postureCounts(run.results),
    policies: run.results.map(resultJson),
    ...(waiting === undefined ? {} : { waiting }),
    notApplicable: run.notApplicable,
    gaps: run.gaps,
    unread: run.unread,
  };
}

/** How many items of a failing result a report lists beneath it. */
const SHOWN = 10;

/**
 * Print a run into a phase: the failing policies as warnings (with items, fix, SCF controls and code), the warnings and accepted risks as
 * notes, the passes, what was not observed yet as one waiting item, what does not apply, and the gaps.
 */
export function printPosture(run: PostureRun, o: { gaps?: boolean; passes?: boolean } = {}): void {
  const p = ui.phase("Network posture");
  // A report is read as a whole (spec 105-calm-output FR-001): its lines are said, not kept for the log; the failing ones are also
  // problems, so that they carry their fix and code to the closing block.
  const say = (l: string): void => ui.say(`  ${l}`);
  const items = (r: NetworkPolicyResult): void => {
    for (const it of r.items.slice(0, SHOWN)) say(`  ${it.subject}: ${it.detail}`);
    if (r.items.length > SHOWN) say(`  and ${r.items.length - SHOWN} more`);
  };
  for (const r of run.results) {
    if (r.status === "unknown") continue;
    if (r.status === "fail") {
      p.warn(`${r.title}: ${r.detail} [${r.scf.join(", ")}]`, r.fix ?? "", r.code);
      say(`fail: ${r.title}: ${r.detail} [${r.scf.join(", ")}]`);
      items(r);
      if (r.fix) say(`  fix: ${r.fix} [${r.code}]`);
    } else if (r.status === "warn") {
      say(`to look at: ${r.title}: ${r.detail} [${r.scf.join(", ")}]`);
      items(r);
      if (r.fix) say(`  fix: ${r.fix} [${r.code}]`);
    } else if (r.status === "accepted") {
      say(`accepted: ${r.title}: ${r.detail}`);
    } else if (o.passes !== false) {
      say(`pass: ${r.title}: ${r.detail}`);
    }
  }
  const waiting = postureWaiting(run);
  if (waiting) p.pending(waiting.message, waiting.fix, waiting.code);
  for (const n of run.notApplicable) say(`not applicable: ${n.title}: ${n.reason}`);
  if (o.gaps !== false) {
    for (const g of run.gaps) say(`gap: ${g.title}: ${g.reason} (missing: ${g.missing})`);
    for (const g of run.unread) say(`not readable: ${g}`);
  }
  const c = postureCounts(run.results);
  p.done(
    [
      `${c.pass} of ${run.results.length} pass`,
      c.fail ? `${c.fail} fail` : "",
      c.warn ? `${c.warn} to look at` : "",
      c.accepted ? `${c.accepted} accepted` : "",
      c.unknown ? `${c.unknown} not observed yet` : "",
    ]
      .filter(Boolean)
      .join(" · "),
  );
}

/** `stolos network check [--tag t] [--any-tag t] [--select e] [--json]`: the posture of the network, as a report. */
export async function networkCheck(args: NetworkSelectionArgs = {}, json = false): Promise<number> {
  const l = await loadPosture(args);
  if (l.error) {
    ui.phase("Network posture").fail(l.error.message, l.error.fix);
    return 1;
  }
  if (!l.run) {
    if (json) {
      stdio.stdout.writeSync(`${JSON.stringify({ connected: [], policies: [] }, null, 2)}\n`);
    } else {
      ui.phase("Network posture").done("no router is connected (bun run stolos connect unifi)");
    }
    return 0;
  }
  if (json) {
    stdio.stdout.writeSync(`${JSON.stringify(postureJson(l.run), null, 2)}\n`);
  } else {
    printPosture(l.run);
  }
  return failing(l.run.results) ? 1 : 0;
}

/** `stolos network inventory [--format markdown|json] [--out file]`: the CM-8 inventory of the network. */
export async function networkInventory(o: { format?: string; out?: string } = {}): Promise<number> {
  const format = o.format ?? "markdown";
  if (format !== "markdown" && format !== "json") {
    ui.phase("Network inventory").fail(
      `${format} is not a format`,
      "--format markdown (the default) or --format json",
    );
    return 1;
  }
  const net = await loadNetwork();
  if (!net.connected.length && !net.assets.length) {
    ui.phase("Network inventory").done("no router is connected (bun run stolos connect unifi)");
    return 0;
  }
  const t = await tagsOf(net.assets.map((a) => a.name));
  const inv = buildInventory({ view: net.view, assets: net.assets, tags: t.held });
  const text = format === "json" ? inventoryJson(inv) : inventoryMarkdown(inv);
  if (o.out === undefined) {
    stdio.stdout.writeSync(text);
    return 0;
  }
  const file = path.resolve(o.out);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeTextFile(file, text);
  ui.phase("Network inventory").done(
    `${inv.devices.length} device(s), ${inv.wifi.length} Wi-Fi network(s), ${inv.networks.length} network(s) written to ${file}`,
  );
  return 0;
}

/** `stolos network changes [--since commit|date] [--json]`: the change events the history of the observation files recorded. */
export async function networkChangesCommand(
  o: { since?: string; json?: boolean } = {},
): Promise<number> {
  const p = ui.phase("Network changes");
  if (!P.fleetId) {
    p.fail("no fleet chosen", "bun run stolos fleet use <id>");
    return 1;
  }
  const { routerObservations } = await import("./network-commands.ts");
  const { routers } = await routerObservations();
  const h = await networkChanges({
    repo: P.repo,
    fleet: P.fleetId,
    connectors: routers,
    since: o.since ?? "7 days ago",
  });
  if ("error" in h) {
    p.fail(h.error, "--since takes a commit, or a date with a commit before it");
    return 1;
  }
  if (o.json) {
    stdio.stdout.writeSync(`${JSON.stringify(h, null, 2)}\n`);
    return 0;
  }
  // A report is read as a whole: each event is said (spec 105-calm-output FR-001), not kept for the log.
  for (const c of h.changes) {
    ui.say(
      `${c.at.slice(0, 16).replace("T", " ")} ${c.commit.slice(0, 10)} ${c.kind}: ${c.subject}: ${c.detail}${c.uncommitted ? " (uncommitted)" : ""} [${c.scf.join(", ")}]`,
    );
  }
  if (h.cut) ui.say("the history was cut at 200 commits: use a later --since for the rest");
  p.done(
    h.changes.length
      ? `${h.changes.length} change(s) since ${h.since.rev.slice(0, 10)} (${h.since.at.slice(0, 10)})`
      : `no change since ${h.since.rev.slice(0, 10)} (${h.since.at.slice(0, 10)})`,
  );
  return 0;
}
