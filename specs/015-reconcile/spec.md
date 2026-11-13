# Feature Specification: Update and reconcile

**Feature Branch**: `015-reconcile` (committed directly to main) **Created**: 2026-11-10 **Status**:
Implemented **Input**: Hosts converge to the repository (Article 9), on a timer and on demand.

## Requirements _(mandatory)_

- **FR-001**: `archon reconcile` (timer, every 15 minutes) fetches the fleet's branch as `ops`,
  fast-forwards a clean checkout, and applies only when HEAD equals the remote.
- **FR-002**: `archon update [--check]` pulls, validates (an invalid model stops it), applies, syncs
  tools, re-applies dotfiles when tools changed, and verifies.
- **FR-003**: One host-changing archon run at a time (`/run/archon.lock`): interactive runs wait,
  the timer skips, and children inherit the lock.

### Overrides of Ubuntu defaults

None.
