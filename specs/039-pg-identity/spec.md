# Feature Specification: Linux identities are PostgreSQL identities

**Feature Branch**: `039-pg-identity` (committed directly to main) **Created**: 2026-11-12
**Status**: Implemented **Input**: People use their own Linux accounts to reach PostgreSQL; apps and
services get their own Linux accounts (`s-app1`, `s-app2`, ...) and use those. Integrate usernames
and passwords with PAM and sudo. Decisions: (1) role names identical to the Linux names, always
quoted; (2) the superuser only through `sudo -u postgres`; (3) people reach a published instance
with their Linux password, kept in step by PAM; (4) service accounts are fleet-wide. Also:
PostgreSQL is not started on a new machine; an operator turns it on.

## User Scenarios & Testing _(mandatory)_

1. **Given** a new server whose model declares instances, **When** it is installed and applied,
   **Then** no PostgreSQL package is installed and nothing runs until an operator runs
   `archon pg on`.
2. **Given** PostgreSQL is on, **When** a person runs `psql service=prime` on the server, **Then**
   they are connected as the role of their own Linux name over the socket, with no password.
3. **Given** an app runs as `s-app1`, **When** it connects to `service=prime`, **Then** it is the
   role `s-app1`, with no password, and reaches only the databases the model gives it.
4. **Given** an operator, **When** they need the superuser, **Then** `sudo -u postgres psql` (their
   own password, in sudo's log) is the only way; no other role is a superuser.
5. **Given** an instance is published, **When** a person types their Linux password on the server (a
   login, `sudo`, Cockpit, `passwd`), **Then** the same password signs them in to the published
   instance; a private instance holds no person's password.
6. **Given** a login role with no Linux account (made by hand), **When** an apply runs, **Then** it
   can no longer log in; `archon pg who` names it until then.
7. **Given** `archon pg off`, **Then** every instance is stopped and stays stopped, a reboot
   included, until `archon pg on` (spec 040).

## Requirements _(mandatory)_

- **FR-001** PostgreSQL is an opt-in service (spec 040): every server has `postgresql-common` and no
  cluster, and `postgresql.service` (every cluster is part of it) is masked until `archon pg on`;
  `archon pg off` masks and stops it, which stops every instance (data kept). The decision is
  `state/hosts/<host>/pg.json` `{enabled, by, at}` (with the instances). `ensure` refuses while off;
  an account that cannot become root gets one sentence instead of a sudo prompt.
- **FR-002** Service accounts: `fleet.services` (`name` `s-<app>`, `uid` 800 to 899, `description`),
  on every server, through `systemd-sysusers` (`/etc/sysusers.d/archon-services.conf`: no password,
  shell `/usr/sbin/nologin`, home `/var/lib/<name>` 0750). The same UID everywhere. Validation: the
  `s-` prefix, a UID in range, each name and UID once, a description.
- **FR-003** Databases and access instead of hand-made roles:
  `PgInstanceDef.databases: [{name, owner, write?, read?, extensions?}]`. Each name is a person in
  the host's model, a fleet service account, or `@group` (a Linux group's members); validation
  rejects anything else, `postgres`, `ops`, and a group as owner.
- **FR-004** Login roles: every person on the host (not `ops`) and each service account a database
  names, `LOGIN NOSUPERUSER NOCREATEROLE NOREPLICATION NOBYPASSRLS`; people who are fleet admins
  also `CREATEDB` and members of `pg_monitor` and `pg_signal_backend`. Names identical to Linux,
  always quoted (`"s-app1"`). Marked `archon: human|service (spec 039)` (`COMMENT ON ROLE`). Never a
  password in the SQL that makes them.
- **FR-005** Access: two `NOLOGIN` roles per database, `<db>_rw` and `<db>_ro`.
  `REVOKE CONNECT, TEMPORARY ... FROM PUBLIC`; both may connect; rights on every table and sequence
  in `public`, now and (default privileges for the owner) later. Members are exactly the model's
  `write` and `read` lists, `@group` expanded from the account database on every apply; the owner is
  in neither; `write` wins over `read`.
- **FR-006** Lifecycle: a login role that is Archon's but not wanted, or any login role with no
  Linux account of its name, becomes `NOLOGIN` (never dropped: dropping moves ownership, a
  destructive operation). A role Archon wants that was a superuser is made `NOSUPERUSER`.
