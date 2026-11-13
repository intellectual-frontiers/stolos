// `archon reconcile` (Article IX): approval means origin/main. Fetch, fast-
// forward a clean checkout, then apply only when HEAD equals origin/main.
// Runs a fresh `archon apply` process so the newly pulled code is used.

import { P } from "../core/paths.ts";
import { currentUser, isRoot, run } from "../core/exec.ts";
import { journal, log } from "../core/log.ts";
import type { HostDef } from "../model/types.ts";

export interface SyncResult {
  /** fetched, and HEAD now equals origin/main */
  current: boolean;
  /** commits fast-forwarded in this run (subject lines) */
  pulled: string[];
  /** commits on origin/main not yet applied locally (when check or blocked) */
  incoming: string[];
  head: string;
  remote: string;
  /** why HEAD could not reach origin/main, if it could not */
  blocked?: string;
}

/** `git status --porcelain` lines that block a pull: any (spec 048: hosts record nothing in the checkout). */
export function blockingChanges(porcelain: string): string {
  return porcelain.split("\n").filter((l) => l.trim()).join("\n");
}

/**
 * Fetch origin/main as the checkout's owner (who holds the host's deploy key, spec 006)
 * and fast-forward when the working tree is clean. With `check`, only fetch.
 */
export async function syncCheckout(opts: { check?: boolean } = {}): Promise<SyncResult> {
  const repo = P.repo;
  const owner = (await run(["stat", "-c", "%U", repo])).stdout.trim() || "root";
  // As root, act as the owner (who holds the gh login); otherwise as yourself
  // (operators share the checkout through the archon-ops group).
  const git = (args: string[]) =>
    run(["git", "-C", repo, ...args], {
      asUser: isRoot() ? owner : undefined,
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
      blocked: `fetch failed as ${isRoot() ? owner : currentUser()}: ${
        fetch.stderr.trim().split("\n").pop()
      }`,
    };
  }
  const remote = (await git(["rev-parse", `origin/${branch}`])).stdout.trim();
  const log1 = async (range: string) =>
    (await git(["log", "--format=%h %s", range])).stdout.split("\n").filter(Boolean);
  const incoming = await log1(`HEAD..origin/${branch}`);
  if (head0 === remote) return { current: true, pulled: [], incoming: [], head: head0, remote };
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
    const t = await checkTip(repo, remote, head0, undefined, isRoot() ? owner : undefined);
    if (!t.ok) {
      await journal(
        "archon-approval",
        `refused ${remote.slice(0, 10)}: ${t.reason}`,
        "user.warning",
      );
      return { current: false, pulled: [], incoming, head: head0, remote, blocked: t.reason };
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
  return { current: true, pulled: incoming, incoming: [], head: remote, remote };
}

export async function reconcile(host: HostDef): Promise<number> {
  const s = await syncCheckout();
  if (!s.current) {
    log.warn(`not reconciling: ${s.blocked}`);
    await journal("archon-reconcile", `skipped: ${s.blocked}`, "user.warning");
    return 0;
  }
  if (s.pulled.length) log.ok(`fast-forwarded to ${s.remote.slice(0, 10)}`);
  const applied = await run(["/usr/local/bin/archon", "apply", "--host", host.name], {
    env: { ...Deno.env.toObject(), ARCHON_AGENT: "reconciler" },
  });
  await journal(
    "archon-reconcile",
    `${applied.ok ? "applied" : "apply FAILED"} at ${s.remote.slice(0, 10)}: ${
      (applied.stderr.match(/(\d+) change\(s\)/)?.[0]) ?? ""
    }`,
    applied.ok ? "user.info" : "user.err",
  );
  if (!applied.ok) log.error(applied.stderr.trim());
  return applied.ok ? 0 : 1;
}
