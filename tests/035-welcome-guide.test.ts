/**
 * Spec 035 (the welcome page and `archon guide`): one source for "what's here", made from the
 * host's plan, and the agent steps that match the repository's `.mcp.json`.
 *
 * @module
 */

import { assert, assertEquals, proves, test } from "@intellectual-frontiers/ifc-ts/runtime/test";
import { workstation } from "../src/archon/capabilities/mod.ts";
import { agentSetup, agentSteps, CATEGORIES, guideFor } from "../src/archon/guide/guide.ts";
import { resolvePlan } from "../src/archon/model/resolve.ts";
import { mcpServers } from "../src/archon/render/agent.ts";
import { fleet, host } from "./fixtures.ts";

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

// Spec 035 FR-002 also says AGENTS.md at the repository's root points any agent at CLAUDE.md;
// that does not hold (AGENTS.md is the entry point itself). The agent steps are checked here.
test("035: agentSetup and agentSteps use .mcp.json's server name and SSH target", () => {
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
});
