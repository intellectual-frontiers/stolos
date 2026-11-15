/**
 * `archon reconcile` (Article IX): approval means origin/main. Fetch, fast-
 * forward a clean checkout, then apply only when HEAD equals origin/main.
 * Runs a fresh `archon apply` process so the newly pulled code is used.
 *
 * ```mermaid
 * flowchart TD
 *   timer["every 15 minutes, or archon update"] --> fetch["git fetch"]
 *   fetch --> new{"new commits?"}
 *   new -->|no| verify["verify"]
 *   new -->|yes| tip{"tip signed and trusted?<br/>(signers.ts)"}
 *   tip -->|no| refuse["stay; say why (E047-*)"]
 *   tip -->|yes| ff["fast-forward /srv/archon"]
 *   ff --> apply["apply the plan"]
 *   apply --> verify
 *   verify --> record["archon.sql"]
 * ```
 *
 * @module
 */

import { boolean, type Decoder, object, string } from "@intellectual-frontiers/ifc-ts/kernel";
import { fs, proc } from "@intellectual-frontiers/ifc-ts/runtime";
import { count } from "../core/telemetry.ts";
import { P } from "../core/paths.ts";
import { currentUser, run } from "../core/exec.ts";
import { journal, log } from "../core/log.ts";
import type { HostDef } from "../model/types.ts";

/** What syncing the checkout with origin/main found or did. */
export interface SyncResult {
  /** fetched, and HEAD now equals origin/main */
  current: boolean;
  /** commits fast-forwarded in this run (subject lines) */
  pulled: string[];
  /** commits on origin/main not yet applied locally (when check or blocked) */
  incoming: string[];
  /** The commit it runs. */
  head: string;
  /** origin/main's commit. */
  remote: string;
  /** why HEAD could not reach origin/main, if it could not */
  blocked?: string;
}

/** `git status --porcelain` lines that block a pull: any (spec 048: hosts record nothing in the checkout). */
export function blockingChanges(porcelain: string): string {
  return porcelain
    .split("\n")
    .filter((l) => l.trim())
    .join("\n");
}

/** What the last pull did, for the PC (archon state, spec 066): when, the commits, and why not. */
export interface SyncStatus {
  /** When it ran (ISO). */
  at: string;
  /** HEAD after it. */
  head: string;
  /** origin's commit. */
  remote: string;
  /** Whether HEAD is origin's commit. */
  current: boolean;
  /** Why HEAD could not reach origin's commit (an unsigned commit, a failed fetch, ...). */
  blocked?: string;
}

/** Reads a recorded `SyncStatus` (SYNC_STATUS). */
export const syncStatusDecoder: Decoder<SyncStatus> = object(
  { at: string, head: string, remote: string, current: boolean },
  { blocked: string },
);

/** Where the last pull is recorded. */
export const SYNC_STATUS = "/var/lib/archon/status/sync.json";

/**
 * Fetch origin/main as the checkout's owner (who holds the host's deploy key, spec 006)
 * and fast-forward when the working tree is clean. With `check`, only fetch.
 * As root, the outcome is recorded for the PC (SYNC_STATUS).
 */
export async function syncCheckout(opts: { check?: boolean } = {}): Promise<SyncResult> {
  const r = await syncOnce(opts);
  if (!opts.check && proc.isRoot()) {
    const s: SyncStatus = {
      at: new Date().toISOString(),
      head: r.head,
      remote: r.remote,
      current: r.current || (!r.blocked && r.pulled.length > 0),
      ...(r.blocked ? { blocked: r.blocked } : {}),
    };
    await fs
      .writeTextFile(SYNC_STATUS, JSON.stringify(s) + "\n")
      .catch((e: unknown) =>
        log.warn(`${SYNC_STATUS} not written: ${e instanceof Error ? e.message : String(e)}`),
      );
  }
  return r;
}

