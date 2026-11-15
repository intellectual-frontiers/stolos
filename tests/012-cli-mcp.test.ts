/**
 * Spec 012: the MCP server, the man pages, the completions, and the agent's permissions all come
 * from the one command registry.
 *
 * @module
 */
import { assert, assertEquals, proves } from "@intellectual-frontiers/ifc-ts/runtime/test";
import { COMMANDS } from "../src/archon/commands/registry.ts";
import { allowed, handle, listed, mcpToolName } from "../src/archon/mcp/server.ts";
import { resolvePlan } from "../src/archon/model/resolve.ts";
import { renderFishCompletions } from "../src/archon/render/fish.ts";
import { renderManPages } from "../src/archon/render/man.ts";
import { fleet, host } from "./fixtures.ts";

proves(
  ["012-cli-mcp FR-002"],
  "012: the MCP tools, man pages, fish completions, and per-tier permissions are generated from the registry",
  async () => {
    const machine = COMMANDS.filter((c) => c.place !== "pc");
    assert(machine.length > 50);
    // MCP: tools/list is exactly the registry's commands within the tier, each with its own name.
    const list = (await handle({ jsonrpc: "2.0", id: 1, method: "tools/list" }, "mutate")) as {
      result: { tools: Array<{ name: string; description: string }> };
    };
    assertEquals(
      list.result.tools.map((t) => t.name),
      COMMANDS.filter((c) => listed(c, "mutate")).map(mcpToolName),
    );
    // Permissions: what each tier may call follows each command's tier in the registry.
    for (const c of machine.filter((x) => !x.noMcp && !x.readOnlyWith)) {
      assertEquals(allowed(c, {}, "read"), c.tier === "read", c.name);
      assertEquals(allowed(c, {}, "mutate"), c.tier !== "destructive", c.name);
    }
    // Man pages: one per machine command.
    const pages = renderManPages();
    assert(pages.has("man1/archon.1"));
    for (const c of machine) {
      const page = pages.get(`man1/archon-${c.name.replace(/ /g, "-")}.1`);
      assert(page !== undefined, c.name);
    }
    // Completions: every command's first word, from the same list.
    const fish = renderFishCompletions(machine);
    for (const head of new Set(machine.map((c) => c.name.split(" ")[0] ?? ""))) {
      assert(new RegExp(`-a '?${head}'? `).test(fish) || fish.includes(`-a ${head} `), head);
    }
    // And the host gets exactly these rendered files.
    const plan = resolvePlan(host(), fleet());
    assertEquals(
      plan.files.find((f) => f.path === "/usr/local/share/fish/vendor_completions.d/archon.fish")
        ?.content,
      fish,
    );
    for (const [rel, text] of pages) {
      assertEquals(
        plan.files.find((f) => f.path === `/usr/local/share/man/${rel}`)?.content,
        text,
        rel,
      );
    }
  },
);
