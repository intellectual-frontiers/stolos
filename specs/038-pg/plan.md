# Plan: 038-pg

- **Model**: `PgInstanceDef`, `PgRoleDef`, `PgRecord`, `PgState` in `src/archon/model/types.ts`;
  `HostDef.pg` (model) and `HostDef.pgState` (read from `state/hosts/<host>/pg.json` by
  `loadHosts`). Validation in `validate.ts`.
- **Pure core** `src/archon/pg/config.ts`: instances (model ∪ record), roles, port allocation,
  `conf.d/50-archon.conf`, `pg_hba.conf`, role/database SQL, SCRAM verifier, service block, .pgpass,
  `pg_lsclusters` parsing, ownership, PGDG source, approve marker.
- **Converge** `src/archon/pg/converge.ts`: one instance to the model, reporting to a sink (apply's
  runner, or a command's collector). Apply gains a Databases phase after Units.
- **Capability** `src/archon/capabilities/pg.ts`: postgresql-common and zstd, `createcluster.d`,
  tmpfiles for secrets and dumps, published ports (Archon-LAN), unit checks, the nightly dump timer.
  Nothing on a server with no instances.
- **Commands** `src/archon/pg/commands.ts`, registered in `registry.ts`; `Command.precheck`
  (main.ts) lets `ensure` answer unprivileged when satisfied.
- **Prompt** `home/dot_psqlrc`; **docs** `docs/pg.md` (served at /guide/pg, `man 7 archon-pg`);
  guide entry.
- **Tests** `tests/pg_test.ts`.
