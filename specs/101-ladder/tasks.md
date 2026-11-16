# Tasks: The ladder, the ontology, and the trace

**Input**: `specs/101-ladder/spec.md`, `plan.md`

**Tests**: every requirement is proved by `tests/ladder101.test.ts` or reviewed in `reviewed.tsv`.

## Phase 1: Constitution, ontology and specification (rungs 0 and 1)

- [x] T001 Commons 0015-trace: the trace and layers checks in the kernel and the runtime (commons)
- [x] T002 Article 0 of the constitution, version 6.0.0, and `AGENTS.md`'s Rules (FR-001, FR-011)
- [x] T003 The ontology: `ontology/stolos/vocabulary.ts`, `codes.ts`, `architecture.ts`, `mod.ts` (FR-001, FR-002, FR-004)
- [x] T004 This specification, drafted with the ontology (FR-010)

## Phase 2: The generator and the code (rungs 2 to 6)

- [x] T005 `tools/ontology.ts`: Turtle, unions, the constitution's table, `AGENTS.md`'s layout, `--check`; run first by `tools/gen-assets.ts` (FR-001, FR-005)
- [x] T006 The code imports the generated unions (FR-006) in `src/archon/core/ui.ts`, `src/archon/console/pc.ts`, `src/archon/model/types.ts`, `src/archon/core/registry-types.ts`, `src/archon/adopt/integrate.ts`, `src/archon/fleet/records.ts`
- [x] T007 `tools/trace.ts` and `tools/layers.ts` on commons 0015-trace, with their baselines (FR-002, FR-003, FR-007, FR-008)
- [x] T008 `package.json`: `check:ontology`, `check:trace`, `check:layers`, in `ci` before the tests (FR-009)

## Phase 3: The pilot and the proof (rung 7)

- [x] T009 Plans and tasks for 097-controller, 098-pair, 099-engine-update, 100-remote-access; their ontology terms; `Spec:` lines in their sources; their entries removed from the trace's baseline (FR-010)
- [x] T010 `Spec:` lines in every other source file whose `@module` names its spec with certainty (FR-007)
- [x] T011 `tests/ladder101.test.ts` (FR-001 to FR-010)
