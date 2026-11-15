# 078: Custom-control SDK

Issue intellectual-frontiers/stolos#19: controls as TypeScript, tested like code.

## Why

Every company has rules of its own that no product ships: a port that must stay closed, a system
that may have only so many administrators, a naming rule for accounts. Stolos already checks adopted
machines, devices, connected accounts, and the estate graph, each with code of its own. A company
should write its own controls the same way Stolos writes its own: in TypeScript, in the fleet
repository, tested with the runtime's own test runner (`bun test`), and shown in Compliance as
evidence for the SCF controls they name. When the built-in policies are written on the same SDK, the
SDK gets the same use as the engine.

## Requirements

- **FR-001** A control (`src/archon/controls/define.ts`, `defineControl`) is a query plus an
  assertion, tagged with SCF controls, with a fix in words. Its subject is one of:
  - `estate`: SQL over the estate graph (spec 090), one SELECT or several by name, read-only
    (through `estateQuery`); one result across systems;
  - `osquery`: one osquery SELECT on each adopted machine through its probe (the path `fleet query`
    uses, `queryAdopted`), within `fleet query`'s allowlist; one result per machine;
  - `observation`: an observation Stolos holds (`of`: `adopted`, `device`, or `connector`), typed;
    one result per subject.

  The assertion returns a verdict (`pass`, `fail`, `warn`, `unknown`, with what was found, an
  optional fix, and, for estate controls, the node uids it is about), or `undefined` when the
  control does not apply.

- **FR-002** SCF ids are typed from `src/archon/compliance/scf.ts` (`ScfId`): a wrong id fails type
  checking, and `defineControl` also refuses it at run time. Control and pack ids are lower case
  letters, digits, and hyphens.
- **FR-003** A pack (`defineControlPack`) has an id, a title, a version (`1.0.0`), and its controls,
  whose ids are unique in it. Its results have ids `<pack>/<control>`.
- **FR-004** Results are `PolicyResult`s (spec 067). Accepted risks apply as they do to adopted
  machines (`acceptRisks`, which `accept` now calls): from `fleets/<fleet>/controls/accepted.ts`
  (`export const accepted: Acceptance[]`, each naming `<pack>/<control>`), and from an adopted
  machine's own `accepted` list for its results.
- **FR-005** The built-in policies run on the SDK with unchanged results (ids, titles, SCF ids,
  statuses, details, fixes, order, and the estate's finding rows):
  - the adopted-machine pack (`ADOPTED_CONTROLS`, `src/archon/adopt/policy.ts`);
  - devices (`DEVICE_CONTROLS`, `src/archon/device/device.ts`);
  - the estate graph's cross-system policies (`ESTATE_CONTROLS`, `src/archon/estate/graph.ts`).

  "Never observed" stays a single result outside the controls (there is no observation to give a
  control). Connector posture policies stay as they are (`check`, `fresh`): porting them would
  change many files and nothing a person sees.

- **FR-006** Packs in a fleet repository: `fleets/<fleet>/controls/<pack>/pack.ts` exports the pack
  (as `pack`, or as its default export); `*.test.ts` beside it tests it. A pack that does not load
  is reported with why, and the others still run.
- **FR-007** Testing (`src/archon/controls/testing.ts`): `testControl(control, fixture)` runs one
  control over a fixture and returns its results as Stolos would show them. A fixture is rows (an
  estate query's, or osquery rows per machine), an estate built from a few records
  (`fixtureEstate`), or an observation, with optional accepted risks and a time. An osquery
  control's query is checked against `fleet query`'s rules. A fleet may add a `test` script to its
  `package.json` (`bun test fleets/`) for `bun run test`; the scaffold keeps its two scripts (spec
  059), and `stolos controls test` runs the packs' tests without it.
- **FR-008** Compliance: the Stolos Console's facts carry each pack's results (`PcFacts.controls`);
  `fleetEvidence` turns them into evidence with source `control pack` and the check
  `<pack title>: <control title>`, so they show in `stolos compliance`, the Compliance tab, the OCSF
  findings, and the OSCAL documents (a component of their own).
- **FR-009** Osquery controls ask machines only in `stolos controls run`; each machine's answer is
  kept in this PC's state (kind `control`, name `<pack>/<control>`), and the consoles and
  `stolos compliance` assert over the answers kept. Estate and observation controls run wherever the
  facts are gathered (nothing is asked of a machine or an account).
- **FR-010** Commands: `stolos controls list` (packs and controls; `--json`),
  `stolos controls run [pack]` (results now; exits 1 on a failure; `--json`), and
  `stolos controls test` (`bun test` on the packs, `node --test` on Node; terminal only).
- **FR-011** An example pack, `examples/fleets/lab/controls/baseline/` (an estate control and an
  osquery control), with a passing test.
- **FR-012** The guide `controls` (`src/archon/controls/mod.ts`), which is also the module a fleet
  imports (`@intellectual-frontiers/stolos/archon/controls/mod`).

## Success criteria

- **SC-001** `tests/controls078.test.ts`:
  - a wrong SCF id fails type checking (`@ts-expect-error`) and definition; duplicate control ids
    are refused;
  - a pack loads from a controls folder; a broken one is a problem;
  - a pack runs over a fixture estate and osquery answers, failing, passing, and saying unknown as
    asserted;
  - accepted risks apply until their date, from the fleet's list and the machine's own;
  - observation controls run per device and per account, and `testControl` gives the same result;
  - the built-ins on the SDK give byte-identical results to the implementations they replaced (kept
    in `tests/controls078_legacy.ts`): 400 generated adopted machines, 200 devices, and six estates
    that reach both verdicts of every cross-system policy, with identical finding rows;
  - a pack's results are Compliance evidence from a `control pack`;
  - in a temporary fleet repository, `stolos controls list` lists its packs,
    `stolos compliance
--json` shows a pack's failing control as evidence, and
    `stolos controls test` passes.
- **SC-002** The example pack's tests pass with `bun test`, and run in the engine's suite.
- **SC-003** Existing tests pass unchanged.
