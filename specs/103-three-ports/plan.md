# Implementation Plan: The controller opens three ports

**Branch**: `103-three-ports` (committed directly to main) | **Date**: 2026-11-17 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/103-three-ports/spec.md`

## Summary

Article 29 makes the controller PC's inbound ports three: UDP 69 and TCP 8080 (the boot server) and TCP 443 (the console over TLS).
The ports are facts of the ontology and one module (`core/listeners.ts`) gives them to the code. Pairing (spec 098) leaves TCP 7457
for `/device/pair`, served by two doors (the boot server's HTTP, and the console's TLS) from one handler over one short-lived file
that `stolos pair` writes and the doors read; the console's 8443 fallback (spec 100) is removed, with a refusal that names what
holds 443; a test scans `src/` so that a new listener elsewhere fails.

## Technical Context

**Language/Version**: TypeScript 7, run by Bun, with Node 26 as the backup (Article 4, spec 096-bun-runtime)

**Primary Dependencies**: IFC TypeScript's kernel and runtime (`@intellectual-frontiers/commons`: `lock`, `fs`, `tcp`, `dns`), `node:https`

**Storage**: the pairing's file in the secrets folder (`pair/pairing`, with `-lock` and `-tmp`), ephemeral; nothing in Git

**Testing**: `tests/ports103.test.ts`, `tests/pair098.test.ts`, `tests/access100.test.ts` through `bun run test`

**Target Platform**: the controller PC (Linux, macOS, Windows); the machines pairing use `curl`/`openssl` or PowerShell

**Project Type**: command line (headless first), the boot server, and the console

## Constitution Check

- Article 0 (the ladder): the terms are in the ontology (rung 0: `Listener`, `Door`, `DevicePath`) and cited in `spec.md` (rung 1);
  the ports module is infrastructure (rung 4), the pairing's protocol and store are business rules (rung 5), the doors are hosts
  (rung 6); the guides are rung 7. No new upward import: the pair-only server's use of `archon-boot/http.ts` stays in
  `pair-command.ts`, where the baseline already holds it.
- Article 28: plain HTTP only on the boot server's port, on the trusted network; the console's TLS door adds a certificate.
- Article 29: this spec.
- Article 13: the pairing's code is a secret while it lasts: owner-only file, ephemeral, never in a log or in Git.

## Design

**The record** (`adopt/pair-store.ts`): JSON, one object (`PairRecord`). **Writes**: under `<file>-lock` (commons' `acquireLock`,
`O_EXCL`, a dead holder's lock is taken over), read fresh, change, write `<file>-tmp` (0600), rename over `<file>`. **Reads**
need no lock (the rename is atomic). **Expiry** is `expiresAt` in the record, checked by every request; a late `POST` says so.

**Why not a port or a socket between processes**: Article 29; the armed-install pattern already exists.

**The handler** (`adopt/pair.ts`, `PairSession`): stateless, the store holds everything; it builds the scripts' base from the
request's own origin, so one handler serves `http://<pc>:8080/device/pair` and `https://<name>/device/pair`. `/checkin` stores the
check-in and polls the store (500 ms) until the decision. **The terminal** (`adopt/pair-command.ts`, `runPairing`) polls the
record, asks the person, writes the decision, waits until a door has told the machine (`delivered`, at most 3 s) and removes
the file in `finally`.

**Doors**: boot serve passes `devicePair` to the boot handler (before the boot routes); the console's handler answers
`/device/pair` right after its Host check, on the HTTPS names only (404 on 127.0.0.1); `stolos pair` binds its own pair-only
server (`archon-boot/http.ts`) on 8080 or finds the boot server holding it.

## Project Structure

### Documentation (this feature)

```text
specs/103-three-ports/
  spec.md     the requirements, the ontology terms they use, the decisions
  plan.md     this file
  tasks.md    the tasks, each with its files and requirements
```

### Source Code (by rung of the ladder)

```text
rung 0: ontology/stolos/vocabulary.ts, ontology/stolos/codes.ts, ontology/stolos/mod.ts, src/archon/ontology.auto.ts
rung 4: src/archon/core/listeners.ts, src/archon/core/net.ts, src/archon/core/secrets.ts
rung 5: src/archon/adopt/pair.ts, pair-store.ts, pair-service.ts, pair-command.ts, src/archon/access/holder.ts, https.ts, launch.ts, tls.ts, src/archon/model/secret-inventory.ts
rung 6: src/archon-boot/http.ts, tftp.ts, server.ts, main.ts, src/archon/console/stolos-server.ts, stolos-launch.ts, src/archon/commands/registry.ts, tools/ontology.ts
rung 7: the guides (src/archon-boot/mod.ts, src/archon/adopt/mod.ts, src/archon/access/mod.ts), tests/ports103.test.ts
```

**Structure Decision**: the engine's existing folders; nothing new at the top level.

## Complexity Tracking

None.
