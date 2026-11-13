# Feature Specification: SQL over infrastructure

**Feature Branch**: `042-sql` (committed directly to main) **Created**: 2026-11-12 **Status**:
Implemented **Input**: Add the official osquery and similar infrastructure querying utilities (SQL
over infra). Decisions: Steampipe on workstations only; osquery is infrastructure, always installed
and operational, with its standard port open in the firewall; CloudQuery, trdsql, q, csvkit, and
`sq` are left out.

## User Scenarios & Testing _(mandatory)_

1. **Given** any host, **When** an operator runs `sudo osqueryi`, **Then** they query the machine in
   SQL (processes, listening ports, users, sudoers, SSH keys, packages, systemd units).
2. **Given** any host, **Then** `osqueryd` runs, executes Archon's scheduled queries, and logs what
   changed to `/var/log/osquery`.
3. **Given** any host, **When** someone runs `duckdb`, **Then** they query CSV, JSON, and Parquet
   files, their S3 buckets (spec 041), and PostgreSQL instances (spec 038) in SQL; `jc` turns
   command output into JSON for it.
4. **Given** a workstation, **When** the operator runs `steampipe`, **Then** they query GitHub,
   cloud, DNS, and certificate APIs with their own credentials.

## Requirements _(mandatory)_

- **FR-001** osquery on every host (servers and workstations) from osquery's own apt repository
  (`https://pkg.osquery.io/deb`, suite `deb`, component `main`), signed with osquery's key pinned in
  the repository (`src/archon/tools/keys/osquery.ts`, fingerprint
  `1484120AC4E9F8A1A577AEEE97A80C63C9D8B80B`, from keyserver.ubuntu.com, matching osquery's
  published fingerprint); apt and unattended-upgrades keep it current. Not in Ubuntu 26.04's
  archive.
- **FR-002** `osqueryd` is infrastructure: installed, enabled, and running on every host (the
  package's own unit). Archon renders `/etc/osquery/osquery.flags` (filesystem logger in
  `/var/log/osquery`, rotated at 25 MiB, 10 files; database in `/var/osquery`; host identifier the
  host name; event tables off, so no kernel audit subscription; the watchdog on) and
  `/etc/osquery/osquery.conf` (Archon's schedule, differential results: listening ports by process
  every 15 minutes, logged-in users every 5, users, sudoers, SSH authorized keys, and kernel modules
  hourly, failed systemd units every 10 minutes, Debian packages daily). A change to either restarts
  it. The package puts `osqueryi` on the PATH.
- **FR-003** No port: `osqueryd` listens on no TCP or UDP port (its only socket is a local Unix
  socket for extensions; the ports associated with osquery belong to a separate management server,
  such as Fleet, which Archon does not run). The firewall therefore opens nothing for it: an open
  port with nothing behind it only widens the firewall. A central osquery server would be an opt-in
  container (spec 040) with its own port.
- **FR-004** DuckDB on every host: the official CLI from its GitHub release
  (`duckdb-cli-linux-amd64.tar.gz`; 1.x `duckdb_cli-linux-amd64.zip`), checked against the release's
  published SHA-256. Its extensions (`httpfs` for S3, `postgres`) are downloaded on first use and
  signature-checked by DuckDB.
- **FR-005** `jc` and `sqlite3` on every host, from Ubuntu's archive.
- **FR-006** Steampipe on workstations only, from its GitHub release
  (`steampipe_linux_amd64.tar.gz`), checked against the release's SHA-256: it asks APIs with the
  operator's own credentials, and secrets stay off servers. Its first run downloads its embedded
  PostgreSQL and plugins into the user's home.
- **FR-007** Left out: CloudQuery (a data pipeline into a database, its plugin hub needs a login),
  trdsql, q, csvkit (DuckDB covers them), and neilotoole's `sq` (its command name is Ubuntu's
  Sequoia OpenPGP tool).
- **FR-008** Verify: `osqueryd` is active and `osqueryi` answers a query; each tool's version
  command runs.
- **FR-009** `docs/sql.md` (served at /guide/sql, `man 7 archon-sql`) and a guide entry: examples
  for each tool, osquery's results log, DuckDB with S3 and PostgreSQL, `jc` with DuckDB, Steampipe's
  plugins.

## Non-goals

- A central osquery server (Fleet), or osquery results into the OpenTelemetry pipeline: later, as an
  opt-in container.

## Success Criteria _(mandatory)_

- `tests/sql_test.ts`: catalog entries, sources and placement; the pinned key's fingerprint; the
  asset patterns against the names the projects' release builds publish (DuckDB's packaging test,
  Steampipe's `.goreleaser.yml`); `osqueryd` enabled and running with Archon's flags and schedule;
  no port for it; the docs and guide.
- On a host: `archon tools status` lists osquery, duckdb, jc, sqlite3 (and steampipe on a
  workstation); `sudo osqueryi --json "SELECT * FROM uptime"` answers;
  `systemctl is-active osqueryd`.
