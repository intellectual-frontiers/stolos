# Tasks: 039-pg-identity

- [x] T001 Off by default (the opt-in switch, spec 040); ensure refuses while off
- [x] T002 Fleet service accounts (sysusers, fixed UIDs, no password, no shell), validated
- [x] T003 Databases with owner, write, read (@group); login roles from people and services; access
      roles; members kept exact
- [x] T004 pg_hba: peer on the socket; postgres never over a network; scram otherwise
- [x] T005 Superuser only through sudo; operators act as an app with sudo -u
- [x] T006 One PAM hook for Samba and PostgreSQL (published instances only)
- [x] T007 connect: you as yourself, socket by default, --remote; the system-wide service file
- [x] T008 archon pg who, in verify; converge disables login roles without a Linux account and
      removes extra superusers
- [x] T009 Archon's code, specs, and docs name no app (apps are the fleet's data)
- [x] T010 Exercised against PostgreSQL 16 in a sandbox (see the spec's success criteria); tests
- [ ] T011 On alpha: archon update, archon pg on, archon pg who prime, psql service=prime as a
      person and as the app's account, archon verify, archon push
