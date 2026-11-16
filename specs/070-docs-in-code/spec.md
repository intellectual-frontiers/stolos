# 070: The guides are module documentation, beside the code

## Why

Guides in a separate `docs/` folder drift from the code they describe: a command is renamed, a flag
goes away, and the guide keeps saying the old thing. The engine's reference is already its JSDoc,
rendered by IFC Docs (spec 055). The guides belong there too, in the folder of the code they
explain, where a change to one is seen beside the other, and tests can check them.

## Requirements

- **FR-001** Each guide is the `@module` JSDoc of a module in the folder whose code it explains
  (`src/archon/pg/mod.ts` for PostgreSQL, `src/archon/vault/mod.ts` for disaster recovery, ...);
  `src/archon/core/guides.ts` lists them (name, title, purpose, module). There is no `docs/` folder.
- **FR-002** IFC Docs (`bun run docs`, spec 055) renders them, with their Mermaid diagrams, on
  GitHub Pages: `docs.config.ts` makes each guide's module the first entry point of an area, so the
  guide is that area's overview (`api/<area>/index.html`, the area named by `docsArea` of
  `core/guides.ts`); links between guides are relative links to each other's module and go to its
  page; a guide's links to other repository files go to GitHub.
- **FR-003** `bun run gen` extracts each guide into the engine's assets as `docs/<name>.md`, so the
  man pages, the welcome page, both consoles, and `explain` read the same text offline.
- **FR-004** `stolos docs [name]` and `archon docs [name]` list the guides with their pages online,
  or print one in the terminal (diagrams: a link). Messages point to `bun run stolos docs <name>`.
- **FR-005** Tests: each guide's module exists and its extraction is what the assets carry; every
  link between guides reaches a guide and a heading; every `archon ...` or `bun run stolos ...`
  command a guide names exists (the boot server's commands included).
