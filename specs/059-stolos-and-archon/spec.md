# 059: Two commands: `stolos` on your PC, `archon` on each machine

## Why

One command (`archon`, plus `deno task boot`) did everything everywhere: a newbie could not tell
where a command runs, commands that mean nothing on a PC were offered there, and `update` meant two
things. The name should say where you are.

## Requirements

- **FR-001** Every command in the one registry says where it runs: `pc`, `machine`, or `both`
  (`explain`). `update` is two commands, one each: on the PC, pull and check (spec 058); on a
  machine, pull and apply (spec 015).
- **FR-002** `stolos` (src/stolos/main.ts; a fleet repository's `stolos.ts`, run as
  `deno task stolos`) offers the PC's commands, and `stolos boot <sub>` is the boot server (it
  starts itself again with the boot server's OpenTelemetry settings). With no arguments: where you
  are.
- **FR-003** `archon` (src/archon/main.ts; `/usr/local/bin/archon` on each machine, running the
  fleet repository's `archon.ts`) offers the machine's commands. With no arguments: its state.
- **FR-004** Each points at the other: a command of the other place is refused with the exact
  command to run there.
- **FR-005** A new fleet repository has one task, `stolos`, and the files `stolos.ts`, `archon.ts`,
  `engine.ts`. MCP serves machine commands only; man pages and completions are archon's.
- **FR-006** On Windows, an optional PowerShell function makes `stolos ...` a shortcut for
  `deno task stolos ...` in the fleet folder (the READMEs show it, and the macOS/Linux equivalent).

## Success criteria

- **SC-001** Tests: every command has a place; the two do not overlap but for `explain` and the two
  `update`s; each points at the other; the scaffold has the one task.
- **SC-002** The public lab installs, bootstraps, and reaches a server with `stolos` and `archon`.
