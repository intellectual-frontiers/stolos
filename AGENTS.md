# AGENTS.md: working in the engine

This repository is the fleet engine: the `archon` command, the boot server, and everything general
about turning bare metal into a converged, verified Ubuntu host. It holds no real fleet. Fleets live
in their own repositories (for example `example-org/fleet`), under `fleets/<id>/`, and depend on this
engine by Git at a version tag:
`"@intellectual-frontiers/stolos": "github:intellectual-frontiers/stolos#v<version>"`, with the
commit and its integrity in `bun.lock`. A release is the tag alone: no GitHub release, no tarball,
no build. This file is the entry point for any agent; the constitution,
[`.specify/memory/constitution.md`](.specify/memory/constitution.md), governs everything here.

## Rules

- **Climb the ladder, lowest rung first** (constitution Article 0, `101-ladder`): 0 ontology,
  1 specifications, 2 governed data, 3 data operations, 4 infrastructure rules, 5 business rules,
  6 application (headless hosts, then windowed hosts), 7 documentation (the layout below). A rung
  relies only on the rungs below it that it names and never reaches around the rung under it; a
  change is complete only when every rung it touches is updated and proved by that rung's checks,
  in order. `bun run check:layers` holds the direction of every relative import.
- **Ontology terms before specs use them.** The ontology is TypeScript on commons' kernel RDF
  (`ontology/stolos/`): define a term there, citing its spec in its `spec` field, before a
  specification names it (`stolos:Controller`); the two are drafted and committed together, then
  the code. A word the code branches on is a code list there, and the code imports its union
  from `src/archon/ontology.auto.ts` (`bun run gen`) instead of writing the words again.
  `bun run check:ontology` fails on a stale generated file and on a `stolos:` term a spec names
  that the ontology does not define.
- **Spec Kit, fully.** Every change goes through specify, clarify, plan, tasks, implement, in
  `specs/NNN-short-name/` (`spec.md`, `plan.md`, `tasks.md`; the prompts are in
  `.specify/commands/`, the templates in `.specify/templates/`). Commit subjects start with the
  spec ID (`046-engine-instance: ...`), or `constitution: ...`.
- **Every source file names its requirements** on a line after its `@module` JSDoc:
  `// Spec: NNN-short-name FR-001, FR-003 to FR-005` (several lines and several specs, `;`
  between, are allowed; `// Spec: NNN-short-name` cites a whole spec). Every test names what it
  proves with `proves(["NNN-short-name FR-NNN", ...], ...)` (literal ids, or a `const` of the same
  file; never ids built at run time), or a `// Proves:` line. A requirement no test can prove is
  listed in its spec's `reviewed.tsv` with the reason. `bun run check:trace` holds all of it,
  and every ontology term's spec too.
- **The checks' baselines only shrink.** `tools/trace.baseline.txt` and
  `tools/layers.baseline.txt` hold the findings that existed when each check was first held.
  A new finding fails the check, and so does a line of a baseline that no longer occurs: when
  you fix one (add a `Spec:` line, move an import), delete its line from the baseline (or run
  `bun tools/trace.ts --write-baseline` / `bun tools/layers.ts --write-baseline` and check the
  diff only removes lines). Never add a line to make a check pass.
- **Headless first** (Article 0). Rungs 0 to 5 are headless; every action a console offers is
  also a command of the one registry and an MCP tool where its tier allows; a console holds no
  logic, it draws a model and calls operations; write the headless operation and its test before
  the console action that uses it.
- **No fleet's facts here** (Article 24). Use the example lab (`examples/fleets/lab/`: hosts `alpha`
  and `beta`, `lab.example.net`, `10.0.0.0/16`, `alice`). `tests/engine_test.ts` fails on a leak.
- **Code over config** (Article 4). TypeScript for anything ours; no JSON in a fleet. Third-party
  formats are rendered, never edited.
- **Generated files are `.auto.`** (Article 26) and are never edited by hand. `bun run gen` writes
  `src/archon/assets.auto.ts` (the engine's docs, specs, constitution, and base dotfiles, carried as
  a module), and, from the ontology, `ontology/stolos.auto.ttl`, `src/archon/ontology.auto.ts`, the
  constitution's ladder table and this file's layout (between their marker comments).
- **Bun and IFC TypeScript** (spec 096): Bun is the default TypeScript 7 runtime, Node 26 the backup. Relative imports with `.ts` inside `src/`;
  packages by their bare names from `package.json` (`@intellectual-frontiers/commons/ts/kernel`,
  `.../ts/runtime`, `ajv`); never `npm:`, `jsr:` or a URL. Commons is a Git dependency pinned by a
  full commit; on Node 26 an entry file runs with
  `node --import @intellectual-frontiers/commons/ts/node <file>`. `examples/` import the engine by its package
  name (`@intellectual-frontiers/stolos/archon/...`), as a fleet does.
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
bun run ci       # fresh generated files, types, lint, format, docs, the ontology, trace and layers
                 # checks, tests, version newer than origin/main
