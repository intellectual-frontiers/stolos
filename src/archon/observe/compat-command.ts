/**
 * `stolos compat` (spec 115-compatibility FR-016): the contract between this PC and its machines, in one report: the seams with this PC's
 * `current` and `minimum`, this PC's engine, each machine with its engine, status and fix, and each hold at an engine tag with its check.
 * It asks nobody (it reads what the machines last reported, kept by `stolos fleet status` and `stolos host observe`), except
 * `git ls-remote` of the engine's repository for a hold's tag, with a time limit.
 *
 * ```mermaid
 * flowchart LR
 *   cache["the PC's cache<br/>what machines reported"] --> fc["fleetCompat"]
 *   seams["SEAMS: this PC's contract"] --> r["stolos compat"]
 *   fc --> r
 *   holds["enginePin, engineHolds"] --> chk["git ls-remote --tags"]
 *   chk --> r
 *   r --> out["the report, or --json"]
 * ```
 *
 * @module
 */
// Spec: 115-compatibility FR-014, FR-016

import { stdio } from "@intellectual-frontiers/commons/ts/runtime";
import { SEAMS } from "../core/compat.ts";
import { P } from "../core/paths.ts";
import { ui } from "../core/ui.ts";
import { SEAM_IDS } from "../ontology.auto.ts";
import { checkEngineTags, engineUrl, type TagExists } from "../fleet/engine-holds.ts";
import { readPin, PIN_FILE } from "../fleet/upgrade.ts";
import { TAG, VERSION } from "../version.ts";
import { type CompatMachine, fleetCompat, fleetPinTag } from "./compat.ts";

/** What `stolos compat --json` prints. */
export interface CompatReport {
  /** This PC's engine version and its release tag. */
  pc: { engine: string; tag: string; pin?: string };
  /** The seams: this PC's `current` and `minimum` of each. */
  seams: Array<{ seam: string; current: string; minimum: string }>;
  /** Each machine against them. */
  machines: Array<{
    name: string;
    kind: string;
    status: string;
    statement: string;
    detail: string;
    fix?: string;
    code?: string;
    engine?: string;
    reported?: string;
    seams: CompatMachine["judgement"]["seams"];
    hold?: {
      tag: string;
      until: string;
      reason: string;
      source: string;
      expired: boolean;
      exists?: TagExists;
    };
    holdWords?: string;
  }>;
}

/** The report's data (the same for the words and for `--json`). */
export async function compatReport(
  o: {
    machines?: readonly CompatMachine[];
    checkTags?: (tags: string[]) => Promise<Map<string, TagExists>>;
  } = {},
): Promise<CompatReport> {
  let machines = o.machines;
  if (!machines) {
    const { loadFleet, loadHosts } = await import("../model/load.ts");
    const { loadAdopted } = await import("../adopt/adopt.ts");
    const fleet = await loadFleet().catch(() => undefined);
    const hosts = await loadHosts().catch(() => []);
    const adopted = await loadAdopted().catch(() => []);
    machines = await fleetCompat({
      ...(fleet ? { fleet } : {}),
      hosts,
      adopted: adopted.map((a) => ({
        machine: a.machine,
        ...(a.observed ? { observed: a.observed } : {}),
      })),
    });
  }
  const holds = machines.flatMap((m) => (m.hold && !m.hold.expired ? [m.hold.tag] : []));
  const exists = holds.length
    ? await (o.checkTags ?? defaultCheck)([...new Set(holds)])
    : new Map<string, TagExists>();
  const pin = await fleetPinTag().catch(() => undefined);
  return {
    pc: { engine: VERSION, tag: TAG, ...(pin ? { pin } : {}) },
    seams: SEAM_IDS.map((s) => ({ seam: s, ...SEAMS[s] })),
    machines: machines.map((m) => ({
      name: m.name,
      kind: m.kind,
      status: m.judgement.status,
      statement: m.words.headline,
      detail: m.words.detail,
      ...(m.words.fix ? { fix: m.words.fix } : {}),
      ...(m.words.code ? { code: m.words.code } : {}),
      ...(m.judgement.engine ? { engine: m.judgement.engine } : {}),
      ...(m.reportedAt ? { reported: m.reportedAt } : {}),
      seams: m.judgement.seams,
      ...(m.hold
        ? {
            hold: {
              tag: m.hold.tag,
              until: m.hold.until,
              reason: m.hold.reason,
              source: m.hold.source,
              expired: m.hold.expired,
              ...(exists.has(m.hold.tag) ? { exists: exists.get(m.hold.tag) as TagExists } : {}),
            },
          }
        : {}),
      ...(m.holdWords ? { holdWords: m.holdWords } : {}),
    })),
  };
}

