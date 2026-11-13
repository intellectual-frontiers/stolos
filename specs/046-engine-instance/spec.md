# Feature Specification: The engine and its fleets

**Feature Branch**: `046-engine-instance` (committed directly to main) **Created**: 2026-11-13
**Status**: In progress (the split, the lab, versioning: v0.1.0 to v0.2.0) **Input**: Make Archon a
general engine in a public repository (`intellectual-frontiers/stolos`) that any operator uses to
manage fleets on any network, while each operator's fleets (their model, site, hosts, and decisions)
live in a repository of their own (for example `shah/fleet`), which imports the engine by version.
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
- **FR-005a** Every engine module is named statically in the generated `src/archon/modules.auto.ts`;
  a fleet repository's `engine.ts` (`import "@stolos/archon/modules.auto.ts";`) is cached with its
  entry files (`deno cache --lock=deno.lock archon.ts boot.ts engine.ts`), so `deno.lock` pins every
  module the engine may load on demand, and `--frozen` never meets an unlocked one. A fleet
  repository that is not on GitHub (`repository.url` elsewhere) is cloned from its URL at first
  boot.
- **FR-005b** `archon fleet upgrade <tag>` (repo tier, never over MCP) is the only way a fleet
  repository changes its engine: the tag must be a release (`src/archon/version.ts` at that tag says
  the same version), newer than the pin unless `--downgrade`, and the tree clean; it rewrites the
  pin, rebuilds `deno.lock` through `engine.ts`, validates every fleet with the new engine in its
  own process (`--frozen`), and makes one signed commit of `deno.json`, `deno.lock`, and
  `engine.ts`. On any failure nothing is committed and the pin is put back. Documented in
  `docs/fleet-repository.md`; engine releases in `docs/releasing.md`.
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
- **FR-011** `archon fleet init <id>` creates `fleets/<id>/` and, in a repository without them,
  `deno.json` pinned to the running engine's release, `archon.ts`, `boot.ts`, `engine.ts`,
  `.gitignore`, and `deno.lock`; it never overwrites a file. `--fleet <id>` (or `ARCHON_FLEET`)
  chooses the fleet of a repository holding several, for `archon` and the boot server.
- **FR-012** MCP servers are named `archon-<fleet>-<host>`. The repository has one `.mcp.json`; a
  fleet's build replaces only its own servers' entries and keeps the other fleets'.

## Open

- Providers as explicit choices in the model (site, mail, DNS, ACME, vault).

## Success Criteria

- **SC-001** `deno task test` passes, including `tests/engine_test.ts`; `deno task archon build`
  renders the lab.
- **SC-002** A fleet repository pinned to a tag builds its fleet with no engine file of its own.
- **SC-004** `tests/upgrade_test.ts`: an upgrade against a local copy of the engine locks modules
  loaded on demand, validates, and signs exactly three files; a tag that is not a release, an
  unknown tag, an older version, and a dirty tree are refused with nothing changed.
- **SC-003** `.github/workflows/e2e.yml` (`tests/e2e/ci.sh`): a throwaway fleet, signed, served with
  this checkout of the engine; a blank Secure Boot VM installs to the event `boot.ready`;
  `archon fleet query` answers from it.
