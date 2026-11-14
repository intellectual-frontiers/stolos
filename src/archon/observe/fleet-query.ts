/**
 * `archon fleet query` (spec 048): one SQL question to every server, through
 * each server's MCP server over SSH (the server limits what it answers).
 *
 * @module
 */

import { ui } from "../core/ui.ts";
import { loadHosts } from "../model/load.ts";
import { mcpServers } from "../render/agent.ts";
import { P } from "../core/paths.ts";
import { callRemoteTool } from "./remote.ts";
import { queryRefusal, table } from "../state/query.ts";

/**
 * Ask every server `sql` (refused unless it is a read-only query) and print
 * the rows, each with its host, as a table or, with `json`, as JSON with the
 * unreachable servers. Returns 1 when any server did not answer, else 0.
 */
export async function fleetQuery(sql: string, json: boolean): Promise<number> {
  const why = queryRefusal(sql);
  if (why) throw new Error(`refused: ${why}`);
  const hosts = await loadHosts();
  const servers = mcpServers(hosts, P.fleetId);
  // Spec 047: each server's key is checked against Git (registration.ts).
  const { writeKnownHosts } = await import("../fleet/registration.ts");
  const knownHosts = await writeKnownHosts().catch((e) => {
    // Without it, ssh checks the servers against your own known_hosts only.
    console.error(`warning: known_hosts.auto (from Git) not written: ${(e as Error).message}`);
    return undefined;
  });
  const answers = await Promise.all(servers.map(async (s) => {
    const r = await callRemoteTool(s.target, "archon_query", { sql, json: true }, { knownHosts });
    let rows: Array<Record<string, unknown>> = [];
    if (r.ok) {
      try {
        rows = JSON.parse(r.text);
      } catch {
        return { host: s.name.replace(`archon-${P.fleetId}-`, ""), ok: false, error: r.text, rows };
      }
    }
    return {
      host: s.name.replace(`archon-${P.fleetId}-`, ""),
      ok: r.ok,
      error: r.ok ? "" : r.text,
      rows,
    };
  }));
  const rows = answers.flatMap((a) => a.rows.map((r) => ({ host: a.host, ...r })));
  if (json) {
    console.log(JSON.stringify({ rows, unreachable: answers.filter((a) => !a.ok) }, null, 2));
  } else {
    console.log(table(rows));
    for (const a of answers.filter((x) => !x.ok)) {
      ui.problem("warn", "fleet query", `${a.host}: ${a.error.split("\n").pop()}`);
    }
  }
  return answers.every((a) => a.ok) ? 0 : 1;
}
