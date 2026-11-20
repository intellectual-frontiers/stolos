/**
 * Spec 035 (the welcome page and `archon guide`): one source for "what's here", made from the
 * host's plan, and the agent steps that match the repository's `.mcp.json`.
 *
 * @module
 */

import { fs, path, proc } from "@intellectual-frontiers/system";
import { assert, assertEquals, proves } from "@intellectual-frontiers/commons/ts/runtime/test";
import { resetRoots } from "../src/archon/core/paths.ts";
import { workstation } from "../src/archon/capabilities/mod.ts";
import { agentSetup, agentSteps, CATEGORIES, guideFor } from "../src/archon/guide/guide.ts";
import { resolvePlan } from "../src/archon/model/resolve.ts";
import { mcpServers, renderMcpJson } from "../src/archon/render/agent.ts";
import { at, fleet, host } from "./fixtures.ts";

const full = () =>
  fleet({
    web: { domain: "lab.example.net" },
    mail: { to: "fleet@example.net", domain: "example.net", tag: "lab" },
  });

proves(
  ["035-welcome-guide FR-001"],
  "035: guideFor(plan): items by category, each described, with commands, live links and guides, only for what the plan has",
  () => {
    const plan = resolvePlan(host(), full());
    const items = guideFor(plan);
    // Every category, in the order the page shows them.
    assertEquals(Object.keys(CATEGORIES), ["shell", "web", "watch", "safety", "email", "work"]);
    for (const c of Object.keys(CATEGORIES)) {
      assert(
        items.some((i) => i.category === c),
        `an item in ${c}`,
      );
    }
    for (const i of items) {
      assert(i.what.length > 20, `${i.id} says what it is`);
      for (const u of i.use ?? []) assert(u.cmd !== "" && u.why !== "", `${i.id}: ${u.cmd}`);
    }
    const links = (id: string) =>
      Object.fromEntries(
        (items.find((i) => i.id === id)?.links ?? []).map((l) => [l.label, l.href]),
      );
    assertEquals(links("cockpit"), {
      Overview: "https://cockpit.alpha.lab.example.net",
      Logs: "https://cockpit.alpha.lab.example.net/system/logs",
      Services: "https://cockpit.alpha.lab.example.net/system/services",
      Metrics: "https://cockpit.alpha.lab.example.net/metrics",
      Terminal: "https://cockpit.alpha.lab.example.net/system/terminal",
    });
    assertEquals(Object.values(links("https")), ["https://traefik.alpha.lab.example.net"]);
    assertEquals(Object.values(links("repository")), ["https://github.com/example/fleet"]);
    assert(
      items.some((i) => i.guide === "dotfiles"),
      "a longer guide",
    );

    // An item appears only when the plan has what it describes.
    const ids = (p: typeof plan) => guideFor(p).map((i) => i.id);
    assert(ids(plan).includes("fish") && ids(plan).includes("mail"));
    assert(!ids({ ...plan, tools: plan.tools.filter((t) => t.id !== "fish") }).includes("fish"));
    assert(
      !ids(resolvePlan(host(), fleet())).includes("mail"),
      "no mail in the model, no mail item",
    );
    const ws = resolvePlan(
      host({
        name: "pc",
        kind: "workstation",
        user: "alice",
        mac: undefined,
        disk: undefined,
        capabilities: workstation(),
        spec: "020-workstation",
      }),
      full(),
    );
    assert(!ids(ws).includes("cockpit"), "a workstation has no Cockpit");
  },
);

proves(
  ["035-welcome-guide FR-002"],
  "035: agentSetup and agentSteps use .mcp.json's server name and SSH target; AGENTS.md at the repository's root gives the operating rules",
  async () => {
    const h = host({ dnsName: "alpha.lab.example.net" });
    const plan = resolvePlan(h, full());
    const a = agentSetup(plan);
    const [entry] = mcpServers([h], plan.fleet.id);
    assertEquals([a.server, a.target], [entry?.name, entry?.target]);
    assertEquals(a.server, "archon-lab-alpha");
    assertEquals(a.target, "ops@alpha.lab.example.net");
    const steps = agentSteps(a);
    assert(steps.some((s) => s.cmds.includes(`ssh -T ${a.target}`)));
    assert(steps.some((s) => s.text.includes(a.server)));
    assert(steps.some((s) => s.cmds.includes("git clone https://github.com/example/fleet.git")));
    // .mcp.json, as stolos build renders it, has that server, reached with those arguments.
    const rendered: unknown = JSON.parse(renderMcpJson(mcpServers([h], plan.fleet.id)));
    assertEquals(at(rendered, "mcpServers", a.server), { command: "ssh", args: a.args });
    // AGENTS.md at the repository's root: the steps point there, and every server serves it to
    // the agent as the operating rules.
    assert(steps.some((s) => s.text.includes("AGENTS.md there gives the operating rules")));
    const repo = await fs.makeTempDir({ prefix: "archon-agents-" });
    const saved = proc.env.get("ARCHON_REPO");
    try {
      await fs.writeTextFile(
        path.join(repo, "AGENTS.md"),
        "# AGENTS.md\n\n## Rules\n\n- Spec first.\n",
      );
      proc.env.set("ARCHON_REPO", repo);
      resetRoots();
      const { handle } = await import("../src/archon/mcp/server.ts");
      const listed = JSON.stringify(
        await handle({ jsonrpc: "2.0", id: 1, method: "resources/list" }),
      );
      assert(listed.includes("Operating rules (AGENTS.md of the fleet's repository)"), listed);
      const read = await handle({
        jsonrpc: "2.0",
        id: 2,
        method: "resources/read",
        params: { uri: "archon://operating-rules" },
      });
      assertEquals(
        at(read, "result", "contents", 0, "text"),
        "# AGENTS.md\n\n## Rules\n\n- Spec first.\n",
      );
    } finally {
      if (saved === undefined) proc.env.delete("ARCHON_REPO");
      else proc.env.set("ARCHON_REPO", saved);
      resetRoots();
      await fs.remove(repo, { recursive: true });
    }
  },
);
