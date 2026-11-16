# 055: Documentation from the TypeScript

## Why

Documentation is how the next person (or the same one, a year later) runs a fleet. Everything here
is TypeScript, so the documentation lives in it: JSDoc on every module and export, rendered to HTML
and checked by IFC Docs (`ifc-docs`, commons 0011-documentation, from commons' package; spec 096
FR-009), configured by `docs.config.ts`, with diagrams where a picture says it faster.

## Requirements

- **FR-001** Every engine module starts with a `/** … @module */` block (a test, and the lint rule
  `ifc/module-doc`). Every exported symbol has JSDoc: `bun run docs:lint` (`ifc-docs check`, in CI)
  fails on an undocumented export of any area `docs.config.ts` gives, and every module of `src/` is
  in an area.
- **FR-002** Every `@example` is TypeScript that compiles: `tools/doc-examples.ts` type-checks each
  one with `tsc` and the repository's strict configuration, in CI (`bun run docs:lint`).
- **FR-003** Diagrams are Mermaid blocks in JSDoc (flowchart, sequence, state, class): IFC Docs
  draws them with the Mermaid its package pins (`bun.lock` holds its integrity), served by the site
  itself. A test checks each block's kind.
- **FR-004** `bun run docs` (`ifc-docs build`) writes the HTML to `out/docs/` (never committed): a
  home page, the overview module (`src/mod.ts`) with the architecture in diagrams as the first area,
  each guide as an area's overview, the API of every module by area, and every specification of
  `specs/` with the constitution.
- **FR-005** Each release's HTML (`ifc-docs build`) is published by CI to the `gh-pages` branch:
  `/vX.Y.Z/`, `/latest/`, the newest 20 kept. GitHub Pages serves that branch (a repository
  setting, once).
- **FR-006** A fleet repository's own documentation stays local (its repository is private).

## Success criteria

- **SC-001** `tests/docs055.test.ts`.
- **SC-002** Every diagram draws in a browser (checked with Chromium on the first build: 20 diagrams
  on 17 pages).

## Next

- Phase 5: the files archon writes into a fleet repository (fleet.ts, host.ts, registration.ts,
  signers.ts, decisions.ts) carry JSDoc, with a one-time migration of the fixed forms, proven on the
  synthetic fleet; `bun run docs` in a fleet repository.
