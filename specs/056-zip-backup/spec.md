# 056: The backup is one ZIP you keep (revises 029)

## Why

Spec 029 copied the secrets into a OneDrive Personal Vault folder and restored them by command. It
tied the backup to one product (locked after 20 minutes, Windows only), and a restore that writes
secrets is a command you run once in a disaster, never tested by use. A backup should be one file
you put wherever you keep important things, holding everything a new boot machine needs, and its
restore should be a few steps you can read.

## Requirements

- **FR-001** `deno task boot vault backup` writes `archon-backup-<pc>-<UTC>.zip` into archon's
  backup folder, beside its other data (`%LOCALAPPDATA%\archon\backup`; Linux and macOS:
  `~/.local/share/archon/backup`), readable by its owner only.
- **FR-002** The ZIP holds every fleet's non-ephemeral secrets on this PC (`secrets/<fleet>/...`),
  the signing key Git uses (`git config user.signingkey`: both halves, under `signing/`; the private
  half stays locked by its passphrase), `manifest.json` (names, sizes, SHA-256; never a value), and
  `RESTORE.txt`.
- **FR-003** It reads the ZIP back and checks every file's SHA-256 before saying it worked, then
  records the backup in the ledger.
- **FR-004** It then tells the person where the ZIP is and to move it somewhere safe and encrypted,
  that the ZIP itself is not encrypted, and to keep the recovery key apart. No signing key: a
  warning, with the fix.
- **FR-005** `vault restore` prints the restore steps (the same as `RESTORE.txt`) and changes
  nothing. (Revised by spec 061: `vault restore <zip>` restores, after checking the ZIP, never
  overwriting.)
- **FR-006** `vault list` lists the ZIPs still in the backup folder. A moved ZIP still counts as the
  last backup (the record); `vault status` points out a ZIP not yet moved.
- **FR-007** `verify`, `rehearse`, `prune`, the Personal Vault detection (`--to`, `--wait`,
  `ARCHON_VAULT_DIR`), and the rehearse reminder are removed.

## Success criteria

- **SC-001** `tests/vault_test.ts`: the ZIP's contents (secrets, signing key, no ephemeral token, no
  value in the manifest), owner-only, status before and after a move, restore changes nothing.
