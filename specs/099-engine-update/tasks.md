# Tasks: Updating the engine is one command, or one button

**Input**: `specs/099-engine-update/spec.md`, `plan.md`

**Tests**: every requirement is proved by `tests/update099.test.ts` with `proves([...])`.

## Phase 1: Ontology and specification (rungs 0 and 1)

- [x] T001 Define the terms the spec uses in `ontology/stolos/`, each citing `099-engine-update` (see `spec.md`, Ontology)
- [x] T002 Write the requirements in `specs/099-engine-update/spec.md`, using only those terms

## Phase 2: Headless operations, then the consoles (rungs 2 to 6)

- [x] T003 `stolos update`: find the newest release, pin it, sign, send with `stolos apply` (FR-001) in `src/archon/update/operator.ts`, `src/archon/fleet/releases.ts`, `src/archon/commands/registry.ts`
- [x] T004 Both consoles show the engine and a newer release in the header (FR-002) in `src/archon/console/layout.ts`, `src/archon/console/pages.ts`, `src/archon/console/server.ts`, `src/archon/console/stolos-server.ts`
- [x] T005 The Overview's Update button runs the same command (FR-003) in `src/archon/console/stolos-pages.ts`, `src/archon/fleet/releases.ts`
- [x] T006 No message tells the owner to run `git push` (FR-004) in `src/archon/update/operator.ts`
- [x] T007 A passphrase asked on the page that ran the command (askpass) (FR-005) in `src/archon/console/askpass.ts`, `src/archon/console/stolos-launch.ts`, `src/archon/console/stolos-server.ts`
- [x] T008 Records are expected: sent by update, "not sent yet" in the doctor (FR-006) in `src/archon/fleet/records.ts`, `src/archon/update/operator.ts`, `src/archon-boot/doctor.ts`
- [x] T009 The outcome level action (⚡), with commons' marks (FR-007) in `src/archon/core/ui.ts`, `src/archon-boot/doctor.ts`
- [x] T010 The compliance impact reads the previous commit's fleet files as they are (FR-008) in `src/archon/compliance/impact.ts`

## Phase 3: Proof and documentation (rung 7)

- [x] T011 Prove every requirement in `tests/update099.test.ts`
- [x] T012 Name the requirements on a `// Spec:` line in every source file above (spec 101-ladder FR-010)
- [x] T013 Update the guide that explains it (its `mod.ts`) in the same commit
