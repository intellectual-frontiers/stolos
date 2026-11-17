# Tasks: The controller opens three ports

**Input**: `specs/103-three-ports/spec.md`, `plan.md`

**Tests**: every requirement is proved by `tests/ports103.test.ts` (and `tests/pair098.test.ts`) with `proves([...])`.

## Phase 1: Constitution, ontology and specification (rungs 0 and 1)

- [x] T001 Article 29 and the amendment row in `.specify/memory/constitution.md` (its own change, `constitution: ...`) (FR-001)
- [x] T002 Define `stolos:Listener`, `stolos:Door`, `stolos:DevicePath` in `ontology/stolos/`, each citing `103-three-ports`; write `LISTENERS` and the rest in `src/archon/ontology.auto.ts` (FR-002)
- [x] T003 Write the requirements in `specs/103-three-ports/spec.md`; update specs 098 (FR-001, FR-008) and 100 (FR-003) to what is true now

## Phase 2: Headless operations, then the hosts (rungs 4 to 6)

- [x] T004 `src/archon/core/listeners.ts`: `standardPort`, `choosePort`, `firewallRule` (FR-002, FR-011)
- [x] T005 `PairStore`, the memory and file stores, the lock and the atomic write (FR-006, FR-007) in `src/archon/adopt/pair-store.ts`; the secret inventory and `SECRETS.pairing`
- [x] T006 `PairSession` over a store, under `/device/pair`, 404 with no pairing, one machine per code, tries in the store, `/checkin` held (FR-003, FR-005, FR-006) in `src/archon/adopt/pair.ts`, `pair-service.ts`
- [x] T007 `stolos pair`: the record, the doors, the lines, the firewall checks, the approval, the `finally` (FR-008) in `src/archon/adopt/pair-command.ts`
- [x] T008 Door A in the boot server; `--port` and `--tftp-port` as explicit choices (FR-004, FR-010) in `src/archon-boot/`
- [x] T009 Door B in the console's handler, LAN names only (FR-004) in `src/archon/console/stolos-server.ts`, `stolos-launch.ts`
- [x] T010 The console's TLS on 443 only; the refusal that names the holder; `--lan-port`; the doctor (FR-009) in `src/archon/access/`
- [x] T011 The guard test (FR-011) in `tests/ports103.test.ts`

## Phase 3: Proof and documentation (rung 7)

- [x] T012 Prove every requirement in `tests/ports103.test.ts` and `tests/pair098.test.ts`
- [x] T013 Name the requirements on a `// Spec:` line in every source file above (spec 101-ladder FR-010)
- [x] T014 Update the guides (`src/archon-boot/mod.ts`, `src/archon/adopt/mod.ts`, `src/archon/access/mod.ts`) in the same commit (FR-012)

## Later (not built)

- [ ] L001 The console's Remote Access page lists a waiting machine with an **Approve** action. Not built: approving runs
      `adoptCheckIn` (pins host keys, observes over SSH, writes and signs a commit in the fleet repository, may ask for a
      passphrase), which today needs the terminal's `ui.confirm` and the person's signing key; doing it from a page means the
      askpass round trip of spec 099, the console's own session privileges (spec 100 FR-009) and a decision on who may approve
      a machine. That is a spec of its own, not a small addition.
