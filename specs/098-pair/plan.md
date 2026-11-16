# Implementation Plan: Pairing with a short code

**Branch**: `098-pair` (committed directly to main) | **Date**: 2026-11-16 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/098-pair/spec.md`

## Summary

`stolos pair` brings a machine into the fleet with one short fixed command and a code that expires, as device login does: the PC serves this engine's scripts on the trusted network, every message after the script is signed with the code, and the person approves on the PC, which already holds the fleet's trust.

## Technical Context

**Language/Version**: TypeScript 7, run by Bun, with Node 26 as the backup (Article 4, spec 096-bun-runtime)

**Primary Dependencies**: IFC TypeScript's kernel and runtime (`@intellectual-frontiers/commons`), nothing else

**Storage**: the fleet repository (typed TypeScript under `fleets/<id>/`) and the controller's own files; no secret in Git (Article 13)

**Testing**: `tests/pair098.test.ts` through `bun run test` (`proves([...])`, every requirement of the spec)

**Target Platform**: the controller PC (Linux, macOS, Windows) and the fleet's machines

**Project Type**: command line (headless first), then the consoles

## Constitution Check

- Article 0 (the ladder): the terms are in the ontology (rung 0) and cited in `spec.md` (rung 1); the
  operations are business rules (rung 5) on the infrastructure (rung 4), reached by commands of the
  one registry (rung 6, headless) before any console page (rung 6, windowed); the guides are rung 7.
  Every source file below names its requirements on a `// Spec:` line.
- Article 6 (one registry): every action is a command, and an MCP tool where its tier allows.
- Article 13 (no plaintext secrets) and Article 28 (trusted networks): as `spec.md` decides.

## Project Structure

### Documentation (this feature)

```text
specs/098-pair/
  spec.md     the requirements, the ontology terms they use, the decisions
  plan.md     this file
  tasks.md    the tasks, each with its files and requirements
```

### Source Code (by rung of the ladder)

```text
rung 5: src/archon/adopt/commands.ts, src/archon/adopt/mesh.ts, src/archon/adopt/pair-command.ts, src/archon/adopt/pair.ts
rung 6: src/archon/commands/registry.ts
rung 7: src/archon/adopt/mod.ts
tests: tests/pair098.test.ts
```

**Structure Decision**: the engine's existing folders; nothing new at the top level.

## Complexity Tracking

None.
