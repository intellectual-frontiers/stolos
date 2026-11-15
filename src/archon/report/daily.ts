/**
 * `archon report daily` (spec 013): deterministic facts only. No agent runs on
 * a server (spec 030); a workstation's agent reads reports over MCP.
 *
 * @module
 */

import { fs, path as paths, proc, toError } from "@intellectual-frontiers/ifc-ts/runtime";
import { P } from "../core/paths.ts";
import { run } from "../core/exec.ts";
import { journal } from "../core/log.ts";
import { capture } from "../state/capture.ts";
import type { HostDef } from "../model/types.ts";

/**
 * Writes today's daily report (failed units, disk, pending upgrades, archon
 * timers, drift, the latest tools report) as daily-<date>.md and journals a
 * one-line summary. Returns its path, the failed unit count, and the pending
 * upgrade count.
 */
export async function dailyReport(
  host: HostDef,
): Promise<{ path: string; failedUnits: number; upgradable: number }> {
  const date = new Date().toISOString().slice(0, 10);
  const failed = (
    await run(["systemctl", "--failed", "--no-legend", "--plain", "--no-pager"])
  ).stdout.trim();
  const disk = (
    await run([
      "df",
      "-h",
      "--output=target,size,used,avail,pcent",
      "-x",
      "tmpfs",
      "-x",
      "devtmpfs",
    ])
  ).stdout.trim();
  const upgradable = (await run(["apt", "list", "--upgradable"], { env: { LANG: "C" } })).stdout
    .split("\n")
    .filter((l) => l.includes("[upgradable")).length;
  const timers = (
    await run(["systemctl", "list-timers", "--no-pager", "--plain", "archon-*"])
  ).stdout.trim();
  const drift = await capture(host)
    .then((c) => c.summary)
    .catch((e: unknown) => `capture failed: ${toError(e).message}`);
  const outside = await outsideStolos(host);
  const reports = await fs.listFiles(paths.join(P.varLib, "reports"), ".md");
  const latestTools = reports.filter((r) => r.startsWith("tools-")).pop();
  const toolsReport = latestTools
    ? await fs.readTextFile(paths.join(P.varLib, "reports", latestTools))
    : "No tools report yet.";
  const facts = [
    `# Daily report ${date}: ${host.name}`,
    "",
    "## Failed units",
    "",
    "```",
    failed || "none",
    "```",
    "",
    "## Disk",
    "",
    "```",
    disk,
    "```",
    "",
    `## Pending upgrades: ${upgradable}`,
    "",
    "## Archon timers",
    "",
    "```",
    timers,
    "```",
    "",
    "## Drift",
    "",
    "```",
    drift,
    "```",
    "",
    "## Changes outside Stolos (spec 095)",
    "",
    "```",
    outside,
    "```",
    "",
    "## Latest tools report",
    "",
    toolsReport.replace(/^# /m, "### "),
  ].join("\n");

  const text = facts + "\n";
  const dir = proc.isRoot() ? paths.join(P.varLib, "reports") : paths.join(P.state, "reports");
  await fs.ensureDir(dir);
  const path = paths.join(dir, `daily-${date}.md`);
  await fs.writeTextFile(path, text);
  await journal(
    "archon-report",
    `daily report: ${
      failed ? "failed units present" : "no failed units"
    }, ${upgradable} pending upgrade(s)`,
  );
  return { path, failedUnits: failed ? failed.split("\n").length : 0, upgradable };
}

/**
 * Spec 095: collect (as root), then what changed outside Stolos and is not
 * proposed yet. Never fails the report.
 */
async function outsideStolos(host: HostDef): Promise<string> {
  try {
    const { collect } = await import("../proposal/collect.ts");
    const { loadDrift } = await import("../proposal/server.ts");
    const { driftText } = await import("../proposal/drift.ts");
    const { remind, waiting, waitingLine } = await import("../proposal/record.ts");
    if (proc.isRoot()) await collect(host);
    const v = await loadDrift(host);
    if (!v.state) return "nothing collected yet (sudo archon drift --collect)";
    // Spec 095: what waits on a person; a reminder after 3 days (at most every 3 days).
    const w = waiting(v);
    const reminded = proc.isRoot() ? await remind(host, w) : false;
    return [
      waitingLine(w) + (reminded ? " (reminder mailed)" : ""),
      "",
      driftText(host.name, v.items, v.alerts, { birthLate: v.birth?.late, collected: v.state.at }),
    ].join("\n");
  } catch (e) {
    return `not collected: ${(e as Error).message}`;
  }
}
