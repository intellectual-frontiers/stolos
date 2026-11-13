# Plan: 029-vault

- `src/archon/core/secret-ledger.ts`: the ledger; `recordChange()` from
  `writeSecret()`/`removeSecret()`.
- `src/archon/core/secrets.ts`: `writeSecret()` (records, Windows owner-only ACL), `removeSecret()`.
- `src/archon/vault/state.ts`: live secrets (SHA-256), the assessment, the vault folder, the prompt
  status.
- `src/archon/vault/commands.ts`: the commands (a backup is a folder of the files and a manifest);
  `panel.ts`, `reminder.ts`: panel, email, hook.
- `src/archon/core/ui.ts`: `ui.panel`, printed once by `finish()` or by the entry point at exit;
  `ui.say()` for the destination line.
- `src/archon/install/host-add.ts`, `host-keys.ts`: `ssh-keygen` into a temporary folder, then
  `writeSecret()`; `exportHostKeys()`.

## Decisions

- The Personal Vault is the encryption (the owner's decision, 2026-11-11): files copied as they are,
  in the secrets folder's own layout, so restoring by hand needs only a file copy. The first version
  encrypted a bundle with age and a passphrase; it was removed.
- A manifest per backup (names, SHA-256, sizes) lets backup read itself back, and verify and
  rehearse check a backup on their own.
