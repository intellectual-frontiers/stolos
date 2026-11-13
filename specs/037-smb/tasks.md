# Tasks: 037-smb

- [x] T001 Operator switches for units (UnitDef.switch, state/hosts/<host>/<switch>.json), unmask on
- [x] T002 Samba on every server: smb.conf from the model (testparm), shared and homes, nmbd masked,
      445 local networks only
- [x] T003 archon fs smb on | off | status
- [x] T003b Same username and password as Linux: PAM profile (pam-auth-update) and the password hook
      (password-sync, shared with PostgreSQL)
- [x] T004 Samba's password database in nightly backups
- [x] T005 Guide entry, docs/smb.md (served at /guide/smb), tests
- [ ] T006 On alpha: archon fs smb on, log in to Cockpit once, map
      \\smb.alpha.lab.example.net\shared from Windows; testparm on the real file
