/**
 * The contract between a PC and its machines (spec 115-compatibility): `archon` (on each machine) and `stolos` (on the PC) are
 * one engine, with one version and one release train (spec 114-release-record); what is versioned on its own is the contract
 * between them, in five **seams**. A seam is one interface with a Semantic Version `current` and a `minimum`: the oldest
 * version of that seam the other side may have, that is, the oldest this side still understands. Every number is written here
 * and nowhere else; a golden test (`tests/compat115.test.ts`, `bun run compat:digest`) fails when the shape of a seam changes
 * and its version does not.
 *
 * The rule of change is Semantic Versioning 2.0.0's: a change that breaks a reader raises the major, an addition a reader may
 * ignore raises the minor. A PC judges each machine against its own contract, seam by seam ({@link judgeMachine}), and says it in
 * plain words with the fix ({@link describeCompat}); the engine's own number takes no part in the judgement, only in the words.
 *
 * ```mermaid
 * flowchart LR
 *   pc["this PC: SEAMS<br/>current, minimum"] --> j["judgeMachine"]
 *   m["the machine's report<br/>engine, seams"] --> j
 *   j --> s{"per seam"}
 *   s -->|"machine current below PC minimum"| old["too-old"]
 *   s -->|"machine minimum above PC current,<br/>or a higher major"| newer["newer"]
 *   s -->|"not reported"| unk["unknown"]
 *   s -->|"otherwise"| ok["compatible"]
 * ```
 *
 * @example A machine two minors behind, and one that is too old
 * ```ts
 * import { judgeMachine } from "./compat.ts";
 *
 * const seam = (current: string) => ({ current, minimum: "1.0.0" });
 * const ok = judgeMachine("managed", {
 *   engine: "0.148.0",
 *   seams: { model: seam("1.0.0"), "signed-records": seam("1.0.0"), query: seam("1.0.0"), mcp: seam("1.0.0") },
 * });
 * console.log(ok.status); // compatible
 * console.log(judgeMachine("managed", undefined).status); // unknown
 * ```
 *
 * @module
 */
// Spec: 115-compatibility FR-001, FR-002, FR-005, FR-007, FR-008

import { type CompatStatus, type Seam, SEAM_IDS } from "../ontology.auto.ts";
import { VERSION } from "../version.ts";

/** One seam's version on this side: the version it is at, and the oldest version of the other side it still understands. */
export interface SeamVersion {
  /** The Semantic Version this side is at. */
  readonly current: string;
  /** The oldest Semantic Version of the other side that this side understands (never above `current`). */
  readonly minimum: string;
}

/**
 * The seams, and each seam's version: the one place they are written (spec 115-compatibility FR-001). Raise `current` in the
 * change that needs it: the major for a change that breaks a reader, the minor for an addition (FR-002); `bun run compat:digest`
 * refuses to record a changed shape under an unchanged version.
 */
export const SEAMS: Readonly<Record<Seam, SeamVersion>> = {
  /** The fleet model's types and the site's (`src/archon/model/{types,site}.ts`), which `stolos` renders and `archon` applies. */
  model: { current: "1.0.0", minimum: "1.0.0" },
  /** The signed commit and approval conventions, the pairing check-in text, the observation and verify records. */
  "signed-records": { current: "1.0.0", minimum: "1.0.0" },
  /** The probe's facts; its own `version` (3) is the major (`bin/stolos-probe.sh`), `@compat` the minor's addition. */
  "probe-facts": { current: "3.1.0", minimum: "1.0.0" },
  /** The views of the machine's state database that `archon state`, `archon query` and osquery read, and their columns. */
  query: { current: "1.0.0", minimum: "1.0.0" },
  /** The MCP tools a machine serves, their arguments and their tiers. */
  mcp: { current: "1.0.0", minimum: "1.0.0" },
};

/** The seams a machine that runs `archon` has: the PC reads them from its `archon state`. */
export const MACHINE_SEAMS: readonly Seam[] = ["model", "signed-records", "query", "mcp"];

/** The seams an adopted machine (and the controller) has: its probe's facts. */
export const PROBE_SEAMS: readonly Seam[] = ["probe-facts"];

/** How a machine is reached, which says which seams it has: a managed server or workstation, or an adopted machine. */
export type ContractKind = "managed" | "adopted";

/** The seams a kind of machine has. */
export const seamsOf = (kind: ContractKind): readonly Seam[] =>
  kind === "managed" ? MACHINE_SEAMS : PROBE_SEAMS;

