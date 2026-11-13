# Plan: 039-pg-identity

- **Model**: `FleetDef.services` (`ServiceDef`), `PgDatabaseDef` (owner, write, read, extensions) ,
  the switch is spec 040's. Validation in `validate.ts`.
- **Pure core** (`src/archon/pg/config.ts`): roles from people and services, `roleSql`, access roles
  and their SQL, `desiredMembers`, `membershipSql`, `hbaConf` (postgres rejected over networks),
  `scramMatches`, `connectInfo` (socket by default), `systemServices`, `sudoersPg`.
- **Converge** (`src/archon/pg/converge.ts`): identities, access, services' passwords, cleanup;
  `writeSystemServices`. Apply's Databases step runs while PostgreSQL is on.
- **Capabilities**: `services.ts` (sysusers, tmpfiles), `passwords.ts` (the PAM hook for Samba and
  PostgreSQL), `pg.ts` (tooling and the masked umbrella unit always; sudoers, checks, and dumps
  while on).
- **Commands**: `pg on`, `pg off`, `pg who`, `pg passwd-sync` (PAM only), `pg connect --remote`;
  `ensure` refuses while off.
- **Tests**: `tests/pg_identity_test.ts`; spec 038's tests updated.
