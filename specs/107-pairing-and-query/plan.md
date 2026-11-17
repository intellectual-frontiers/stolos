# Implementation Plan: Pairing many machines, the controller as auto-adopted, and asking every machine at once

**Branch**: `107-pairing-and-query` (committed directly to main) | **Date**: 2026-11-17 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/107-pairing-and-query/spec.md`

## Summary

The pairing record becomes a session of many machines (per-machine hello, check-in and decision; wrong signatures per client address;
no expiry) that `stolos pair` keeps open and the two doors serve; the controller joins the fleet with a recorded way of joining
(auto-adopted) that the consoles and commands show; and a question to every machine is asked all at once by one pool and drawn by a
vendored AG Grid as the answers arrive.

## Technical Context

**Language/Version**: TypeScript 7, run by Bun, with Node 26 as the backup (Article 4, spec 096-bun-runtime)

**Primary Dependencies**: IFC TypeScript's kernel and runtime (`@intellectual-frontiers/commons`); AG Grid Community 36.3.0, vendored (browser only)

**Storage**: the pairing session's file in the secrets folder (ephemeral, owner only); `joined` in an adopted machine's `machine.ts`

**Testing**: `tests/pair098.test.ts`, `tests/ports103.test.ts`, `tests/query107.test.ts`, `tests/console066.test.ts`, `tests/controller097.test.ts`,
and the console-browser job (`tests/console/stolos-browser.cjs`), all through `proves([...])`; the project's runner on Bun and Node 26

**Target Platform**: the controller PC (Linux, macOS, Windows) and the fleet's machines

**Project Type**: command line (headless first), then the Stolos Console

## Constitution Check

- Article 0 (the ladder): the terms are in the ontology (rung 0) and cited in `spec.md` (rung 1); the session store, the way of joining and
  the pool are business rules (rung 5) on the infrastructure (rung 4); `stolos pair` and `fleet query` are commands of the one registry
  (rung 6, headless) before the console pages that draw them (rung 6, windowed); the guides are rung 7.
- Article 6 (one registry): `fleet query --timeout`; the console calls the same operation (`askFleet`) the command does.
- Article 13 (no plaintext secrets), 28 (trusted networks), 29 (three ports): unchanged; pairing is still `/device/pair` on two doors.
- Article 5 (binaries only): AG Grid is its published `dist` build, never built here.

## Project Structure

### Documentation (this feature)

```text
specs/107-pairing-and-query/
  spec.md     the requirements, the ontology terms they use, the decisions
  plan.md     this file
  tasks.md    the tasks, each with its files and requirements
```

### Source Code (by rung of the ladder)

```text
rung 0: ontology/stolos/{vocabulary,codes,mod}.ts (WayOfJoining, PairingStage, AnswerState, PairingSession, AddressBlock, MachineTable)
rung 4: src/archon/core/exec.ts (a signal to stop a program), src/archon/model/secret-inventory.ts
rung 5: src/archon/adopt/{pair-store,pair,pair-service,pair-command,joining,query,commands,adopt,controller,mod}.ts,
        src/archon/observe/fleet-status.ts, src/archon/access/pages.ts
rung 6: src/archon/commands/registry.ts, src/archon-boot/server.ts, src/archon/console/{assets,server,table,pc,stolos-pages,stolos-server,mod}.ts
vendor: vendor/ag-grid/ (the build, its licence, its README)
rung 7: guides (adopt/mod.ts, console/mod.ts), tests: tests/{pair098,ports103,query107,console066,observe048}.test.ts,
        tests/integrate/pair-server.ts, tests/console/{serve-stolos.ts,stolos-browser.cjs}
```

**Structure Decision**: the engine's existing folders; one new folder under `vendor/`.

## Design notes

- **The record (format 2)** keeps `tries` by address and `machines` by lowercase hostname, each machine with `stage`, `address`, `name`, `key`,
  `checkIn`, `decision`, `delivered` and its place `seq` in the queue. `PairSession` (the protocol, no state of its own) claims a hostname
  in the store before it names it, so two doors and two processes cannot give one name twice. Blocking is a read of `tries` on every
  request; the cap of addresses and of machines keeps the file small.
- **`runPairing`** (the terminal) polls the record, hands each waiting check-in to `approve` one at a time, and calls `onState` so the
  terminal prints what changed; on Ctrl+C it waits (briefly) for decided machines to be told, marks the session ended, closes the doors and
  removes the record in `finally`.
- **`askAll`** is a pool of at most 8 workers over the targets; each target is raced against its own timer and aborted by an `AbortSignal`
  (ssh and the local probe are stopped by it), and every target yields exactly one answer. `askFleet` builds the targets; the command and the
  console both call it.
- **The grid** is fed by events: the console patches a hidden marker carrying one change as JSON into the table's feed element, and the
  page's script applies it as a transaction. The columns follow the rows, so any SQL works.
