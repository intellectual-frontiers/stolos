# Feature Specification: Your PostgreSQL connections, and how to reach an instance

**Feature Branch**: `043-pg-connections` (committed directly to main) **Created**: 2026-11-12
**Status**: Implemented **Input**: Two read-only commands in the `archon pg` family, each also an
MCP tool: `archon pg connections [--json]` (every entry of the password file and every section of
the service files, matched, with problems and reasons) and
`archon pg show NAME [--form conninfo|url|env|service]` (how to reach an instance). Never a
password, in any output. Read-only; any instance `archon pg list` knows, and entries Archon did not
make.

## User Scenarios & Testing _(mandatory)_

1. **Given** a person with a `~/.pgpass` and a `~/.pg_service.conf`, **When** they run
   `archon pg connections`, **Then** they see each password-file entry (host, port, database, user),
   the services it serves, whether it is usable, and each problem with its reason, and no password
   anywhere.
2. **Given** `~/.pgpass` readable by others, **Then** the file is reported unusable (libpq ignores
   it), with the `chmod 600` that fixes it.
3. **Given** `archon pg show prime`, **Then** a libpq connection string for prime on this server
   (the socket, the person as themselves); `--form url`, `env`, and `service` give the other forms;
   `--remote` the published name with `sslmode=verify-full`.
4. **Given** `--form json`, **Then** a usage error (exit 2) that lists the four forms.

## Requirements _(mandatory)_

- **FR-001** `archon pg connections [--json]` (read, no lock, an MCP tool): the password file is
  `PGPASSFILE`, else `~/.pgpass`; the service files are `PGSERVICEFILE`, else `~/.pg_service.conf`,
  then `PGSYSCONFDIR/pg_service.conf`, else Ubuntu's `/etc/postgresql-common/pg_service.conf` (a
  user's section hides a system section of the same name, as in libpq).
