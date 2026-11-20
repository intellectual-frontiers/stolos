/**
 * The PC's side of the contract (spec 115-compatibility FR-006 to FR-010, FR-014): what each machine last reported of its engine and its
 * seams is in the PC's observation cache (the `reported` record of its own `archon.sql`, with what a machine says about its tags: no commit
 * per run), and is judged here against this PC's contract, once, for every place that shows it: `stolos fleet status`, `host check`,
 * `boot doctor`, the Stolos Console, `stolos compat` and the compliance evidence.
 *
 * ```mermaid
 * flowchart LR
 *   st["archon state (SSH, MCP)<br/>compat: engine, seams"] --> keep["keepReport<br/>(bounded, no commit)"]
 *   pr["probe @compat<br/>probe_facts"] --> keep
 *   keep --> cache["the PC's archon.sql<br/>kind reported"]
 *   cache --> fc["fleetCompat"]
 *   h["enginePin, engineHolds<br/>(the model)"] --> fc
 *   fc --> j["judgeMachine, describeCompat<br/>(core/compat.ts)"]
 *   j --> out["fleet status, compat, console, evidence"]
 * ```
 *
 * @module
 */
// Spec: 115-compatibility FR-006, FR-007, FR-008, FR-009, FR-014

import { fs, path } from "@intellectual-frontiers/system";
import {
  type CompatWords,
  type ContractKind,
  type ContractReport,
  describeCompat,
  judgeMachine,
  type MachineJudgement,
} from "../core/compat.ts";
import { P } from "../core/paths.ts";
import { describeHold, holdFor, type ResolvedHold } from "../fleet/engine-holds.ts";
import { PIN_FILE, readPin } from "../fleet/upgrade.ts";
import type { MachineReport } from "../model/reported.ts";
import type { HoldFleet, HoldHost } from "../model/holds.ts";
import { lastReports } from "../state/reported.ts";

/** One machine, judged against this PC's contract, with the words that say it. */
export interface CompatMachine {
  /** Its name. */
  name: string;
  /** How it is reached, which says which seams it has. */
  kind: ContractKind;
  /** The judgement: status, engine and each seam. */
  judgement: MachineJudgement;
  /** The statement in plain words, with its fix and code. */
  words: CompatWords;
  /** When the machine last reported (ISO), when it did. */
  reportedAt?: string;
  /** The hold that applies to it (its own `enginePin`, or a group's), when there is one. */
  hold?: ResolvedHold;
  /** The hold in plain words (`held at stolos-v0.150.0 (fleet pin stolos-v0.152.0) ...`). */
  holdWords?: string;
}

/** What a machine reported, as the contract the judge reads. */
export function contractOf(report: MachineReport | undefined): ContractReport | undefined {
  const c = report?.compat;
  return c ? { ...(c.engine ? { engine: c.engine } : {}), seams: c.seams } : undefined;
}

/** What an adopted machine's committed observation says of its probe (`3` is the probe-facts seam at `3.0.0`), for a cache that predates `@compat`. */
export function contractOfProbeVersion(probe: string | undefined): ContractReport | undefined {
  return probe !== undefined && /^\d{1,5}$/.test(probe)
    ? { seams: { "probe-facts": { current: `${probe}.0.0` } } }
    : undefined;
}

/** One machine judged (spec 115-compatibility FR-007, FR-008). `answered`: it was just asked and answered, so "not reported" means its engine predates this check. */
export function compatOf(
  name: string,
  kind: ContractKind,
  report: MachineReport | undefined,
  o: {
    fallback?: ContractReport | undefined;
    hold?: ResolvedHold | undefined;
    fleetPin?: string | undefined;
    answered?: boolean;
    pcEngine?: string;
  } = {},
): CompatMachine {
  const judgement = judgeMachine(kind, contractOf(report) ?? o.fallback);
  const base = describeCompat(name, kind, judgement, o.pcEngine);
  // A machine that answered and still reported nothing runs an engine from before this contract: the fix is on the machine.
  const words: CompatWords =
    o.answered && judgement.status === "unknown" && kind === "managed"
      ? {
          ...base,
          detail: `${name} answered without reporting its engine: it predates this check`,
          fix: `ssh ${name} archon update`,
        }
      : base;
  return {
    name,
    kind,
    judgement,
    words,
    ...(report?.compat ? { reportedAt: report.at } : {}),
    ...(o.hold ? { hold: o.hold, holdWords: describeHold(o.hold, o.fleetPin) } : {}),
  };
}

/** The adopted machines the PC judges: each with its model and its last observation (the committed one is the fallback of an old cache). */
export interface AdoptedForCompat {
  /** The machine (name, role). */
  machine: { name: string };
  /** Its last observation, when there is one. */
  observed?: { probe: string };
}

