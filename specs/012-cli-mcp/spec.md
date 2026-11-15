# Feature Specification: CLI and MCP

**Feature Branch**: `012-cli-mcp` (committed directly to main) **Created**: 2026-11-10 **Status**:
In progress **Input**: One command registry yields the CLI, MCP tools, man pages, completions, and
the agent's permissions (Article 6).

## Requirements _(mandatory)_

- **FR-001**: `/usr/local/bin/archon` runs the CLI from `/srv/archon` with Bun (`bun archon.ts`),
  and with Node 26 where Bun is not installed.
- **FR-002**: MCP server, man pages, completions, and the agent's permissions are generated from the
  registry (milestone 4).
