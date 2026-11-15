# 093: The estate graph as osquery tables

Issue intellectual-frontiers/stolos#30.

## Why

Spec 090 writes the estate graph as canonical SQL (`estate.sql`) and as a SQLite file made from it
(`estate.auto.sqlite.db`). osquery can already read a SQLite file as tables through its Automatic
Table Construction (ATC), with no extension and no new process. Generating that configuration from
the schema's declarations makes every estate table and view an osquery table, so osquery can join
the estate (who owns this machine, which accounts a leaver still has) with what it sees on a
machine.

## Decisions (the owner's)

- The canonical artifact stays `estate.sql`; `estate.auto.sqlite.db` (made from it) is what ATC
  reads.
- No Thrift extension: left out until the owner approves one.

## Requirements

- **FR-001** `src/archon/estate/osquery.ts` generates the ATC configuration from `ESTATE_SCHEMA`:
  one osquery table per estate table and view, named `stolos_<name>`, with `query` =
  `SELECT <declared columns> FROM <name>`, `path` = the absolute path of `estate.auto.sqlite.db`,
  `columns` = the declared columns in order, and `platform` = `darwin,linux,windows` (osquery
  matches it by substring).
- **FR-002** `stolos estate build` writes it as `estate.osquery.json` next to the database.
  `stolos estate osquery [--print]` (tier read) writes it, or prints it, and says how to load it:
  `osqueryi --config_path <file>`, an existing osqueryd configuration (merge the
  `auto_table_construction` object), or a fleet manager.
- **FR-003** osquery reads the SQLite file without locks, so the file is built in a temporary file
  and renamed over the old one (atomic on one file system); the configuration is written the same
  way.
- **FR-004** ATC reserves the column name `path` (it adds its own: the file each row came from). The
  generator exposes a reserved estate column as `estate_<name>` in osquery only (an alias in
  `query`); the estate's own names never change. No current estate column is reserved.
- **FR-005** Every column is TEXT in osquery: integers and booleans arrive as decimal text, NULL as
  an empty value. The docs say so.
- **FR-006** Docs: the estate section of `src/archon/adopt/mod.ts` and the module doc of
  `src/archon/estate/commands.ts`, each with a Mermaid diagram.

## Tests

`tests/osquery093.test.ts`: the configuration covers every table and view with exactly its declared
columns and the right path; its JSON has exactly the ATC keys; a reserved column is aliased; and,
when `osqueryi` is installed, `osqueryi --config_path <generated> --json` returns, for
`stolos_device`, `stolos_user_account`, `stolos_person`, and `stolos_compliance_finding`, the same
rows as `estateQuery` on a fixture estate. CI (the `check` job) installs osquery from its official
package repository at a pinned version and SHA-256 (a binary package; never built from source) and
sets `STOLOS_REQUIRE_OSQUERY`, so the integration test cannot be skipped there.
