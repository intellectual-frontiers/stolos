# Tasks: 029-vault

- [x] T001 Ledger; every secret write through writeSecret (ssh-keygen moved onto it); coverage test
- [x] T002 vault status, backup (read back and verified), verify, restore, rehearse, list, prune
- [x] T003 Backups copied as they are into the Personal Vault (age and the passphrase removed: the
      owner's decision)
- [x] T004 recover-host-keys and archon host-keys export
- [x] T005 Panel (ui.finish and at exit), boot serve and status, doctor warning, pre-push hook,
      email reminders, prompt status
- [x] T006 Tests: the whole flow in a throwaway home
- [x] T008 docs/disaster-recovery.md
- [x] T009 The last backup counts only if it is there (locked: not verifiable, amber; gone: never
      backed up)
- [x] T010 Tests sandboxed on Windows too (cleared environment, path probe, ARCHON_SANDBOX guard,
      real folders hashed before and after)
- [ ] T007 On BOOTPC: vault status (expect never backed up), vault backup, vault rehearse
