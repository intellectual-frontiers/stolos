# Tasks: The release record

**Input**: `specs/114-release-record/spec.md`, `plan.md`

**Tests**: every requirement is proved with `proves([...])` in `tests/release114.test.ts` and in the tests whose fixtures name a tag (`tests/upgrade.test.ts`,
`tests/update058.test.ts`, `tests/update099.test.ts`, `tests/scaffold.test.ts`, `tests/guides070.test.ts`); FR-009 and FR-012 are reviewed (`reviewed.tsv`).

## Phase 1: Ontology and specification (rungs 0 and 1)

- [x] T001 `stolos:EngineRelease` says what a release is and is mapped to commons' `ifr:Release` (no new term) in `ontology/stolos/vocabulary.ts`, `ontology/stolos/audit.ts`; `bun run gen`
- [x] T002 This specification, its plan and tasks, the standards considered

## Phase 2: The work, its version and the tag (rungs 4 to 6)

- [x] T003 `release.ts`, the record of the one work `stolos` (FR-001)
- [x] T004 `TAG_PREFIX`, `tagOf`, `TAG`; the version is 0.150.0 in `src/archon/version.ts`, `package.json`, `release.ts` (FR-003, FR-004) in `src/archon/version.ts`
- [x] T005 `tools/version.ts`: `bump`, `set <version>`, `sync` write the three files, `check` holds that they agree (FR-002) in `tools/version.ts`
- [x] T006 The pin, the tag parser, the workflow references, the `adopt` commit (FR-005, FR-007) in `src/archon/fleet/{upgrade,signing}.ts`
- [x] T007 The newest release is the greatest `stolos-v` tag (FR-006) in `src/archon/fleet/releases.ts`, `src/archon/update/operator.ts` (unchanged: it reads `newestTag`)
- [x] T008 The scripts and the lines that name the tag: bootstrap, integrate, pairing, `fleet init`, the launcher, the boot server, the docs site (FR-005) in `src/archon/fleet/bootstrap.ts`, `src/archon/adopt/{integrate,pair-service}.ts`, `src/archon/identity/fleet-init.ts`, `src/archon/capabilities/cli.ts`, `src/archon-boot/main.ts`, `src/archon/core/guides.ts`
- [x] T009 CI: `versions check` in the `check` job, the annotated tag by `versions tag stolos`, the docs under the tag's name, `fleet-e2e.yml` reads the new pin (FR-008, FR-009, FR-004) in `.github/workflows/ci.yml`, `.github/workflows/fleet-e2e.yml`
- [x] T010 `bun run versions:check`, and it in `bun run ci` (FR-008) in `package.json`

## Phase 3: Proof and documentation (rung 7)

- [x] T011 Prove FR-001 to FR-008, FR-010, FR-011 in `tests/release114.test.ts`; the fixtures of the tests that fake a tag use `stolos-v` and real Git (FR-010)
- [x] T012 Name the requirements on a `// Spec:` line in every source file above (spec 101-ladder FR-010)
- [x] T013 The guide "Changing and releasing the engine", `AGENTS.md`, the README and the guides that name the tag (FR-011) in `src/releasing.ts`, `AGENTS.md`, `README.md`, `src/archon/fleet/mod.ts`
- [x] T014 The operator's note: the commit that brings 0.150.0 carries `Operator action: run bun add github:intellectual-frontiers/stolos#stolos-v0.150.0 and then bun run stolos update` (FR-012)

- [x] T015 The slug and the tag form in one place; `tools/version.ts slug|tag`; the workflow reads them (FR-013) in `src/archon/version.ts`, `tools/version.ts`, `.github/workflows/ci.yml`
- [x] T016 `--version` of both commands prints `<version> (engine stolos-v<version>)`, the smoke run checks it (FR-014) in `src/archon/main.ts`, `tools/smoke.ts`

## Later (not built)

- [ ] L001 A signed tag: where an owner's key can sign (a release made on the owner's PC, or a signing service that holds a key CI can use without keeping it), `versions tag stolos` signs it where Git is set to sign (commons 0026 FR-018).
- [ ] L002 The release's provenance, its software bill of materials and its checksums, and the citation file (`versions cite stolos`, commons 0026 FR-024, FR-025): each is recorded by its digest on the release.
- [ ] L003 Release notes from the capabilities closed since the last tag (`versions notes stolos`, commons 0026 FR-023), where this repository's commits state the `Closes` and `Impact:` lines.
- [ ] L004 Protect `stolos-v*` tags on GitHub with a tag ruleset (the steps are in the guide) and delete the old `v*` tags (the owner does both).
