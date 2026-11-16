# Implementation Plan: The ladder, the ontology, and the trace

**Branch**: `101-ladder` (committed directly to main) | **Date**: 2026-11-16 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/101-ladder/spec.md`

## Summary

Article 0 of the constitution states the ladder; the ontology (`ontology/stolos/`, TypeScript on
commons' kernel RDF) states its rungs, the classes of a fleet and the code lists the engine branches
on, each citing its spec; a generator writes the Turtle, the code's unions, the constitution's table
and `AGENTS.md`'s layout; and three checks, built on commons 0015-trace, hold the trace of every
file and term, the direction of every import, and the ontology's freshness, with baselines that only
shrink.

## Technical Context

**Language/Version**: TypeScript 7, run by Bun, with Node 26 as the backup (Article 4)

**Primary Dependencies**: IFC TypeScript's kernel (`rdf`, `trace`, `layers`, `palette`) and runtime
(`trace`, `fs`, `path`, `proc`), at commons `8e94d0d77cc899f20f2bdfd61357119c07d10cb0`

**Storage**: files of the repository: `ontology/stolos.auto.ttl`, `src/archon/ontology.auto.ts`,
`tools/trace.baseline.txt`, `tools/layers.baseline.txt`

**Testing**: `tests/ladder101.test.ts` through `bun run test`

**Target Platform**: any computer that runs the engine's CI (Linux, macOS, Windows)

**Project Type**: the harness's own tools

## Constitution Check

- Article 0: this plan states it. The ontology module and this spec are drafted and committed
  together; the code (the generator, the checks, the unions' imports) follows.
- Article 4 (code over config): the ladder is TypeScript; the baselines are the tools' plain text
  output, the one exception, chosen because nothing in them runs (commons 0015-trace FR-002).
- Article 26 (generated files say so): `stolos.auto.ttl` and `ontology.auto.ts`.

## Project Structure

### Documentation (this feature)

```text
specs/101-ladder/
  spec.md, plan.md, tasks.md, reviewed.tsv
```

### Source Code (by rung of the ladder)

```text
rung 0: ontology/stolos/vocabulary.ts, codes.ts, architecture.ts, mod.ts; ontology/stolos.auto.ttl;
        src/archon/ontology.auto.ts
rung 1: .specify/memory/constitution.md (Article 0), specs/101-ladder/
rung 2: src/archon/model/types.ts (SignerRole, DataClass, the host's kind)
rung 4: src/archon/core/ui.ts (ProblemLevel), src/archon/core/registry-types.ts (Tier)
rung 5: src/archon/adopt/integrate.ts (INTEGRATIONS), src/archon/fleet/records.ts (fileKindOf)
rung 6: tools/ontology.ts, tools/trace.ts, tools/layers.ts, tools/gen-assets.ts,
        src/archon/console/pc.ts (PcMachine's kind)
rung 7: AGENTS.md (Rules, Layout), tests/ladder101.test.ts
```

**Structure Decision**: `ontology/` is a new top-level folder, on rung 0.

## Complexity Tracking

| Violation                                      | Why needed                                                                                                       | Simpler alternative rejected because                                                      |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Baselines of today's trace and layers findings | The engine predates the ladder: hundreds of files carry no `Spec:` line yet and many imports climb the wrong way | Fixing all of them in one change would guess at requirements and move code without a spec |
