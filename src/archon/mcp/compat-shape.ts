/**
 * The shape of the MCP tool surface a machine serves (spec 115-compatibility FR-003): each tool listed at the tier `mutate` (what an
 * operator's agent reaches), with its tier, whether it is read-only with a flag, and its arguments (name, type, whether required), sorted.
 * Descriptions are not part of the shape: rewording a tool does not change what a reader may rely on. `bun run compat:digest` and
 * `tests/compat115.test.ts` digest this text for the seam `mcp`.
 *
 * @module
 */
// Spec: 115-compatibility FR-003

import { COMMANDS } from "../commands/registry.ts";
import { listed, toolFor } from "./server.ts";

/** The tools a machine serves at `mutate`, one line each: name, tier, read-only flag, and each argument as `name:type` (`!` where required). */
export function mcpShape(): string {
  return COMMANDS.filter((c) => listed(c, "mutate"))
    .map((c) => {
      const t = toolFor(c);
      const args = Object.entries(t.inputSchema.properties)
        .map(([name, def]) => {
          const type = (def as { type?: string }).type ?? "?";
          return `${name}:${type}${t.inputSchema.required.includes(name) ? "!" : ""}`;
        })
        .sort();
      return `${t.name} ${c.tier}${c.readOnlyWith ? ` ro:${c.readOnlyWith}` : ""} (${args.join(",")})`;
    })
    .sort()
    .join("\n");
}
