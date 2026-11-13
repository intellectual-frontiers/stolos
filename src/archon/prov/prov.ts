// Provenance (spec 014, Article 16): every apply is recorded as an activity,
// kept in this machine's archon.sql (spec 048) and exported as W3C PROV (Turtle) by `archon export`.

import { listRecords, putRecord } from "../state/store.ts";
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
  // Spec 048: kept on this machine (archon.sql, table archon_prov), the newest PROV_KEEP.
  const run = act.started;
  await putRecord(
    host,
    "prov",
    run,
    {
      ...act,
      command: "apply",
      ok: !act.failed,
      changes: act.changes.length,
      detail: act.changes,
    },
    P.state,
    act.ended,
  );
  return run;
}

export async function loadActivities(host: string, root = P.state): Promise<Activity[]> {
  return (await listRecords<Activity & { detail?: string[] }>(host, "prov", root)).map((r) => ({
    ...r.body,
    changes: r.body.detail ?? [],
  })).sort((a, b) => a.started.localeCompare(b.started));
}
