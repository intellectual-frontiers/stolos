# Implementation Plan: Remote access to the Stolos Console

**Branch**: `100-remote-access` (committed directly to main) | **Date**: 2026-11-16 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/100-remote-access/spec.md`

## Summary

The Stolos Console answers at its own HTTPS names on the site's LAN or the fleet's mesh network, with a Let's Encrypt certificate by DNS-01; a new browser registers a passkey and shows a code a signer approves with a signed commit of `access.ts`; sign-in is WebAuthn against what Git holds; every event is audited by mail.

## Technical Context

**Language/Version**: TypeScript 7, run by Bun, with Node 26 as the backup (Article 4, spec 096-bun-runtime)

**Primary Dependencies**: IFC TypeScript's kernel and runtime (`@intellectual-frontiers/commons`), nothing else

**Storage**: the fleet repository (typed TypeScript under `fleets/<id>/`) and the controller's own files; no secret in Git (Article 13)

**Testing**: `tests/access100.test.ts` through `bun run test` (`proves([...])`, every requirement of the spec)

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
specs/100-remote-access/
  spec.md     the requirements, the ontology terms they use, the decisions
  plan.md     this file
  tasks.md    the tasks, each with its files and requirements
```

### Source Code (by rung of the ladder)

```text
rung 2: src/archon/model/types.ts
rung 3: src/archon/model/secret-inventory.ts, src/archon/model/validate.ts
rung 4: src/archon/core/secrets.ts, src/archon/identity/fleet-init.ts, src/archon/web/cloudflare.ts
rung 5: src/archon/access/commands.ts, src/archon/access/devices.ts, src/archon/access/doctor.ts, src/archon/access/https.ts, src/archon/access/launch.ts, src/archon/access/names.ts, src/archon/access/pages.ts, src/archon/access/passkeys.ts, src/archon/access/routes.ts, src/archon/access/service.ts, src/archon/access/tls.ts, src/archon/adopt/controller.ts, src/archon/adopt/policy.ts, src/archon/fleet/records.ts
rung 6: src/archon-boot/doctor.ts, src/archon/commands/registry.ts, src/archon/console/stolos-launch.ts, src/archon/console/stolos-pages.ts, src/archon/console/stolos-server.ts
rung 7: src/archon/access/mod.ts, src/archon/console/mod.ts
tests: tests/access100.test.ts
```

**Structure Decision**: the engine's existing folders; nothing new at the top level.

## Complexity Tracking

None.
