# Feature Specification: The engine and its fleets

**Feature Branch**: `046-engine-instance` (committed directly to main) **Created**: 2026-11-13
**Status**: In progress (the split, the lab, versioning: v0.1.0 to v0.2.0) **Input**: Make Archon a
general engine in a public repository (`intellectual-frontiers/stolos`) that any operator uses to
manage fleets on any network, while each operator's fleets (their model, site, hosts, and decisions)
live in a repository of their own (for example `example-org/fleet`), which imports the engine by version.
Constitution Articles 7, 24, 26.

## User Scenarios & Testing _(mandatory)_

1. **Given** the engine checked out, **When** a developer runs `bun run stolos build`, **Then** the
   example fleet (`examples/fleets/lab/`, hosts `alpha` and `beta`) validates and renders, with no
   real fleet's data anywhere in the repository.
2. **Given** a fleet repository whose `package.json` depends on the engine by Git at a tag
   (`"@intellectual-frontiers/stolos": "github:intellectual-frontiers/stolos#v0.1.0"`) and its
   `bun.lock`, which pins the tag's commit and its integrity, **When** an operator runs `bun run stolos build` there, **Then** the pinned
   engine builds the fleet's hosts.
3. **Given** a fleet repository with two fleets, **When** `archon` runs without `ARCHON_FLEET`,
   **Then** it says which fleets exist and how to choose one; with `ARCHON_FLEET=fcr` it uses
   `fleets/fcr/`.
4. **Given** a host installed from a fleet repository, **Then** `/etc/archon/fleet` names its fleet
   and its launcher runs the repository's `archon.ts` with the engine `bun.lock` holds, installed
   with `bun install --frozen-lockfile`.
5. **Given** a push to the engine's `main`, **Then** CI fails unless `src/archon/version.ts` is
   newer than before, and tags the commit `v<version>` when it passes.

## Requirements _(mandatory)_

- **FR-001** Two roots. The engine's root is where its modules were loaded from (a checkout, or the
  installed package's folder under `node_modules`). The instance (fleet repository) is
  `ARCHON_REPO`, else the nearest folder above the working directory holding `fleets/`, else
  `/srv/archon`, else an engine checkout's `examples/`. The fleet is `ARCHON_FLEET`, else
  `/etc/archon/fleet`, else the instance's only fleet (`src/archon/core/paths.ts`).
- **FR-002** Layout of a fleet: `fleets/<id>/fleet.ts` (its `id` equals the folder's name, checked
  at load), `site.ts`, `hosts/<host>/host.ts` (one folder per host), `specs/` (the fleet's own
  decisions, including `approve: destructive` lines), and dotfile layers. Rendered output goes to
  `out/<id>/` of the instance, never committed.
- **FR-003** The engine's own text files (constitution, `specs/*/spec.md`, `docs/*.md`, the base
  dotfile layer `home/`, the prompt theme) travel as a generated module, `src/archon/assets.auto.ts`
  (`bun run gen`); a test fails when it is stale.
- **FR-004** The engine imports its own modules by relative path (with `.ts`), `node:` builtins, and
  only the packages its `package.json` declares, by their bare names
  (`@intellectual-frontiers/commons/ts/...`, `ajv`; the PAM binding also `bun:ffi`), never `npm:`,
  `jsr:` or a URL. Fleet files import the engine by its package name, through the package's
  `exports`: `@intellectual-frontiers/stolos/archon/...`.
