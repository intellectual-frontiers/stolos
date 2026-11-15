# Feature Specification: The agent layer

**Feature Branch**: `030-agent-layer` (committed directly to main) **Created**: 2026-11-12
**Status**: Implemented **Input**: Managed Ubuntu servers run no agent. The agent is the
workstation's own MCP client, whichever the operator chooses; it reaches each server through
`archon mcp` over SSH. The engine names no particular agent and installs none. Constitution Article 17.

## User Scenarios & Testing _(mandatory)_

1. **Given** a freshly installed server, **When** the owner looks for an agent, **Then** there is
   none: no agent binary, no AI token, and nothing in the install or first boot asks for a
   sign-in.
2. **Given** a workstation with this repository checked out, **When** the owner starts an MCP
   client in it, **Then** the client finds one MCP server per server host (`archon-<fleet>-<host>`)
   in `.mcp.json`, each started as `ssh ops@<host>`.
3. **Given** that SSH connection, **When** it reaches the server, **Then** the server's
   `authorized_keys` for `ops` forces `archon mcp --max-tier <tier>` with `restrict`: no shell, no
   forwarding, no other command, whatever the client asks for.
4. **Given** the agent calls a tool above the allowed tier (a mutating command when the tier is
   `read`, or any destructive command), **When** the call arrives, **Then** the server refuses it
   and lists only the tools it allows.
5. **Given** any MCP tool call, **When** it runs, **Then** the server's journal records it (tag
   `archon-mcp`) with the SSH client address, and the command's provenance names agent `mcp`.

## Requirements _(mandatory)_

- **FR-001**: Servers install no agent: the tool catalog holds no agent, personas carry no agent
  feature, and the dotfiles hold no agent's settings.
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
- **FR-006**: `bun run stolos build` renders `.mcp.json` with one entry per server host (workstations
  excluded), `archon-<fleet>-<host>`:
  `ssh -T -o BatchMode=yes -o ServerAliveInterval=30 ops@<dnsName, ip, or name>`, keeping the
  entries other fleets of the same repository own. No agent-specific file is rendered: each server
  enforces its tier itself.
- **FR-007**: `.mcp.json` names no particular agent: any MCP client on the workstation uses the same
  entries, and the server enforces the limits whatever the client.

### Overrides of Ubuntu defaults

None.

## Notes

- The engine installs nothing for an agent on a workstation: no agent binary, no agent settings, and
  no agent hooks. The agent is the workstation's own MCP client, set up by the operator.

## Non-goals

- A gateway or local model (a later spec: a workstation profile, servers unchanged).
