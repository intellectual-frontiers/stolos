# 059: Two commands: `stolos` on your PC, `archon` on each machine

## Why

With one command for everything, everywhere, a newcomer could not tell where a command runs,
commands that mean nothing on a PC would be offered there, and `update` would mean two things. The
name should say where you are.

## Requirements

- **FR-001** Every command in the one registry says where it runs: `pc`, `machine`, or `both`
  (`explain`). `update` is two commands, one each: on the PC, pull and check (spec 058); on a
  machine, pull and apply (spec 015). Spec 112-machine-reported-tags adds `tag add`, `tag remove` and
  `tag list` the same way: on the PC, the fleet's tags of a machine (spec 108); on a machine, the tags it
  says about itself in its own state database.
- **FR-002** `stolos` (src/stolos/main.ts; a fleet repository's `stolos.ts`, run as
  `bun run stolos`) offers the PC's commands, and `stolos boot <sub>` is the boot server, in the
  same process (its telemetry starts in-process, spec 023). With no arguments: where you are.
- **FR-003** `archon` (src/archon/main.ts; `/usr/local/bin/archon` on each machine, running the
  fleet repository's `archon.ts`) offers the machine's commands. With no arguments: its state.
- **FR-004** Each points at the other: a command of the other place is refused with the exact
  command to run there.
- **FR-005** A new fleet repository's `package.json` has the scripts `stolos` and `archon`
  (`bun stolos.ts`, `bun archon.ts`), and the files `stolos.ts` and `archon.ts`. MCP serves machine
  commands only; man pages and completions are archon's.
- **FR-006** On Windows, an optional PowerShell function makes `stolos ...` a shortcut for
  `bun run stolos ...` in the fleet folder (the READMEs show it, and the macOS/Linux equivalent).

## Success criteria

- **SC-001** Tests: every command has a place; the two do not overlap but for `explain`, the two
  `update`s and the two `tag add`, `tag remove` and `tag list`; each points at the other; the scaffold has the two scripts.
- **SC-002** The public lab installs, bootstraps, and reaches a server with `stolos` and `archon`.
