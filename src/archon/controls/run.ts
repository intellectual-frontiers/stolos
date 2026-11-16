/**
 * Spec 078: a fleet's control packs, loaded and run. Each pack is a folder,
 * `fleets/<fleet>/controls/<pack>/`, whose `pack.ts` exports the pack (as
 * `pack`, or as its default export) and whose `*_test.ts` files test it. Risks
 * the owner accepted are in `fleets/<fleet>/controls/accepted.ts` (exporting
 * `accepted`), each naming a result as `<pack>/<control>`.
 *
 * ```mermaid
 * flowchart LR
 *   packs["fleets/&lt;fleet&gt;/controls/*&#47;pack.ts"] --> load["loadControlPacks"]
 *   load --> run["runPack"]
 *   estate[("estate graph")] --> run
 *   probe["adopted machines: osquery through the probe"] --> run
 *   obs["observations: adopted, devices, accounts"] --> run
 *   run --> results["results: &lt;pack&gt;/&lt;control&gt;, per subject"]
 *   results --> compliance["stolos compliance, the Compliance tab: source control pack"]
 * ```
 *
 * An osquery control asks the machines only when `stolos controls run` runs;
 * each machine's answer is kept in this PC's state, and the consoles and
 * `stolos compliance` assert over the answers kept (so a change to the
 * assertion shows at once, and nothing is asked of a machine to draw a page).
 *
 * @module
 */

import type { Acceptance, AdoptedDef, Observed } from "../adopt/adopt.ts";
import type { PolicyResult } from "../adopt/policy.ts";
import type { Observation } from "../connect/connector.ts";
import type { DeviceDef, DeviceObserved } from "../device/device.ts";
import type { Estate } from "../estate/graph.ts";
import { fs, path, toError } from "@intellectual-frontiers/commons/ts/runtime";
import { P } from "../core/paths.ts";
import type { Control, ControlPack, OsqueryControl } from "./define.ts";
import { acceptRisks, type MachineAnswer, runEstate, runObservation, runOsquery } from "./core.ts";

/** One control's result for one subject, from a pack. */
export interface ControlResult extends PolicyResult {
  /** What it is about: a machine, a device, an account, or "across systems". */
  subject: string;
  /** The control's own id (the result's id is `<pack>/<control>`). */
  control: string;
  /** The estate node uids it is about (estate controls). */
  subjects?: string[];
}

/** A pack's results. */
export interface PackRun {
  /** The pack. */
  pack: { id: string; title: string; version: string };
  /** Its results, control by control, subject by subject. */
  results: ControlResult[];
}

/** What a pack's controls read. Each part is optional: a control whose input is missing says unknown. */
export interface PackInputs {
  /** The estate graph (estate controls). */
  estate?: Estate;
  /** Each adopted machine's answer to an osquery control (osquery controls). */
  osquery?: (c: OsqueryControl) => Promise<MachineAnswer[]> | MachineAnswer[];
  /** Adopted machines and their observations. */
  adopted?: ReadonlyArray<{ machine: AdoptedDef; observed?: Observed }>;
  /** Devices and their observations. */
  devices?: ReadonlyArray<{ device: DeviceDef; observed?: DeviceObserved }>;
  /** Connected accounts and their observations. */
  connectors?: ReadonlyArray<{ connector: string; observed: Observation }>;
  /** Accepted risks (`<pack>/<control>`), from controls/accepted.ts. */
  accepted?: readonly Acceptance[];
  /** Now. */
  now?: Date;
}

/** The subject of a result that is about the whole estate. */
export const ACROSS = "across systems";

