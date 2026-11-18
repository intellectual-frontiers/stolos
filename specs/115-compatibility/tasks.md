# Tasks: Compatibility: one engine, one release train, and a contract between a PC and its machines

**Input**: `specs/115-compatibility/spec.md`, `plan.md`

**Tests**: every requirement is proved with `proves([...])` in `tests/compat115.test.ts` (and the contracts specs 067, 069 and 112 carry, in `tests/adopt067.test.ts`,
`tests/integrate069.test.ts` and `tests/tags112.test.ts`); FR-018 and FR-019 are reviewed (`reviewed.tsv`).

## Phase 1: Ontology and specification (rungs 0 and 1)

- [x] T001 `stolos:Seam` and `stolos:CompatStatus`, code lists citing `115-compatibility`, each mapped to a standard in `ontology/stolos/audit.ts` (SKOS concept schemes); `bun run gen` in `ontology/stolos/{vocabulary,codes,mod,audit}.ts`
- [x] T002 This specification, its plan and tasks, the standards considered

## Phase 2: The seams and the judgement (rungs 2 to 4)

- [x] T003 The five seams with their versions, the judgement and the words, in one module (FR-001, FR-002, FR-007, FR-008) in `src/archon/core/compat.ts`
- [x] T004 The holds' types (FR-013) in `src/archon/model/types.ts`
- [x] T005 The bounded report: `compat` in the PC's cache, the probe's `@compat` read (FR-004, FR-006) in `src/archon/model/reported.ts`
- [x] T006 The codes `E115-TOO-OLD`, `E115-NEWER`, `P115-UNKNOWN` (FR-012) in `src/archon/core/explain.ts`

## Phase 3: Headless operations (rungs 5 and 6)

- [x] T007 The machine reports its engine and seams in `archon state` and `archon` (FR-005) in `src/archon/state/state-command.ts`, `src/archon/commands/registry.ts`, `src/archon/guide/where.ts`
- [x] T008 The probe's `@compat` section, POSIX and PowerShell (FR-004) in `bin/stolos-probe.sh`, `bin/stolos-probe.ps1`, `src/archon/adopt/adopt.ts`
- [x] T009 The PC keeps and judges what machines reported (FR-006, FR-007) in `src/archon/observe/{compat,fleet-status}.ts`
- [x] T010 The finding and the adopted pack's policy (FR-010) in `src/archon/compliance/report.ts`, `src/archon/adopt/policy.ts`
- [x] T011 The warning before `stolos apply`, never a block (FR-011) in `src/archon/fleet/apply.ts`, `src/archon/observe/compat.ts`
- [x] T012 The digests and the golden test's tool: `bun run compat:digest`, `--check` in `bun run ci` (FR-003) in `src/archon/observe/compat-shapes.ts`, `src/archon/mcp/compat-shape.ts`, `tools/compat-digest.ts`, `tests/compat.digest.txt`, `package.json`
- [x] T013 Holds: validation at `stolos build`, resolution, the existence check (FR-013, FR-014, FR-015) in `src/archon/fleet/engine-holds.ts`, `src/archon/build.ts`
- [x] T014 `stolos compat` and `--json` (FR-016) in `src/archon/observe/compat-command.ts`, `src/archon/commands/registry.ts`
- [x] T015 `boot doctor`'s Hosts line (FR-009) in `src/archon-boot/doctor.ts`

## Phase 4: The Stolos Console (rung 6, windowed)

- [x] T016 The machines table's Contract column, the machine page's card, the Overview's attention rows and summary, the CSV and the evidence JSON (FR-009) in `src/archon/console/{pc,stolos-pages}.ts`

## Phase 5: Proof and documentation (rung 7)

- [x] T017 Prove every requirement (SC-001, SC-002): `tests/compat115.test.ts`
- [x] T018 Name the requirements on a `// Spec:` line in every source file above; the guide in `src/archon/fleet/mod.ts` (FR-019)

## Later (not built)

- [ ] L001 **The install side of a hold** (FR-015): a host held at an engine tag runs that engine while the fleet's pin moves on. The exact blocker: a server has one engine, one
      `node_modules` in `/srv/archon` installed by `bun install --frozen-lockfile` from the checkout's `package.json` and `bun.lock`, and the launcher and the fleet's own files resolve the
      engine from that tree; a held host needs (1) a lock for the held tag that a signed commit holds (the PC makes it with a non-frozen `bun install` at the tag, as `fleet upgrade` does, and
      signs it as `engine-holds/<tag>/{package.json,bun.lock}`), (2) a second install root on the host (`/var/lib/archon/engines/<tag>/`) installed by `bun install --frozen-lockfile` from
      those two files, so the lock is never relaxed and nothing is built, (3) the checkout's `node_modules` made to resolve to that root for that host (a link the reconcile maintains), and
      (4) a launcher that selects the root, rendered by the engine the host runs: a host held at an engine older than the one that renders the launcher cannot receive it, so the first hold of
      a host needs the host on an engine that knows holds. Each part is testable with real Git tags and two real installs; none is built here because (2) and (3) change how every server
      starts, which wants its own specification and a real server to prove it.
- [ ] L002 The PC says which engine a hold would run, by reading the seams of the held tag (the digest file at that tag), so that "held at X" can also say whether X is compatible with this PC before it is moved to.
- [ ] L003 Not verified in this change: the PowerShell probe's `@compat` section (read as text, not run), Windows and macOS sessions, and a real installed server (its `archon state` is run in a host root; the transport is a stand-in `ssh`, as spec 048's and 112's tests have it).
- [ ] L004 Workstations (Ubuntu on WSL, desktops) are not asked by `stolos fleet status`, so they have no contract status; a workstation that is asked would be judged as a managed machine.
- [ ] L005 The `signed-records` seam is versioned by hand: a digest of the check-in text's grammar, the verify and observation record types and the commit conventions would make it mechanical like the others.
