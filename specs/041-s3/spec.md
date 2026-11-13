# Feature Specification: S3 object storage (`archon fs s3`)

**Feature Branch**: `041-s3` (committed directly to main) **Created**: 2026-11-12 **Status**:
Implemented **Input**: The first opt-in container: RustFS (or another popular, well-supported
open-source S3 server), managed with `archon fs s3`. It uses Linux accounts and credentials wherever
it can. Decisions: RustFS; the image pinned; each Linux account is an S3 user of the same name;
`/srv/s3` is not in the nightly backups.

## User Scenarios & Testing _(mandatory)_

1. **Given** a fresh server, **Then** S3 is off: its Quadlet file is there, its unit masked, no
   image downloaded, no route.
2. **Given** `archon fs s3 on`, **Then** RustFS starts, `https://s3.<host>.<domain>` (the S3 API)
   and `https://s3-console.<host>.<domain>` (its console) answer on the local networks, and every
   person on the server and every fleet service account has an S3 user of the same name.
3. **Given** a person runs `archon fs s3 key --write`, **Then** `~/.aws` has a profile `s3-<host>`
   with their key; `aws --profile s3-<host> s3 mb s3://<user>-files` works, and a bucket not named
   `<user>-*` is refused.
4. **Given** `archon fs s3 off`, **Then** the container stops and stays stopped; buckets, users, and
   keys are kept.

## Requirements _(mandatory)_

- **FR-001** The server: RustFS (Apache-2.0; 1.0 GA, September 2026; a single node with its own
  console), `docker.io/rustfs/rustfs:1.0.5`, pinned by digest
  `sha256:b81d16a90ee25bd9511280127ca1471788c6e874cf0f0da759645f46b2dc1d74` (Docker Hub; quay.io is
  not used). Garage (AGPLv3; no bucket versioning) and SeaweedFS (more parts) were considered. A new
  version is a catalog change.
- **FR-002** The container (spec 040): runs as the image's own user (UID 10001), every capability
  dropped, no new privileges; `/srv/s3` (0750, UID 10001) is `/data`; the API (9000) on
  `127.0.0.1:9300`, the console (9001) on `127.0.0.1:9301`; settings `RUSTFS_VOLUMES=/data`,
  `RUSTFS_ADDRESS=:9000`, `RUSTFS_CONSOLE_ENABLE=true`, `RUSTFS_CONSOLE_ADDRESS=:9001`. Ready means
  `GET /health/ready` answers 200.
- **FR-003** Names: `s3.<host>.<domain>` and `s3-console.<host>.<domain>`, Traefik routes while on
  (LAN only, the server's wildcard certificate and DNS record, spec 032). Path-style requests
  (`https://s3.<host>.<domain>/<bucket>/<key>`): a bucket as a hostname would need a certificate one
  level deeper.
- **FR-004** Admin credentials: generated on the server before the first start (`archon-root`, 32
  random bytes) in `/var/lib/archon/s3/rustfs.env` (root, 0600; the container's `EnvironmentFile`),
  and the admin alias for `rc` (RustFS's CLI, in the image) in `/var/lib/archon/s3/rc.env` (root,
  0600). Never in the repository, a log, or a report.
- **FR-005** Identities are Linux accounts (spec 040 FR-007): every person on the server (not `ops`)
  and every fleet service account (`fleet.services`) is an S3 user of the same name, with the policy
  `archon-<name>`: list buckets, and everything in the buckets named `<name>-*`, nothing else. S3
  signs every request with a secret the server keeps, so it cannot be the Linux password: each
  secret is 32 random bytes generated on the server, in `/var/lib/archon-keys/s3/<name>` (0400,
  owned by that account; `/var/lib/archon-keys` is 0711, so every account reaches its own key and
  nobody can list them). Users are made with `rc` inside the container (`podman exec`); a secret
  travels in Podman's environment (`-e NAME`, read with `--password-from-env`), never on a command
  line (`rc admin user add` takes one there, so a throwaway is given and replaced at once). An
  identity Archon made that is no longer a person here or a fleet service account is disabled, and
  its key removed.
- **FR-006** Commands: `archon fs s3 on | off` (mutate; the opt-in switch); `archon fs s3 status`
  (read: on or off, since when, by whom, the unit, ready, the addresses, and as root the users;
  non-zero when on but not ready); `archon fs s3 key [--write]` (read, no lock, as yourself: your
  access key is your username; `--write` puts the profile `s3-<host>` in `~/.aws/credentials` and
  `~/.aws/config`, 0600, replacing only that profile, with `endpoint_url`, `region = us-east-1`, and
  path-style addressing). A service gets its key with `sudo -u s-<app> archon fs s3 key --write`.
- **FR-007** Verify: while on, the unit is active and `/health/ready` answers; while off, it is not
  running.
- **FR-008** Backups: `/srv/s3` is not in the nightly backups (it can be large, as SMB shares); the
  credentials and keys are (`/var/lib/archon`, spec 016).
- **FR-009** The guide and `docs/s3.md` (served at /guide/s3) explain turning it on, getting a key,
  and connecting with the `aws` CLI, `rclone`, and the SDKs.

## Non-goals

- Buckets as hostnames; the S3 API from outside the local networks; replication; the RustFS console
  signing in with the Linux password (it takes an access key and secret).

## Success Criteria _(mandatory)_

- Exercised against `rustfs/rustfs:1.0.5` (the pinned digest) under Podman 4.9 during development:
  started with the Quadlet's own options, ready in seconds; Archon's user sequence (`rc` inside the
  container, the secret through the environment) made two users with keys owned by their accounts,
  and a second run changed nothing; with its own key a user created, wrote, and read its `<name>-*`
  bucket, was refused another bucket and another's objects, and was locked out once disabled;
  `archon fs s3 key --write` as that user wrote a working profile, and an account with no key got
  one sentence.
- `tests/optin_test.ts` covers the rest that runs without a server.

## Keys: showing and rotating

- **FR-K1** The web console signs in with Account: the username and Key: the S3 secret, never the
  Linux password; `archon fs s3 key`, `fs s3 status`, `fs s3 on`, the guide, and `docs/s3.md` say
  so. `archon fs s3 key --show` prints the person's own secret on their terminal (refused for JSON,
  a pipe, MCP, and agents).
- **FR-K2** `archon fs s3 key --rotate` (mutate, through sudo, for the person behind sudo): a new
  32-byte secret set in RustFS through Podman's environment and written to the key file at once
  (0400, the account's), so the old one stops working. Only the fact is journaled (`archon-s3`). A
  command whose flag changes the host (`Command.mutateWith`) elevates with that flag, counts as
  mutate over MCP, and always asks in the agent's permissions.
