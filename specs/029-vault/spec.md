# Feature Specification: The secrets vault

**Feature Branch**: `029-vault` (committed directly to main) **Created**: 2026-11-11 **Status**:
Implemented **Input** (revised 2026-11-11: the owner decided the Personal Vault's own encryption is
enough; secrets are copied as they are, with no age and no passphrase): The boot machine (BOOTPC)
holds the only copies of the fleet's secrets: the admin password hash, each host's deploy key and
SSH host keys, the mail relay token. Losing it must be routine (constitution Article 22): back them
up encrypted to the owner's OneDrive Personal Vault, remind until backed up, and restore onto a new
PC from the repo plus the vault (Article 13).

## User Scenarios & Testing _(mandatory)_

1. **Given** secrets changed since the last backup, **When** any command finishes (or `boot serve`
   or `boot status` starts), **Then** one framed panel lists them by name with the command to run;
   `boot doctor` warns; the prompt shows 🔐 backup; after 24 hours one email names them, then
   weekly.
2. **Given** the Personal Vault is unlocked, **When** the owner runs `deno task boot vault backup`,
   **Then** the secrets are copied into a new folder there with a manifest, read back, and checked,
   and every reminder stops.
3. **Given** a new PC, **When** the owner restores from the vault, **Then** the secrets come back
   with owner-only permissions, `known_hosts` is rebuilt, and `boot doctor` runs.
4. **Given** no backup at all, **When** the owner runs `vault status --lost`, **Then** each secret's
   rebuild steps are printed.

## Requirements _(mandatory)_

- **FR-001**: Commands in the one registry (Article 6), run as `deno task boot vault <sub>` (also
  `deno task archon vault <sub>`), never offered over MCP (`noMcp`): `status [--lost]`,
  `backup [--to <dir>] [--wait]`, `verify [--file]`, `restore [--file] [--dry-run] [--force]`,
  `rehearse [--file]`, `list`, `prune [--keep 12]`, `recover-host-keys <host>`; on hosts,
  `archon host-keys export` (root, `noMcp`) serves `recover-host-keys`.
- **FR-002**: `vault status` lists every file in the secrets folder with its inventory label (spec
  028), when it changed, and whether the last backup holds it as it is now (by SHA-256): ✓, ⚠
  (newer), or · (ephemeral). Exit 1 if anything is newer than the last backup. `--lost` prints each
  inventory entry's `recreate`. It writes the prompt status, installs the pre-push hook, and sends
  due reminders.
