/**
 * Spec 078: a control, written in TypeScript. A control is a query plus an
 * assertion, tagged with the Secure Controls Framework (SCF) controls it gives
 * evidence for. Its subject says what it asks:
 *
 * - `estate`: SQL over the estate graph (spec 090), one SELECT per query,
 *   read-only (through `estateQuery`); one result across systems.
 * - `osquery`: one osquery SELECT on every adopted machine, through its probe
 *   (as `stolos fleet query`); one result per machine.
 * - `observation`: a typed observation Stolos already holds (an adopted
 *   machine's, a device's, a connected account's); one result per subject.
 *
 * Its assertion turns the answer into a {@link Verdict} (pass, fail, warn, or
 * unknown, with what was found), or `undefined` when the control does not
 * apply. Controls are grouped into a pack ({@link defineControlPack}), which a
 * fleet keeps in `fleets/<fleet>/controls/<pack>/pack.ts`.
 *
 * ```mermaid
 * flowchart LR
 *   q["query: estate SQL, osquery SQL, or an observation"] --> a["assert"]
 *   a --> v["Verdict: pass, fail, warn, unknown"]
 *   v --> r["PolicyResult (accepted risks applied)"]
 *   r --> c["Compliance: evidence for its SCF controls"]
 * ```
 *
 * @example A control over the estate graph
 * ```ts
 * import { defineControl } from "./define.ts";
 *
 * export const adminsMfa = defineControl({
 *   id: "admins-mfa",
 *   title: "Every administrator signs in with a second factor",
 *   scf: ["IAC-37"],
 *   subject: "estate",
 *   query: "SELECT display_name AS name FROM user_account WHERE admin = 1 AND mfa = 0",
 *   assert: (rows) => ({
 *     status: rows.length ? "fail" : "pass",
 *     detail: rows.length ? `${rows.length} without MFA` : "every administrator has MFA",
 *   }),
 *   fix: "require MFA for administrators",
 * });
 * ```
 *
 * @module
 */

import type { AdoptedDef, Observed } from "../adopt/adopt.ts";
import type { Observation } from "../connect/connector.ts";
import type { DeviceDef, DeviceObserved } from "../device/device.ts";
import { isScfId, type ScfId } from "../compliance/scf.ts";

export type { ScfId };

/** One row of an answer: column to value. */
export type Row = Record<string, unknown>;

/** What a control's assertion can say (an accepted risk is the runner's, not the control's). */
export type CheckStatus = "pass" | "fail" | "warn" | "unknown";

/** What an assertion found. */
export interface Verdict {
  /** pass, fail, warn (not required, but worth doing), or unknown (cannot tell). */
  status: CheckStatus;
  /** What was found, in words. */
  detail: string;
  /** How to make it pass, when it differs from the control's own fix. */
  fix?: string;
  /** The estate's node uids it is about (estate controls: written to the finding table). */
  subjects?: string[];
}

/** The observations an `observation` control can read, by kind. */
export interface ObservationInputs {
  /** An adopted machine (spec 067), with what its probe last reported. */
  adopted: { machine: AdoptedDef; observed: Observed; now: number };
  /** A device read over SNMPv3 (spec 069). */
  device: { device: DeviceDef; observed: DeviceObserved; now: number };
  /** A connected account (spec 084): its connector's id and its observation. */
  connector: { connector: string; observed: Observation; now: number };
}

/** The kinds of observation. */
export type ObservationKind = keyof ObservationInputs;

/** What every control has. */
export interface ControlBase {
  /** Its id: lower case, digits, and hyphens; unique in its pack. */
  id: string;
  /** What it requires, for people. */
  title: string;
  /** The SCF controls it gives evidence for (ids Stolos knows: a wrong one fails type checking). */
  scf: readonly ScfId[];
  /** Why it matters, or how it decides, for people (optional). */
  description?: string;
}

/** An estate query: one SELECT, or several by name. */
export type EstateQuery = string | Readonly<Record<string, string>>;

/** The answer to an estate query: its rows, or each named query's rows. */
export type EstateRows<Q extends EstateQuery> = Q extends string ? Row[]
  : { [K in keyof Q]: Row[] };

/** A control over the estate graph: SQL, read-only, one result across systems. */
export interface EstateControl<Q extends EstateQuery = EstateQuery> extends ControlBase {
  /** It asks the estate graph. */
  subject: "estate";
  /** One SELECT (or WITH ... SELECT), or several by name; the tables are `stolos estate schema`'s. */
  query: Q;
  /** The verdict from the rows; undefined when the control does not apply (it then has no result). */
  assert(rows: EstateRows<Q>, ctx: { now: Date }): Verdict | undefined;
  /** How to make it pass. */
  fix?: string;
}

