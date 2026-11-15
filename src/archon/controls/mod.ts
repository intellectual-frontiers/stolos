/**
 * # Custom controls
 *
 * A company writes its own controls in TypeScript, tests them like code, and keeps them in the
 * fleet repository beside everything else (spec 078). A control is a query plus an assertion,
 * tagged with the Secure Controls Framework (SCF) controls it gives evidence for; its results show
 * up in `stolos compliance` and the Compliance tab, as evidence from a "control pack". Stolos's own
 * policies (adopted machines, devices, and the estate graph's cross-system checks) are written the
 * same way, on the same SDK.
 *
 * ```mermaid
 * flowchart LR
 *   pack["fleets/&lt;fleet&gt;/controls/&lt;pack&gt;/pack.ts"] --> test["deno task test: *_test.ts with testControl"]
 *   pack --> run["stolos controls run"]
 *   run --> estate[("estate graph: SQL")] & probe["adopted machines: osquery"] & obs["observations"]
 *   run --> comp["stolos compliance, the Compliance tab"]
 * ```
 *
 * ## A control
 *
 * Each control has a subject:
 *
 * | `subject`     | It asks                                                       | Results               |
 * | ------------- | ------------------------------------------------------------- | --------------------- |
 * | `estate`      | SQL over the estate graph (`stolos estate schema`), read-only | one, across systems   |
 * | `osquery`     | one osquery SELECT on each adopted machine, through its probe | one per machine       |
 * | `observation` | an adopted machine's, a device's, or an account's observation | one per subject       |
 *
 * Its `assert` returns a verdict (`pass`, `fail`, `warn`, or `unknown`, with what was found), or
 * `undefined` when it does not apply. `scf` lists SCF control ids, typed: a wrong id fails type
 * checking. `fix` says how to make it pass.
 *
 * ```ts
 * import { defineControl, defineControlPack } from "@stolos/archon/controls/mod.ts";
 *
 * export const noTelnet = defineControl({
 *   id: "no-telnet",
 *   title: "Nothing listens on the telnet port",
 *   scf: ["CFG-04"],
 *   subject: "osquery",
 *   query: "SELECT port, address FROM listening_ports WHERE port = 23",
 *   assert: (rows) => ({
 *     status: rows.length ? "fail" : "pass",
 *     detail: rows.length ? `listening on ${rows.map((r) => r.address).join(", ")}` : "no listener",
 *   }),
 *   fix: "turn the telnet service off",
 * });
 *
 * export const pack = defineControlPack({
 *   id: "acme-baseline",
 *   title: "Acme's baseline",
 *   version: "1.0.0",
 *   controls: [noTelnet],
 * });
 * ```
 *
 * An estate control's `query` may be one SELECT or several by name (`{ admins: "...", known:
 * "..." }`); its `assert` then gets each one's rows by name.
 *
 * ## A pack in the fleet repository
 *
 * Put each pack in its own folder: `fleets/<fleet>/controls/<pack>/pack.ts` exports the pack (as
 * `pack`, or as its default export), and `<pack>_test.ts` beside it tests it. Stolos loads every
 * pack there. A risk the owner accepts is recorded in `fleets/<fleet>/controls/accepted.ts`:
 *
 * ```ts
 * import type { Acceptance } from "@stolos/archon/adopt/adopt.ts";
 *
 * export const accepted: Acceptance[] = [{
 *   policy: "acme-baseline/no-telnet",
 *   reason: "the lab's terminal server, until it is replaced",
 *   by: "alice@example.org",
 *   until: "2027-03-31",
 * }];
 * ```
 *
 * A failing result it names shows as accepted (not as passing) until the date. An adopted
 * machine's own `accepted` list in `machine.ts` applies to its results too.
 *
 * ## Testing a control
 *
 * `testControl(control, fixture)` runs one control over a fixture and returns its results as
 * Stolos would show them. A fixture is rows (`rows`, or `machines` for osquery), an estate made
 * from a few records (`estate`, built with `fixtureEstate`), or an observation (`input`); add
 * `accepted` and `now` as needed.
 *
 * ```ts
 * import { defineControl, testControl } from "@stolos/archon/controls/mod.ts";
 *
 * const noTelnet = defineControl({
 *   id: "no-telnet",
 *   title: "Nothing listens on the telnet port",
 *   scf: ["CFG-04"],
 *   subject: "osquery",
 *   query: "SELECT port FROM listening_ports WHERE port = 23",
 *   assert: (rows) => ({ status: rows.length ? "fail" : "pass", detail: `${rows.length} listener(s)` }),
 * });
 *
 * Deno.test("telnet fails where it listens", () => {
 *   const rs = testControl(noTelnet, { machines: { alpha: [{ port: 23 }], beta: [] } });
 *   if (rs.map((r) => r.status).join() !== "fail,pass") throw new Error("wrong verdicts");
 * });
 * ```
 *
 * In the fleet repository, `deno task test` runs every test once `deno.json`'s tasks have
 * `"test": "deno test -A fleets/"` (add it beside `stolos`); `stolos controls test` runs the packs'
 * tests without it.
 *
 * ## Commands
 *
 * ```bash
 * deno task stolos controls list
 * deno task stolos controls run
 * deno task stolos controls test
 * ```
 *
 * `controls list` shows each pack and its controls. `controls run` runs them now: estate controls
 * over the graph built from Git, observation controls over the observations in Git, and osquery
 * controls on each adopted machine through its probe. It keeps each machine's answer on this PC,
 * so `stolos compliance` and the consoles show osquery results without asking machines again.
 * `controls test` runs the packs' tests. An example pack is in the engine's repository,
 * `examples/fleets/lab/controls/baseline/`.
 *
 * @module
 */

export {
  type CheckStatus,
  type Control,
  type ControlPack,
  defineControl,
  defineControlPack,
  type EstateControl,
  type EstateQuery,
  type EstateRows,
  type ObservationControl,
  type ObservationInputs,
  type ObservationKind,
  type OsqueryControl,
  type Row,
  type ScfId,
  type Verdict,
} from "./define.ts";
export { acceptRisks } from "./core.ts";
export { type ControlResult, type PackRun, runPack } from "./run.ts";
export { fixtureEstate, testControl } from "./testing.ts";
