# Feature Specification: Workstation (Ubuntu on WSL)

**Feature Branch**: `020-workstation` (committed directly to main) **Created**: 2026-11-10
**Status**: Implemented **Input**: The owner's Windows PC runs Ubuntu on WSL; it should get the same
tools, dotfiles, prompt as the hosts, plus Claude Code (the agent layer, spec 030), managed by
Archon, without anything that belongs to a server.

## User Scenarios & Testing _(mandatory)_

### User Story 1: Set up WSL Ubuntu as a workstation (Priority: P1)

**Acceptance Scenarios**:

1. **Given** Ubuntu 26.04 on WSL with systemd, and the repository cloned to `/srv/archon` by the
   owner, **When** the owner runs `bun run stolos workstation add`, **Then**
   `fleets/<fleet>/hosts/<name>/host.ts` is written (`kind: "workstation"`, `user: <owner>`), and
   through sudo the workstation gets the tools at their newest releases, the dotfiles, Claude Code,
   the `archon` command, and Ubuntu's daily updates; a new terminal opens in fish with the Archon
   prompt.
2. **Given** the wrong Ubuntu release, no systemd, or a checkout elsewhere, **Then** it stops before
   changing anything, with the fix for each.
3. **Given** a workstation in the model, **Then** the boot server never lists, arms, or installs it.

## Requirements _(mandatory)_

- **FR-001**: `HostDef.kind` is `"server"` (default) or `"workstation"`; a workstation names the
  existing account it sets up (`user`, default the fleet admin's name) and has no `mac`, `disk`,
  `guests`, `backup`, or extra `users` (validated).
- **FR-002**: `workstation()` is the workstation's capability set: a base (Archon's directories,
  `/etc/archon/host`, git, curl, unzip, software-properties-common, a systemd check), accounts
  (Archon's groups and sudo rule; no ops), updates (spec 009), tools (spec 010), shell (spec 011),
  and the CLI (spec 012).
- **FR-003**: The workstation has one account, its user, with the operator persona (fish,
  oh-my-posh, tmux, developer tools, archon completions) and Claude Code. It is never created: WSL
  created it.
- **FR-004**: `archon workstation add [<name>] [--user <u>] [--force]` runs as the user from
  `/srv/archon`, checks the Ubuntu release against the fleet's, that systemd runs (fix:
  `/etc/wsl.conf` `[boot] systemd=true`, `wsl --shutdown`), and the checkout location, writes the
  host file, installs the engine `bun.lock` holds (`bun install --frozen-lockfile`), then runs
  `archon update --no-pull --host <name>` through sudo with the same runtime (Bun, or Node 26).
  Later changes come with `sudo archon update`.
- **FR-005**: The boot machine ignores workstations (`loadServers`).

### Overrides of Ubuntu defaults

None beyond those of specs 009 to 012, which apply unchanged.

## Success Criteria _(mandatory)_

- **SC-001**: After `workstation add`, `archon verify` passes on the workstation, and a new terminal
  is fish with the Archon prompt.
