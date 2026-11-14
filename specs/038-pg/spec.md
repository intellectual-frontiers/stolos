# Feature Specification: PostgreSQL instances (`archon pg`)

> **Revised by spec 064:** the machine restricts no network; who reaches this service is the
> router's decision. Statements below about the local networks only no longer hold.

**Feature Branch**: `038-pg` (committed directly to main) **Created**: 2026-11-12 **Status**:
Implemented; identities, access, and the on/off switch are spec 039's **Input**: An `archon pg`
database server. Several PostgreSQL versions side by side, each instance named, published as
`pg-<name>.<host>.<domain>`. Default instance: PostgreSQL 18 named `prime`. Multi-version through
Debian's postgresql-common (`pg_createcluster`, `pg_ctlcluster`, `pg_lsclusters`); clusters are
`<version>/<name>`, each with its own port, data directory, systemd unit, and logs. Never touch a
cluster Archon did not make. A pretty psql prompt in `home/dot_psqlrc`. Commands `list`, `status`,
`ensure`, `start`, `stop`, `restart`, `reload`, `upgrade`, `remove`, `backup`, `restore`,
`maintain`, `publish`, `unpublish`, `connect`, all taking NAME (default `prime`) and `--json`. A
least-privilege identity for an app, owning its database and its extensions. The app contract:
`archon pg ensure prime`, then `archon pg connect prime --write --json`, then `service=prime`,
unattended for an ordinary account. Mid-request, the owner said: "Traefik does not need to route
PostgreSQL connections."

## User Scenarios & Testing _(mandatory)_

1. **Given** alpha' model declares `prime` and an operator turned PostgreSQL on (spec 039), **When**
   an apply (or the reconcile timer) runs, **Then** cluster `18/prime` exists on its own port, runs,
   has Archon's configuration, roles, and passwords, and is recorded in `state/hosts/alpha/pg.json`.
2. **Given** an operator runs `archon pg ensure lab --version 17`, **When** it finishes, **Then**
   `17/lab` exists on the next free port, is recorded on the host, and every later apply keeps it;
   `archon pg list` shows `prime` and `lab` with distinct ports.
3. **Given** a cluster named `main` (or any name) that Archon did not create, **When** anything in
   `archon pg` meets it, **Then** it is listed as not Archon's and never changed, started, stopped,
   dumped, or removed.
4. **Given** an app's service account (spec 039), **When** it runs `archon pg ensure prime --json`
   and `archon pg connect prime --write --json`, **Then** both exit 0 without sudo, print the
   documented JSON, and `psql service=prime` connects as that account to its database.
5. **Given** an operator in psql on `prime`, **Then** the prompt shows
   `prime · production 🔒 protected · role@database · host:port · pid N` and `*` in a transaction,
   the arrow is red for a superuser, AUTOCOMMIT is off with a red warning, borders are unicode, NULL
   is ∅, timing is on.
6. **Given** `archon pg publish prime`, **Then** clients reach `pg-prime.alpha.lab.example.net` on
   prime's port with TLS and scram-sha-256 only, from wherever the router lets them through (with
   `--local-only`, from the local networks only); `archon pg unpublish prime` restores private.
7. **Given** `upgrade`, `restore`, or `remove` without the owner's approve marker in this spec,
   **Then** it refuses with one sentence and changes nothing.

## Requirements _(mandatory)_

- **FR-001** Instances: `HostDef.pg.instances` (`name`, `version` default 18, `port`, `environment`
  default production, `protected` default true for production, `roles`). alpha declares `prime`
  (PostgreSQL 18) and, as the fleet's data, its databases (spec 039). Names are lowercase DNS
  labels; roles and database names are validated (`archon build` rejects bad ones).
- **FR-002** Versions: 18 from Ubuntu (Article 2). Others from PGDG (`apt.postgresql.org`, suite
  `<codename>-pgdg`), signed by the key Ubuntu's `postgresql-common` ships at
  `/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc` (Article 12: a pinned key, provided by
  Ubuntu). The source is written only when a non-Ubuntu version is wanted. When PGDG does not
  publish a version for 26.04, `ensure` fails with that sentence. Nothing is built from source.
- **FR-003** Ownership: Archon owns exactly the clusters recorded in `state/hosts/<host>/pg.json`
  (written when Archon creates one: version, port, when, by whom). Any other cluster, whatever its
  name, is reported (`list`: "not Archon's") and never touched. Ubuntu's `main` cluster is never
  created (`createcluster.d/50-archon.conf`: `create_main_cluster = false`, written before the first
  PostgreSQL package is installed).
- **FR-004** Model and record: the instances a host keeps are the model's plus those recorded on the
  host (`loadHosts` reads the record into `HostDef.pgState`), so `archon build` renders both and
  every apply's Databases phase converges both (the reconcile timer keeps them). A record's version
  and port win over the model: they are what the cluster is.
