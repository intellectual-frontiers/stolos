# Tasks: Every machine the fleet knows is in `fleet status`, and "no evidence" is not a failure

**Input**: `specs/117-adopted-in-status/spec.md`, `plan.md`

**Tests**: FR-001 to FR-010 are proved with `proves([...])` in `tests/status117.test.ts`; none is reviewed.

- [x] T001 `P117-NO-EVIDENCE` (FR-010) in `src/archon/core/explain.ts`
- [x] T002 `src/archon/compliance/not-observed.ts`: the decision and the words (FR-006, FR-008, FR-009)
- [x] T003 `printImpact`, the PR comment and the drift print and mail use it (FR-006, FR-007) in `compliance/impact.ts` and `compliance/drift.ts`
- [x] T004 `adopt/policy.ts` names the never-observed result; `report` prints it and `unknown` as one waiting item (FR-006, FR-007) in `adopt/commands.ts`
- [x] T005 `src/archon/observe/fleet-machines.ts` and `fleet-status.ts`: every machine, one line each (FR-001 to FR-005)
- [x] T006 Prove FR-001 to FR-010 in `tests/status117.test.ts`
- [x] T007 `bun run version bump` (0.157.0)
