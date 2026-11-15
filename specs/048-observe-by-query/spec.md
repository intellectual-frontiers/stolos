# Feature Specification: Each machine keeps its own state; observe it by query

**Feature Branch**: `048-observe-by-query` (committed directly to main) **Created**: 2026-11-13
**Status**: In progress (v0.4.0: archon.sql, archon query, fleet query, read-only hosts) **Input**:
Constitution Articles 17 and 25. Hosts stop writing to Git: what a machine recorded about itself
stays on it, canonically as readable SQL (`archon.sql`), from which `archon.auto.sqlite.db` is built
for osquery. Operators and agents read machines live over SSH through each server's MCP server,
which limits what it answers.

## User Scenarios & Testing _(mandatory)_

1. **Given** a host after its first boot, **Then** `/var/lib/archon/archon.sql` holds its install
   record (readable: a header, the schema, one `INSERT` per record) and `archon.auto.sqlite.db` was
   built from it; nothing was committed or pushed.
2. **Given** a host, **When** an operator runs `archon query "select * from archon_verify"`,
   **Then** osquery answers from Archon's tables next to its own;
   `archon query "select * from shadow"` is refused.
3. **Given** the boot machine, **When** the operator runs `archon fleet status`, **Then** each
   server is asked live over MCP (`archon_state`); an unreachable one is shown with what it said
   last.
4. **Given** the boot machine, **When** the operator runs
   `archon fleet query "select name, version from deb_packages where name = 'openssh-server'"`,
   **Then** every server answers in one table with a machine column.
5. **Given** a new host, **Then** its deploy key is read-only: it can fetch the fleet repository and
   never push.
6. **Given** a person edits `archon.sql` by hand, **Then** the next write keeps their records (it
   loads the file) and `archon.auto.sqlite.db` follows it.

## Requirements _(mandatory)_

- **FR-001** The state store (`src/archon/state/store.ts`): records
  `(host, kind, name, at, body JSON)` with kinds `install`, `verify`, `prov`, `optin`; views
  `archon_install`, `archon_verify`, `archon_prov`, `archon_optin` give each its columns. Every
  write loads `archon.sql` into an in-memory SQLite (`node:sqlite`), changes it, writes `archon.sql`
  in a fixed order (atomically), and rebuilds `archon.auto.sqlite.db` from it. Provenance keeps the
  newest 500 records per host.
- **FR-002** Where: an installed machine (`/etc/archon/host` exists) uses `/var/lib/archon`; the
  boot machine and workstations use their user data, per fleet (`<data>/stolos/state/<fleet>/`), as
  a cache of what servers last said.
- **FR-003** The install record (first boot), the latest verify, provenance (each apply), and the
  operators' switches (pg, s3, smb, with their data class) are written to the store; verify checks
  of opt-in units are rendered from the host's own records.
- **FR-004** osquery's configuration declares Archon's views as tables (automatic table
  construction) over `/var/lib/archon/archon.auto.sqlite.db`.
- **FR-005** `archon query <sql>` (read): one `SELECT` or `WITH`, only tables on the allowlist
  (never `shadow`, `process_envs`, `curl`, `curl_certificate`, `carves`, `yara`, `augeas`, `file`,
  `hash`, `magic`, `docker_container_envs`, which are also disabled in osqueryi), at most 1000 rows,
  20 seconds.
- **FR-006** `archon state` (read): this machine's install, latest verify, switches, and data class,
  as text or `--json`. `archon fleet status` asks each server for it over MCP (ssh as ops,
  newline-delimited JSON-RPC) and caches each answer.
- **FR-007** `archon fleet query <sql>` (read, not over MCP): `archon_query` on every server in
  parallel (and adopted machines through their probe, spec 067); one table with a machine column;
  unreachable machines named.
- **FR-008** `archon push` is gone; `archon capture` reports drift and writes nothing;
  `archon update` blocks on any local change in the checkout (hosts record nothing there);
  `boot reinstall` no longer pushes; deploy keys are registered read-only.

## Open

- Operators' decisions (opt-ins and their data class) made on the workstation and committed
  (`decisions.ts`, spec 047), so they survive a re-install and the class is known when a host is
  offline.
- The trace context passed in MCP calls (`_meta.traceparent`, spec 049).

## Success Criteria

- **SC-001** `tests/state.test.ts`: `archon.sql` is canonical, ordered, idempotent, quoted; the
  SQLite file follows it, including a hand edit; the query allowlist refuses what it must; osquery's
  tables point at the `.auto.` file.
