# Tasks: Tags: the labels a fleet gives its machines, and choosing machines by them

**Input**: `specs/108-tags/spec.md`, `plan.md`

**Tests**: every requirement is proved with `proves([...])` in `tests/tags108.test.ts` (and `tests/decisions.test.ts`,
`tests/query107.test.ts` where they carry a changed contract); FR-017 and FR-018 are reviewed (`reviewed.tsv`).

## Phase 1: Ontology and specification (rungs 0 and 1)

- [x] T001 `stolos:Tag`, `stolos:TagDimension`, `stolos:TagRule`, `stolos:TagGroup`, `stolos:TagSelection` and the code lists `stolos:TagColour`, `stolos:TagCardinality`, `stolos:TagOrigin` in `ontology/stolos/`, each citing `108-tags`; `bun run gen`
- [x] T002 This specification, its plan and tasks, the standards considered

## Phase 2: Headless operations (rungs 2 to 6)

- [x] T003 `defineTags`, the typed ids, the definitions' problems, the rule helpers, the starter kit (FR-001, FR-002, FR-003) in `src/archon/model/tags.ts`
- [x] T004 Resolution with origins and precedence; groups; free-form tags kept apart (FR-004, FR-005, FR-009, FR-010, FR-011) in `src/archon/model/tags.ts`
- [x] T005 The expression parser and the selection (FR-012) in `src/archon/model/tags.ts`
- [x] T006 Tags in `decisions.ts` and `machine.ts`, read by `loadHosts` and `loadAdopted` (FR-004) in `src/archon/fleet/decisions.ts`, `src/archon/adopt/adopt.ts`, `src/archon/model/{types,load}.ts`
- [x] T007 Loading the fleet's tags and machines; the build's problems (FR-002) in `src/archon/fleet/tags.ts`, `src/archon/build.ts`
- [x] T008 `stolos tag add|remove|list` (FR-006, FR-007) in `src/archon/fleet/tag-commands.ts`, `src/archon/commands/registry.ts`, `src/archon/core/registry-types.ts`
- [x] T009 `stolos pair --tag` and the choice at each approval (FR-008) in `src/archon/adopt/pair-command.ts`, `commands.ts`
- [x] T010 `fleet query --tag|--any-tag|--select` (FR-013) in `src/archon/adopt/{commands,query}.ts`; `compliance --tag|--any-tag|--select` (FR-016) in `src/archon/compliance/commands.ts`
- [x] T011 The starter `tags.ts` for a new fleet (FR-003) in `src/archon/identity/fleet-init.ts`; the example lab's `tags.ts` and `decisions.ts`

## Phase 3: The Stolos Console (rung 6, windowed)

- [x] T012 Chips, the filter and facets, group-by, a machine's tags, custom tags apart (FR-014, FR-015) in `src/archon/console/{tags,assets,pc,stolos-pages}.ts`
- [x] T013 The tag picker above Ask every machine (FR-013) in `src/archon/console/{tags,stolos-pages,stolos-server}.ts`
- [x] T014 The machines CSV and the evidence JSON carry the tags and their origins (FR-014, FR-015) in `src/archon/console/stolos-pages.ts`

## Phase 4: Proof and documentation (rung 7)

- [x] T015 Prove every requirement (SC-001, SC-002): `tests/tags108.test.ts`
- [x] T016 Name the requirements on a `// Spec:` line in every source file above; the guide in `src/archon/fleet/mod.ts` (FR-018)

## Later (not built)

- [ ] L001 Tag the machines of cloud accounts and SNMP devices (and the discovered ones). Their records are written by observation,
      not by a person, so a person's tags for them need a file of their own (`fleets/<fleet>/tags.assigned.ts`?) and a decision on
      who may write it.
- [ ] L002 The daily mail and report grouped by an `owner` tag (one section per owner), and compliance evidence grouped by tag in the
      JSON and the OSCAL documents (this change cuts the evidence to the chosen machines; it does not yet group it).
- [ ] L003 The machines table as an AG Grid (spec 107) with the tags as a set filter, sorting and paging; this change keeps the
      HTML table with its filter and facets.
- [ ] L004 Tag a machine from the Stolos Console (the console already runs commands: a form for `tag add` and `tag remove`, behind the
      same signed commit), and edit a tag's definition there through a pull request.
- [ ] L005 Rules over what a machine reports beyond its operating system and address (a package, a policy that fails, an open port),
      and rules over other tags; and IPv6 prefixes in `addressIn` and in groups.
- [ ] L006 Policies scoped by tag (a control that applies only to `data:regulated`) in the control SDK (spec 078), and a
      compliance impact gate that knows a weakening of a `criticality:high` machine is worse.
- [ ] L007 `stolos tag rename <old> <new>` that edits `tags.ts` and every machine's file in one commit, and `tag unused` (a defined
      tag no machine holds).
- [ ] L008 Not verified in a real browser, Windows or macOS session in this change: the chips, filter, facets and group-by are
      checked as HTML and signals by the tests, and `tests/console/stolos-browser.cjs` (CI's console-browser job) does not yet
      click them.
