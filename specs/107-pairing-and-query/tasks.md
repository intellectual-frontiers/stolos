# Tasks: Pairing many machines, the controller as auto-adopted, and asking every machine at once

**Input**: `specs/107-pairing-and-query/spec.md`, `plan.md`

**Tests**: every requirement is proved with `proves([...])` in `tests/pair098.test.ts`, `tests/ports103.test.ts`, `tests/query107.test.ts`,
`tests/console066.test.ts` and `tests/console/stolos-browser.cjs` (CI's console-browser job); `tests/observe048.test.ts` and
`tests/controller097.test.ts` carry the changed contracts.

## Phase 1: Ontology and specification (rungs 0 and 1)

- [x] T001 `stolos:PairingSession`, `stolos:AddressBlock`, `stolos:MachineTable` and the code lists `stolos:WayOfJoining`, `stolos:PairingStage`, `stolos:AnswerState` in `ontology/stolos/`, each citing `107-pairing-and-query`; `bun run gen`
- [x] T002 This specification; specs 098, 103-three-ports, 097-controller, 066-stolos-console and 106-one-passphrase-speed say what is true now (FR-015)

## Phase 2: Headless operations (rungs 4 to 6)

- [x] T003 The session record, format 2: machines, tries by address, the bounds (FR-004, FR-005) in `src/archon/adopt/pair-store.ts`
- [x] T004 `PairSession`: many machines, per-address blocking, no expiry, names, the queue of check-ins (FR-001, FR-004, FR-006) in `src/archon/adopt/pair.ts`, `pair-service.ts`; the client address through both doors in `src/archon-boot/server.ts`, `src/archon/console/stolos-server.ts`
- [x] T005 `stolos pair`: the session, the queue of prompts, the live state, Ctrl+C closes cleanly (FR-002, FR-003) in `src/archon/adopt/pair-command.ts`
- [x] T006 The way of joining: `joined` in `machine.ts`, `wayOfJoining`, the marks (FR-007, FR-009) in `src/archon/adopt/joining.ts`, `adopt.ts`, `commands.ts`, `src/archon/observe/fleet-status.ts`
- [x] T007 The pool: all at once, 8 at a time, 15 s each, `--timeout`, a row for every machine (FR-010, FR-011) in `src/archon/adopt/query.ts`, `commands.ts`, `src/archon/core/exec.ts`, `src/archon/commands/registry.ts`

## Phase 3: The Stolos Console (rung 6, windowed)

- [x] T008 Vendor AG Grid Community 36.3.0, pin it, serve it and its licence (FR-012) in `vendor/ag-grid/`, `src/archon/console/assets.ts`, `server.ts`
- [x] T009 The thin wrapper (FR-013) in `src/archon/console/table.ts`
- [x] T010 Ask every machine: the grid filling in as machines answer (FR-011) in `src/archon/console/stolos-pages.ts`, `stolos-server.ts`
- [x] T011 Machines: This PC first, How it joined, the filter, the controller's page and its disabled actions (FR-008) in `src/archon/console/pc.ts`, `stolos-pages.ts`, `stolos-server.ts`; Remote Access says it (FR-009) in `src/archon/access/pages.ts`

## Phase 4: Proof and documentation (rung 7)

- [x] T012 Prove every requirement (SC-001 to SC-003); update `tests/integrate/pair-server.ts` and `windows-check.ps1`'s server (FR-014)
- [x] T013 Name the requirements on a `// Spec:` line in every source file above (spec 101-ladder FR-010)
- [x] T014 Update the guides (`src/archon/adopt/mod.ts`, `src/archon/console/mod.ts`) in the same commit (FR-015)

## Later (not built)

- [ ] L001 A **Stop** for the pairing session in the Stolos Console (and the session's machines listed on the Remote Access page). Not built:
      the record already allows it (a console process can mark it ended and `stolos pair` closes), but who may stop a session, and showing
      a prompt's machines to a page that cannot answer them (spec 103-three-ports L001), is a decision of its own.
- [ ] L002 Not verified in a real Windows or macOS session in this change: the loader and `integrate.windows.ps1 --pair` run against the same
      wire protocol and are exercised by `tests/integrate/windows-check.ps1` in CI.
