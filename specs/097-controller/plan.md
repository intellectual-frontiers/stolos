# Implementation Plan: The controller PC is a fleet machine

**Branch**: `097-controller` (committed directly to main) | **Date**: 2026-11-16 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/097-controller/spec.md`

## Summary

The PC that runs `stolos` records itself as an adopted machine with the role controller, is observed locally by the same probe an adopted machine runs (never over SSH), adds its own facts (the signing key, the vault against the latest backup, the recovery key) and is held to four policies of its own.

## Technical Context

**Language/Version**: TypeScript 7, run by Bun, with Node 26 as the backup (Article 4, spec 096-bun-runtime)

**Primary Dependencies**: IFC TypeScript's kernel and runtime (`@intellectual-frontiers/commons`), nothing else

**Storage**: the fleet repository (typed TypeScript under `fleets/<id>/`) and the controller's own files; no secret in Git (Article 13)

**Testing**: `tests/controller097.test.ts` through `bun run test` (`proves([...])`, every requirement of the spec)

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
specs/097-controller/
  spec.md     the requirements, the ontology terms they use, the decisions
  plan.md     this file
  tasks.md    the tasks, each with its files and requirements
```

### Source Code (by rung of the ladder)

```text
rung 4: src/archon/identity/fleet-init.ts, src/archon/identity/keys-commands.ts
rung 5: src/archon/adopt/adopt.ts, src/archon/adopt/commands.ts, src/archon/adopt/controller.ts, src/archon/adopt/pair-command.ts, src/archon/adopt/policy.ts
rung 7: src/archon/adopt/mod.ts
tests: tests/controller097.test.ts
```

**Structure Decision**: the engine's existing folders; nothing new at the top level.

## Complexity Tracking

None.