/** One control's results (without accepted risks, ids not yet prefixed). */
async function runOne(c: Control, i: PackInputs, now: Date): Promise<ControlResult[]> {
  const base = (subject: string, r: PolicyResult): ControlResult => ({
    ...r,
    subject,
    control: c.id,
  });
  const unknown = (subject: string, detail: string): ControlResult =>
    base(subject, {
      id: c.id,
      title: c.title,
      scf: [...c.scf],
      status: "unknown",
      detail,
      ...(c.subject !== "observation" && c.fix ? { fix: c.fix } : {}),
    });
  try {
    if (c.subject === "estate") {
      const estate = i.estate;
      if (!estate) return [unknown(ACROSS, "the estate graph is not available")];
      const { estateQuery } = await import("../estate/graph.ts");
      const r = runEstate(c, (sql) => estateQuery(estate, sql), now);
      if (!r) return [];
      const { subjects, ...rest } = r;
      return [{ ...base(ACROSS, rest), ...(subjects.length ? { subjects } : {}) }];
    }
    if (c.subject === "osquery") {
      const { queryRefusal } = await import("../state/query.ts");
      const why = queryRefusal(c.query);
      if (why) return [unknown("adopted machines", `the query is refused: ${why}`)];
      const answers = i.osquery ? await i.osquery(c) : [];
      if (!answers.length) {
        return [
          unknown(
            "adopted machines",
            "no adopted machine has answered yet (bun run stolos controls run asks them)",
          ),
        ];
      }
      return runOsquery(c, answers, now).map(({ machine, ...r }) => base(machine, r));
    }
    const t = now.getTime();
    const out: ControlResult[] = [];
    if (c.of === "adopted") {
      for (const a of i.adopted ?? []) {
        if (!a.observed) continue;
        const r = runObservation(c, { machine: a.machine, observed: a.observed, now: t });
        if (r) out.push(base(a.machine.name, r));
      }
    } else if (c.of === "device") {
      for (const d of i.devices ?? []) {
        if (!d.observed) continue;
        const r = runObservation(c, { device: d.device, observed: d.observed, now: t });
        if (r) out.push(base(d.device.name, r));
      }
    } else {
      for (const x of i.connectors ?? []) {
        const r = runObservation(c, { connector: x.connector, observed: x.observed, now: t });
        if (r) out.push(base(`${x.connector} (${x.observed.account})`, r));
      }
    }
    return out;
  } catch (e) {
    return [unknown(ACROSS, `the control failed: ${toError(e).message}`)];
  }
}

/** Run every control of a pack: results with ids `<pack>/<control>`, accepted risks applied. */
export async function runPack(pack: ControlPack, inputs: PackInputs = {}): Promise<PackRun> {
  const now = inputs.now ?? new Date();
  const results: ControlResult[] = [];
  for (const c of pack.controls) {
    for (const r of await runOne(c, inputs, now)) {
      const id = `${pack.id}/${r.id}`;
      const own = inputs.adopted?.find((a) => a.machine.name === r.subject)?.machine.accepted ?? [];
      results.push(
        ...acceptRisks([...(inputs.accepted ?? []), ...own], [{ ...r, id }], now.getTime()),
      );
    }
  }
  return { pack: { id: pack.id, title: pack.title, version: pack.version }, results };
}

/** Where a fleet's packs are. */
export function controlsDir(): string {
  return path.join(P.fleetDir, "controls");
}

/** A pack found in the fleet, with its folder. */
export interface LoadedPack {
  /** Its folder. */
  dir: string;
  /** The pack. */
  pack: ControlPack;
}

/** A fleet module (`pack.ts`, `risks.ts`, ...), imported afresh (a changed file is read again), as its exports. */
export async function importFresh(file: string): Promise<Record<string, unknown>> {
  const mod: unknown = await import(`${path.toFileUrl(file).href}?t=${Date.now()}`);
  return typeof mod === "object" && mod !== null ? { ...mod } : {};
}

const isPack = (x: unknown): x is ControlPack =>
  !!x &&
  typeof x === "object" &&
  typeof (x as ControlPack).id === "string" &&
  Array.isArray((x as ControlPack).controls);

