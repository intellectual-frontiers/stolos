/**
 * Spec 082: `stolos clients report --out <folder>`: one report per client,
 * each in its own folder (`<folder>/<client>/`), each read in that client's
 * scope, plus the cross-client summary at the top (numbers only). A folder
 * inside any client's checkout is refused, so no report lands in a client's
 * repository, and each client's folder holds that client's data only.
 *
 * @module
 */
// Spec: 082-multi-fleet

import { fs, path } from "@intellectual-frontiers/system";
import type { FreshView } from "../compliance/freshness.ts";
import { type Client, overlaps } from "./registry.ts";
import { type ClientSummary, readClient, totals } from "./summary.ts";

/** One client's report, in words: its numbers, then each failing and stale control. */
export function clientReportText(s: ClientSummary, view?: FreshView): string {
  const lines = [
    `# ${s.title}: compliance report`,
    "",
    `Taken ${s.asOf.slice(0, 16).replace("T", " ")} UTC.`,
    "",
  ];
  if (!s.readable) {
    lines.push(`Not read: ${s.problem}.`);
    return lines.join("\n") + "\n";
  }
  lines.push(
    `- Controls: ${s.controls.pass} pass, ${s.controls.fail} fail, ${s.controls.partial} partial, ${s.controls.noEvidence} without evidence; ${s.controls.stale} with stale evidence`,
    `- Machines: ${s.machines}`,
    `- Drift: ${
      s.drift
        ? `${s.drift.changed} control(s) changed since ${s.drift.since.slice(
            0,
            10,
          )}, ${s.drift.worse} worse`
        : "no history to compare"
    }`,
    `- Last observation: ${s.lastObservation ?? "none"}`,
    `- Open POA&M items: ${s.poamOpen}`,
    `- Newest evidence bundle: ${s.evidenceBundle ?? "none on this PC"}`,
    "",
  );
  const failing = view?.controls.filter((c) => c.status === "fail") ?? [];
  if (failing.length) {
    lines.push("## Failing controls", "");
    for (const c of failing) {
      lines.push(`- ${c.control.id} ${c.control.name}`);
      for (const e of c.evidence.filter((x) => x.status === "fail").slice(0, 10)) {
        lines.push(`  - ${e.subject}: ${e.check}${e.fix ? ` (fix: ${e.fix})` : ""}`);
      }
    }
    lines.push("");
  }
  const stale = view?.controls.filter((c) => c.freshness.stale > 0) ?? [];
  if (stale.length) {
    lines.push("## Controls with stale evidence", "");
    for (const c of stale) lines.push(`- ${c.control.id} ${c.control.name}: ${c.freshness.stale}`);
    lines.push("");
  }
  return lines.join("\n");
}

/** The cross-client summary, in words: one line per client, numbers only. */
export function summaryText(list: ClientSummary[], now = new Date()): string {
  const t = totals(list);
  return [
    "# Clients: summary",
    "",
    `Taken ${now
      .toISOString()
      .slice(0, 16)
      .replace(
        "T",
        " ",
      )} UTC. ${t.clients} client(s), ${t.failing} failing control(s), ${t.poamOpen} open POA&M item(s).`,
    "",
    "| Client | Pass | Fail | Partial | No evidence | Stale | Drift (worse) | Last observation | Open POA&M | Evidence bundle |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...list.map((s) =>
      s.readable
        ? `| ${s.title} (${s.client}) | ${s.controls.pass} | ${s.controls.fail} | ${s.controls.partial} | ${s.controls.noEvidence} | ${s.controls.stale} | ${
            s.drift ? `${s.drift.changed} (${s.drift.worse})` : "-"
          } | ${s.lastObservation?.slice(0, 16).replace("T", " ") ?? "-"} | ${s.poamOpen} | ${
            s.evidenceBundle ?? "-"
          } |`
        : `| ${s.title} (${s.client}) | not read: ${s.problem} | | | | | | | | |`,
    ),
    "",
  ].join("\n");
}

/** Where the reports go, or why not there: never inside a client's checkout. */
export function reportFolder(out: string, clients: Client[]): { dir: string } | { error: string } {
  const dir = path.resolve(out);
  const inside = clients.find((c) => overlaps(c.path, dir));
  return inside
    ? { error: `${dir} is inside client ${inside.id}'s checkout (or holds it)` }
    : { dir };
}

/** Write each client's report into its own folder, then the summary; returns the summaries. */
export async function writeReports(
  clients: Client[],
  dir: string,
  o: { since?: string; now?: Date; each?: (s: ClientSummary, folder: string) => void } = {},
): Promise<ClientSummary[]> {
  const now = o.now ?? new Date();
  const out: ClientSummary[] = [];
  for (const c of [...clients].sort((a, b) => a.id.localeCompare(b.id))) {
    const r = await readClient(c, { ...o, now });
    const folder = path.join(dir, c.id);
    await fs.mkdir(folder, { recursive: true });
    const view = "view" in r ? r.view : undefined;
    await fs.writeTextFile(path.join(folder, "report.md"), clientReportText(r.summary, view));
    await fs.writeTextFile(
      path.join(folder, "summary.json"),
      JSON.stringify(r.summary, null, 2) + "\n",
    );
    if (view) {
      await fs.writeTextFile(
        path.join(folder, "compliance.json"),
        JSON.stringify(view, null, 2) + "\n",
      );
    }
    out.push(r.summary);
    o.each?.(r.summary, folder);
  }
  await fs.writeTextFile(
    path.join(dir, "summary.json"),
    JSON.stringify({ asOf: now.toISOString(), totals: totals(out), clients: out }, null, 2) + "\n",
  );
  await fs.writeTextFile(path.join(dir, "summary.md"), summaryText(out, now));
  return out;
}
