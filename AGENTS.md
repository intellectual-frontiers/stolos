# AGENTS.md: working in the engine

This repository is the fleet engine: the `archon` command, the boot server, and everything general
about turning bare metal into a converged, verified Ubuntu host. It holds no real fleet. Fleets live
in their own repositories (for example `shah/fleet`), under `fleets/<id>/`, and depend on this
engine by Git at a version tag:
`"@intellectual-frontiers/stolos": "github:intellectual-frontiers/stolos#v<version>"`, with the
commit and its integrity in `bun.lock`. A release is the tag alone: no GitHub release, no tarball,
no build. This file is the entry point for any agent; the constitution,
[`.specify/memory/constitution.md`](.specify/memory/constitution.md), governs everything here.

## Rules

- **Spec first.** Every change goes through Spec Kit: specify, clarify, plan, tasks, implement, in
  `specs/NNN-short-name/` (the prompts are in `.specify/commands/`, the templates in
  `.specify/templates/`). Commit subjects start with the spec ID (`046-engine-instance: ...`), or
  `constitution: ...`.
- **No fleet's facts here** (Article 24). Use the example lab (`examples/fleets/lab/`: hosts `alpha`
  and `beta`, `lab.example.net`, `10.0.0.0/16`, `alice`). `tests/engine_test.ts` fails on a leak.
- **Code over config** (Article 4). TypeScript for anything ours; no JSON in a fleet. Third-party
  formats are rendered, never edited.
- **Generated files are `.auto.`** (Article 26) and are never edited by hand. `bun run gen` writes
  `src/archon/assets.auto.ts` (the engine's docs, specs, constitution, and base dotfiles, carried as
  a module).
- **Bun and IFC TypeScript, no Deno** (spec 096). Relative imports with `.ts` inside `src/`;
  packages by their bare names from `package.json` (`@intellectual-frontiers/commons/ts/kernel`,
  `.../ts/runtime`, `ajv`); never `npm:`, `jsr:` or a URL. Commons is a Git dependency pinned by a
  full commit; on Node 26 an entry file runs with
  `node --import @intellectual-frontiers/commons/ts/node <file>`. `examples/` import the engine by its package
  name (`@intellectual-frontiers/stolos/archon/...`), as a fleet does. How each old call and module
  converts: [`specs/096-bun-runtime/mapping.md`](specs/096-bun-runtime/mapping.md).
- **Every push to `main` raises the version.** Run `bun run version bump` (0.1.0, 0.2.0, ...) in
  the same push; CI fails otherwise and tags the commit `v<version>` when it passes. The version
  lives in `src/archon/version.ts`; `package.json`'s follows it (`bun run version` writes both).
- **Name no particular agent.** Instructions are this file; the agent layer is MCP (`.mcp.json`
  rendered for a fleet), limited by each server (Article 17).
- **Never** put a secret, a token, or a person's data in this repository: it is public.
- **Document in the TypeScript** (spec 055). Every file starts with `/** … @module */`; every export
  has JSDoc; every `@example` compiles; a picture is a Mermaid block.
  `bun run docs` renders `out/docs/` with IFC Docs (`ifc-docs`, configured by `docs.config.ts`);
  `bun run docs:lint` (`ifc-docs check`, `tools/doc-examples.ts`) fails on an undocumented export,
  an unknown citation or link, or an example that does not compile.
- Write without em dashes: use commas, colons, parentheses, or separate sentences.

## Before you push (the whole procedure: [Changing and releasing the engine](https://intellectual-frontiers.github.io/stolos/latest/api/releasing/index.html))

Raise the version, then run exactly what CI runs, and push only when it passes:

```sh
bun run version bump
bun run gen
bun run ci       # fresh generated files, types, lint, format, tests, version newer than origin/main
```

Every commit's author is Shahid Shah, with the GitHub noreply address; an agent's part is a
`Co-Authored-By` trailer.

## Layout

```
src/archon/            the CLI: model, validator, capabilities, renderers, commands
src/archon/version.ts  the engine's version (raised on every push to main)
src/archon-boot/       the boot server (Windows or Linux)
home/                  the base dotfile layer (fleets add their own on top)
examples/fleets/lab/   the example fleet: what a fleet repository holds
specs/                 Spec Kit specifications, one per capability
src/**/mod.ts          the guides: each module's @module JSDoc (an area's overview on the site; hosts, man pages, stolos docs)
docs.config.ts         the documentation site's configuration (IFC Docs, from commons)
tools/                 generators and the version tool
tests/                 bun run test (ifc test); tests/e2e installs a VM end to end
```