/** Every pack in `dir` (each folder with a pack.ts), sorted by folder; a pack that fails to load is a problem, not an error. */
export async function loadControlPacks(
  dir: string = controlsDir(),
): Promise<{ packs: LoadedPack[]; problems: string[] }> {
  const packs: LoadedPack[] = [];
  const problems: string[] = [];
  const names = (await fs.listDirs(dir)).filter((n) => !n.startsWith("_"));
  for (const n of names) {
    const f = path.join(dir, n, "pack.ts");
    if (!(await fs.exists(f))) continue;
    try {
      const mod = await importFresh(f);
      const pack = mod["pack"] ?? mod["default"];
      if (!isPack(pack)) {
        problems.push(
          `controls/${n}/pack.ts exports no pack (export const pack = defineControlPack(...))`,
        );
        continue;
      }
      if (packs.some((p) => p.pack.id === pack.id)) {
        problems.push(`controls/${n}: a second pack named ${pack.id}`);
        continue;
      }
      packs.push({ dir: path.join(dir, n), pack });
    } catch (e) {
      problems.push(`controls/${n}/pack.ts: ${toError(e).message.split("\n")[0]}`);
    }
  }
  return { packs, problems };
}

/** The risks the owner accepted for the fleet's packs (controls/accepted.ts), or none. */
export async function loadAccepted(dir: string = controlsDir()): Promise<Acceptance[]> {
  const f = path.join(dir, "accepted.ts");
  if (!(await fs.exists(f))) return [];
  const accepted = (await importFresh(f))["accepted"];
  return Array.isArray(accepted) ? (accepted as Acceptance[]) : [];
}

/** The name an osquery answer is kept under in this PC's state. */
export const answerName = (pack: string, control: string): string => `${pack}/${control}`;

/** Osquery answers kept from the last `stolos controls run` (nothing is asked of a machine). */
export function keptAnswers(
  pack: string,
  adopted: ReadonlyArray<{ machine: AdoptedDef }>,
  dir?: string,
): (c: OsqueryControl) => Promise<MachineAnswer[]> {
  return async (c) => {
    const { getRecord } = await import("../state/store.ts");
    const out: MachineAnswer[] = [];
    for (const { machine } of adopted) {
      const r = await getRecord<MachineAnswer>(
        machine.name,
        "control",
        answerName(pack, c.id),
        ...(dir ? [dir] : []),
      );
      if (r) out.push({ ...r.body, machine: machine.name });
    }
    return out;
  };
}

/** Ask each adopted machine now, through its probe, and keep each answer in this PC's state. */
export function liveAnswers(
  pack: string,
  adopted: ReadonlyArray<{ machine: AdoptedDef }>,
): (c: OsqueryControl) => Promise<MachineAnswer[]> {
  return async (c) => {
    const { queryAdopted } = await import("../adopt/commands.ts");
    const { putRecord } = await import("../state/store.ts");
    const answers: MachineAnswer[] = (await queryAdopted(c.query, adopted)).map((a) => ({
      machine: a.machine,
      ...(a.rows ? { rows: a.rows } : {}),
      ...(a.error ? { error: a.error } : {}),
    }));
    for (const a of answers) await putRecord(a.machine, "control", answerName(pack, c.id), a);
    return answers;
  };
}

/** What the fleet's packs read, and whether to ask machines now. */
export interface FleetInputs extends Omit<PackInputs, "osquery" | "accepted"> {
  /** Ask adopted machines now (`stolos controls run`), or use the answers kept (the consoles). */
  live?: boolean;
  /** Only this pack. */
  only?: string;
  /** Where the packs are (default: fleets/<fleet>/controls). */
  dir?: string;
}

/** Load and run every pack of the fleet. */
export async function runFleetPacks(
  i: FleetInputs,
): Promise<{ runs: PackRun[]; problems: string[] }> {
  const dir = i.dir ?? controlsDir();
  const { packs, problems } = await loadControlPacks(dir);
  const accepted = await loadAccepted(dir).catch((e) => {
    problems.push(`controls/accepted.ts: ${toError(e).message.split("\n")[0]}`);
    return [];
  });
  const adopted = i.adopted ?? [];
  const runs: PackRun[] = [];
  for (const { pack } of packs.filter((p) => !i.only || p.pack.id === i.only)) {
    runs.push(
      await runPack(pack, {
        ...i,
        accepted,
        osquery: i.live ? liveAnswers(pack.id, adopted) : keptAnswers(pack.id, adopted),
      }),
    );
  }
  if (i.only && !packs.some((p) => p.pack.id === i.only)) {
    problems.push(
      `no pack ${i.only} (one of: ${packs.map((p) => p.pack.id).join(", ") || "none"})`,
    );
  }
  return { runs, problems };
}