/** The engine repository's tags, asked of the fleet's own pin (GitHub, or a `git+` URL), with a time limit. */
async function defaultCheck(tags: string[]): Promise<Map<string, TagExists>> {
  const { fs, path } = await import("@intellectual-frontiers/commons/ts/runtime");
  const pin = readPin((await fs.readTextOr(path.join(P.repo, PIN_FILE))) ?? "");
  const url = pin ? engineUrl(pin) : undefined;
  return url
    ? await checkEngineTags(tags, url)
    : new Map(tags.map((t) => [t, "not-checked" as const]));
}

/** `stolos compat`: the report (verbose by default), `--json`; exit 1 where a machine is too old or newer, or a hold names no tag. */
export async function compatCommand(
  o: { json?: boolean; report?: CompatReport } = {},
): Promise<number> {
  const r = o.report ?? (await compatReport());
  const bad =
    r.machines.some((m) => m.status === "too-old" || m.status === "newer") ||
    r.machines.some((m) => m.hold?.exists === "missing" && !m.hold.expired);
  if (o.json) {
    stdio.stdout.writeSync(`${JSON.stringify(r, null, 2)}\n`);
    return bad ? 1 : 0;
  }
  const c = ui.phase("Contract");
  c.done(
    `this PC runs engine ${r.pc.engine} (${r.pc.tag})${r.pc.pin ? `, the fleet pins ${r.pc.pin}` : ""}; ${r.seams.length} seams`,
  );
  const out = (t: string): void => {
    stdio.stdout.writeSync(`${t}\n`);
  };
  out(`\n  ${"seam".padEnd(16)}${"this PC".padEnd(10)}needs at least`);
  for (const s of r.seams) out(`  ${s.seam.padEnd(16)}${s.current.padEnd(10)}${s.minimum}`);
  out("");
  if (!r.machines.length) ui.phase("Machines").done("no machines yet");
  for (const m of r.machines) {
    const p = ui.phase(m.name);
    if (m.status === "too-old" || m.status === "newer") p.fail(m.detail, m.fix, m.code);
    else if (m.status === "unknown")
      p.action(m.detail, m.fix ?? "bun run stolos fleet status", m.code);
    if (m.hold) {
      const line = m.holdWords ?? `held at ${m.hold.tag}`;
      if (m.hold.exists === "missing" && !m.hold.expired) {
        p.fail(
          `${m.name} is held at ${m.hold.tag}, which is not a tag of the engine's repository`,
          `choose a tag that exists (bun run stolos fleet upgrade lists the newest), then change enginePin or engineHolds`,
        );
      } else if (m.hold.exists === "not-checked" && !m.hold.expired) {
        p.note(`${line} (not checked: the engine's repository was not reached)`);
      } else p.note(line);
    }
    for (const s of m.seams) {
      p.note(
        `${s.seam}: ${s.machine ?? "not reported"} (this PC ${s.pc}, needs ${s.needs}) ${s.status}`,
      );
    }
    p.done(`${m.statement}${m.engine ? ` · engine ${m.engine}` : ""}`);
  }
  return ui.finish() || (bad ? 1 : 0);
}