- **FR-005** Converge (`src/archon/pg/converge.ts`, run by apply and `ensure`): install the version,
  allocate the first free port from 5432 (not used by any cluster, record, or listener) unless the
  model fixes one,
  `pg_createcluster <v> <name> --port P --start -- --auth-local=peer --auth-host=scram-sha-256 --data-checksums`,
  record it; write `conf.d/50-archon.conf` (`listen_addresses = 'localhost'`,
  `password_encryption = 'scram-sha-256'`, `ssl = on`, `ssl_min_protocol_version = 'TLSv1.3'`,
  connection logging, `archon.instance`, `archon.environment`, `archon.protected`) and `pg_hba.conf`
  (peer on the socket, scram-sha-256 on loopback, nothing weaker); reload, or restart when
  `listen_addresses` changed; start when down; roles, passwords, databases, extensions.
  `apply --check` reports what would change and changes nothing. A record whose cluster is gone (a
  reinstall) is re-created empty and says to restore.
- **FR-006** Commands and tiers (the registry generates the CLI, MCP tools, man pages, completions,
  and agent rules): `list`, `status`, `connect` read (no lock); `maintain` read (runs as root;
  VACUUM ANALYZE changes no data or configuration); `ensure`, `start`, `stop`, `restart`, `reload`,
  `backup`, `publish`, `unpublish` mutate; `upgrade`, `restore`, `remove` destructive (never served
  over MCP). Every command takes NAME (default `prime`); `list`, `status`, `ensure`, `backup`,
  `maintain`, `connect` print JSON with `--json`. Every failure exits non-zero with one plain
  sentence.
- **FR-007** `ensure [NAME] [--version N]` is idempotent. For an instance not in the model it
  records one (operator decision, pushed with `archon push`). A different `--version` than the
  instance has is refused with the upgrade command to use. It has a precheck (`Command.precheck`):
  when the instance is Archon's and online, it answers without elevating, so an ordinary account
  runs it unattended.
- **FR-008** `upgrade NAME --to N`: never in place without a backup: dumps first, installs N,
  `pg_upgradecluster -v N -m upgrade`, records the new version and port, keeps the old cluster
  stopped (`retired`) until `remove NAME --version OLD`.
- **FR-009** `remove NAME [--version V]`: dumps first, `pg_dropcluster --stop`, forgets the record
  and passwords; refuses an instance still in the model; `--version` removes only a retired cluster.
