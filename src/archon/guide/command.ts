/**
 * `archon guide` (spec 035): what's on this machine and how to use it, in the
 * terminal, from the same source as the welcome page (guideFor).
 *
 * @module
 */

import { stdio } from "@intellectual-frontiers/system";
import { ui } from "../core/ui.ts";
import { loadFleet, loadHosts } from "../model/load.ts";
import { resolvePlan } from "../model/resolve.ts";
import { fqdn } from "../web/config.ts";
import { agentSetup, agentSteps, CATEGORIES, type Category, guideFor } from "./guide.ts";

/** Prints the guide for a host in the model: what is on it and how to use it. Returns 0. */
export async function guide(hostName: string): Promise<number> {
  const fleet = await loadFleet();
  const host = (await loadHosts()).find((h) => h.name === hostName);
  if (!host) throw new Error(`no host ${hostName} in the model`);
  const plan = resolvePlan(host, fleet);
  const items = guideFor(plan);
  const name = fqdn(fleet, host);
  const out: string[] = [
    "",
    `${ui.bold(host.name)} is managed by Archon: it is described in ${ui.cyan(
      fleet.repository.slug,
    )} and keeps itself matching it.`,
    "Changes go in the repository, not on the server.",
  ];
  if (name) out.push(`Welcome page, with links to everything: ${ui.cyan(`https://${name}`)}`);
  if (host.kind !== "workstation") {
    out.push(
      "",
      `${ui.emoji ? "🤖 " : ""}${ui.bold("Manage this server with an AI agent (any MCP client)")}`,
    );
    agentSteps(agentSetup(plan)).forEach((s, i) => {
      out.push(`  ${i + 1}. ${ui.bold(s.title)}`, `     ${ui.dim(s.text)}`);
      for (const c of s.cmds) for (const l of c.split("\n")) out.push(`     ${ui.cyan(l)}`);
    });
  }
  const order: Category[] = ["shell", "web", "watch", "safety", "email", "work"];
  for (const cat of order) {
    const these = items.filter((x) => x.category === cat);
    if (!these.length) continue;
    const c = CATEGORIES[cat];
    out.push("", `${ui.emoji ? `${c.emoji} ` : ""}${ui.bold(c.title)}`);
    for (const x of these) {
      out.push(`  ${ui.bold(x.title)}`, `    ${ui.dim(x.what)}`);
      for (const u of x.use ?? []) out.push(`    ${ui.cyan(u.cmd)}  ${ui.dim(u.why)}`);
      for (const l of x.links ?? []) out.push(`    ${l.label}: ${ui.cyan(l.href)}`);
    }
  }
  out.push(
    "",
    `More: ${ui.cyan("man archon-guide")} (for newcomers) · ${ui.cyan(
      "man archon",
    )} (every command)`,
    "",
  );
  stdio.stdout.writeSync(`${out.join("\n")}\n`);
  return 0;
}
