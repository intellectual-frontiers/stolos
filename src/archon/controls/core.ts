/**
 * Spec 078: how a control's answer becomes a result. Each runner here is
 * pure: it is given the rows (or the observation) and returns
 * {@link PolicyResult}s, so the built-in policies (adopted machines, devices,
 * the estate graph) and a fleet's own packs give results the same way, and
 * accepted risks apply to both alike.
 *
 * ```mermaid
 * flowchart LR
 *   rows["rows or observation"] --> assert["control.assert"]
 *   assert -- "undefined" --> none["no result (does not apply)"]
 *   assert -- "Verdict" --> result["PolicyResult: id, title, scf, status, detail, fix"]
 *   result --> accept["acceptRisks: a recorded decision makes a failure accepted"]
 * ```
 *
 * @module
 */

import type { Acceptance } from "../adopt/adopt.ts";
import type { PolicyResult } from "../adopt/policy.ts";
import type {
  EstateControl,
  EstateQuery,
  EstateRows,
  ObservationControl,
  ObservationInputs,
  ObservationKind,
  OsqueryControl,
  Row,
  Verdict,
} from "./define.ts";

/** A result with the estate node uids it is about (estate controls). */
export type SubjectResult = PolicyResult & { subjects: string[] };

/** A verdict as a PolicyResult, in the built-ins' key order (id, title, scf, status, detail, fix). */
export function toResult(
  c: { id: string; title: string; scf: readonly string[] },
  v: Verdict,
  fix: string | undefined,
): PolicyResult {
  const f = v.fix ?? fix;
  return {
    id: c.id,
    title: c.title,
    scf: [...c.scf],
    status: v.status,
    detail: v.detail,
    ...(f !== undefined ? { fix: f } : {}),
  };
}

/** One observation control on one subject; undefined when it does not apply. */
export function runObservation<K extends ObservationKind>(
  c: ObservationControl<K>,
  input: ObservationInputs[K],
): PolicyResult | undefined {
  const v = c.assert(input);
  if (!v) return undefined;
  const fix = typeof c.fix === "function" ? c.fix(input) : c.fix;
  return toResult(c, v, fix);
}

/** Every observation control of a list on one subject, in order. */
export function runObservations<K extends ObservationKind>(
  cs: readonly ObservationControl<K>[],
  input: ObservationInputs[K],
): PolicyResult[] {
  return cs.flatMap((c) => runObservation(c, input) ?? []);
}

/** The rows an estate control's query (one SELECT, or several by name) answers, from `query`. */
export function estateRows<Q extends EstateQuery>(
  q: Q,
  query: (sql: string) => Row[],
): EstateRows<Q> {
  if (typeof q === "string") return query(q) as EstateRows<Q>;
  return Object.fromEntries(
    Object.entries(q as Record<string, string>).map(([k, sql]) => [k, query(sql)]),
  ) as EstateRows<Q>;
}

/** One estate control, given a read-only query function; undefined when it does not apply. */
export function runEstate<Q extends EstateQuery>(
  c: EstateControl<Q>,
  query: (sql: string) => Row[],
  now: Date,
): SubjectResult | undefined {
  const v = c.assert(estateRows(c.query, query), { now });
  if (!v) return undefined;
  return { ...toResult(c, v, c.fix), subjects: v.subjects ?? [] };
}

/** One machine's answer to an osquery control: its rows, or why there are none. */
export interface MachineAnswer {
  /** The machine. */
  machine: string;
  /** Its rows. */
  rows?: Row[];
  /** Why it did not answer. */
  error?: string;
}

/** An osquery control over each machine's answer: one result per machine (unknown when it did not answer). */
export function runOsquery(
  c: OsqueryControl,
  answers: readonly MachineAnswer[],
  now: Date,
): Array<PolicyResult & { machine: string }> {
  const out: Array<PolicyResult & { machine: string }> = [];
  for (const a of answers) {
    const v: Verdict | undefined = a.rows
      ? c.assert(a.rows, { machine: a.machine, now })
      : { status: "unknown", detail: `no answer: ${a.error ?? "unknown"}` };
    if (v) out.push({ ...toResult(c, v, c.fix), machine: a.machine });
  }
  return out;
}

/**
 * Failing results the owner accepted (until a date) become "accepted", with
 * who, why, and until when; after the date they fail again, saying so. A
 * pass or an unknown is never changed.
 */
export function acceptRisks<R extends PolicyResult>(
  accepted: readonly Acceptance[],
  rs: R[],
  now = Date.now(),
): R[] {
  const today = new Date(now).toISOString().slice(0, 10);
  return rs.map((r) => {
    const a = accepted.find((x) => x.policy === r.id);
    if (!a || r.status === "pass" || r.status === "unknown") return r;
    if (a.until < today) return { ...r, detail: `${r.detail}; the accepted risk ended ${a.until}` };
    return {
      ...r,
      status: "accepted",
      detail: `${r.detail}; accepted by ${a.by} until ${a.until}: ${a.reason}`,
    };
  });
}