- **FR-002** Matching follows libpq (`passwordFromFile` in `fe-connect.c`): lines starting with `#`
  are comments; fields are `host:port:database:user:password` with `\` escaping `:` and `\`; `*`
  matches anything; a socket connection in the default socket directory, or no host, matches
  `localhost`; no port is 5432, no user is the account's own name, no database is the user's name.
- **FR-003** Per password-file entry: line number, host, port, database, user, the services it
  serves, whether libpq can use it, and problems with reasons: fewer than five fields (libpq skips
  it; its fields are not shown, since a password may sit in any of them), no service uses it, the
  file is ignored. Per file: path, mode, usable; not a plain file, or group or others can access it,
  means libpq ignores the whole file, with `chmod 600` as the fix. Per service: file, source (user
  or system), host, port, database, user, sslmode, the password-file line libpq would use, and
  problems: it holds a password, or it uses a network host without `sslmode=verify-full`.
- **FR-004** No password, ever: the password field is dropped as each password-file line is split
  (only whether there is one is kept); a service file's `password` key is dropped as it is read.
  Nothing is printed, logged, journaled, returned in JSON or an MCP result, or put in an error that
  holds a password.
- **FR-005** `archon pg show NAME [--form conninfo|url|env|service] [--remote] [--json]` (read, no
  lock, an MCP tool): NAME is an instance Archon keeps, else any cluster `pg_lsclusters` shows
  (Archon's or not), else a section of the service files. On this server: the socket directory and
  the person as themselves (peer; database as `archon pg connect` chooses it). Over a network
  (`--remote` for a published instance, or a service whose host is a network name):
  `sslmode=verify-full` and `sslrootcert=system`, never a fallback to plain text. No password in any
  form.
- **FR-006** An unknown form is a usage error (exit 2) whose message lists every form.
- **FR-006b** `--form jdbc`: a JDBC URL for tools on the PostgreSQL JDBC driver (DBeaver, IntelliJ,
  Java apps), for a network host: `sslmode=verify-full` with
  `sslfactory=org.postgresql.ssl.DefaultJavaSSLFactory` (Java's trust store), never
  `sslrootcert=system` (pgJDBC reads it as a file name), the user, no password. A socket-only
  instance is refused with the command that publishes it. The external form includes it, with what
  to do when the tool's Java lacks the certificate's root.
- **FR-006e** More forms, each in its client's own syntax, verified TLS over a network, no password:
  `npgsql` (`Host=;Port=;Database=;Username=;SSL Mode=VerifyFull`: .NET, Power BI, Excel's Power
  Query, which trust the system's store); `odbc` (psqlODBC: a Windows connection string relying on
  libpq's own `%APPDATA%\postgresql\root.crt`, and a Linux one with `pqopt={sslrootcert=system}`);
  `dotenv` (`DATABASE_URL` for libpq-based frameworks with `sslrootcert=system`, and commented lines
  for Node, which reads `sslrootcert` as a file, and Prisma, `sslmode=require&sslaccept=strict`);
  `pgadmin` (a `servers.json` for Import Servers, `sslmode=verify-full`, relying on libpq's root
  certificate file); `ca` (the root certificate behind the chain the server presents, read with
  `openssl s_client -starttls postgres` within 15 seconds, found among the system's trusted roots by
  its issuer hash and checked to sign the chain's last certificate, printed as PEM with its subject
  and SHA-256 fingerprint on standard error; network hosts only). The external form includes the
  first three and how to get the last two.
- **FR-006a** `--form external`: everything a client on another machine needs, for a published
  instance (it implies `--remote`; a private one is refused with the command that publishes it): the
  published name; the server's IP address from the model as `hostaddr` (connect without DNS; TLS
  still checks the name); port, database, user; `sslmode=verify-full` and `sslrootcert=system`
  (libpq 16 or newer; for an older client, `/etc/ssl/certs/ca-certificates.crt`); where the password
  comes from (a person's Linux password, or a service account's own `~/.pgpass` line), never the
  password; then the conninfo, URL, `PG*`, and service forms filled in for that client.
- **FR-006c** The PAM reminder (spec 039): every connection detail for a published instance, for a
  person, says that PostgreSQL learns the Linux password only when it is typed on the server after
  publishing, with `sudo -k && sudo -v` (a plain `sudo -v` does not ask while sudo remembers you).
  In the external form it is part of the text; for the other forms it goes to standard error (stdout
  stays usable in `psql "$(...)"` and `eval`); in JSON it is `note`. `archon pg publish` says it
  too. `archon pg passwd-sync` journals every outcome (`journalctl -t archon-pg`), never the
  password, and the PAM hook gives it root's `HOME` and `PATH`.
- **FR-006d** `archon pg test NAME [--user U]` (read, no lock, interactive so not an MCP tool):
  connects as an external client does, to the published name (never localhost), with
  `sslmode=verify-full` and `sslrootcert=system`, as the person (or U), with a password typed now
  (not echoed; one line from a pipe), handed to psql through a private temporary password file
  (0600, in a 0700 directory) removed at once. It reports the role, the server's and the client's
  addresses, and the TLS version and cipher; on failure, the likely cause and fix (password: the PAM
  reminder; certificate; not admitted: `--local-only`; name not resolving; nothing answering:
  firewall or router). On the server itself it says the firewall was not crossed. `psql` (Ubuntu's
  `postgresql-client`) is in the tool catalog for every host.
- **FR-006f** `archon pg admin-tui [NAME] [--remote]` starts rainfrog and
  `archon pg observe-tui [NAME] [--remote]` starts `pgcenter top`, each connected to NAME as
  `archon pg show` finds it: through the socket as the person (peer) on the server; with `--remote`,
  the published name with `sslmode=verify-full` and the system's roots
  (`/etc/ssl/certs/ca-certificates.crt`, since neither tool takes `sslrootcert=system`). rainfrog
  gets a URL (`--url`, the socket through its `host` parameter) and asks for a password itself;
  pgcenter gets libpq's flags and `PGSSLMODE`/`PGSSLROOTCERT`, and over the network its password
  comes from `~/.pgpass` or is asked by Archon and passed in pgcenter's own environment. No password
  is ever on a command line, in a file, or in a log. Both need a terminal: read-only, no lock, not
  MCP tools.
- **FR-007** Read-only: no `--write`, nothing changes on the host.
- **FR-008** Documented in `docs/pg.md` ("Your connections, and how to reach an instance").

## Success Criteria _(mandatory)_

- `tests/pg_connections_test.ts`: a password planted in the fixture password file (also with escaped
  colons, and in a malformed line) and in a service file appears in no output of `pg connections`,
  `pg connections --json`, `pg show` in every form, `pg show` for an unknown name, the usage error,
  the warning for a file others can read, or the MCP server's `tools/call` results. Matching,
  problems, forms, verify-full over a network, and the usage error are each tested.
