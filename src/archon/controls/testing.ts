/**
 * Spec 078: testing a control like code. {@link testControl} runs one
 * control over a fixture (rows, an estate made from a few records, or an
 * observation) and returns its results, exactly as Stolos would show them,
 * so a fleet's `*_test.ts` asserts on them with `deno task test`. Nothing is
 * asked of a machine or an account.
 *
 * ```mermaid
 * flowchart LR
 *   fixture["fixture: rows, an estate, or an observation"] --> tc["testControl(control, fixture)"]
 *   tc --> results["PolicyResult[]: pass, fail, warn, unknown, accepted"]
 *   results --> asserts["your test's assertions"]
 * ```
 *
 * @example A control tested over rows
 * ```ts
 * import { defineControl } from "./define.ts";
 * import { testControl } from "./testing.ts";
 *
 * const noTelnet = defineControl({
 *   id: "no-telnet",
 *   title: "Nothing listens on the telnet port",
 *   scf: ["CFG-04"],
 *   subject: "osquery",
 *   query: "SELECT port FROM listening_ports WHERE port = 23",
 *   assert: (rows) => ({ status: rows.length ? "fail" : "pass", detail: `${rows.length} listener(s)` }),
 * });
 * const [r] = testControl(noTelnet, { machines: { alpha: [{ port: 23 }] } });
 * if (r.status !== "fail") throw new Error("telnet should fail");
 * ```
 *
 * @module
 */

import type { Acceptance } from "../adopt/adopt.ts";
import type { PolicyResult } from "../adopt/policy.ts";
import { buildGraph, type Estate, estateQuery } from "../estate/graph.ts";
import type { Snapshot } from "../estate/snapshot.ts";
import { queryRefusal } from "../state/query.ts";
import type {
  EstateControl,
  EstateQuery,
  EstateRows,
  ObservationControl,
  ObservationInputs,
  ObservationKind,
  OsqueryControl,
  Row,
} from "./define.ts";
import { acceptRisks, runEstate, runObservation, runOsquery, type SubjectResult } from "./core.ts";

/** What every fixture may add. */
export interface FixtureCommon {
  /** Accepted risks (by the control's id). */
  accepted?: readonly Acceptance[];
  /** Now (default: the current time). */
  now?: Date;
}

/** A fixture for an estate control: an estate, or the rows its query answers. */
export interface EstateFixture<Q extends EstateQuery> extends FixtureCommon {
  /** An estate graph, or the records to build one from ({@link fixtureEstate}). */
  estate?: Estate | Partial<Snapshot>;
  /** The rows the query answers, instead of an estate. */
  rows?: EstateRows<Q>;
}

/** A fixture for an osquery control: rows per machine (or one machine's rows). */
export interface OsqueryFixture extends FixtureCommon {
  /** Each machine's rows; a string is a machine that did not answer, and why. */
  machines?: Record<string, Row[] | string>;
  /** One machine's rows (it is called "fixture"). */
  rows?: Row[];
}

/** A fixture for an observation control: the observation. */
export interface ObservationFixture<K extends ObservationKind> extends FixtureCommon {
  /** The observation, as Stolos would hand it to the control. */
  input: ObservationInputs[K];
}

/** An estate graph built from a few records (sources, machines, links); the rest is empty. */
export function fixtureEstate(s: Partial<Snapshot> = {}, now?: Date): Estate {
  return buildGraph({ fleet: "fixture", sources: [], machines: [], links: {}, ...s }, {
    ...(now ? { now } : {}),
  });
}

const isEstate = (x: unknown): x is Estate =>
  !!x && typeof x === "object" && "db" in (x as Record<string, unknown>);

/** Run an estate control over a fixture. */
export function testControl<Q extends EstateQuery>(
  c: EstateControl<Q>,
  f: EstateFixture<Q>,
): Array<PolicyResult & { subjects: string[] }>;
/** Run an osquery control over a fixture: one result per machine. */
export function testControl(
  c: OsqueryControl,
  f: OsqueryFixture,
): Array<PolicyResult & { machine: string }>;
/** Run an observation control over a fixture. */
export function testControl<K extends ObservationKind>(
  c: ObservationControl<K>,
  f: ObservationFixture<K>,
): PolicyResult[];
/**
 * Run a control over a fixture, with accepted risks applied: what Stolos
 * would show (an empty list when the control does not apply).
 */
export function testControl(
  // deno-lint-ignore no-explicit-any
  c: EstateControl<any> | OsqueryControl | ObservationControl<any>,
  // deno-lint-ignore no-explicit-any
  f: any,
): PolicyResult[] {
  const now: Date = f.now ?? new Date();
  const accepted: readonly Acceptance[] = f.accepted ?? [];
  const done = <R extends PolicyResult>(rs: R[]) => acceptRisks(accepted, rs, now.getTime());
  if (c.subject === "estate") {
    let r: SubjectResult | undefined;
    if (f.rows !== undefined) {
      const rows = f.rows;
      const v = c.assert(rows, { now });
      r = v ? runEstate({ ...c, assert: () => v }, () => [], now) : undefined;
    } else {
      const e = isEstate(f.estate) ? f.estate : fixtureEstate(f.estate ?? {}, now);
      // The query is answered for real (read-only), so a wrong column fails the test.
      r = runEstate(c, (sql) => estateQuery(e, sql), now);
    }
    return done(r ? [r] : []);
  }
  if (c.subject === "osquery") {
    // The query must be one Stolos would send (stolos fleet query's rules).
    const why = queryRefusal(c.query);
    if (why) throw new Error(`control ${c.id}: the query is refused: ${why}`);
    const machines: Record<string, Row[] | string> = f.machines ??
      (f.rows ? { fixture: f.rows } : {});
    return done(runOsquery(
      c,
      Object.entries(machines).map(([machine, x]) =>
        typeof x === "string" ? { machine, error: x } : { machine, rows: x }
      ),
      now,
    ));
  }
  const r = runObservation(c, f.input);
  return done(r ? [r] : []);
}