async function syncOnce(opts: { check?: boolean }): Promise<SyncResult> {
  const repo = P.repo;
  const owner = (await run(["stat", "-c", "%U", repo])).stdout.trim() || "root";
  // As root, act as the owner (who holds the gh login); otherwise as yourself
  // (operators share the checkout through the archon-ops group).
  const git = (args: string[]): ReturnType<typeof run> =>
    run(["git", "-C", repo, ...args], {
      ...(proc.isRoot() ? { asUser: owner } : {}),
      // Never wait at a hidden username prompt: fail and say how to fix it.
      env: { GIT_TERMINAL_PROMPT: "0" },
    });
  // Hosts converge to the fleet's branch (main; tests use their own).
  const { loadFleet } = await import("../model/load.ts");
  const branch = (await loadFleet()).repository.branch ?? "main";
  let fetch = await git(["fetch", "--quiet", "origin", branch]);
  // A fetch racing another git process (or one cut off by a crash) fails to
  // lock the ref; once more is enough.
  if (!fetch.ok && /cannot lock ref|unable to update local ref/.test(fetch.stderr)) {
    fetch = await git(["fetch", "--quiet", "origin", branch]);
  }
  const head0 = (await git(["rev-parse", "HEAD"])).stdout.trim();
  if (!fetch.ok) {
    return {
      current: false,
      pulled: [],
      incoming: [],
      head: head0,
      remote: "",
      blocked: `fetch failed as ${proc.isRoot() ? owner : currentUser()}: ${fetch.stderr
        .trim()
        .split("\n")
        .pop()}`,
    };
  }
  const remote = (await git(["rev-parse", `origin/${branch}`])).stdout.trim();
  const log1 = async (range: string) =>
    (await git(["log", "--format=%h %s", range])).stdout.split("\n").filter(Boolean);
  const incoming = await log1(`HEAD..origin/${branch}`);
  if (head0 === remote) {
    count("archon.update.outcome", 1, { "archon.outcome": "current" });
    return { current: true, pulled: [], incoming: [], head: head0, remote };
  }
  const dirty = blockingChanges(
    (await git(["status", "--porcelain", "--untracked-files=no"])).stdout,
  );
  const ff = (await git(["merge-base", "--is-ancestor", "HEAD", `origin/${branch}`])).ok;
  if (dirty || !ff) {
    return {
      current: false,
      pulled: [],
      incoming,
      head: head0,
      remote,
      blocked: dirty
        ? "working tree has uncommitted changes"
        : "origin/main does not come after this checkout (local commits, or a rollback)",
    };
  }
  // Spec 047 (Article 9): move only to a tip signed by a signer this host trusts.
  const { checkTip, enforcing } = await import("../identity/signers.ts");
  if (await enforcing()) {
    const t = await checkTip(repo, remote, head0, undefined, proc.isRoot() ? owner : undefined);
    if (!t.ok) {
      count("archon.update.outcome", 1, { "archon.outcome": `refused-${t.code}` });
      await journal(
        "archon-approval",
        `refused ${remote.slice(0, 10)}: ${t.reason}`,
        "user.warning",
      );
      // Spec 052: the reason carries its code (archon explain E047-...).
      const code = `E047-${(t.code ?? "untrusted").toUpperCase()}`;
      return {
        current: false,
        pulled: [],
        incoming,
        head: head0,
        remote,
        blocked: `${t.reason} (archon explain ${code})`,
      };
    }
  }
  if (opts.check) return { current: false, pulled: [], incoming, head: head0, remote };
  const merge = await git(["merge", "--ff-only", "--quiet", `origin/${branch}`]);
  if (!merge.ok) {
    return {
      current: false,
      pulled: [],
      incoming,
      head: head0,
      remote,
      blocked: `fast-forward failed: ${merge.stderr.trim()}`,
    };
  }
  // Spec 096: the engine the new commit pins, exactly as its bun.lock holds it; a package that
  // does not match the lock stops the move (E046-LOCK-INTEGRITY), and the checkout stays where it was.
  const changed = await git([
    "diff",
    "--name-only",
    head0,
    remote,
    "--",
    "package.json",
    "bun.lock",
  ]);
  if (!changed.ok || changed.stdout.trim() !== "") {
    const { installDependencies } = await import("../install/bun.ts");
    const install = await installDependencies(repo, proc.isRoot() ? { asUser: owner } : {});
    if (!install.ok) {
      await git(["reset", "--keep", head0]);
      await installDependencies(repo, proc.isRoot() ? { asUser: owner } : {});
      count("archon.update.outcome", 1, { "archon.outcome": "refused-lock" });
      return {
        current: false,
        pulled: [],
        incoming,
        head: head0,
        remote,
        blocked: `bun install --frozen-lockfile refused the engine at ${remote.slice(0, 10)}: ${
          install.stderr.trim().split("\n").pop() ?? `exit ${install.code}`
        } (archon explain E046-LOCK-INTEGRITY)`,
      };
    }
  }
  count("archon.update.outcome", 1, { "archon.outcome": "applied" });
  return { current: true, pulled: incoming, incoming: [], head: remote, remote };
}

/** archon reconcile: fetch, check the signature, fast-forward, apply, verify (the timer, every 15 minutes). */
export async function reconcile(host: HostDef): Promise<number> {
  const s = await syncCheckout();
  if (!s.current) {
    log.warn(`not reconciling: ${s.blocked}`);
    await journal("archon-reconcile", `skipped: ${s.blocked}`, "user.warning");
    return 0;
  }
  if (s.pulled.length) log.ok(`fast-forwarded to ${s.remote.slice(0, 10)}`);
  const applied = await run(["/usr/local/bin/archon", "apply", "--host", host.name], {
    env: { ...proc.env.toObject(), ARCHON_AGENT: "reconciler" },
  });
  await journal(
    "archon-reconcile",
    `${applied.ok ? "applied" : "apply FAILED"} at ${s.remote.slice(0, 10)}: ${
      applied.stderr.match(/(\d+) change\(s\)/)?.[0] ?? ""
    }`,
    applied.ok ? "user.info" : "user.err",
  );
  if (!applied.ok) log.error(applied.stderr.trim());
  return applied.ok ? 0 : 1;
}
