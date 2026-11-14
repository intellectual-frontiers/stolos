/**
 * The agent layer's project configuration (spec 030, Articles 4, 6, 17),
 * rendered from the model for a workstation's checkout: .mcp.json with one MCP
 * server per server host (archon-<fleet>-<host>, reached as ops over SSH; spec
 * 046: one repository can hold several fleets, and two may name a host alike). It names no
 * particular agent: any MCP client reads it. Each server enforces its tier
 * itself (archon mcp --max-tier), so no agent-specific permission file is needed.
 *
 * @module
 */

import type { HostDef } from "../model/types.ts";

/** A server as the workstation's agent reaches it. */
export interface McpServer {
  /** The MCP server's name in .mcp.json: archon-<fleet>-<host>. */
  name: string;
  /** user@address for ssh. */
  target: string;
}

/** The MCP server's name for a host of a fleet. */
export const mcpServerName = (fleet: string, host: string) => `archon-${fleet}-${host}`;

export function mcpServers(hosts: HostDef[], fleet: string): McpServer[] {
  return hosts.filter((h) => h.kind !== "workstation").map((h) => ({
    name: mcpServerName(fleet, h.name),
    target: `ops@${h.dnsName ?? h.ip ?? h.name}`,
  }));
}

/**
 * .mcp.json: each server over SSH. The server forces `archon mcp` for ops'
 * keys, so no command is sent. The workstation's own commands are run from
 * the shell (archon on Ubuntu, deno task archon on Windows), not over MCP, so
 * the same file works on both.
 */
export function renderMcpJson(
  servers: McpServer[] = [],
  keep: { existing?: string; fleet?: string; fleets?: string[] } = {},
): string {
  type Entry = { command: string; args: string[] };
  const mcpServers: Record<string, Entry> = {};
  // One .mcp.json for the repository: keep the other fleets' servers (each
  // fleet's build owns the names archon-<its id>-*); drop anything else.
  const others = (keep.fleets ?? []).filter((f) => f !== keep.fleet);
  try {
    const old = (JSON.parse(keep.existing ?? "{}").mcpServers ?? {}) as Record<string, Entry>;
    for (const [name, e] of Object.entries(old)) {
      const owner = others.find((f) => name.startsWith(`archon-${f}-`));
      // A fleet whose id starts with another's (lab, lab-2) owns its own names.
      const longer = (keep.fleets ?? []).some((f) =>
        f !== owner && f.length > (owner?.length ?? 0) && name.startsWith(`archon-${f}-`)
      );
      if (owner && !longer) mcpServers[name] = e;
    }
  } catch { /* an unreadable .mcp.json is rendered again from scratch */ }
  for (const s of servers) {
    mcpServers[s.name] = {
      command: "ssh",
      args: ["-T", "-o", "BatchMode=yes", "-o", "ServerAliveInterval=30", s.target],
    };
  }
  const sorted = Object.fromEntries(Object.entries(mcpServers).sort(([a], [b]) => a < b ? -1 : 1));
  return JSON.stringify({ mcpServers: sorted }, null, 2) + "\n";
}
