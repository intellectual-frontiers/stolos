# Tasks: The controller PC is a fleet machine

**Input**: `specs/097-controller/spec.md`, `plan.md`

**Tests**: every requirement is proved by `tests/controller097.test.ts` with `proves([...])`.

## Phase 1: Ontology and specification (rungs 0 and 1)

- [x] T001 Define the terms the spec uses in `ontology/stolos/`, each citing `097-controller` (see `spec.md`, Ontology)
- [x] T002 Write the requirements in `specs/097-controller/spec.md`, using only those terms

## Phase 2: Headless operations, then the consoles (rungs 2 to 6)

- [x] T003 Record the controller from `fleet init`, `keys setup`, `pair` and `host observe` (FR-001) in `src/archon/adopt/controller.ts`, `src/archon/identity/fleet-init.ts`, `src/archon/identity/keys-commands.ts`, `src/archon/adopt/commands.ts`
- [x] T004 Observe it locally with the probe, as `SSH_ORIGINAL_COMMAND` would ask (FR-002) in `src/archon/adopt/controller.ts`, `src/archon/adopt/adopt.ts`
- [x] T005 Add the controller facts: signing key, vault, recovery key (states and dates, never a secret) (FR-003) in `src/archon/adopt/controller.ts`
- [x] T006 Add the four controller policies with their SCF controls and fixes (FR-004) in `src/archon/adopt/policy.ts`
- [x] T007 Read BitLocker on Windows without administrator rights (FR-005) in `bin/stolos-probe.ps1`
- [x] T008 Several controllers: each observes only itself; `host release` removes only the model (FR-006) in `src/archon/adopt/controller.ts`, `src/archon/adopt/commands.ts`

## Phase 3: Proof and documentation (rung 7)

- [x] T009 Prove every requirement in `tests/controller097.test.ts`
- [x] T010 Name the requirements on a `// Spec:` line in every source file above (spec 101-ladder FR-010)
- [x] T011 Update the guide that explains it (its `mod.ts`) in the same commit
