# Feature Specification: Backups

**Feature Branch**: `016-backups` (committed directly to main) **Created**: 2026-11-10 **Status**:
Implemented **Input**: Anything that holds state is backed up and restore-tested (Article 14).

## Requirements _(mandatory)_

- **FR-001**: Daily (timer, 02:37) zstd tar archives of `/etc`, `/home`, `/root`, `/var/lib/archon`,
  and LXD's database into `/var/backups/archon` (Ubuntu's backup location), keeping 14; each host
  may override paths, target, retention, and schedule (`backup` in its model).
- **FR-002**: `archon backup verify` restore-tests the newest archive; `archon backup restore`
  extracts into a directory to inspect, never in place.
- **FR-003a**: Every failed backup is emailed with its log, and a summary of successful backups once
  a week (spec 025).

### Overrides of Ubuntu defaults

None (Ubuntu ships no server backup; /var/backups is its location for them).

## Assumptions

- The repository itself is backed up by GitHub; host backups do not cover it.
