/**
 * Spec 047-intent-and-identity (Article 25): what operators decided for a host
 * (which opt-ins are on, and whether their data is durable) lives in Git, in
 * fleets/<id>/hosts/<host>/decisions.ts, written by `stolos decide` on a
 * workstation and approved by a signed push. Such a decision wins over the
 * host's own record (archon.sql), survives a re-install, and tells the boot
 * machine whether a host holds durable data even when it is offline.
 *
 * @module
 */
// Spec: 047-intent-and-identity
// Spec: 108-tags FR-004, FR-006

import { fs, path } from "@intellectual-frontiers/commons/ts/runtime";
import { lf, tsKey } from "@intellectual-frontiers/commons/ts/kernel";
import { P, repoRel } from "../core/paths.ts";
import { ui } from "../core/ui.ts";
import type { DataClass, HostDecisions, OptInRecord } from "../model/types.ts";

/** fleets/<id>/hosts/<host>/decisions.ts. */
export function decisionsFile(host: string): string {
  return path.join(P.hosts, host, "decisions.ts");
}

/** A list as the formatter writes it (on one line while it fits in 100 columns, else one tag to a line), or nothing. */
function list(key: string, items: readonly string[] | undefined): string {
  if (!items?.length) return "";
  const one = `  ${key}: [${items.map((t) => JSON.stringify(t)).join(", ")}],\n`;
  return one.length <= 101
    ? one
    : `  ${key}: [\n${items.map((t) => `    ${JSON.stringify(t)},\n`).join("")}  ],\n`;
}

/** The fixed form of decisions.ts (sorted, one way to write each value). */
export function decisionsSource(d: HostDecisions): string {
  const rows = Object.entries(d.optIns ?? {})
    .sort(([a], [b]) => a.localeCompare(b))
    .map(
      ([name, r]) =>
        `    ${tsKey(name)}: {\n      enabled: ${r.enabled},\n${
          r.data ? `      data: ${JSON.stringify(r.data)},\n` : ""
        }      by: ${JSON.stringify(r.by)},\n      at: ${JSON.stringify(r.at)},\n    },\n`,
    )
    .join("");
  // Spec 108-tags: a person's tags, typed by the fleet's own tags.ts (a type error where one is not defined there).
  const tags = list("tags", d.tags);
  const custom = list("customTags", d.customTags);
  const typed = tags !== "";
  return `/**
 * Written by stolos decide (spec 047): what operators decided for this host.
 * Change it with stolos decide, in a signed commit; a decision here wins over the host's own record.
 *
 * @module
 */
import type { HostDecisions } from "@intellectual-frontiers/stolos/archon/model/types";
${typed ? `import type { TagId } from "../../tags.ts";\n` : ""}
export default {
${rows ? `  optIns: {\n${rows}  },` : "  optIns: {},"}
${tags}${custom}} satisfies HostDecisions${typed ? "<TagId>" : ""};
`;
}

/** A host's decisions (none: empty). */
export async function loadDecisions(
  host: string,
  file = decisionsFile(host),
): Promise<HostDecisions> {
  if (!(await fs.exists(file))) return {};
  const { fleetExport } = await import("../model/load.ts");
  return (await fleetExport<HostDecisions>(file, "default", true)) ?? {};
}

/** decisions.ts files that are not in the fixed form (build fails on them). */
export async function decisionProblems(hosts: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const h of hosts) {
    const file = decisionsFile(h);
    const text = await fs.readTextOr(file);
    if (text === undefined) continue;
    // Line endings are Git's business (CRLF on a Windows checkout): the form is the text.
    if (lf(text) !== decisionsSource(await loadDecisions(h, file))) out.push(repoRel(file));
  }
  return out;
}

/**
 * `stolos decide <opt-in> on|off --host <host> [--durable|--ephemeral]` (repo
 * tier, on a workstation): write the decision; the host applies it after a
 * signed push.
 */
export async function decide(
  hostName: string,
  name: string,
  enabled: boolean,
  data: DataClass | undefined,
  confirm: unknown,
  by: string,
): Promise<number> {
  const { optInDef, holdsUserData, checkChoice } = await import("../optin/optin.ts");
  const { loadHosts } = await import("../model/load.ts");
  const def = optInDef(name);
  if (!def) throw new Error(`no opt-in named ${name} (archon opt-in lists them)`);
  const host = (await loadHosts()).find((h) => h.name === hostName);
  if (!host) throw new Error(`no host ${hostName} in the model`);
  if (host.kind === "workstation") throw new Error(`${def.title} is for servers, not workstations`);
  const p = ui.phase("Decide");
  if (enabled && holdsUserData(name) && !data) {
    p.fail(`${def.title} holds end users' data: say which`, "add --durable or --ephemeral");
    return ui.finish();
  }
  if (data) checkChoice(host, name, data, confirm);
  const d = await loadDecisions(hostName);
  const was = d.optIns?.[name] ?? host.optIn?.[name];
  const kept = data ?? was?.data;
  const rec: OptInRecord = {
    enabled,
    by,
    at: new Date().toISOString(),
    ...(kept ? { data: kept } : {}),
  };
  const next: HostDecisions = { ...d, optIns: { ...(d.optIns ?? {}), [name]: rec } };
  const file = decisionsFile(hostName);
  await fs.writeTextFile(file, decisionsSource(next));
  p.done(
    `${def.title} ${enabled ? "on" : "off"}${rec.data ? `, ${rec.data}` : ""} for ${hostName} in ${repoRel(
      file,
    )}`,
  );
  ui.next.push(
    `commit and push it: bun run stolos apply -m "${P.fleetId} decide: ${name} ${
      enabled ? "on" : "off"
    } on ${hostName}"`,
    `${hostName} applies it within 15 minutes (or now: archon update on it)`,
  );
  return ui.finish();
}
