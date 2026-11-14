/**
 * Provenance (spec 014, Article 16): every apply is recorded as an activity,
 * kept in this machine's archon.sql (spec 048) and exported as W3C PROV (Turtle) by `archon export`.
 *
 * @module
 */

import { listRecords, putRecord } from "../state/store.ts";
import { P } from "../core/paths.ts";
import { run } from "../core/exec.ts";

/** One apply, recorded as a PROV activity (spec 014). */
export interface Activity {
  /** The host it ran on. */
  host: string;
  /** When it started (ISO 8601). */
  started: string;
  /** When it ended (ISO 8601). */
  ended: string;
  /** Who ran it: `agentName()`. */
  agent: string;
  /** The checkout's commit at the time (`"unknown"` when git cannot say). */
  commit: string;
  /** What it changed, one line each. */
  changes: string[];
  /** Whether it failed. */
  failed: boolean;
  /** The path of the run's log, when there is one. */
  log?: string;
}

/** Who is acting: `ARCHON_AGENT`, else `SUDO_USER`, else `USER`, else `"unknown"`. */
export function agentName(): string {
  return Deno.env.get("ARCHON_AGENT") ?? Deno.env.get("SUDO_USER") ?? Deno.env.get("USER") ??
    "unknown";
}

/** The checkout's HEAD commit, or `"unknown"`. */
export async function headCommit(): Promise<string> {
  return (await run(["git", "-C", P.repo, "rev-parse", "HEAD"])).stdout.trim() || "unknown";
}

/**
 * Record an apply in this machine's archon.sql (spec 048) as a `prov` record
 * keyed by its start time, which is returned. An apply that changed nothing
 * and did not fail is not recorded (returns `undefined`).
 */
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

/** A host's recorded activities, oldest first. */
export async function loadActivities(host: string, root = P.state): Promise<Activity[]> {
  return (await listRecords<Activity & { detail?: string[] }>(host, "prov", root)).map((r) => ({
    ...r.body,
    changes: r.body.detail ?? [],
  })).sort((a, b) => a.started.localeCompare(b.started));
}
