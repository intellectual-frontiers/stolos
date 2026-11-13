# Tasks: 041-s3

- [x] T001 RustFS in the container catalog, pinned by digest; Quadlet; routes
- [x] T002 Generated admin credentials before the first start (root only, outside /etc)
- [x] T003 Identities: people and fleet service accounts, policies <name>-*, keys owned by each
      account; disable what is no longer wanted
- [x] T004 archon fs s3 on | off | status | key
- [x] T005 docs/s3.md, guide entry, tests; exercised against the real image
- [ ] T006 On alpha: archon fs s3 on, archon fs s3 key --write, aws --profile s3-alpha s3 mb
      s3://<you>-files, archon verify, archon push
