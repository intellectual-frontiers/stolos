# 055: Documentation from the TypeScript

## Why

Documentation is how the next person (or the same one, a year later) runs a fleet. Everything here
is TypeScript, so the documentation lives in it: JSDoc on every module and export, rendered to HTML
by `deno doc`, checked by `deno doc --lint`, with diagrams where a picture says it faster.

## Requirements

- **FR-001** Every engine module starts with a `/** … @module */` block (a test). Every exported
  symbol gets JSDoc; `deno doc --lint`'s count may only go down (`tools/doc-baseline.ts`, checked in
  CI; `deno task docs:baseline` lowers it), until it is zero and becomes a hard gate.
- **FR-002** Every `@example` is TypeScript that compiles: `deno check --doc src/` in CI.
- **FR-003** Diagrams are Mermaid blocks in JSDoc (flowchart, sequence, state, class): `deno doc`
  renders them as code; `deno task docs` draws them with a pinned Mermaid (its SHA-256 checked
  before use), light or dark as the page. A test checks each block's kind.
- **FR-004** `deno task docs` writes the HTML to `out/docs/` (never committed): an overview module
  (`src/mod.ts`) with the architecture in diagrams, and a front page that lists every module by
  folder with its first sentence.
- **FR-005** Each release's HTML is published by CI to the `gh-pages` branch: `/vX.Y.Z/`,
  `/latest/`, the newest 20 kept. GitHub Pages serves that branch (a repository setting, once).
- **FR-006** A fleet repository's own documentation stays local (its repository is private).

## Success criteria

- **SC-001** `tests/docs055_test.ts`.
- **SC-002** Every diagram draws in a browser (checked with Chromium on the first build: 20 diagrams
  on 17 pages).

## Next

- Phase 4: JSDoc on every exported symbol, in batches (the model and capabilities first), until the
  baseline is zero.
- Phase 5: the files archon writes into a fleet repository (fleet.ts, host.ts, registration.ts,
  signers.ts, decisions.ts) carry JSDoc, with a one-time migration of the fixed forms, proven on the
  synthetic fleet; `deno task docs` in a fleet repository.