/** A control that asks every adopted machine one osquery SELECT, through its probe. */
export interface OsqueryControl extends ControlBase {
  /** It asks osquery on each adopted machine. */
  subject: "osquery";
  /** One SELECT on the tables `stolos fleet query` allows. */
  query: string;
  /** The verdict for one machine from its rows; undefined when it does not apply there. */
  assert(rows: Row[], ctx: { machine: string; now: Date }): Verdict | undefined;
  /** How to make it pass. */
  fix?: string;
}

/** A control over an observation Stolos holds: one result per machine, device, or account. */
export interface ObservationControl<K extends ObservationKind = ObservationKind>
  extends ControlBase {
  /** It reads an observation. */
  subject: "observation";
  /** Which kind of observation. */
  of: K;
  /** The verdict for one subject; undefined when it does not apply there. */
  assert(input: ObservationInputs[K]): Verdict | undefined;
  /** How to make it pass: words, or words for this subject (its operating system, its name). */
  fix?: string | ((input: ObservationInputs[K]) => string | undefined);
}

/** An observation control of any kind. */
export type AnyObservationControl = {
  [K in ObservationKind]: ObservationControl<K>;
}[ObservationKind];

/** Any control. */
export type Control =
  // deno-lint-ignore no-explicit-any
  | EstateControl<any>
  | OsqueryControl
  | AnyObservationControl;

/** A pack: controls shared together, versioned. */
export interface ControlPack {
  /** Its id (lower case, digits, and hyphens): result ids are `<pack>/<control>`. */
  id: string;
  /** Its name, for people. */
  title: string;
  /** Its version (for example 1.0.0). */
  version: string;
  /** What it is for (optional). */
  description?: string;
  /** Its controls, in the order results are shown. */
  controls: readonly Control[];
}

const ID = /^[a-z0-9][a-z0-9-]*$/;

/** Why a control is malformed (an empty list when it is not); checked at definition too. */
export function controlProblems(c: Control): string[] {
  const out: string[] = [];
  const at = `control ${c.id || "(no id)"}`;
  if (!ID.test(c.id ?? "")) out.push(`${at}: its id must be lower case letters, digits, hyphens`);
  if (!c.title?.trim()) out.push(`${at}: it needs a title`);
  if (!c.scf?.length) out.push(`${at}: it needs at least one SCF control`);
  for (const x of c.scf ?? []) {
    if (!isScfId(x)) out.push(`${at}: ${x} is not an SCF control Stolos knows`);
  }
  if (!["estate", "osquery", "observation"].includes(c.subject)) {
    out.push(`${at}: subject must be estate, osquery, or observation`);
  }
  if (c.subject === "observation" && !["adopted", "device", "connector"].includes(c.of)) {
    out.push(`${at}: of must be adopted, device, or connector`);
  }
  if ((c.subject === "estate" || c.subject === "osquery") && !c.query) {
    out.push(`${at}: it needs a query`);
  }
  if (typeof c.assert !== "function") out.push(`${at}: assert must be a function`);
  return out;
}

/** Define a control over the estate graph. */
export function defineControl<const Q extends EstateQuery>(c: EstateControl<Q>): EstateControl<Q>;
/** Define a control run with osquery on every adopted machine. */
export function defineControl(c: OsqueryControl): OsqueryControl;
/** Define a control over an observation. */
export function defineControl<K extends ObservationKind>(
  c: ObservationControl<K>,
): ObservationControl<K>;
/** Define a control: checked now (its id, title, SCF controls, subject), returned unchanged. */
export function defineControl(c: Control): Control {
  const p = controlProblems(c);
  if (p.length) throw new Error(p.join("; "));
  return c;
}

/** Define a pack: its id and version are checked, and its controls' ids must be unique. */
export function defineControlPack<const P extends ControlPack>(p: P): P {
  const out: string[] = [];
  if (!ID.test(p.id ?? "")) {
    out.push(`pack ${p.id}: its id must be lower case letters, digits, hyphens`);
  }
  if (!p.title?.trim()) out.push(`pack ${p.id}: it needs a title`);
  if (!/^\d+\.\d+\.\d+/.test(p.version ?? "")) {
    out.push(`pack ${p.id}: its version must be like 1.0.0`);
  }
  const seen = new Set<string>();
  for (const c of p.controls ?? []) {
    out.push(...controlProblems(c));
    if (seen.has(c.id)) out.push(`pack ${p.id}: two controls are named ${c.id}`);
    seen.add(c.id);
  }
  if (out.length) throw new Error(out.join("; "));
  return p;
}
