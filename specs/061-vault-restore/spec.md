# 061: `vault restore <zip>`: a fresh PC from one backup (revises 056 FR-005)

## Why

Spec 056 made the backup one ZIP holding everything a disaster needs (spec 057 added both keys), but
its restore was a page of steps to copy by hand: folders, permissions, `icacls`, `.ssh`, the key
store, then `keys setup`. Those steps run once, in a disaster, on a PC that is not set up yet: the
worst time to get one wrong. After cloning the fleet repository, one command should put everything
back, check it, and set up signing, the same way every time (constitution Article 22: a documented,
rehearsed procedure).

## Requirements

- **FR-001** `deno task stolos vault restore <zip>`, run in the freshly cloned fleet repository,
  reads the ZIP and checks it before writing anything: a stolos backup (`manifest.json`, format
  `stolos-backup/1`), every file present and matching its SHA-256, and every file in one of its
  places (`secrets/<fleet>/...`, `signing/<file>`, `signing/recovery/<file>`; no other path, no
  `..`).
- **FR-002** The fleet: the backup's fleets must include one of this repository's (else: the wrong
  repository, nothing written). When none is chosen here and exactly one matches, it is chosen
  (`fleet use`).
- **FR-003** The files go where stolos keeps them: the secrets into the secrets folder, readable by
  their owner only; the daily key into `.ssh` (private half owner only, as OpenSSH requires); the
  recovery key (and any retired one) into the key store.
- **FR-004** It never overwrites. A file already there with the same bytes is kept; a file that
  differs (it may be newer than the backup) stops the restore before anything is written, naming it.
  Run again, it changes nothing.
- **FR-004a** `--destroy-existing` restores clean, after the ZIP is checked: every fleet's secrets,
  the key store, and the backup's daily key files in `.ssh` go first, so what is left is exactly the
  backup. Anything there the backup does not hold identically is first saved as a backup ZIP of its
  own (if that fails, nothing is removed); a daily key file in `.ssh` that differs is moved aside as
  `<file>.replaced-<date>`, never deleted; no other `.ssh` file is touched. The change history of
  the secrets starts again. Only a person types it (never an agent).
- **FR-005** The ZIP is recorded as the last backup: `vault status` shows every restored secret as
  backed up.
- **FR-006** Then `keys setup` (Git's signing for this checkout, the pre-push check, one test
  signature: the daily passphrase), and the engine's types for VS Code. When the ZIP held both keys,
  no "back up" reminder. `--files-only` stops after the files.
- **FR-007** Without a ZIP, `vault restore` prints the steps (the command first, then by hand), the
  same as `RESTORE.txt` in every ZIP. Never offered over MCP.

## Success criteria

- **SC-001** `tests/vault_test.ts`: a backup, the PC wiped, a restore (`--files-only`) puts back
  every secret and both keys owner-only; `vault status` is clean; again: nothing written; a file
  that differs: nothing written, named; `--destroy-existing`: exactly the backup, what it lacked
  saved in a ZIP first, a different daily key moved aside, a GitHub key untouched; a damaged ZIP and
  a non-ZIP refused; no path escapes.
- **SC-002** `tests/keys057_test.ts`: real keys with passphrases: setup, commit, backup, the PC
  wiped, a fresh clone, `vault restore <zip>`: signing set up and a test signature verified; `keys`
  clean; again: unchanged.