- **FR-003**: `vault backup`: the default target is `%OneDrive%\Personal Vault\Archon\`; a locked
  vault (folder absent or unreadable) prints the unlock steps; `--wait` polls up to 10 minutes. It
  copies every non-ephemeral secret as it is into a new folder `archon-secrets-<pc>-<UTC>\` (the
  secrets folder's own layout) with `manifest.json` (format, PC, time, Archon commit, and each
  secret's name, SHA-256, and size; no value), then reads every file back and checks its SHA-256
  before reporting success. Ephemeral secrets (install tokens) are left out.
- **FR-004**: Protection (revised 2026-11-11, the owner's decision): the OneDrive Personal Vault
  encrypts the files, requires a second sign-in (Windows Hello or a code) to open, and locks after
  20 minutes idle; Archon adds no encryption and asks for no passphrase, so a backup can be copied
  back by hand without Archon. Superseded: age with a passphrase. A destination outside the Personal
  Vault (`--to`, `ARCHON_VAULT_DIR`) is accepted, and Archon says the files there are stored as they
  are.
- **FR-005**: `vault verify` checks the newest (or a given) backup against its manifest and compares
  it with the live secrets by name: missing, changed, extra. `vault rehearse` restores into a
  temporary folder, compares, removes it, records the rehearsal; archon notify reminds after 30 days
  without one.
- **FR-006**: `vault restore` shows the plan, writes each secret with owner-only permissions (POSIX
  0600; Windows: inheritance removed, full control for the user only, `icacls`), rebuilds
  `known_hosts` from the hosts' public keys (their `ip` and `dnsName`), then runs `boot doctor`. It
  refuses to overwrite a live secret newer than the backup without `--force`; `--dry-run` writes
  nothing.
- **FR-007**: `vault list` and `vault prune --keep N` (at least 1: the newest is never removed).
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
  (`%LOCALAPPDATA%\archon\vault\ledger.json`). A test fails on any direct write into the secrets
  folder.
- **FR-010**: Reminders (calm, Article 19): one framed panel at the end of any command that changed
  a secret (amber; red when anything has been unbacked for more than 7 days or host identity keys
  were never backed up), and at the start of `boot serve` and `boot status`, until backed up;
  `boot doctor` reports it as a warning (a failure when red) whose fix is the command; `fleet init`
  (and `vault status`, `boot doctor`) install a non-blocking git pre-push hook that prints the
  panel; after 24 hours unbacked, one "[Archon] <pc>: N secrets not backed up" email (names only),
  then weekly (`boot serve` checks hourly); the prompt status file
  (`%LOCALAPPDATA%\archon\status\prompt-vault`) holds `🔐 backup` while unbacked, and the oh-my-posh
  theme colors it amber.

- **FR-012**: The destination is `--to <folder>` on every vault command, else `ARCHON_VAULT_DIR`,
  else OneDrive's Personal Vault; each run shows it (📁 vault), and each step is shown as it
  happens.
- **FR-013**: `vault rehearse` with no backup yet rehearses the round trip with the live secrets
  (copy into a temporary folder, read back, compare); it warns that no backup exists and changes
  nothing.
- **FR-014**: The ledger's last backup counts only if it is really there: the ledger records the
  destination folder, and `assess` (behind `vault status`, the panel, `boot doctor`, and the
  reminders) checks that the backup's folder and manifest exist there and match the record. The
  destination unreachable (the Personal Vault locked): "recorded <date>, not verifiable: Personal
  Vault locked", the secrets shown as not verified, the reminder amber (never "never backed up",
  never ✓). Reachable but the backup gone or different: treated as never backed up ("the recorded
  backup is gone"). A record without a folder (older ledgers) is checked against the default vault.
- **FR-015**: Tests never touch the boot machine's real secrets: tests that run archon as a
  subprocess use `tests/sandbox.ts` (a cleared environment with every per-user root, HOME,
  USERPROFILE, APPDATA, LOCALAPPDATA, XDG__, OneDrive, inside a temporary folder; a probe that fails
  unless the secrets, ledger, vault, prompt status, and log paths resolve inside it);
  `ARCHON_SANDBOX` makes archon refuse to start if any per-user path escapes it and skips the git
  hook; the vault tests hash the real archon folders before and after and fail if anything changed.
  (A sandbox that set only HOME and XDG__ let `deno task test` on Windows run vault commands against
  the real `%APPDATA%\archon\secrets` and overwrite the real ledger with a backup that no longer
  existed.)
- **FR-011**: `docs/disaster-recovery.md`: with a backup (tools by winget, `gh auth login`, clone,
  unlock the Personal Vault, `vault restore`, the boot server's address in UniFi or
  `site.bootServer.address` with validation listing the UniFi changes, Windows Firewall rules,
  `boot doctor`, `vault rehearse`, `archon doctor --send` on each host); without one
  (`vault status --lost`); and the gap outside Archon (the owner's own SSH key and `gh` login: a
  second admin SSH key is recommended).

### Overrides of Ubuntu defaults

None: this runs on the boot machine.

## Success Criteria _(mandatory)_

- **SC-001**: On BOOTPC, `deno task boot vault status` lists the admin hash, install tokens
  (ephemeral), `mail.json`, and alpha' deploy key and host keys as never backed up, with the panel.
- **SC-002**: backup (copied as they are, ephemeral left out, a manifest with no values), status,
  verify, rehearse (with and without a backup), restore (a lost secret back, a newer one kept),
  prune, and `ARCHON_VAULT_DIR` pass in tests.