- **FR-005** A fleet repository runs the engine through its own entry files: `archon.ts`
  (`import { run } from "@intellectual-frontiers/stolos/archon/main"; await run();`) and `stolos.ts`
  (the same for `@intellectual-frontiers/stolos/stolos/main`, the boot server included as
  `stolos boot`). The first boot installs the engine with `bun install --frozen-lockfile`, and it
  and the host launcher run `bun /srv/archon/archon.ts` (Node 26 where Bun is not installed, with
  commons' hook: `node --import <the hook's file> /srv/archon/archon.ts`, spec 096 FR-007). The
  install writes `/etc/archon/fleet`.
- **FR-005a** The engine is installed whole: a fleet repository's `package.json` depends on the
  engine by Git at a tag (`github:intellectual-frontiers/stolos#v<version>`), and `bun.lock` pins
  the commit the tag named and the integrity of its archive, so every module the engine may load on
  demand is the one locked; a tag moved later changes nothing a fleet installs. There is no GitHub
  release of the engine (spec 096 FR-005). `bun install --frozen-lockfile` installs exactly that, or
  stops on an integrity error (`E046-LOCK-INTEGRITY`). A fleet repository that is not on GitHub
  (`repository.url` elsewhere) is cloned from its URL at first boot.
- **FR-005b** `archon fleet upgrade <tag>` (repo tier, never over MCP) is the only way a fleet
  repository changes its engine: the tag must be a version tag of the engine's repository (the
  package installed at it says the same version), newer than the pin unless `--downgrade`, and the
  tree clean; it rewrites the pin (the tag after `#` in the `github:` dependency of `package.json`),
  runs `bun install` so that `bun.lock` pins that tag's commit and its integrity, validates every
  fleet with the new engine in its own process, and makes one signed commit of `package.json` and
  `bun.lock` (with the files the engine refreshes: the bootstrap scripts, `.gitattributes`, the
  compliance-impact workflow, and the engine's reusable workflows moved to the same tag). On any
  failure nothing is committed and the pin and the lock are put back. Documented in the fleet
  repository's guide (`src/archon/fleet/mod.ts`); engine releases in `src/releasing.ts`.
- **FR-006** Boot-machine secrets are per fleet: `<config>/stolos/secrets/<fleet>/` (a provider's client, spec 082:
  `<config>/stolos/clients/<client>/secrets/<fleet>/`).
- **FR-007** The engine's version is `VERSION` in `src/archon/version.ts`; `package.json`'s
  `version` follows it (`bun run version` writes both, and its `check` fails where they differ).
  `bun run version bump` raises the minor number; every push to `main` raises it; CI
  (`.github/workflows/ci.yml`) checks that and tags the commit `v<version>`.
- **FR-008** The engine holds no fleet's facts: `tests/engine.test.ts` fails on a known fleet's
  names, domains, or identities, on an import in `src/` that is not relative, `node:`, or a package
  `package.json` declares, on JSON under `fleets/`, on agent-specific files (`CLAUDE.md`,
  `.claude/`), and on a generated TypeScript file whose name lacks `.auto.`.
- **FR-009** The agent layer names no particular agent: `archon build` renders `.mcp.json` (one
  stdio server per server host, over SSH as `ops`); each server limits its tools itself (Article
  17). Archon installs no agent on workstations.
- **FR-010** Instructions for people and agents are `AGENTS.md` only.
- **FR-011** `archon fleet init <id>` creates `fleets/<id>/` and, in a repository without them,
  `package.json` pinned to the running engine's tag (`github:` at `v<version>`), `archon.ts`,
  `stolos.ts`,
  `.gitignore`, and `bun.lock` (written by `bun install`); it never overwrites a file.
  `--fleet <id>` (or `ARCHON_FLEET`) chooses the fleet of a repository holding several, for `archon`
  and the boot server.
- **FR-012** MCP servers are named `archon-<fleet>-<host>`. The repository has one `.mcp.json`; a
  fleet's build replaces only its own servers' entries and keeps the other fleets'.

## Open

- Providers as explicit choices in the model (site, mail, DNS, ACME, vault).

## Success Criteria

- **SC-001** `bun run test` passes, including `tests/engine.test.ts`; `bun run stolos build` renders
  the lab.
- **SC-002** A fleet repository pinned to a tag builds its fleet with no engine file of its own.
- **SC-004** `tests/upgrade.test.ts`: an upgrade against a local Git copy of the engine locks the
  tag's commit, validates, and signs exactly the pin, the lock, and the files the engine refreshes;
  a tag whose package says another version, an unknown tag, an older version, and a dirty tree are
  refused with nothing changed.
- **SC-003** `.github/workflows/e2e.yml` (`tests/e2e/ci.sh`): a throwaway fleet, signed, served with
  this checkout of the engine; a blank Secure Boot VM installs to the event `boot.ready`;
  `archon fleet query` answers from it.
