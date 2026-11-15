# Feature Specification: Opt-in services and containers

**Feature Branch**: `040-opt-in` (committed directly to main) **Created**: 2026-11-12 **Status**:
Implemented **Input**: A new installation starts no opt-in service (SMB, PostgreSQL), just as
`fs smb` is not started; nothing special in `update`, no legacy or migration code, so fresh machines
are truly fresh and the code works idempotently. Call them "opt-in services", and add "opt-in
containers"; the first is S3 object storage (`archon fs s3`, spec 041). Where an opt-in service or
container supports it, it uses Linux accounts and credentials, never its own.

## User Scenarios & Testing _(mandatory)_

1. **Given** a freshly installed server, **When** anyone looks, **Then** every opt-in service and
   container is present and off (its unit masked); no image is downloaded; nothing answers.
2. **Given** an operator runs `archon fs smb on`, `archon pg on`, or `archon fs s3 on`, **Then** it
   starts, the decision is recorded (who, when), and every later apply, reboot, and reinstall keeps
   it on until the matching `off`.
3. **Given** `archon opt-in`, **Then** each opt-in is listed: on or off, since when, by whom, and
   the command that turns it on or shows it.
4. **Given** any apply, run twice on the same machine, **Then** the second changes nothing.

## Requirements _(mandatory)_

- **FR-001** Opt-in services and containers: on every server, off until an operator turns one on,
  then on until an operator turns it off. The term is used in the docs, the guide, and the CLI.
- **FR-002** The decision is the host's record, `state/hosts/<host>/<name>.json` `{enabled, by, at}`
  (pushed with `archon push`, so a reinstall keeps it). `loadHosts` reads every such record into
  `HostDef.optIn`, so a plan knows what is on (routes, the Databases and Containers steps); the
  opt-in's unit carries `UnitDef.switch`, so apply masks it while off and unmasks and starts it
  while on.
- **FR-003** One module, `src/archon/optin/optin.ts`: `OPT_INS` (name, kind, title, unit, commands,
  how to connect), `writeOptIn` (keeps the record's other fields: `pg.json` also lists instances),
  `setOptIn` (record, apply at once with the same apply every run does, journal `archon-optin`,
  mail, next steps), `optInList`. `fs smb on|off`, `pg on|off`, and `fs s3 on|off` are this switch.
- **FR-004** `archon opt-in` (read, no lock), with `--json`.
- **FR-005** The opt-ins: SMB (`smbd.service`, spec 037), PostgreSQL (`postgresql.service`, Ubuntu's
  umbrella unit that every cluster is part of, specs 038 and 039: every server has
  `postgresql-common` and no cluster; clusters exist only while on), and S3 (`archon-s3.service`,
  spec 041).
- **FR-006** Opt-in containers: a catalog (`src/archon/containers/catalog.ts`): name, title, image
  pinned by digest (Article 12), the image's UID, ports, volumes, plain settings, a root-only file
  of generated secrets (outside `/etc`, so etckeeper never records it), and a readiness URL. Each
  renders a Podman Quadlet file, `/etc/containers/systemd/archon-<name>.container`: `User=<uid>`,
  `NoNewPrivileges`, `DropCapability=ALL`, ports published on `127.0.0.1` only, `Pull=missing` (no
  image is downloaded until it first starts), `WantedBy=multi-user.target`. Its generated unit
  (`UnitDef.generated`: never enabled; on is unmask and start) is masked while off. While on, its
  routes are on Traefik (LAN only, spec 032).
- **FR-007** Linux identities: an opt-in uses Linux accounts and their credentials where it can (SMB
  and PostgreSQL take the Linux password through PAM). Where its protocol needs a secret of its own
  (S3 signs requests with one the server keeps), the identity is still the Linux account (the same
  name), the secret is generated on the server, and only that account (and root) can read it; Archon
  never puts a Linux password where it can be read back.
- **FR-008** Apply's steps: Files (then, for an opt-in container that is on, its generated secrets),
  Units (the switch), Databases (PostgreSQL, while on), Containers (S3's users, while on). `update`
  has nothing of its own: it pulls and applies.
- **FR-009** Fresh means fresh: no code removes what an earlier version shipped, and no spec, doc,
  comment, or message describes a previous state. A second apply on the same machine changes
  nothing.

## Non-goals

- Opt-ins on workstations.
- Automatic image updates (a new version is a catalog change).

## Success Criteria _(mandatory)_

- `tests/optin.test.ts`: a fresh plan has every opt-in masked and nothing routed; records are model
  input and keep their other fields; containers are pinned, unprivileged, loopback-only, with no
  secret in the file, and Podman's own Quadlet generator accepts the file; commands and tiers; a
  second apply into a sandbox root changes nothing.
