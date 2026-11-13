# Plan: 044-durable

- `src/archon/model/durable.ts`: sources, `hostData`, `describeData`, `chooseData`,
  `confirmDestroy`, `durablePaths`, `durableGuests`, the shared arguments.
- `src/archon/model/types.ts`: `DataClass`; `OptInRecord.data`; `GuestDef.data` (required).
  `load.ts` reads `data`; `validate.ts` requires a guest's.
- `src/archon/optin/optin.ts`: the forced choice in `setOptIn`, `checkChoice`, the class in
  `archon opt-in`. `src/archon/optin/data.ts`: `archon data` and `archon data set`.
- `src/archon/core/registry-types.ts`: `ArgSpec.human`, refused under `ARCHON_AGENT`;
  `src/archon/mcp/server.ts`: not offered, refused when passed.
- `src/archon/commands/registry.ts`: `--durable|--ephemeral` on `pg on`, `fs s3 on`, `fs smb on`;
  `data`, `data set`; `--confirm-destroy` on the destructive pg commands.
- `src/archon/capabilities/backup.ts`, `src/archon/backup/backup.ts`: durable paths, guest exports,
  the off-host warning.
- `src/archon/capabilities/data.ts`, `src/archon/render/motd.ts`, `src/archon/shell/emit.ts`,
  `src/archon/shell/archon.omp.json`, `src/archon/web/*`, `src/archon/observe/fleet-status.ts`:
  where the class shows.
- `src/archon-boot/reinstall.ts`, `src/archon-boot/main.ts`: the reinstall and arm guards.
- Docs: the constitution (Article 23), `docs/guide.md`, `docs/pg.md`, `docs/s3.md`, `docs/smb.md`,
  `docs/disaster-recovery.md`. Tests: `tests/durable_test.ts`.
