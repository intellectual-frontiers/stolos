// `archon push` (spec 014): share what this host recorded. `archon capture`,
// `archon verify`, and every apply write state into state/hosts/<host>/
// (snapshots, SOSA observations, PROV activities). That record is only useful
// once it is on GitHub, so this command says whether a push is needed, why,
// and then does it: commit the recorded state with a spec ID, rebase onto
// origin/main when someone else pushed meanwhile, and push.
//
// It never commits anything outside state/: a model or spec edit is a change
// that goes through the spec loop, so it is listed with what to do instead.

import { P, repoRel } from "../core/paths.ts";
import { currentUser, isRoot, run } from "../core/exec.ts";
import { ui } from "../core/ui.ts";

export interface PushOptions {
  check: boolean;
}

export interface PushPlan {
  /** Recorded state (state/) not yet committed. */
  state: string[];
  /** Other uncommitted paths: these need a person and a spec ID. */
  other: string[];
  /** Local commits not on origin/main. */
  ahead: string[];
  /** Commits on origin/main not here yet. */
  behind: number;
  fetched: boolean;
  fetchError?: string;
}

export interface PushResult extends PushPlan {
  committed?: string;
  pushed: boolean;
  needed: boolean;
}

/** Split `git status --porcelain` output into recorded state and everything else. */
export function classifyStatus(porcelain: string): { state: string[]; other: string[] } {
  const state: string[] = [];
  const other: string[] = [];
  for (const line of porcelain.split("\n")) {
    if (!line.trim()) continue;
    const path = line.slice(3).replace(/^"|"$/g, "").split(" -> ").pop()!;
    (path.startsWith(repoRel(P.state) + "/") ? state : other).push(path);
  }
  return { state, other };
}

/** The commit subject for recorded state. */
export function stateMessage(host: string, paths: string[]): string {
  const kinds = new Set<string>();
  for (const p of paths) {
    if (p.includes("/prov/")) kinds.add("activity");
    else if (p.endsWith("observations.ttl")) kinds.add("verification");
    else if (p.includes("/snapshot/")) kinds.add("snapshot");
    else kinds.add("state");
  }
  return `014-state: record ${host} ${[...kinds].sort().join(", ")}`;
}

async function owner(): Promise<string> {
  return (await run(["stat", "-c", "%U", P.repo])).stdout.trim() || "root";
}

export async function push(
  host: string,
  opts: PushOptions,
  identity: string[] = [],
): Promise<PushResult> {
  const who = isRoot() ? await owner() : currentUser();
  const git = (args: string[]) =>
    run(["git", "-C", P.repo, ...args], {
      asUser: isRoot() ? who : undefined,
      // Never wait for an answer nobody can see (a host key or passphrase prompt).
      env: { GIT_TERMINAL_PROMPT: "0", GIT_SSH_COMMAND: "ssh -o BatchMode=yes" },
    });

  // --------------------------------------------------------------- look
  const look = ui.phase("Changes");
  const { loadFleet } = await import("../model/load.ts");
  const branch = (await loadFleet()).repository.branch ?? "main";
  look.status(`fetching origin/${branch}`);
  const fetch = await git(["fetch", "--quiet", "origin", branch]);
  const { state, other } = classifyStatus((await git(["status", "--porcelain"])).stdout);
  const list = async (range: string) =>
    (await git(["log", "--format=%h %s", range])).stdout.split("\n").filter(Boolean);
  const ahead = await list(`origin/${branch}..HEAD`);
  const behind = (await list(`HEAD..origin/${branch}`)).length;
  const plan: PushPlan = {
    state,
    other,
    ahead,
    behind,
    fetched: fetch.ok,
    ...(fetch.ok ? {} : { fetchError: fetch.stderr.trim().split("\n").pop() }),
  };
  if (!fetch.ok) {
    look.warn(
      `could not reach GitHub as ${who}: ${plan.fetchError}`,
      `gh auth status; then gh auth setup-git (as ${who})`,
    );
  }
  for (const p of state) look.note(`state: ${p}`);
  for (const c of ahead) look.note(`unpushed: ${c}`);
  for (const p of other) {
    look.warn(
      `${p} has changes that are not recorded state`,
      "it is part of the spec loop: commit it yourself as `<spec-id>: <summary>`, then archon push",
    );
  }
  const needed = state.length > 0 || ahead.length > 0;
  const why: string[] = [];
  if (state.length) why.push(`${state.length} recorded state file(s) not committed`);
  if (ahead.length) why.push(`${ahead.length} commit(s) not on GitHub`);
  if (behind) why.push(`${behind} new on GitHub`);
  look.done(
    needed ? why.join(" · ") : `nothing to push${behind ? ` · ${behind} new on GitHub` : ""}`,
  );

  const result: PushResult = { ...plan, pushed: false, needed };
  if (!needed) {
    if (behind) ui.next.push("pull them with: archon update --check, then sudo archon update");
    return result;
  }
  if (opts.check) {
    ui.next.push(
      "why: capture, verify, and apply record this host's state in state/; GitHub is where it is kept (Article XV)",
      "to share it: archon push",
    );
    return result;
  }
  if (!fetch.ok) return result;

  // -------------------------------------------------------------- commit
  if (state.length) {
    const c = ui.phase("Commit");
    const msg = stateMessage(host, state);
    await git(["add", "--", "state/"]);
    const r = await git([...identity, "commit", "--quiet", "-m", msg, "--", "state/"]);
    if (r.ok) {
      result.committed = msg;
      c.done(`"${msg}" (${state.length} file(s))`);
    } else {
      c.fail(`git commit failed: ${(r.stderr || r.stdout).trim()}`, "git -C /srv/archon status");
      return result;
    }
  }

  // ---------------------------------------------------------------- push
  const p = ui.phase("Push");
  if (behind) {
    p.status(`rebasing onto ${behind} new commit(s) from GitHub`);
    const rb = await git(["rebase", "--quiet", "--autostash", `origin/${branch}`]);
    if (!rb.ok) {
      await git(["rebase", "--abort"]);
      p.fail(
        "your commits do not apply on top of GitHub's main",
        "git -C /srv/archon pull --rebase, resolve, then archon push",
      );
      return result;
    }
  }
  p.status(`pushing to origin/${branch}`);
  const r = await git(["push", "--quiet", "origin", `HEAD:${branch}`]);
  if (!r.ok) {
    p.fail(
      `push failed: ${r.stderr.trim().split("\n").pop()}`,
      `gh auth status (as ${who}); then archon push`,
    );
    return result;
  }
  result.pushed = true;
  p.done(`${ahead.length + (result.committed ? 1 : 0)} commit(s) on GitHub`);
  return result;
}
