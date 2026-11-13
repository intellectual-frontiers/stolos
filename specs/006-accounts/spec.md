# Feature Specification: Accounts and personas

**Feature Branch**: `006-accounts` (committed directly to main) **Created**: 2026-11-10 **Status**:
In progress **Input**: The fleet admin and `ops` on every host, Archon's persona groups, and the
operator sudo rule.

## Requirements _(mandatory)_

- **FR-001**: The admin account is the one Ubuntu's installer creates from the fleet identity (spec
  003); it stays in Ubuntu's `sudo` group.
- **FR-002**: `ops` (the operator account; serves `archon mcp` to workstations, Article 17,
  spec 030) is created by `archon apply` with the operator persona; its SSH keys are forced to
  `archon mcp --max-tier <tier>`.
- **FR-003**: Groups `archon`, `archon-dev`, `archon-ops` come from sysusers.d; operators get
  passwordless sudo for `/usr/local/bin/archon` only.
- **FR-004**: `ops` reaches GitHub over SSH with the host's deploy key (`~ops/.ssh/config`).

### Overrides of Ubuntu defaults

None.
