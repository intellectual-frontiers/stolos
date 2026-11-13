# Feature Specification: The agent layer

**Feature Branch**: `030-agent-layer` (committed directly to main) **Created**: 2026-11-12
**Status**: Implemented **Input**: Managed Ubuntu servers run no agent. The agent (Claude Code by
default) is a layer the operator installs on a workstation, which reaches each server through
`archon mcp` over SSH. Constitution Article 17.

## User Scenarios & Testing _(mandatory)_

1. **Given** a freshly installed server, **When** the owner looks for an agent, **Then** there is
   none: no Claude Code binary, no token, no `claude.env`, and nothing in the install or first boot
   asks for a sign-in.
2. **Given** a workstation with this repository checked out, **When** the owner runs `claude` in it,
   **Then** Claude Code finds one MCP server per server host (`archon-<host>`) in `.mcp.json`, each
   started as `ssh ops@<host>`.
3. **Given** that SSH connection, **When** it reaches the server, **Then** the server's
   `authorized_keys` for `ops` forces `archon mcp --max-tier <tier>` with `restrict`: no shell, no
   forwarding, no other command, whatever the client asks for.
4. **Given** the agent calls a tool above the allowed tier (a mutating command when the tier is
   `read`, or any destructive command), **When** the call arrives, **Then** the server refuses it
   and lists only the tools it allows.
5. **Given** any MCP tool call, **When** it runs, **Then** the server's journal records it (tag
   `archon-mcp`) with the SSH client address, and the command's provenance names agent `mcp`.

## Requirements _(mandatory)_

- **FR-001**: Servers install no agent: the tool catalog's Claude Code entry is workstation-only;
  personas carry no agent feature; dotfiles for Claude Code apply on workstations only.
- **FR-002**: No AI credential reaches a server: the boot machine holds none, the install config
  carries none, and the first boot signs nothing in. Article 18: no human step after power-on.
- **FR-003**: `fleet.mcp` (optional) sets `maxTier` (`read`, `repo`, or `mutate`; default `mutate`)
  and `keys` (default: the admin's GitHub SSH keys). Each key is written to
  `/home/ops/.ssh/authorized_keys` as
  `restrict,command="env ARCHON_AGENT=mcp /usr/local/bin/archon mcp --max-tier <tier>"`.
- **FR-004**: `archon mcp --max-tier <tier>` lists only tools whose tier is within the limit (a tool
  with a read-only flag is listed and runs only with that flag), refuses the rest, and never serves
  the destructive tier. Without the flag (a local operator), the limit is `mutate`.
- **FR-005**: Each tool call is journaled with `logger -t archon-mcp` (tool, arguments,
  `SSH_CLIENT`).
- **FR-006**: `archon build` renders `.mcp.json` with one entry per server, `archon-<host>`:
  `ssh -T -o BatchMode=yes ops@<dnsName or ip>`; and `.claude/settings.json` with permissions per
  server: read tools allowed, repo and mutating tools ask, destructive tools denied.
- **FR-007**: Claude Code stays the default agent and is installed on workstations (spec 020) by its
  native installer. Another agent can use the same `.mcp.json` entries; the server enforces the
  limits either way.
- **FR-008**: The workstation hooks read only the checkout: SessionStart lists the fleet's MCP
  servers; PostToolUse journals on the workstation (tag `archon-agent`); Stop still blocks while
  `archon validate` fails.

### Overrides of Ubuntu defaults

None.

## Non-goals

- A gateway or local model (a later spec: a workstation profile, servers unchanged).
