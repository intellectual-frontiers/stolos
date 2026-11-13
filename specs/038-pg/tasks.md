# Tasks: 038-pg

- [x] T001 Model: instances, roles, the host's record (loadHosts), validation; alpha declares prime
      (its databases are the fleet's data, spec 039)
- [x] T002 Pure core: instances, ports, configuration, pg_hba, roles, SCRAM verifiers, service and
      pgpass, ownership
- [x] T003 Converge and apply's Databases phase (check mode changes nothing)
- [x] T004 Capability: createcluster.d, tmpfiles, published ports, unit checks, nightly dumps
- [x] T005 Commands: list, status, ensure (precheck), start/stop/restart/reload, backup, restore,
      maintain, publish, unpublish, connect, upgrade, remove; destructive guard
- [x] T006 home/dot_psqlrc: the prompt, protected databases, unicode tables
- [x] T007 docs/pg.md (guide, man 7), guide entry, tests
- [x] T008 Exercised against PostgreSQL 16 clusters on Ubuntu 24.04: converge twice, an app
      account's ensure and connect, psql prompt, publish config with TLS, backup and restore,
      foreign cluster refused
- [ ] T009 On alpha: archon apply --check, archon update (prime created), archon pg ensure <second>
      --version 17, archon pg list, archon pg connect prime --write, psql service=prime,
      publish/unpublish, archon verify, archon push
