// Provenance (spec 014, Article 16): every apply is recorded as an activity,
// stored as JSON and exported as W3C PROV (Turtle) by `archon export`.

import { join } from "../core/path.ts";
import { ensureDir, listFiles } from "../core/fsx.ts";
import { P } from "../core/paths.ts";
import { run } from "../core/exec.ts";

export interface Activity {
  host: string;
  started: string;
  ended: string;
  agent: string;
  commit: string;
  changes: string[];
  failed: boolean;
  log?: string;
}

export function agentName(): string {
  return Deno.env.get("ARCHON_AGENT") ?? Deno.env.get("SUDO_USER") ?? Deno.env.get("USER") ??
    "unknown";
}

export async function headCommit(): Promise<string> {
  return (await run(["git", "-C", P.repo, "rev-parse", "HEAD"])).stdout.trim() || "unknown";
}

/** Interactive runs record into the repository (pushed with archon push); timer runs into /var/lib/archon. */
export function provDir(host: string): string {
  const agent = agentName();
  return agent === "timer" || agent === "reconciler"
    ? join(P.varLib, "prov")
    : join(P.state, "hosts", host, "prov");
}

export async function recordActivity(
  host: string,
  a: { started: Date; ended: Date; changes: string[]; failed: boolean; log?: string },
): Promise<string | undefined> {
  if (!a.changes.length && !a.failed) return undefined; // nothing happened: nothing to record
  const act: Activity = {
    host,
    started: a.started.toISOString(),
    ended: a.ended.toISOString(),
    agent: agentName(),
    commit: await headCommit(),
    changes: a.changes,
    failed: a.failed,
    ...(a.log ? { log: a.log } : {}),
  };
  const dir = provDir(host);
  await ensureDir(dir);
  const path = join(dir, `${act.started.replace(/[:.]/g, "-")}.json`);
  await Deno.writeTextFile(path, JSON.stringify(act, null, 2) + "\n");
  return path;
}

export async function loadActivities(host: string): Promise<Activity[]> {
  const dir = join(P.state, "hosts", host, "prov");
  const out: Activity[] = [];
  for (const f of await listFiles(dir, ".json")) {
    out.push(JSON.parse(await Deno.readTextFile(join(dir, f))) as Activity);
  }
  return out.sort((a, b) => a.started.localeCompare(b.started));
}
