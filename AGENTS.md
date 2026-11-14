# AGENTS.md: working in the engine

This repository is the fleet engine: the `archon` command, the boot server, and everything general
about turning bare metal into a converged, verified Ubuntu host. It holds no real fleet. Fleets live
in their own repositories (for example `shah/fleet`), under `fleets/<id>/`, and import this engine
as `@stolos/` from a tagged GitHub URL. This file is the entry point for any agent; the
constitution, [`.specify/memory/constitution.md`](.specify/memory/constitution.md), governs
everything here.

## Rules

- **Spec first.** Every change goes through Spec Kit: specify, clarify, plan, tasks, implement, in
  `specs/NNN-short-name/` (the prompts are in `.specify/commands/`, the templates in
  `.specify/templates/`). Commit subjects start with the spec ID (`046-engine-instance: ...`), or
  `constitution: ...`.
- **No fleet's facts here** (Article 24). Use the example lab (`examples/fleets/lab/`: hosts `alpha`
  and `beta`, `lab.example.net`, `10.0.0.0/16`, `alice`). `tests/engine_test.ts` fails on a leak.
- **Code over config** (Article 4). TypeScript for anything ours; no JSON in a fleet. Third-party
  formats are rendered, never edited.
- **Generated files are `.auto.`** (Article 26) and are never edited by hand. `deno task gen` writes
  `src/archon/assets.auto.ts` (the engine's docs, specs, constitution, and base dotfiles, carried as
  a module).
- **Full import specifiers in `src/`** (`npm:...@x.y.z`, relative paths): a fleet loads the engine
  by URL, so the engine's own import map does not apply there (so the lint rule `no-import-prefix`
  is off).
- **Every push to `main` raises the version.** Run `deno task version bump` (0.1.0, 0.2.0, ...) in
  the same push; CI fails otherwise and tags the commit `v<version>` when it passes. The version
  lives only in `src/archon/version.ts`.
- **Name no particular agent.** Instructions are this file; the agent layer is MCP (`.mcp.json`
  rendered for a fleet), limited by each server (Article 17).
- **Never** put a secret, a token, or a person's data in this repository: it is public.
- **Document in the TypeScript** (spec 055). Every file starts with `/** … @module */`; every export
  has JSDoc; every `@example` compiles (`deno check --doc`); a picture is a Mermaid block.
  `deno task docs` renders `out/docs/`; `deno task docs:lint` may only go down.
- Write without em dashes: use commas, colons, parentheses, or separate sentences.

## Before you push (the whole procedure: [docs/releasing.md](docs/releasing.md))

Raise the version, then run exactly what CI runs, and push only when it passes:

```sh
deno task version bump
deno task gen
deno task ci     # fresh generated files, types, lint, format, tests, version newer than origin/main
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
docs/                  guides (served on each host, and as man pages)
tools/                 generators and the version tool
tests/                 deno task test; tests/e2e installs a VM end to end
```
