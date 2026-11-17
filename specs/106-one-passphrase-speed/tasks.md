# Tasks: One passphrase per command, and a quick one

**Input**: `specs/106-one-passphrase-speed/spec.md`, `plan.md`

**Tests**: `tests/passphrase106.test.ts` and `tests/speed106.test.ts`, each test naming what it proves with `proves([...])`.

## Wave 1: built

### Ontology and specification (rungs 0 and 1)

- [x] T001 `stolos:PassphraseSession`, `stolos:ProbeCache`, `stolos:PhaseTiming`, `stolos:SigningOutcome` and its codes in `ontology/stolos/`, each citing `106-one-passphrase-speed`; `bun run gen` (FR-001, FR-003, FR-008, FR-010)
- [x] T002 This specification, plan and tasks; spec 057-keys FR-007 and spec 105's wave 2 corrected (FR-011)

### Infrastructure (rung 4)

- [x] T003 `core/passphrase.ts`: the session (memory, candidates, settle, wipe), the broker, the terminal prompt without echo (FR-001 to FR-004)
- [x] T004 `core/askpass-helper.ts`: the program OpenSSH runs (FR-002)
- [x] T005 `core/nested.ts` and the Ui's nested scope: a run nested in process, merged once (FR-006)
- [x] T006 `core/probe-cache.ts`, `core/run-memo.ts` (FR-008, FR-009)
- [x] T007 `core/ui.ts`: timing lines, the state folder, the nested scope (FR-006, FR-010)

### Business rules (rung 5) and application (rung 6)

- [x] T008 `fleet/signing.ts`: `commitSigned` through the session and a signing helper for other commands (FR-001, FR-003)
- [x] T009 `update/operator.ts`: nested runs in process, children only after the pin moved, the session's variables to children (FR-001, FR-006)
- [x] T010 `people/commands.ts`, `risk/review.ts`: signing through the session (FR-001)
- [x] T011 `main.ts`, `archon-boot/main.ts`, `src/stolos/main.ts`: the in-process runner, `--fresh`, the session wiped at the end (FR-002, FR-004, FR-006, FR-008)
- [x] T012 `archon-boot/firewall.ts`, `doctor.ts`: the cache, the shared probe, in parallel (FR-008)
- [x] T013 `fleet/apply.ts`, `archon-boot/doctor.ts`, `update/operator.ts`: one fetch per run (FR-009)

### Tests

- [x] T014 `tests/passphrase106.test.ts` (FR-001 to FR-005)
- [x] T016 `adopt/pair-command.ts`: the Firewall phase closed before the instructions, the waiting line, the pairing outcome always shown (UAT of v0.136.0; proved in `tests/pair098.test.ts`) (FR-006)
- [x] T015 `tests/speed106.test.ts` (FR-006 to FR-010)

### Fix forward (v0.139.0: CI of v0.137.0 and v0.138.0 failed)

- [x] T017 `archon-boot/firewall.ts`: a hard limit of 20 seconds on reading the firewall, by signal and by race, one warning where it could not be read, never kept; `core/run-memo.ts`: a limit on `git fetch`; `core/passphrase.ts`: a limit on an askpass program, the end of the command never waits on the broker's close (FR-002, FR-008; proved in `tests/speed106.test.ts`, `tests/passphrase106.test.ts`)
- [x] T018 `core/passphrase.ts`: on Windows no broker (`PerSigningSession`: spec 105's askpass for each signing), the other systems keep it (FR-002; proved in `tests/passphrase106.test.ts`; its two end-to-end broker tests do not run on Windows)
- [x] T019 `archon-boot/doctor.ts`: `EACCES` on a port below 1024 is a warning, not a failure, so a run that is not root passes (FR-008; proved in `tests/speed106.test.ts`)

## Wave 2: later, not built

- [ ] L103 One passphrase per command on Windows awaits a real Windows test of the broker: the loopback server, the `.cmd` helper that ssh-keygen runs, and the helper reaching the broker. Until then Windows asks once per signing (spec 105's way). Turn it on by `brokerHere` in `core/passphrase.ts`, and restore the two end-to-end tests on Windows

- [ ] L101 The passphrase prompt on Windows and macOS terminals is Stolos's own raw-mode read: check it by hand on both (the unit tests cover the reading rules, not a real console)
- [ ] L102 Cache the engine's newest-release lookup (`git ls-remote`) for a few minutes too (spec 099 FR-002 caches it for the consoles only)
