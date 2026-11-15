# Feature Specification: First boot

**Feature Branch**: `005-first-boot` (committed directly to main) **Created**: 2026-11-10
**Status**: Implemented **Input**: On its first boot a host clones the repository with its deploy
key, converges, verifies, and pushes its first record.

## User Scenarios & Testing _(mandatory)_

### User Story 1 (Priority: P1)

As the owner, I want a freshly installed host to finish setting itself up and prove it can reach
GitHub, with nothing for me to do (spec 030: no agent sign-in).

**Acceptance Scenarios**:

1. **Given** Ubuntu's installer finished, **When** the host boots, **Then** cloud-init runs
   `/usr/local/sbin/archon-first-boot`: it installs the pinned Bun (its SHA-256 checked before
   unpacking), clones the repository to `/srv/archon` with the deploy key, installs the engine
   (`bun install --frozen-lockfile`), and runs `archon first-boot`.
2. **Then** `archon first-boot` applies the host, moves the deploy key to `ops`, verifies, and
   pushes `state/hosts/<host>/installed.json` as `005-first-boot: <host> installed`. The record
   lists every step that failed or warned (`ok`, `problems`), and the commit subject counts them, so
   a partial first boot is visible in the repository.

## Requirements _(mandatory)_

- **FR-001**: The first-boot script is the only shell Archon renders; it hands over to TypeScript at
  once.
- **FR-002**: Without a deploy key (public repository or an authenticating site proxy), it clones
  over HTTPS.
- **FR-003**: Logs go to `/var/log/archon-first-boot.log` and the run log in `/var/log/archon/`.
- **FR-004**: Each phase and a final `Ready` line (checks, problems) are reported to the boot
  server's window (spec 004 FR-015), best effort; the report URL is removed when the first boot
  ends.

### Overrides of Ubuntu defaults

None.

## Success Criteria _(mandatory)_

- **SC-001**: In the e2e test, the first record appears on GitHub with no input.

### User Story 2: Manual installs (Priority: P2)

As the owner, when a server cannot network-boot, I want to install Ubuntu Server from the ISO with
its defaults and have Archon finish it the same way.

**Acceptance Scenarios**:

1. **Given** Ubuntu Server 26.04 installed by hand (fleet admin as the username, OpenSSH with keys
   imported from GitHub), **When** `archon host bootstrap <host> --ssh <user>@<address>` runs on the
   boot machine, **Then** it copies the host name, GitHub's host keys, the first-boot script, and
   the deploy key over SSH and runs the same first boot with sudo.
