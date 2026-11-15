# Feature Specification: The secrets vault

**Feature Branch**: `029-vault` (committed directly to main) **Created**: 2026-11-11 **Status**:
Implemented **Input** (revised 2026-11-11: the owner decided the Personal Vault's own encryption is
enough; secrets are copied as they are, with no age and no passphrase): The boot machine (BOOTPC)
holds the only copies of the fleet's secrets: the admin password hash, each host's deploy key and
SSH host keys, the mail relay token. Losing it must be routine (constitution Article 22): back them
up encrypted to the owner's OneDrive Personal Vault, remind until backed up, and restore onto a new
PC from the repo plus the vault (Article 13).

The backup itself and its restore are governed by spec 056 (one ZIP the owner keeps, no Personal
Vault) and spec 061 (`vault restore <zip>`). This spec keeps what stays the same: the commands'
place in the registry, `vault status`, the ledger, the reminders, recovery of host keys without a
backup, the disaster-recovery guide, and the test sandbox.

## User Scenarios & Testing _(mandatory)_

1. **Given** secrets changed since the last backup, **When** any command finishes (or `boot serve`
   or `boot status` starts), **Then** one framed panel lists them by name with the command to run;
   `boot doctor` warns; the prompt shows 🔐 backup; after 24 hours one email names them, then
   weekly.
2. **Given** no backup at all, **When** the owner runs `vault status --lost`, **Then** each secret's
   rebuild steps are printed.

## Requirements _(mandatory)_

- **FR-001**: Commands in the one registry (Article 6), run as `bun run stolos vault <sub>`, never
  offered over MCP (`noMcp`): `status [--lost]`, `backup`,
  `restore [<zip>] [--files-only] [--destroy-existing]`, `list`, `recover-host-keys <host>`; on
  hosts, `archon host-keys export` (root, `noMcp`) serves `recover-host-keys`.
- **FR-002**: `vault status` lists every file in the secrets folder with its inventory label (spec
  028), when it changed, and whether the last backup holds it as it is now (by SHA-256): ✓, ⚠
  (newer), or · (ephemeral). Exit 1 if anything is newer than the last backup. `--lost` prints each
  inventory entry's `recreate`. It writes the prompt status, installs the pre-push hook, and sends
  due reminders.
- **FR-008**: `vault recover-host-keys <host>` pulls a running host's SSH host keys and ops' deploy
  key over SSH (`archon host-keys export` there) into the secrets folder and trusts the host keys
  again, for a boot machine lost without a backup: the rebuilt boot machine holds the same
  identities, so nothing changes on GitHub or for SSH clients. `fleet init` keeps an existing
  `fleets/<fleet>/fleet.ts` (and its admin account) and only stores the password hash and the
  checkout's git identity again (`--rewrite` starts it over); `host add` without `--force` keeps the
  host's model and makes a deploy key only if none is there.
- **FR-009**: Every secret write goes through `writeSecret()` (and removal through
  `removeSecret()`), including the deploy keys and SSH host keys `ssh-keygen` makes (into a
  temporary folder, then stored); each records `{name, changedAt}` in a non-secret ledger
  (`%LOCALAPPDATA%\stolos\vault\ledger.json`; Linux and macOS:
  `~/.local/share/stolos/vault/ledger.json`). A test fails on any direct write into the secrets
  folder.
- **FR-010**: Reminders (calm, Article 19): one framed panel at the end of any command that changed
  a secret (amber; red when anything has been unbacked for more than 7 days or host identity keys
  were never backed up), and at the start of `boot serve` and `boot status`, until backed up;
  `boot doctor` reports it as a warning (a failure when red) whose fix is the command; `fleet init`
  (and `vault status`, `boot doctor`) install a non-blocking git pre-push hook that prints the
  panel; after 24 hours unbacked, one "[Archon] <pc>: N secrets not backed up" email (names only),
  then weekly (`boot serve` checks hourly); the prompt status file
  (`%LOCALAPPDATA%\stolos\status\prompt-vault`) holds `🔐 backup` while unbacked, and the oh-my-posh
  theme colors it amber.

- **FR-015**: Tests never touch the boot machine's real secrets: tests that run archon as a
  subprocess use `tests/sandbox.ts` (a cleared environment with every per-user root, HOME,
  USERPROFILE, APPDATA, LOCALAPPDATA, XDG__, OneDrive, inside a temporary folder; a probe that fails
  unless the secrets, ledger, vault, prompt status, and log paths resolve inside it);
  `ARCHON_SANDBOX` makes archon refuse to start if any per-user path escapes it and skips the git
  hook; the vault tests hash the real archon folders before and after and fail if anything changed.
  (A sandbox that set only HOME and XDG__ would let the suite on Windows run vault commands against
  the real `%APPDATA%\stolos\secrets` and overwrite the real ledger with a backup that does not
  exist.)
- **FR-011**: The disaster-recovery guide (the `@module` JSDoc of `src/archon/vault/mod.ts`, spec
  070): with a backup ZIP (the bootstrap one-liner of spec 062 for the tools and the clone,
  `vault restore <zip>`, the boot server's address in UniFi or `site.bootServer.address` with
  validation listing the UniFi changes, Windows Firewall rules, `boot doctor`, `vault status`,
  `archon doctor --send` on each host); without one (`vault status --lost`); and the gap outside
  Archon (the owner's own SSH key and `gh` login: a second admin SSH key is recommended).

### Overrides of Ubuntu defaults

None: this runs on the boot machine.

## Success Criteria _(mandatory)_

- **SC-001**: On BOOTPC, `bun run stolos vault status` lists the admin hash, install tokens
  (ephemeral), `mail.json`, and alpha' deploy key and host keys as never backed up, with the panel.
- **SC-002**: status (before and after a backup, `--lost`), the ledger, the reminders, and
  `recover-host-keys` pass in tests; backup and restore are tested as specs 056 and 061 say.