/** A Semantic Version as numbers: major, minor, patch. */
export type SemVer = readonly [number, number, number];

/** A version of the form `major.minor.patch` (each at most five digits), or undefined: a machine's words are never trusted further. */
export function parseSemVer(text: unknown): SemVer | undefined {
  if (typeof text !== "string") return undefined;
  const m = /^(\d{1,5})\.(\d{1,5})\.(\d{1,5})$/.exec(text);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined;
}

/** -1, 0 or 1 by Semantic Versioning's precedence (numbers; no pre-release in a seam's version). */
export function compareSemVer(a: SemVer, b: SemVer): number {
  for (const i of [0, 1, 2] as const) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  return 0;
}

/** What a machine says of one seam: where it is, and (where it says) the oldest PC it reads. */
export interface ReportedSeam {
  /** The version the machine is at. */
  readonly current: string;
  /** The oldest version of the other side it understands. */
  readonly minimum?: string;
}

/** What a machine reports: its engine version and its seams (what `archon state` carries as `compat`, and the probe's `@compat`). */
export interface ContractReport {
  /** The engine version, `major.minor.patch` (what `archon --version` prints first). Absent for a probe. */
  readonly engine?: string;
  /** Its seams. */
  readonly seams: Readonly<Partial<Record<Seam, ReportedSeam>>>;
}

/** What this engine reports of itself, as a machine: its version and the seams a machine has (spec 115-compatibility FR-005). */
export function ownReport(): { engine: string; seams: Record<string, SeamVersion> } {
  return {
    engine: VERSION,
    seams: Object.fromEntries(MACHINE_SEAMS.map((s) => [s, { ...SEAMS[s] }])),
  };
}

/** The result for one seam. */
export interface SeamCheck {
  /** The seam. */
  readonly seam: Seam;
  /** Its status. */
  readonly status: CompatStatus;
  /** The version the machine reported, when it did. */
  readonly machine?: string;
  /** What this PC is at. */
  readonly pc: string;
  /** What this PC needs of the machine (its `minimum`). */
  readonly needs: string;
  /** In words, for a status that is not compatible. */
  readonly why?: string;
}

/**
 * One seam of one machine against this PC's contract (spec 115-compatibility FR-007): too old where the machine's `current` is
 * below this PC's `minimum`; newer where the machine's `minimum` is above this PC's `current` or its `current` is of a higher major;
 * unknown where it did not report (or reported something that is not a version); otherwise compatible.
 */
export function judgeSeam(seam: Seam, said: ReportedSeam | undefined): SeamCheck {
  const pc = SEAMS[seam];
  const base = { seam, pc: pc.current, needs: pc.minimum };
  const cur = parseSemVer(said?.current);
  const pcCurrent = parseSemVer(pc.current);
  const pcMinimum = parseSemVer(pc.minimum);
  if (!said || !cur || !pcCurrent || !pcMinimum) return { ...base, status: "unknown" };
  const machine = said.current;
  if (compareSemVer(cur, pcMinimum) < 0) {
    return {
      ...base,
      machine,
      status: "too-old",
      why: `${seam} is ${machine}, this PC needs ${pc.minimum}`,
    };
  }
  const min = parseSemVer(said.minimum);
  if (min && compareSemVer(min, pcCurrent) > 0) {
    return {
      ...base,
      machine,
      status: "newer",
      why: `${seam} needs a PC at ${said.minimum}, this PC has ${pc.current}`,
    };
  }
  if (cur[0] > pcCurrent[0]) {
    return {
      ...base,
      machine,
      status: "newer",
      why: `${seam} is ${machine}, this PC reads up to major ${pcCurrent[0]}`,
    };
  }
  return { ...base, machine, status: "compatible" };
}

/** A machine judged: its status, its engine, and each seam it was judged on. */
export interface MachineJudgement {
  /** Its status (`stolos:CompatStatus`). */
  readonly status: CompatStatus;
  /** The engine it reported, when it did. */
  readonly engine?: string;
  /** Each seam of its kind, in the ontology's order. */
  readonly seams: readonly SeamCheck[];
}

/**
 * A machine against this PC's contract (spec 115-compatibility FR-007): the seams its kind has, each judged; `too-old` where any is
 * (the machine cannot be read, or cannot read), else `newer` where any is, else `unknown` where any is unknown or nothing was
 * reported, else `compatible`. The engine's version takes no part in it.
 */