- **FR-007** `pg_hba.conf`: `local all postgres peer`, `local all all peer`; on loopback, `postgres`
  rejected first, then `scram-sha-256`; when published, `postgres` rejected from anywhere, then
  `hostssl ... scram-sha-256` from the local networks. Nothing weaker anywhere (`trust`, `md5`,
  `password`, `ident`, `pam`).
- **FR-008** The superuser: `postgres` only, through sudo. `/etc/sudoers.d/archon-pg` (0440, checked
  with `visudo`): `%archon-ops ALL=(postgres) /usr/bin/psql`, and
  `%archon-ops ALL=(<every service account an instance uses>) /usr/bin/psql` to act as an app; the
  operator's own password every time. Fleet admins are in Ubuntu's `sudo` group already.
- **FR-009** People's passwords, from PAM: one hook for every protocol that needs its own copy of a
  Linux password. `/usr/local/libexec/archon/password-sync` (root, 0700), installed with Ubuntu's
  `pam-auth-update` (`/usr/share/pam-configs/archon-passwords`: auth and password,
  `optional pam_exec.so quiet seteuid expose_authtok`). For real accounts (UID 1000 and up; not root
  or ops) it gives Samba the password (spec 037) and, while PostgreSQL is on (`postgresql.service`
  enabled), runs `archon pg passwd-sync <user>` in the background with the password on standard
  input. That command sets a SCRAM-SHA-256 verifier (100,000 rounds) on each **published** instance
  where the person has a role, only when the stored one does not already match.
- **FR-010** No password where none is needed: on a private instance, a person's password is removed
  by the next apply (peer needs none). Service accounts keep the generated password (32 random
  bytes, `/var/lib/archon-keys/pg/<instance>/<service>`, 0400, owned by the service) for clients on
  other machines; any other file there is removed.
- **FR-011** `archon pg connect NAME [--write] [--remote]` (read, no lock): you connect as yourself;
  `--user` is gone. Default: `host=/var/run/postgresql` (peer), the first database you own, may
  write, or may read, else `postgres`. `--remote` (published only): the published name,
  `sslmode=verify-full sslrootcert=system`; for a service account, its password goes to its own
  `~/.pgpass`; a person types their Linux password. `/etc/postgresql-common/pg_service.conf`
  (Debian's system-wide libpq services) lists every instance on its socket with no user or secret,
  so `psql service=<name>` works for everyone; it is written by the Databases step, after the
  instances exist.
- **FR-012** `archon pg who NAME` (read): each role, its kind, whether a Linux account of that name
  exists, login, superuser, password (root only), groups. Exits 1 when a login role has no Linux
  account, a role other than `postgres` is a superuser, or a person has a password on a private
  instance. Verify runs it for each instance.
- **FR-013** The app contract (spec 038 FR-019) runs as the app's service account:
  `archon pg ensure prime --json` answers without sudo when the instance runs;
  `archon pg connect prime --write --json` writes the socket service (no password); then
  `service=prime`.
- **FR-014** Archon's code, specs, and docs name no app: apps are the fleet's data
  (`fleet.services`, a host's `pg.instances[].databases`).

### Overrides of Ubuntu defaults

- PostgreSQL is not installed or started until an operator turns it on (Ubuntu starts a `main`
  cluster on install).
- Ubuntu's PAM stacks gain one `optional` auth and password module through `pam-auth-update` (not an
  edit of `/etc/pam.d`).

## Non-goals

- Kerberos, LDAP, or client certificates. PostgreSQL's own `pam` method (it would need `postgres` in
  the `shadow` group, and sends the password itself, not a SCRAM proof).
- Dropping roles.

## Success Criteria _(mandatory)_

- Exercised against PostgreSQL 16 on Ubuntu 24.04 during development: the service account, the
  system service file, peer logins as a person and as `s-<app>`, the app contract without sudo,
  read-only access through `@group` (including tables made later), writes refused, no superuser but
  `postgres`, `pg who` naming and converge repairing a role without a Linux account and a second
  superuser, the PAM stack regenerated with the hook, a synced password signing in over TCP only
  while published and removed when private, `postgres` refused over the network, and `ensure`
  refused with one sentence while off.
- `tests/pg_identity.test.ts` covers each requirement that runs without a server.