- **FR-010** Roles and access: spec 039 (every login is a Linux account: the people on the host and
  the fleet's service accounts; databases name their owner, writers, and readers). Untrusted
  extensions a database needs are listed in the model (`extensions`) and created by Archon.
- **FR-011** `backup NAME | --all`: `pg_dumpall --clean --if-exists | zstd` into
  `/var/backups/archon/pg/<name>/` (root only, 0600), the last 7 kept; `archon-pg-backup.timer`
  dumps every instance at 02:07, before spec 016's 02:37 archive, which carries them.
  `restore NAME [--from FILE]` dumps what is there first, loads the newest dump (or FILE), then sets
  Archon's passwords again.
- **FR-012** Passwords (spec 039): none on the server (peer). A service account's password, for
  clients on other machines, is generated on the server (32 random bytes), stored in
  `/var/lib/archon-keys/pg/<instance>/<service>` mode 0400, owned by that account, and set as a
  SCRAM-SHA-256 verifier computed by Archon, so the password itself never reaches PostgreSQL, its
  logs, a process list, the repository, or a report. A person's password on a published instance is
  their Linux password, kept in step by PAM. `/var/lib/archon` is in the nightly backups (spec 016).
- **FR-013** `maintain NAME`: VACUUM ANALYZE on every database; a report of connections by database
  and state against `max_connections`, database sizes, and the ten tables with the most dead rows
  per database.
- **FR-014** `publish NAME [--local-only]`: records `published` (who, when, and `localOnly` when
  given) and applies at once (`files` and `databases` phases): PostgreSQL also listens on the host's
  model address; `pg_hba.conf` adds `hostssl ... scram-sha-256` (after `postgres` is rejected from
  every address); PostgreSQL serves the server's Let's Encrypt wildcard certificate (copied from
  Traefik's store, spec 032) so clients use `sslmode=verify-full sslrootcert=system` with
  `pg-<name>.<host>.<domain>`. By default every address may connect (`0.0.0.0/0`, `::/0`) and the
  firewall's Archon profile opens the instance's port to everyone: PostgreSQL is reachable over TLS
  from wherever the router lets it through (the owner's decision; the router decides, Article 21).
  With `--local-only`, `pg_hba.conf` and the firewall (Archon-LAN) admit the local networks only.
  Publishing again changes the scope. Default private. `unpublish` reverses each step.
- **FR-015** No Traefik for PostgreSQL (the owner's decision): PostgreSQL terminates TLS itself on
  its own port. The name `pg-<name>.<host>.<domain>` is covered by the server's existing wildcard
  DNS record and certificate (spec 032), so no record or certificate is added. Spec 028: clients on
  Internal (Default) and the WireGuard network already reach Servers on the ports a server opens (as
  for Cockpit 9090 and SMB 445); Archon changes nothing on the router (Article 21): whether a
  published instance is reachable from the internet is the router's port forwarding, and its public
  DNS. Each published instance keeps its own port (5432 for the first), so libpq needs nothing
  beyond standard TLS.
- **FR-016** `connect NAME [--write] [--remote]` (spec 039): you connect as yourself. Prints the
  libpq service block; with `--write`, writes `[NAME]` into `~/.pg_service.conf` (0600, atomic,
  replacing only that section): on the server, the socket and peer (no password); with `--remote`,
  the published name and verified TLS, and for a service account its password in its own
  `~/.pgpass`. These files are never managed by a dotfile layer.
- **FR-017** `home/dot_psqlrc` (every user, spec 031): unicode borders (`linestyle unicode`,
  `border 2`), NULL as ∅, `\timing on`, `ON_ERROR_ROLLBACK interactive`; prompt line 1: instance
  (`SERVICE`, else `archon.instance`), environment (red for production) and 🔒 protected,
  role@database, host:port, backend PID, `%x` (`*` in a transaction); line 2: an arrow, red for a
  superuser; on a protected instance, AUTOCOMMIT off with a red warning. Colors carry readline's
  invisible markers.
- **FR-018** Verify: each recorded instance's unit (`postgresql@<v>-<name>.service`) is checked with
  `pg_isready` on its port.
- **FR-019** The app contract, stable; it runs as the app's service account (spec 039):
  1. `archon pg ensure prime --json` → exit 0 and
     `{"ok": true, "name", "version", "port", "status": "online", "unit", "created", "changes"}`.
     Without sudo once `prime` exists and runs.
  2. `archon pg connect prime --write --json` → exit 0 and
     `{"ok": true, "service": "prime", "host": "/var/run/postgresql", "port", "user": "<account>", "database": "<its database>", "sslmode": "disable", "files": {"service"}}`
     (plus `published: {host, port, sslmode: "verify-full"}` when published). No privileges, no
     password.
  3. `service=prime` in any libpq client. On failure: exit non-zero; stderr (or
     `{"ok": false, "error"}` with `--json`) is one plain sentence (also when PostgreSQL is off).
- **FR-020** Destructive operations (`upgrade`, `restore`, `remove`) run only when this file
  contains a line `approve: destructive` (added by the owner with an explicit request) and
  `--confirm-destroy NAME` repeats the instance's name. This file does not contain that line.
- **FR-021** Every create, publish, unpublish, upgrade, and remove is journaled (`archon-pg`) and
  mailed to the fleet's mailbox.
- **FR-022** Tools for PostgreSQL on every host (spec 010's catalog): rainfrog (a terminal UI:
  browse, query, edit) and pgcenter (top for PostgreSQL), each a single binary from its project's
  own release, checked against the release's published SHA-256. Neither is in Ubuntu 26.04's
  archive.

### Clarifications (decided with defaults; the owner may revise)

- _Vault (029) or host-held passwords?_ The vault lives on the boot machine and a server cannot read
  it unattended, which the app contract needs. Host-held, root-only (or role-only) files, set as
  SCRAM verifiers; never in the repository or a log. Revisit if the vault gains a server-side
  reader.
- _Second version on 26.04?_ Ubuntu ships 18 only; PGDG's `resolute-pgdg` could not be verified from
  the build environment. `ensure NAME --version 17` uses PGDG and says plainly when it is not
  available.
- _Model or record for `ensure`?_ Both: the model for instances the fleet always has (`prime`), the
  host's record for an operator's `ensure NAME` (like the SMB switch, spec 037), pushed with
  `archon push`.

### Overrides of Ubuntu defaults

- `create_main_cluster = false`: Ubuntu's package makes a `main` cluster on install; Archon makes
  only the clusters asked for.
- Per instance: `pg_hba.conf` (scram-sha-256 instead of Ubuntu's md5/scram mix; peer kept),
  `ssl_min_protocol_version = TLSv1.3`, connection logging.

## Non-goals

- Routing PostgreSQL through Traefik (FR-015). Replication, PITR, connection pooling: later specs.
- Managing `~/.pg_service.conf` or `~/.pgpass` through dotfiles (they hold per-user secrets).

## Success Criteria _(mandatory)_

- On alpha: `archon pg ensure prime` and `archon pg ensure <second> --version <other>` both online;
  `archon pg list` shows distinct ports; `archon pg connect prime --write` then `psql service=prime`
  connects with the prompt; `archon pg publish prime` and `unpublish` round-trip; `archon verify`
  clean.
- Tests (`tests/pg_test.ts`) cover every requirement above that can run without a server; the
  converge, connect, backup, restore, publish-configuration, and prompt paths were exercised against
  PostgreSQL 16 clusters on Ubuntu 24.04 during development.
