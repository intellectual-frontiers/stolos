# Tasks: Calm output

**Input**: `specs/105-calm-output/spec.md`, `plan.md`

**Tests**: every requirement is proved by `tests/calm105.test.ts` with `proves([...])`; the changed expectations of
`tests/019-output.test.ts`, `052` (`explain052`), `058` (`update058`), `060` (`fleetapply060`) and `100` (`access100`) are the old
contract made the new one.

## Wave 1: built

### Constitution, ontology and specification (rungs 0 and 1)

- [x] T001 Article 19 and the 6.2.0 amendment row in `.specify/memory/constitution.md` (its own change, `constitution: ...`) (FR-020)
- [x] T002 `stolos:OutputClass`, `stolos:Verbosity`, `stolos:LineKind` in `ontology/stolos/`, each code citing `105-calm-output`; `bun run gen` (FR-019)
- [x] T003 This specification, with the classification and the before and after (FR-001)

### Infrastructure and business rules

- [x] T004 `core/ui.ts`: modes and `shows(kind)`, honest marks (`Phase.mark`), calm closing block, verdict with counts, one `next:`, hints, nested runs, `Phase.merge`, `outcome`, `live`, `splitFix`, `lastLogPath` (FR-002 to FR-009, FR-011)
- [x] T005 `core/explain.ts`: raw-error patterns and the `E105-*` / `P105-WAITING` codes (FR-009)
- [x] T006 `core/registry-types.ts`: `output` on every command, `--quiet` global (FR-001, FR-002)
- [x] T007 `fleet/signing.ts`: `commitSigned` (three tries, "(2 left)"), `describeSigning`, `adoptMessage` (FR-012, FR-013)
- [x] T008 `fleet/upgrade.ts`: `waitingUpgrade`; the signing failure said once, cause first (FR-007, FR-013, FR-014)
- [x] T009 `fleet/apply.ts`: what is sent is listed before the passphrase; the waiting upgrade's message; `Sent:` outcome; the secrets reminder as one thing for you (FR-006, FR-012, FR-014, FR-017)
- [x] T010 `update/operator.ts`: nested runs as phases, merged once; the resumed upgrade; the remaining steps on the new engine; what's new (FR-005, FR-007, FR-014 to FR-016)
- [x] T011 `fleet/whatsnew.ts` (FR-016); the `Operator action:` convention in `AGENTS.md`
- [x] T012 `vault/panel.ts` (`secretsInWords`), `vault/reminder.ts`; `archon-boot/doctor.ts` (grouped secrets, the waiting upgrade is not "yours"); `access/doctor.ts` (remote access off is a hint) (FR-008, FR-014, FR-017)

### Application

- [x] T013 `commands/registry.ts`: `output` on all commands (the table in the spec) and `log [--last N] [--path]` (FR-001, FR-010)
- [x] T014 `main.ts` and `archon-boot/main.ts`: `-q`/`--quiet`, `-v`/`--verbose`, the class default, `--quiet` holds back what commands write themselves (FR-002)
- [x] T015 `tests/calm105.test.ts`: the golden runs and the invariants (FR-018)

## Wave 2: later, not built

- [x] L001 (built in 106-one-passphrase-speed) One passphrase per command: an in-memory key held only for the command (today: one per signed commit)
- [x] L002 (built in 106-one-passphrase-speed) Speed: in-process runs where the engine has not changed, cache and parallelize the firewall probe; target under 3 s typical
- [ ] L003 A new-release hint on any command, at most once a day (the hint mechanism is built; the lookup is not)
- [ ] L004 A plain-label vocabulary pass: "Catch up", "rendered", "Compliance impact", "Keys: Git's allowed signers..."
- [ ] L005 One vocabulary for update, apply, upgrade and send
- [ ] L006 Mark column alignment
- [ ] L007 `--check` on every action
- [ ] L008 The Approve action items already deferred elsewhere
- [ ] L009 The `stolos` shortcut avoids bun's own trailing `error: script "stolos" exited with code 1`, which the engine cannot remove: make the shortcut what the documents and the prompt teach
- [ ] L010 Propose the shared commons renderer extension (green silent and verdict last as shared rules) as a note for commons spec 0006 FR-027, only after coordinating with the Mizan session
- [ ] L011 Boot server commands other than doctor, serve, status and observe: give them their own phases so `--quiet` is more than muted output
