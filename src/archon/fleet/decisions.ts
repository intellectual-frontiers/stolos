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

import { tsKey } from "../core/ts-literal.ts";
import { P, repoRel } from "../core/paths.ts";
import { join } from "../core/path.ts";
import { exists, readTextOr } from "../core/fsx.ts";
import { toFileUrl } from "../core/path.ts";
import { ui } from "../core/ui.ts";
import type { DataClass, HostDecisions, OptInRecord } from "../model/types.ts";

/** fleets/<id>/hosts/<host>/decisions.ts. */
export function decisionsFile(host: string): string {
  return join(P.hosts, host, "decisions.ts");
}

/** The fixed form of decisions.ts (sorted, one way to write each value). */
export function decisionsSource(d: HostDecisions): string {
  const rows = Object.entries(d.optIns ?? {}).sort(([a], [b]) => a.localeCompare(b)).map((
    [name, r],
  ) =>
    `    ${tsKey(name)}: {\n      enabled: ${r.enabled},\n${
      r.data ? `      data: ${JSON.stringify(r.data)},\n` : ""
    }      by: ${JSON.stringify(r.by)},\n      at: ${JSON.stringify(r.at)},\n    },\n`
  ).join("");
  return `// Written by stolos decide (spec 047): what operators decided for this host.
// Change it with stolos decide, in a signed commit; a decision here wins over the host's own record.
import type { HostDecisions } from "@stolos/archon/model/types.ts";

export default {
  optIns: {
${rows}  },
} satisfies HostDecisions;
`;
}

/** A host's decisions (none: empty). */
export async function loadDecisions(
  host: string,
  file = decisionsFile(host),
): Promise<HostDecisions> {
  if (!(await exists(file))) return {};
  const mod = await import(toFileUrl(file).href + `?t=${Date.now()}`);
  return (mod.default ?? {}) as HostDecisions;
}

/** decisions.ts files that are not in the fixed form (build fails on them). */
export async function decisionProblems(hosts: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const h of hosts) {
    const file = decisionsFile(h);
    const text = await readTextOr(file);
    if (text === undefined) continue;
    if (text !== decisionsSource(await loadDecisions(h, file))) out.push(repoRel(file));
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
  const rec: OptInRecord = {
    enabled,
    by,
    at: new Date().toISOString(),
    ...((data ?? was?.data) ? { data: data ?? was!.data } : {}),
  };
  const next: HostDecisions = { ...d, optIns: { ...(d.optIns ?? {}), [name]: rec } };
  const file = decisionsFile(hostName);
  await Deno.writeTextFile(file, decisionsSource(next));
  p.done(
    `${def.title} ${enabled ? "on" : "off"}${rec.data ? `, ${rec.data}` : ""} for ${hostName} in ${
      repoRel(file)
    }`,
  );
  ui.next.push(
    `commit and push it: deno task stolos apply -m "${P.fleetId} decide: ${name} ${
      enabled ? "on" : "off"
    } on ${hostName}"`,
    `${hostName} applies it within 15 minutes (or now: archon update on it)`,
  );
  return ui.finish();
}
