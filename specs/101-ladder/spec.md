# 101: The ladder, the ontology, and the trace

**Feature Branch**: `101-ladder` (committed directly to main) **Created**: 2026-11-16

**Status**: Implemented

**Input**: Bring Stolos onto Intellectual Frontiers' way of working, as `erga` does it:
the constitution first (Article 0, the ladder), then the ontology (algebraically typed TypeScript on
commons' kernel RDF) and the Spec Kit specifications drafted together, then the code, with every
file and term traced and the ladder's dependency direction checked (commons 0015-trace).

## Why

Stolos grew spec by spec, and each spec says what it needs, but nothing ties a file to the
requirement it implements, nothing says which part may import which, and the words the engine
branches on (a machine's kind, a command's tier, an outcome's level) are written again in every
module that needs them. An auditor, a new contributor and an agent each have to guess. `erga` holds
the same rules with a ladder of eight rungs, an ontology every term comes from, and checks that fail
on code without a requirement and on an import that climbs the wrong way. This spec gives Stolos the
same, with commons' TypeScript checks.

## Ontology

The terms this spec uses, each defined in `ontology/stolos/` before it is used here:
commons' `mz:Rung` (commons 0016-ladder; the rungs `stolos:rung-0` to `stolos:rung-7` are its individuals), `mz:home`, `mz:mayRelyOn`,
`mz:provedBy`, `stolos:spec`, and the code lists `stolos:OutcomeLevel`, `stolos:MachineKind`,
`stolos:SignerRole`, `stolos:CommandTier`, `stolos:DataClass`, `stolos:IntegrationKind` and
`stolos:FileKind`.

## Requirements

- **FR-001** The constitution's Article 0 (NON-NEGOTIABLE) states the ladder of eight rungs, lowest
  first (0 ontology, 1 specifications, 2 governed data, 3 data operations, 4 infrastructure rules,
  5 business rules, 6 application: headless hosts, then windowed hosts, 7 documentation), its two
  rules (dependency direction; order of work) and headless first. The rungs are individuals of
  `mz:Rung` (commons' shared class, `104-mizan`) in `ontology/stolos/architecture.ts`, each with its number, purpose, homes, the
  rungs it may rely on and the commands that prove it; `bun run gen` writes the constitution's table
  between `<!-- ladder:begin -->` and `<!-- ladder:end -->` and `AGENTS.md`'s layout between
  `<!-- layout:begin -->` and `<!-- layout:end -->` from them, and `bun run gen --check` fails where
  either differs.
- **FR-002** Every folder of `src/`, every top-level folder and every file of the root is on exactly
  one rung, by the most specific of the rungs' homes (one path beats every glob, a glob naming files
  beats a folder, then the longer; commons 0015-trace FR-009). `bun run check:layers` reports a
  TypeScript file on no rung or on two.
- **FR-003** Dependency direction: `bun run check:layers` fails on a relative import from a rung to a
  rung above it or to a lower rung it may not rely on (commons 0015-trace FR-010), unless the
  baseline `tools/layers.baseline.txt` holds it.
- **FR-004** The ontology is TypeScript on commons' kernel RDF (commons 0012-ontology) under
  `ontology/stolos/`, in the namespace `https://intellectual-frontiers.github.io/stolos/ontology#`
  (prefix `stolos:`): a vocabulary module (the classes `stolos:Fleet`, `stolos:Host`,
  `stolos:Controller`, `stolos:AdoptedMachine`, `stolos:Device`, `stolos:Signer`,
  `stolos:ConsoleDevice`, `stolos:Capability`, `stolos:Check`, `stolos:Finding`, `stolos:Record`,
  `stolos:Decision`, and the properties), the code lists, and the architecture. Every class,
  property, code and rung cites the spec it comes from in its `spec` field.
- **FR-005** `tools/ontology.ts` writes `ontology/stolos.auto.ttl` (canonical Turtle, by the kernel)
  and `src/archon/ontology.auto.ts` (each code list's keys as a union type and an array, in the
  ontology's order), with `--check`; `bun run gen` runs it before the assets, and
  `bun run check:ontology` is its `--check`. It stops (exit 2) on what the kernel's `validate` finds
  and on a `stolos:` term a spec, plan or tasks file names that the ontology does not define.
- **FR-006** The code branches on the generated unions: the outcome levels of `core/ui.ts` (as far
  as they map: `pending` and `action`), the console's machine kinds (`console/pc.ts`, every kind but
  `controller`), a signer's role (`model/types.ts`), the command tiers (`core/registry-types.ts`),
  the data classes (`model/types.ts`), the integrations (`adopt/integrate.ts`) and records against
  decisions (`fleet/records.ts`), with the same behaviour as the words they replace.
- **FR-007** Trace: every source file under `src/`, `tools/` and `ontology/` (and
  `docs.config.ts`) names its requirements on a line `// Spec: NNN-short-name FR-NNN` (or a whole
  spec), every requirement of a spec in force is proved by a test or reviewed in its spec's
  `reviewed.tsv`, and every term of the ontology cites a spec that exists; `bun run check:trace`
  fails on a finding (commons 0015-trace FR-007) that the baseline `tools/trace.baseline.txt` does
  not hold.
- **FR-008** The baselines only shrink: each check fails on a new finding and on a baseline line
  that no longer occurs; `--write-baseline` writes the baseline from today's findings; `AGENTS.md`
  says how to shrink them. Generated files (`.auto.`) are exempt from the trace.
- **FR-009** `bun run ci` runs `check:ontology`, `check:trace` and `check:layers` before the tests.
- **FR-010** Order of work: the ontology and the specification are drafted and committed together,
  the ontology first, then the code; every new spec has `spec.md`, `plan.md` and `tasks.md` (Spec
  Kit fully), and the pilot specs 097-controller, 098-pair, 099-engine-update and 100-remote-access
  have theirs, cite the ontology terms they use, and their sources carry `Spec:` lines.
- **FR-011** Headless first: every action a console offers is also a command of the one registry
  (Article 6) and an MCP tool where its tier allows; a console holds no logic; the headless
  operation and its test come before the console action that uses it.

## Success criteria

- **SC-001** `tests/ladder101.test.ts`: the generated files are fresh; the ladder places every
  tracked TypeScript file on one rung; a new violation of the trace or of the layers fails each
  check, and so does a stale baseline line; the generated unions are the code lists' keys.
- **SC-002** `bun run ci` runs the three checks, green with today's baselines.

## Decisions

- **A plain text baseline** (commons 0015-trace FR-002): the tool writes it, a person only deletes
  lines from it, and nothing in it runs when it is read.
- **The tests are on rung 7.** They prove every rung below and rely on all of them, beside the
  documentation they make executable.
- **The state store's schema has no file of its own yet**: it is in `src/archon/state/store.ts`
  (rung 3); moving it to rung 2 is later work under this spec's rules.
- **Certain citations only.** A file's `Spec:` line is added where its `@module` names the spec by
  its full name, or by its number where a test of that spec imports the file; the rest stay in the
  baseline until a person names them.
