# Feature Specification: /etc history

**Feature Branch**: `033-etckeeper` (committed directly to main) **Created**: 2026-11-12 **Status**:
Implemented **Input**: Install etckeeper on every server: a local history of every change to /etc,
attributed to apt, unattended-upgrades, archon, or a person.

## User Scenarios & Testing _(mandatory)_

1. **Given** unattended-upgrades changed a configuration file overnight, **When** the owner runs
   `sudo etckeeper vcs log -p`, **Then** the change is one commit made by the apt hook.
2. **Given** `archon apply` changed files in /etc, **When** it finishes, **Then** etckeeper has one
   commit "archon apply: N change(s) (<specs>)" listing the changes.
3. **Given** someone added a remote to /etc's repository, **When** `archon verify` runs, **Then** it
   fails: the history holds secrets and never leaves the host.

## Requirements _(mandatory)_

- **FR-001**: Ubuntu's `etckeeper` package with Ubuntu's configuration: git, commits before and
  after every apt run, and a daily commit (`etckeeper.timer`, enabled).
- **FR-002**: After an `archon apply` that changed something, archon commits /etc through
  `etckeeper commit` when it is unclean, with the specs and the changes in the message.
- **FR-003**: `/etc/.git` exists (warn) and has no remote (fail). It stays root-only (etckeeper's
  own permissions) and is never pushed (Article 13).

### Overrides of Ubuntu defaults

None.
