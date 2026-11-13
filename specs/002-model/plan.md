# Implementation Plan: Model

**Spec**: [spec.md](spec.md)

- `src/archon/model/types.ts`: fleet, host, user, capability, plan types.
- `src/archon/model/load.ts`: load `fleet.ts` and `hosts/*.ts`; the admin and ops accounts.
- `src/archon/model/resolve.ts`: capabilities into a plan, merge rules.
- `src/archon/model/validate.ts`: every rule with message and fix; the secret scanner.
- `src/archon/build.ts`: validate, resolve, render to `out/hosts/<host>/rootfs/...`.
- `src/archon/commands/registry.ts`: `validate`, `build`, `export`.
