# Feature Specification: Ephemeral and durable data

**Feature Branch**: `044-durable` (committed directly to main) **Created**: 2026-11-13 **Status**:
Implemented **Input**: Constitution Article 23. Every source of data that can come from end users
(PostgreSQL, S3, SMB shares, LXD guests) is either ephemeral (losing it is harmless) or durable (it
exists nowhere else). The operator chooses when turning a source on; there is no default. A host is
durable when anything on it is durable, and ephemeral otherwise. Nothing reinstalls or wipes durable
data without `--confirm-destroy`, typed by a person. Home directories on servers are ephemeral by
rule. The off-host destination is an open question (a NAS, in a later spec).

## User Scenarios & Testing _(mandatory)_

1. **Given** a fresh server, **When** an operator runs `archon pg on`, **Then** a usage error says
   to choose `--durable` or `--ephemeral`, with one line on what each means, and nothing changes.
2. **Given** `archon pg on --durable`, **Then** PostgreSQL starts, the record says `data: durable`,
   and the server is durable: `archon data` says "durable (PostgreSQL)", the login banner and the
   welcome page say so, and the prompt marks the host.
3. **Given** a durable server, **When** the boot machine runs `deno task boot reinstall alpha`,
   **Then** it refuses before anything changes, naming why ("alpha is durable (PostgreSQL)") and the
   flag that confirms; with `--confirm-destroy alpha` it goes ahead.
4. **Given** an ephemeral server, **Then** a reinstall needs no confirmation.
5. **Given** a durable source, **When** an operator runs `archon data set pg --ephemeral`, **Then**
   it refuses without `--confirm-destroy alpha`; an agent (over MCP, or with `ARCHON_AGENT` set) can
   never pass that flag.
6. **Given** S3 and SMB recorded as durable, **Then** `/srv/s3` and `/srv/smb` join the nightly
   archive; recorded as ephemeral, they do not.
7. **Given** a guest in the model without `data`, **Then** `archon build` fails with the two
   choices.

## Requirements _(mandatory)_

- **FR-001** Sources of end users' data: the opt-ins `pg` (PostgreSQL), `s3` (S3), and `smb` (SMB
  shares), and every LXD guest. A future opt-in that holds such data is added to `USER_DATA_OPT_INS`
  (`src/archon/model/durable.ts`) and gets the same forced choice.
- **FR-002** The choice is forced. `archon pg on`, `archon fs s3 on`, and `archon fs smb on` take
  exactly one of `--durable` and `--ephemeral`; neither or both is a usage error that explains both.
  The choice is kept in the opt-in's record, `state/hosts/<host>/<name>.json`, as `data`, and it
  stays when the opt-in is turned off (the data is kept). A guest's choice is `GuestDef.data`,
  required by the type and by validation.
- **FR-003** The class is computed, never stored: `hostData(host)` gives `durable` when any source
  (on, or off with its data kept) is durable or has no recorded choice, and `ephemeral` otherwise,
  with the reasons. A source without a recorded choice counts as durable, and `archon data` says how
  to record one. Data without a recorded choice counts too: PostgreSQL instances listed in
  `pg.json`, and, on the host itself (`archon data`, which the boot machine asks), an opt-in's data
  directory that holds anything (a cluster under `/var/lib/postgresql/<version>/`, anything RustFS
  made in `/srv/s3`, anything in `/srv/smb/shared`) or cannot be read. Turning off an opt-in that
  was never on records nothing.
- **FR-004** `archon data [--json]` (read, an MCP tool): the class, the reasons, each source and its
  choice, what the class means, and the home-directory rule; exits non-zero when a source has no
  recorded choice. `archon data set NAME --durable|--ephemeral [--confirm-destroy HOST]` (mutate)
  changes a choice: from durable (or no choice) to ephemeral needs `--confirm-destroy` with the
  host's name. The mailbox is told.
- **FR-005** `--confirm-destroy` is typed by a person: a registry argument marked `human` is not
  offered over MCP, a call that passes it is refused, and any command run with `ARCHON_AGENT` set
  refuses it. `archon pg upgrade`, `pg restore`, and `pg remove` take it (with the instance's name),
  besides spec 038's `approve: destructive` line.
- **FR-006** The boot machine: `deno task boot reinstall HOST` asks the host `archon data --json`
  over SSH before anything changes. Ephemeral: it goes ahead. Durable (including data with no
  recorded choice), or a class that cannot be read (no answer, no valid JSON): it refuses unless
  `--confirm-destroy HOST` names it. A host that does not answer over SSH is armed only with
  `--confirm-destroy`. `deno task boot arm HOST` checks the records in the checkout the same way.
- **FR-007** Backups (spec 016): the nightly archive adds the paths of durable (or unchosen)
  sources, `/srv/s3` and `/srv/smb`; PostgreSQL's dumps are already in the backup target. Each
  durable guest is exported with `lxc export` next to the archives, keeping the newest N; a failed
  export fails the backup run.
- **FR-008** Off-host copies: the destination is not chosen yet. On a durable host, `archon verify`
  reports a warning (not a failure): "no off-host copy yet". A later spec adds the destination (a
  NAS) and turns it into a failure with a maximum age.
- **FR-009** Where it shows: `archon data`; `archon opt-in` (a class line, and each opt-in's
  choice); `/etc/archon/data` (`durable` or `ephemeral`), which the prompt reads into `ARCHON_DATA`:
  the pretty prompt colors the host segment and adds "durable", the plain prompts add `[durable]`;
  the login banner (`/etc/update-motd.d/72-archon-data`); the welcome page ("Data");
  `archon fleet status` on the boot machine (from the records in the checkout).
- **FR-010** Home directories on servers are ephemeral by rule: they are archived locally as before,
  and the login banner, the welcome page, and `archon data` say they are not kept across a
  reinstall.
- **FR-011** No history: the record holds only `enabled`, `by`, `at`, and `data`, the current
  decision. A record without a choice falls under the fail-safe rule (FR-003).
- **FR-012** One vocabulary: "durable" describes data and hosts, never a transaction (not the D in
  ACID). Spec 021's local stores are "ephemeral" in the same sense.

## Success Criteria

- **SC-001** No command turns on a source of end users' data without a choice.
- **SC-002** No reinstall, arm, or destructive PostgreSQL step erases durable data without a person
  repeating the name.
- **SC-003** A server whose records say "off" but whose disk or records still show data is durable
  until someone records a choice.
- **SC-004** Tests cover every combination of choices, the fail-safe rule, each guard, MCP and agent
  refusal, the backup paths, and every place the class shows.
