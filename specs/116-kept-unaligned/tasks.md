# Tasks: Terms kept unaligned carry a typed decision

**Input**: `specs/116-kept-unaligned/spec.md`, `plan.md`

**Tests**: FR-001 to FR-005 are proved with `proves([...])` in `tests/decisions116.test.ts`; none is reviewed.

- [x] T001 The helper, the decisions and the pointer of each record (FR-001 to FR-003) in `ontology/stolos/audit.ts`
- [x] T002 The audit file joins the ontology's files (FR-004) in `ontology/stolos/mod.ts`; `bun run gen`
- [x] T003 `bun tools/mizan.ts --write-baseline`: 52 lines removed, none added (FR-005) in `tools/mizan.baseline.txt`
- [x] T004 Prove FR-001 to FR-005 in `tests/decisions116.test.ts`; the overdue case of `tests/mizan104.test.ts` uses a term with no decision
- [x] T005 `bun run version bump` (0.151.0)
