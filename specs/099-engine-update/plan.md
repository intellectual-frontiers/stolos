# Implementation Plan: Updating the engine is one command, or one button

**Branch**: `099-engine-update` (committed directly to main) | **Date**: 2026-11-16 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/099-engine-update/spec.md`

## Summary

`stolos update` does every step of adopting a newer engine release itself, the consoles show the engine running and offer the update as a button, a passphrase is asked on the page that needs it, records Stolos wrote are expected rather than alarming, and an operator's step is the outcome level action.

## Technical Context

**Language/Version**: TypeScript 7, run by Bun, with Node 26 as the backup (Article 4, spec 096-bun-runtime)

**Primary Dependencies**: IFC TypeScript's kernel and runtime (`@intellectual-frontiers/commons`), nothing else

**Storage**: the fleet repository (typed TypeScript under `fleets/<id>/`) and the controller's own files; no secret in Git (Article 13)

**Testing**: `tests/update099.test.ts` through `bun run test` (`proves([...])`, every requirement of the spec)

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
specs/099-engine-update/
  spec.md     the requirements, the ontology terms they use, the decisions
  plan.md     this file
  tasks.md    the tasks, each with its files and requirements
```

### Source Code (by rung of the ladder)

```text
rung 4: src/archon/core/ui.ts
rung 5: src/archon/compliance/impact.ts, src/archon/fleet/records.ts, src/archon/fleet/releases.ts, src/archon/update/operator.ts
rung 6: src/archon-boot/doctor.ts, src/archon/commands/registry.ts, src/archon/console/askpass.ts, src/archon/console/layout.ts, src/archon/console/pages.ts, src/archon/console/server.ts, src/archon/console/stolos-launch.ts, src/archon/console/stolos-pages.ts, src/archon/console/stolos-server.ts
tests: tests/update099.test.ts
```

**Structure Decision**: the engine's existing folders; nothing new at the top level.

## Complexity Tracking

None.
