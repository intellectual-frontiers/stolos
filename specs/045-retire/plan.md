# Plan: 045-retire

`src/archon-boot/retire.ts` (the command), `src/archon/install/publish.ts` (build, commit the
touched paths, push; shared with `archon host add`), `deleteRecords` in
`src/archon/web/cloudflare.ts`, `removeDeployKey` in `src/archon/install/host-add.ts`, the wiring
and usage in `src/archon-boot/main.ts`, `docs/hosts.md` ("Retire a host"), `docs/boot-machine.md`,
`tests/retire_test.ts`.