export function judgeMachine(
  kind: ContractKind,
  report: ContractReport | undefined,
): MachineJudgement {
  const checks = SEAM_IDS.filter((s) => seamsOf(kind).includes(s)).map((s) =>
    judgeSeam(s, report?.seams[s]),
  );
  const any = (s: CompatStatus) => checks.some((c) => c.status === s);
  const status: CompatStatus = any("too-old")
    ? "too-old"
    : any("newer")
      ? "newer"
      : any("unknown")
        ? "unknown"
        : "compatible";
  return { status, ...(report?.engine ? { engine: report.engine } : {}), seams: checks };
}

/** A machine's statement in plain words (spec 115-compatibility FR-008). */
export interface CompatWords {
  /** The status. */
  readonly status: CompatStatus;
  /** The statement: `compatible`, `too old for this PC: run archon update on alpha`, `newer than this PC: ...`, `unknown (not reported yet)`. */
  readonly headline: string;
  /** The sentence for a list: who runs what, and why it is not compatible. */
  readonly detail: string;
  /** The command that fixes it, alone (nothing for a compatible machine). */
  readonly fix?: string;
  /** The code `stolos explain` knows, for a status that is a problem or a thing to do. */
  readonly code?: "E115-TOO-OLD" | "E115-NEWER" | "P115-UNKNOWN";
}

/** The command that moves the PC's engine forward (the same for every machine). */
export const UPDATE_PC = "bun run stolos update";

/**
 * A judgement said in plain words, once, for every place that shows it (spec 115-compatibility FR-008): `alpha runs engine 0.148.0,
 * compatible with this PC's 0.152.0`; `too old for this PC: run archon update on alpha` (`ssh alpha archon update`); `newer than this PC:
 * run bun run stolos update`; `unknown (not reported yet)`. For an adopted machine the fix is the command that installs the current probe.
 */
export function describeCompat(
  name: string,
  kind: ContractKind,
  j: MachineJudgement,
  pcEngine: string = VERSION,
): CompatWords {
  const runs = j.engine
    ? `${name} runs engine ${j.engine}`
    : `${name}'s probe speaks facts ${j.seams.find((s) => s.seam === "probe-facts")?.machine ?? "?"}`;
  const reasons = j.seams.flatMap((s) => (s.why ? [s.why] : [])).join("; ");
  switch (j.status) {
    case "compatible":
      return {
        status: "compatible",
        headline: "compatible",
        detail: j.engine
          ? j.engine === pcEngine
            ? `${runs}, the same as this PC`
            : `${runs}, compatible with this PC's ${pcEngine}`
          : `${runs}, compatible with this PC's ${SEAMS["probe-facts"].current}`,
      };
    case "too-old":
      return {
        status: "too-old",
        headline:
          kind === "managed"
            ? `too old for this PC: run archon update on ${name}`
            : `too old for this PC: install the current probe on ${name}`,
        detail: `${runs}, too old for this PC: ${reasons}`,
        fix: kind === "managed" ? `ssh ${name} archon update` : `bun run stolos host adopt ${name}`,
        code: "E115-TOO-OLD",
      };
    case "newer":
      return {
        status: "newer",
        headline: `newer than this PC: run ${UPDATE_PC}`,
        detail: `${runs}, newer than this PC: ${reasons}`,
        fix: UPDATE_PC,
        code: "E115-NEWER",
      };
    case "unknown":
      return {
        status: "unknown",
        headline: "unknown (not reported yet)",
        detail: `${name} has not reported its ${kind === "managed" ? "engine and seams" : "probe's facts version"} yet`,
        fix:
          kind === "managed"
            ? "bun run stolos fleet status"
            : `bun run stolos host observe ${name}`,
        code: "P115-UNKNOWN",
      };
  }
}

/**
 * The rules of FR-002 that hold for every seam of {@link SEAMS}: both versions are Semantic Versions, `minimum` is not above
 * `current` and is of the same or an older major. Empty when they hold.
 */
export function seamRuleProblems(seams: Readonly<Record<Seam, SeamVersion>> = SEAMS): string[] {
  const out: string[] = [];
  for (const id of SEAM_IDS) {
    const s = seams[id];
    const cur = parseSemVer(s.current);
    const min = parseSemVer(s.minimum);
    if (!cur || !min)
      out.push(`${id}: current ${s.current} and minimum ${s.minimum} are not major.minor.patch`);
    else if (compareSemVer(min, cur) > 0)
      out.push(`${id}: minimum ${s.minimum} is above current ${s.current}`);
    else if (min[0] > cur[0])
      out.push(`${id}: minimum ${s.minimum} is of a newer major than ${s.current}`);
  }
  return out;
}