```

Every commit's author is Shahid Shah, with the GitHub noreply address; an agent's part is a
`Co-Authored-By` trailer.

## Layout

Every folder of `src/`, every top-level folder and every file of the root is on one rung of the
ladder (constitution Article 0); the ontology says which (`ontology/stolos/architecture.ts`,
`101-ladder`), `bun run gen` writes it here and into the constitution, and `bun run check:layers`
fails for a file that is on none or two. Of the homes that match a path, one path beats every
glob, a glob naming files beats a folder, and among the rest the longer wins.

<!-- layout:begin -->

- **0 Ontology** (relies on nothing): `ontology/`, `src/archon/ontology.auto.ts`. Terms, classes and code lists, stated once as TypeScript on commons' kernel RDF; Turtle and the code's unions are generated from it.
- **1 Specifications** (relies on 0): `.specify/`, `specs/`. What each part must do, in Spec Kit (specify, clarify, plan, tasks, implement), using only terms the ontology defines.
- **2 Governed data** (relies on 0, 1): `src/archon/model/types.ts`, `src/archon/model/site.ts`, `src/archon/estate/schema.ts`, `src/archon/schema/`, `src/archon/ocsf/classes.ts`. The shapes of what is kept: the fleet model's types and the site's, the estate's tables and the schema language and vocabulary they are declared in.
- **3 Data operations** (relies on 0 to 2): `src/archon/model/`, `src/archon/state/`, `src/archon/estate/`, `src/archon/vault/`. Work as close to the data as possible: the model loaded and validated, the state store (archon.sql), the estate graph and the vault.
- **4 Infrastructure rules** (relies on 0, 1, 3): `src/archon/core/`, `src/archon/identity/`, `src/archon/install/`, `src/archon/web/`, `src/archon/telemetry/`, `src/archon/version.ts`, `src/archon/assets.auto.ts`, `.gitattributes`, `.gitignore`, `.vscode/`, `bun.lock`, `bunfig.toml`, `package.json`, `tsconfig.json`. Logic every part reuses, neutral to any one service: the core (output, paths, exec, secrets), identity and keys, install, the web front door, telemetry's names, and the use of commons.
- **5 Business rules** (relies on 0, 1, 3, 4): `src/archon/access/`, `src/archon/adopt/`, `src/archon/apply/`, `src/archon/audit/`, `src/archon/backup/`, `src/archon/build.ts`, `src/archon/capabilities/`, `src/archon/capabilities/mod.ts`, `src/archon/clients/`, `src/archon/compliance/`, `src/archon/connect/`, `src/archon/containers/`, `src/archon/controls/`, `src/archon/device/`, `src/archon/doctor/`, `src/archon/dotfiles/`, `src/archon/evidence/`, `src/archon/export/`, `src/archon/fedramp/`, `src/archon/fleet/`, `src/archon/guests/`, `src/archon/guide/`, `src/archon/notify/`, `src/archon/observe/`, `src/archon/ocsf/`, `src/archon/optin/`, `src/archon/otelui/`, `src/archon/people/`, `src/archon/personas/`, `src/archon/personas/mod.ts`, `src/archon/pg/`, `src/archon/proposal/`, `src/archon/prov/`, `src/archon/reconcile/`, `src/archon/render/`, `src/archon/report/`, `src/archon/risk/`, `src/archon/s3/`, `src/archon/shell/`, `src/archon/smb/`, `src/archon/tools/`, `src/archon/trust/`, `src/archon/update/`, `home/`. The engine's own logic: capabilities and what they render, compliance and controls, adopt and pair, access, update, proposals and the other services.
- **6 Application: headless hosts, then windowed hosts** (relies on 0, 1, 4, 5): `src/stolos/`, `src/archon/main.ts`, `src/archon/commands/`, `src/archon/mcp/`, `src/archon/api/`, `src/archon-boot/`, `bin/`, `tools/`, `.github/`, `src/archon/console/`, `vendor/`. Two bands: the headless hosts (the stolos and archon command lines and their registry, the MCP server, the REST API, the boot server, the bootstrap scripts and the harness's tools), which reach the operations below with no window, session or person present; then the windowed hosts (the Archon and Stolos consoles), which draw a model and call those operations.
- **7 Documentation** (relies on 0 to 6): `src/**/mod.ts`, `src/releasing.ts`, `src/archon/connect/registry-guide.ts`, `src/archon/install/workstation-guide.ts`, `docs/`, `docs.config.ts`, `examples/`, `tests/`, `AGENTS.md`, `LICENSE`, `LICENSING.md`, `README.md`. The guides (each module's @module documentation, src/**/mod.ts first), docs/, the manuals site (docs.config.ts), the example fleet, this repository's own documents, and the tests that prove every rung below.

<!-- layout:end -->

The parts, by folder:

```
src/archon/            the CLI: model, validator, capabilities, renderers, commands
src/archon/version.ts  the engine's version (raised on every push to main)
src/archon-boot/       the boot server (Windows or Linux)
home/                  the base dotfile layer (fleets add their own on top)
examples/fleets/lab/   the example fleet: what a fleet repository holds
specs/                 Spec Kit specifications, one per capability (spec.md, plan.md, tasks.md)
ontology/stolos/       the ontology: terms, code lists and the ladder, TypeScript on commons' RDF
src/**/mod.ts          the guides: each module's @module JSDoc (an area's overview on the site; hosts, man pages, stolos docs)
docs.config.ts         the documentation site's configuration (IFC Docs, from commons)
tools/                 generators, the version tool, and the checks (ontology, trace, layers)
tests/                 bun run test (ifc test); tests/e2e installs a VM end to end
```
