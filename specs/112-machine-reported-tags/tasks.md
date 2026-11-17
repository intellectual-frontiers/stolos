# Tasks: Machine-reported tags: what a machine says about itself, and what the fleet does with it

**Input**: `specs/112-machine-reported-tags/spec.md`, `plan.md`

**Tests**: every requirement is proved with `proves([...])` in `tests/tags112.test.ts` (and the contracts spec 108, 048, 067 and 069 carry
are changed in `tests/tags108.test.ts` and `tests/integrate069.test.ts`); FR-016 and FR-018 are reviewed (`reviewed.tsv`).

## Phase 1: Ontology and specification (rungs 0 and 1)

- [x] T001 `stolos:TagClaim`, the code lists `stolos:TagTrust` and `stolos:TagSource`, and `reported` and `announced` in `stolos:TagOrigin`, each citing `112-machine-reported-tags`, each mapped to a standard in `ontology/stolos/audit.ts` (SKOS concept schemes, RDF 1.1 `rdf:Statement`); `bun run gen`
- [x] T002 This specification, its plan and tasks, the standards considered
- [x] T003 The constitution, Article 25: a machine MAY record facts and claims about itself with `archon`; version 6.3.0 (`.specify/memory/constitution.md`)

## Phase 2: Headless operations (rungs 2 to 6)

- [x] T004 `fromMachine` per dimension, the typed `machineInfoMap`, the starter kit's values (FR-003, FR-005) in `src/archon/model/tags.ts`, `src/archon/identity/fleet-init.ts` (the starter `tags.ts`), `examples/fleets/lab/tags.ts`
- [x] T005 Resolution with claims: precedence, accept, hint, ignore, the fleet wins, disagreements; hints leave `idSet` (FR-002, FR-003, FR-011, FR-013) in `src/archon/model/tags.ts`
- [x] T006 The claim grammar and its caps, `/etc/machine-info`, SMBIOS, the tags table's rows, the bounded report (FR-004, FR-005, FR-006) in `src/archon/model/reported.ts`
- [x] T007 The machine's tags table: records of the kind `tag`, the view and osquery table `archon_tags`, `replaceRecords` (FR-007, FR-009) in `src/archon/state/{store,tags}.ts`, `src/archon/capabilities/osquery.ts` (the ATC tables come from the views)
- [x] T008 `archon tag add | remove | list`, the run log and the journal; the fleet's rows written at each apply (FR-007, FR-008) in `src/archon/fleet/machine-tags.ts`, `src/archon/apply/apply.ts`, `src/archon/commands/registry.ts`, `src/archon/mcp/server.ts`
- [x] T009 What the machine says, over the authenticated paths: `archon state` carries `/etc/machine-info`, the tags table and the firmware facts; the probe (version 3) has a `reported` section, on POSIX and on Windows (FR-005, FR-006) in `src/archon/state/{state-command,inventory,reported}.ts`, `bin/stolos-probe.{sh,ps1}`, `src/archon/adopt/{adopt,commands,controller}.ts`
- [x] T010 The PC's observation cache, read at `fleet status` and `host observe`; claims resolved by `loadFleetTags`; disagreements in `fleet status` (FR-010, FR-011, FR-013) in `src/archon/observe/fleet-status.ts`, `src/archon/fleet/tags.ts`
- [x] T011 `stolos tag accept`, `--reported` on `tag list` and `fleet query`, claims and disagreements in `tag list` and its JSON (FR-011, FR-012, FR-013) in `src/archon/fleet/tag-commands.ts`, `src/archon/adopt/{commands,query}.ts`, `src/archon/commands/registry.ts`
- [x] T012 The finding in the compliance evidence, SCF AST-04 (FR-013) in `src/archon/compliance/report.ts`, `src/archon/console/pc.ts`

## Phase 3: The Stolos Console (rung 6, windowed)

- [x] T013 Reported and announced chips, the Machines say panel with Accept and Ignore, the disagreement on the machine page (FR-014, FR-015) in `src/archon/console/{tags,assets,pc,stolos-pages}.ts`

## Phase 4: Proof and documentation (rung 7)

- [x] T014 Prove every requirement (SC-001, SC-002): `tests/tags112.test.ts`
- [x] T015 Name the requirements on a `// Spec:` line in every source file above; the guide in `src/archon/fleet/mod.ts` (FR-018)

## Later (not built)

- [ ] L001 Cloud providers' own tags (spec 084 and 109's connectors) mapped into the fleet's tags as claims of a cloud machine; they are read by
      observation, not by SSH, so they need a source of their own and a decision on the `announced` or `reported` channel.
- [ ] L002 Windows and macOS sources: Windows has no `machine-info` (a registry key or a file of the fleet's own naming could say the same,
      and its SMBIOS facts are read already); macOS has `scutil --get ComputerName`, which is a name and not a tag, so nothing is read there yet,
      and its SMBIOS-like facts (`hw.model`) are not mapped to chassis types.
- [ ] L003 The daily mail and report grouped by tag (one section per owner), as spec 108 L002, with what machines say beside what the fleet says.
- [ ] L004 Announced sources (spec 113): facts heard on the network without authentication (mDNS and DNS-SD, DHCP and LLDP announcements),
      read as hints with the origin `announced`; the origin exists in this release and nothing announces yet.
- [ ] L005 `archon tag` over MCP is tier `mutate`: a deployment may want a finer rule (an agent that may say tags but not remove them).
- [ ] L006 Accept all of a machine's held claims at once (`tag accept alpha --all`), and a console form that accepts several claims in one commit.
- [ ] L007 Not verified in this change: a real browser (the panel, its Accept form and Ignore are checked as HTML and signals), Windows and
      macOS sessions (the PowerShell probe's `reported` section is read as text, not run), a real `osqueryd` on a real machine (the real
      `osqueryi` reads the generated table), and a real installed server (its `archon state` is run in a host root; the transport is a
      stand-in `ssh`, as spec 048's tests have it).
