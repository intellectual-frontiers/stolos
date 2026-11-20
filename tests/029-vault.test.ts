/**
 * Spec 029 (the secrets vault), as revised by specs 056 and 061: the vault's commands in the one
 * registry and never over MCP, and the disaster-recovery guide's steps.
 *
 * @module
 */

import { fs, path } from "@intellectual-frontiers/system";
import {
  assert,
  assertEquals,
  assertStringIncludes,
  proves,
} from "@intellectual-frontiers/commons/ts/runtime/test";
import { COMMANDS, findCommand } from "../src/archon/commands/registry.ts";
import { GUIDES } from "../src/archon/core/guides.ts";
import { listed } from "../src/archon/mcp/server.ts";
import { ENGINE_ROOT } from "./sandbox.ts";

proves(
  ["029-vault FR-001"],
  "029: the vault's commands are in the one registry, on the PC, never offered over MCP",
  () => {
    // Specs 056 and 061 removed verify, rehearse, and prune; these remain.
    const subs = ["status", "backup", "restore", "list", "recover-host-keys"];
    for (const s of subs) {
      const found = findCommand(["vault", s], "pc");
      assert(found !== undefined, `vault ${s}`);
      assertEquals(found.cmd.name, `vault ${s}`);
      assertEquals(found.cmd.noMcp, true, `vault ${s} is never an MCP tool`);
      assert(!listed(found.cmd, "mutate"), `vault ${s} is not listed over MCP`);
      assertEquals(findCommand(["vault", s], "machine"), undefined, "not a host's command");
    }
    assert(
      COMMANDS.find((c) => c.name === "vault status")?.args.some((a) => a.name === "lost"),
      "status --lost",
    );
    // On hosts: host-keys export serves recover-host-keys, never over MCP either.
    const hk = findCommand(["host-keys", "export"], "machine");
    assert(hk !== undefined);
    assertEquals(hk.cmd.noMcp, true);
    assert(!listed(hk.cmd, "mutate"));
  },
);

proves(
  ["029-vault FR-011"],
  "029: the disaster-recovery guide: with a backup, without one, and the gap outside Archon",
  async () => {
    const g = GUIDES.find((x) => x.name === "disaster-recovery");
    assert(g !== undefined);
    const text = await fs.readTextFile(path.join(ENGINE_ROOT, g.module));
    for (const s of [
      // With a backup.
      "## With a backup ZIP",
      "signs you in to GitHub",
      "bun run stolos vault restore",
      "Fixed IP Address",
      "`site.bootServer.address`",
      "validation lists every UniFi setting that still points",
      "New-NetFirewallRule",
      "bun run stolos boot doctor",
      "archon doctor --send",
      // Without one.
      "## Without a backup",
      "bun run stolos vault status --lost",
      // The gap outside Archon: the owner's SSH key (a second admin key) and the gh login.
      "## The gap outside Archon",
      "**Your own SSH key**",
      "**second\n *   admin SSH key**",
      "`gh auth login`",
    ]) {
      assertStringIncludes(text, s);
    }
  },
);
