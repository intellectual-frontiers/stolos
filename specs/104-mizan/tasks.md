# Tasks: Mizan, the IF Spec Profile

**Input**: `specs/104-mizan/spec.md`, `plan.md`

**Tests**: every requirement is proved by `tests/mizan104.test.ts` or reviewed in `reviewed.tsv`.

- [x] T001 Pin commons at a commit with Mizan (FR-001)
- [x] T002 The eight rungs as individuals of `mz:Rung`; remove Stolos's own Rung class (FR-002)
- [x] T003 `ontology/stolos/audit.ts`: a record of the basis of every class and property (FR-003)
- [x] T004 `tools/mizan.ts`, its baseline and `check:mizan` (FR-004, FR-005)
- [x] T005 `bun run ci` runs `check:mizan` (FR-006)
- [ ] T006 Move the status words and `reviewed.tsv` to commons' (out of scope for this spec)
- [ ] T007 Shrink the baseline: keywords on requirements, requirement citations on scenarios, Standards considered in plans
