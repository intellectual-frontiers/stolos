# Tasks: Pairing with a short code

**Input**: `specs/098-pair/spec.md`, `plan.md`

**Tests**: every requirement is proved by `tests/pair098.test.ts` with `proves([...])`.

## Phase 1: Ontology and specification (rungs 0 and 1)

- [x] T001 Define the terms the spec uses in `ontology/stolos/`, each citing `098-pair` (see `spec.md`, Ontology)
- [x] T002 Write the requirements in `specs/098-pair/spec.md`, using only those terms

## Phase 2: Headless operations, then the consoles (rungs 2 to 6)

- [x] T003 `stolos pair`: listen on the trusted network, show the command and the code (FR-001) in `src/archon/adopt/pair-command.ts`, `src/archon/commands/registry.ts`
- [x] T004 The code: 8 characters from an alphabet without look-alikes (FR-002; expiry and one machine per code replaced by spec 107-pairing-and-query) in `src/archon/adopt/pair.ts`
- [x] T005 Serve this engine's scripts and probes; sign every message with HMAC-SHA256 under the code (FR-003, FR-004) in `src/archon/adopt/pair.ts`
- [x] T006 Ask once about osquery; show who asked; approve on the PC; refuse a bad name first (FR-005, FR-006, FR-007) in `src/archon/adopt/pair.ts`, `src/archon/adopt/pair-command.ts`
- [x] T007 Say why plain HTTP is deliberate (Article 28) (FR-008) in `src/archon/adopt/pair.ts`, `src/archon/adopt/pair-command.ts`
- [x] T008 Keep `host integrate` and `host adopt --check-in` working (FR-009) in `src/archon/adopt/commands.ts`
- [x] T009 `stolos mesh`: guidance on zero trust mesh networks, read only (FR-010) in `src/archon/adopt/mesh.ts`, `src/archon/commands/registry.ts`

## Phase 3: Proof and documentation (rung 7)

- [x] T010 Prove every requirement in `tests/pair098.test.ts`
- [x] T011 Name the requirements on a `// Spec:` line in every source file above (spec 101-ladder FR-010)
- [x] T012 Update the guide that explains it (its `mod.ts`) in the same commit
