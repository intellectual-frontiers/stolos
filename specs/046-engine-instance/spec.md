# Feature Specification: The engine and its fleets

**Feature Branch**: `046-engine-instance` (committed directly to main) **Created**: 2026-11-13
**Status**: In progress (the split, the lab, versioning: v0.1.0 to v0.2.0) **Input**: Make Archon a general
engine in a public repository (`intellectual-frontiers/stolos`) that any operator uses to manage
fleets on any network, while each operator's fleets (their model, site, hosts, and decisions) live
in a repository of their own (for example `shah/fleet`), which imports the engine by version.
Constitution Articles 7, 24, 26.

## User Scenarios & Testing _(mandatory)_

1. **Given** the engine checked out, **When** a developer runs `deno task archon build`, **Then**
   the example fleet (`examples/fleets/lab/`, hosts `alpha` and `beta`) validates and renders, with
   no real fleet's data anywhere in the repository.
2. **Given** a fleet repository with `deno.json` mapping `@stolos/` to
   `https://raw.githubusercontent.com/intellectual-frontiers/stolos/v0.1.0/src/` and its
   `deno.lock`, **When** an operator runs `deno run -A archon.ts build` there, **Then** the pinned
   engine builds the fleet's hosts.
3. **Given** a fleet repository with two fleets, **When** `archon` runs without `ARCHON_FLEET`,
   **Then** it says which fleets exist and how to choose one; with `ARCHON_FLEET=fcr` it uses
   `fleets/fcr/`.
4. **Given** a host installed from a fleet repository, **Then** `/etc/archon/fleet` names its fleet
   and its launcher runs the repository's `archon.ts` with the lockfile frozen.
5. **Given** a push to the engine's `main`, **Then** CI fails unless `src/archon/version.ts` is
   newer than before, and tags the commit `v<version>` when it passes.

## Requirements _(mandatory)_

- **FR-001** Two roots. The engine's root is where its modules were loaded from (a checkout or
  GitHub). The instance (fleet repository) is `ARCHON_REPO`, else the nearest folder above the
  working directory holding `fleets/`, else `/srv/archon`, else an engine checkout's `examples/`.
  The fleet is `ARCHON_FLEET`, else `/etc/archon/fleet`, else the instance's only fleet
  (`src/archon/core/paths.ts`).
- **FR-002** Layout of a fleet: `fleets/<id>/fleet.ts` (its `id` equals the folder's name, checked
  at load), `site.ts`, `hosts/<host>/host.ts` (one folder per host), `specs/` (the fleet's own
  decisions, including `approve: destructive` lines), and dotfile layers. Rendered output goes to
  `out/<id>/` of the instance, never committed.
- **FR-003** The engine's own text files (constitution, `specs/*/spec.md`, `docs/*.md`, the base
  dotfile layer `home/`, the prompt theme) travel as a generated module, `src/archon/assets.auto.ts`
  (`deno task gen`); a test fails when it is stale.
- **FR-004** The engine imports only full specifiers (relative paths, `npm:`, `jsr:`, `node:`,
  `https:`), because a fleet loads it by URL and the engine's import map does not apply there. Fleet
  files import the engine as `@stolos/archon/...`.
- **FR-005** A fleet repository runs the engine through its own entry files: `archon.ts`
  (`import { run } from "@stolos/archon/main.ts"; await run();`) and `boot.ts` (the same for
  `@stolos/archon-boot/main.ts`). The host launcher and the first boot run
  `deno run -A --frozen --config /srv/archon/deno.json /srv/archon/archon.ts`. The install writes
  `/etc/archon/fleet`.
- **FR-006** Boot-machine secrets are per fleet: `<config>/archon/secrets/<fleet>/`.
- **FR-007** The engine's version is `VERSION` in `src/archon/version.ts`, never in a configuration
  file. `deno task version bump` raises the minor number; every push to `main` raises it; CI
  (`.github/workflows/ci.yml`) checks that and tags the commit `v<version>`.
- **FR-008** The engine holds no fleet's facts: `tests/engine_test.ts` fails on a known fleet's
  names, domains, or identities, on a bare import specifier in `src/`, on JSON under `fleets/`, on
  agent-specific files (`CLAUDE.md`, `.claude/`), and on a generated TypeScript file whose name
  lacks `.auto.`.
- **FR-009** The agent layer names no particular agent: `archon build` renders `.mcp.json` (one
  stdio server per server host, over SSH as `ops`); each server limits its tools itself (Article
  17). Archon installs no agent on workstations.
- **FR-010** Instructions for people and agents are `AGENTS.md` only.

## Open

- `archon fleet init <id>` writing `fleets/<id>/`, `deno.json`, `archon.ts`, and `boot.ts` in a
  fleet repository (Phase 2).
- MCP server names per fleet (`archon-<fleet>-<host>`) and `fleet/host` names where a name is
  ambiguous.
- Providers as explicit choices in the model (site, mail, DNS, ACME, vault).

## Success Criteria

- **SC-001** `deno task test` passes, including `tests/engine_test.ts`; `deno task archon build`
  renders the lab.
- **SC-002** A fleet repository pinned to a tag builds its fleet with no engine file of its own.