/** The tag the fleet pins the engine at, from the fleet repository's package.json, or undefined. */
export async function fleetPinTag(repo: string = P.repo): Promise<string | undefined> {
  return readPin((await fs.readTextOr(path.join(repo, PIN_FILE))) ?? "")?.tag;
}

/**
 * Every machine of the fleet judged: the managed servers (not the workstations, which `stolos fleet status` does not ask) from what each
 * reported over SSH, and the adopted machines and the controller from their probe. Reads the cache; asks nobody.
 */
export async function fleetCompat(src: {
  fleet?: HoldFleet | undefined;
  hosts: readonly HoldHost[];
  adopted?: readonly AdoptedForCompat[];
  dir?: string;
  now?: Date;
  /** The tags each machine holds (for a group's hold); read from the fleet's tags when a fleet has groups and this is not given. */
  tagIds?: (name: string) => ReadonlySet<string>;
  /** The machines that were just asked and answered. */
  answered?: ReadonlySet<string>;
  pcEngine?: string;
  fleetPin?: string | undefined;
}): Promise<CompatMachine[]> {
  const none: Record<string, MachineReport> = {};
  const reports = await lastReports(src.dir ?? P.state).catch(() => none);
  const pin = src.fleetPin ?? (await fleetPinTag().catch(() => undefined));
  const tagIds = src.tagIds ?? (await tagIdsOf(src));
  const out: CompatMachine[] = [];
  for (const h of src.hosts.filter((x) => x.kind !== "workstation")) {
    const hold = holdFor(h, src.fleet, tagIds(h.name), src.now);
    out.push(
      compatOf(h.name, "managed", reports[h.name], {
        hold,
        fleetPin: pin,
        ...(src.answered?.has(h.name) ? { answered: true } : {}),
        ...(src.pcEngine ? { pcEngine: src.pcEngine } : {}),
      }),
    );
  }
  for (const a of src.adopted ?? []) {
    out.push(
      compatOf(a.machine.name, "adopted", reports[a.machine.name], {
        fallback: contractOfProbeVersion(a.observed?.probe),
        ...(src.pcEngine ? { pcEngine: src.pcEngine } : {}),
      }),
    );
  }
  return out;
}

/** The tags each host holds, when the fleet has group holds that need them (else nothing is read). */
async function tagIdsOf(src: {
  fleet?: HoldFleet | undefined;
  hosts: readonly HoldHost[];
}): Promise<(name: string) => ReadonlySet<string>> {
  const none = (): ReadonlySet<string> => new Set();
  if (!src.fleet?.engineHolds?.length) return none;
  try {
    const { loadFleetTags } = await import("../fleet/tags.ts");
    const { idSet } = await import("../model/tags.ts");
    // The fleet and its hosts are the model's own (the structural shapes above are what holds read of them).
    const ft = await loadFleetTags({ fleet: src.fleet as never, hosts: src.hosts as never });
    const by = new Map(ft.machines.map((m) => [m.name, idSet(m.resolved)]));
    return (n) => by.get(n) ?? none();
  } catch {
    return none;
  }
}

/** Whether a machine's status is a problem the PC reports (too old or newer); unknown is a thing to do, compatible is nothing. */
export const isIncompatible = (m: Pick<CompatMachine, "judgement">): boolean =>
  m.judgement.status === "too-old" || m.judgement.status === "newer";

/** A machine that cannot read what this PC is about to send (spec 115-compatibility FR-011). */
export interface ApplyWarning {
  /** The machine. */
  machine: string;
  /** Why, in words. */
  message: string;
  /** The command that fixes it. */
  fix?: string;
  /** The code `stolos explain` knows. */
  code?: string;
}

/**
 * Before `stolos apply` signs a change: the managed servers that cannot read what it sends, from what each last reported (the cache; nobody
 * is asked): a `model` or `signed-records` seam that is too old or newer, or any seam too old. It only says; it never blocks (FR-011).
 */
export async function applyWarnings(
  src: Parameters<typeof fleetCompat>[0],
): Promise<ApplyWarning[]> {
  const out: ApplyWarning[] = [];
  for (const m of (await fleetCompat(src)).filter((x) => x.kind === "managed")) {
    const sends = m.judgement.seams.filter(
      (c) =>
        (c.seam === "model" || c.seam === "signed-records") &&
        (c.status === "too-old" || c.status === "newer"),
    );
    if (!sends.length && m.judgement.status !== "too-old") continue;
    out.push({
      machine: m.name,
      message: `${m.name} may not be able to read this change: ${m.words.detail}`,
      ...(m.words.fix ? { fix: m.words.fix } : {}),
      ...(m.words.code ? { code: m.words.code } : {}),
    });
  }
  return out;
}
