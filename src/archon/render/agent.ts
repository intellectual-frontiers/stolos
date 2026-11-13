// The agent layer's project configuration (spec 030, Articles 4, 6, 17),
// rendered from the model for a workstation's checkout: .mcp.json with one MCP
// server per server host (archon-<host>, reached as ops over SSH). It names no
// particular agent: any MCP client reads it. Each server enforces its tier
// itself (archon mcp --max-tier), so no agent-specific permission file is needed.

import type { HostDef } from "../model/types.ts";

/** A server as the workstation's agent reaches it. */
export interface McpServer {
  /** The MCP server's name in .mcp.json: archon-<host>. */
  name: string;
  /** user@address for ssh. */
  target: string;
}

export function mcpServers(hosts: HostDef[]): McpServer[] {
  return hosts.filter((h) => h.kind !== "workstation").map((h) => ({
    name: `archon-${h.name}`,
    target: `ops@${h.dnsName ?? h.ip ?? h.name}`,
  }));
}

/**
 * .mcp.json: each server over SSH. The server forces `archon mcp` for ops'
 * keys, so no command is sent. The workstation's own commands are run from
 * the shell (archon on Ubuntu, deno task archon on Windows), not over MCP, so
 * the same file works on both.
 */
export function renderMcpJson(servers: McpServer[] = []): string {
  const mcpServers: Record<string, { command: string; args: string[] }> = {};
  for (const s of servers) {
    mcpServers[s.name] = {
      command: "ssh",
      args: ["-T", "-o", "BatchMode=yes", "-o", "ServerAliveInterval=30", s.target],
    };
  }
  return JSON.stringify({ mcpServers }, null, 2) + "\n";
}
