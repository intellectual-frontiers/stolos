// Specs 004 and 045: what `archon host add` and `boot retire` change in the
// checkout is built, committed, and pushed by the same command (pushing to
// main is approval, Article 9). Only the paths the change touched are staged,
// with what `archon build` renders from them (.mcp.json, the agent's
// permissions, the man pages); anything else in the working tree is left alone.

import { ui } from "../core/ui.ts";
import { P } from "../core/paths.ts";
import { run } from "../core/exec.ts";

/** What archon build renders that a host's arrival or departure changes. */
export const RENDERED = [".mcp.json"];

const last = (r: { stderr: string; stdout: string }) =>
  (r.stderr || r.stdout).trim().split("\n").pop() ?? "";

/**
 * Build, then commit `paths` (and the rendered files) with `message`, and push
 * to the checkout's upstream, retrying a push that lost a race by rebasing.
 * Returns whether the change is on GitHub.
 */
/**
 * Git's author when this checkout has none configured (a fresh boot machine):
 * the fleet admin's GitHub name and no-reply address, from the model.
 */
async function identity(
  git: (args: string[]) => ReturnType<typeof run>,
  given?: { name: string; email: string },
): Promise<string[]> {
  if ((await git(["config", "user.email"])).stdout.trim()) return [];
  let who = given;
  if (!who) {
    try {
      const { loadFleet } = await import("../model/load.ts");
      const gh = (await loadFleet()).admin.github;
      if (gh?.email) who = { name: gh.name ?? gh.login, email: gh.email };
    } catch { /* no fleet */ }
  }
  return who ? ["-c", `user.name=${who.name}`, "-c", `user.email=${who.email}`] : [];
}

export async function publishChange(
  paths: string[],
  message: string,
  o: { repo?: string; build?: boolean; identity?: { name: string; email: string } } = {},
): Promise<boolean> {
  const git = (args: string[]) => run(["git", "-C", o.repo ?? P.repo, ...args]);
  if (o.build !== false) {
    // build() reports in its own phase (Model); a model with problems commits nothing.
    const { build } = await import("../build.ts");
    if (!(await build())) return false;
  }

  const c = ui.phase("Commit");
  // Only paths that exist or are tracked (git add fails on a pathspec that matches nothing).
  const present: string[] = [];
  for (const x of [...paths, ...RENDERED]) {
    if ((await git(["ls-files", "--error-unmatch", "--", x])).ok) present.push(x);
    else {
      try {
        await Deno.stat(`${o.repo ?? P.repo}/${x}`);
        present.push(x);
      } catch { /* neither */ }
    }
  }
  const add = await git(["add", "-A", "--", ...present]);
  if (!add.ok) {
    c.fail(`git add: ${last(add)}`);
    return false;
  }
  const staged = await git(["diff", "--cached", "--quiet"]);
  if (staged.ok) c.done("nothing to commit");
  else {
    const ci = await git([...(await identity(git, o.identity)), "commit", "-q", "-m", message]);
    if (!ci.ok) {
      c.fail(`git commit: ${last(ci)}`, "git status");
      return false;
    }
    c.done(`"${message}"`);
  }

  const p = ui.phase("Push");
  for (let i = 0; i < 3; i++) {
    const push = await git(["push", "-q"]);
    if (push.ok) {
      p.done("on GitHub (main): pushing is approval");
      return true;
    }
    // Someone (a host's own state) pushed first: rebase onto it and try again.
    const pull = await git(["pull", "-q", "--rebase", "--autostash"]);
    if (!pull.ok) {
      p.fail(`git pull --rebase: ${last(pull)}`, "git status; then git push");
      return false;
    }
  }
  p.fail("git push failed three times", "git push");
  return false;
}
