/**
 * Spec 060: `stolos apply` (or `stolos push`): your changes to the fleet, from
 * this PC to every machine, in one command and at most one passphrase. Each
 * step checks before it changes anything, and stops at the first problem with
 * its fix; running it again with nothing new says so and does nothing.
 *
 * ```mermaid
 * flowchart LR
 *   c["checks<br/>(fleet, branch, keys)"] --> u["catch up<br/>(fast-forward)"]
 *   u --> b["build<br/>(validate, render)"]
 *   b --> s["show what changes"]
 *   s --> ci["compliance impact<br/>(the gate, spec 074)"]
 *   ci --> k["one signed commit<br/>(your passphrase)"]
 *   k --> v["verify: a key<br/>servers trust"]
 *   v --> p["push: every machine<br/>within 15 minutes"]
 * ```
 *
 * @module
 */
// Spec: 060-stolos-apply
// Spec: 105-calm-output FR-006, FR-007, FR-012 to FR-014, FR-017
// Spec: 106-one-passphrase-speed FR-009

import { fs } from "@intellectual-frontiers/commons/ts/runtime";
import { run } from "../core/exec.ts";
import { P } from "../core/paths.ts";
import { fetchOnce } from "../core/run-memo.ts";
import { ui } from "../core/ui.ts";
import { adoptMessage, commitSigned, describeCommit, describeSigning } from "./signing.ts";
import { porcelainPath } from "./records.ts";
import { waitingUpgrade } from "./upgrade.ts";

/** What `stolos apply` is told. */
export interface FleetApplyOptions {
  /** The commit message (default: written from what changed). */
  message?: string;
  /** Show the checks, the build, and what would be committed; change nothing. */
  check?: boolean;
  /**
   * Spec 074: approve weakenings the compliance gate blocks ("updates/beta",
   * "NET-02", "all"): written into the signed commit as the trailer
   * `Compliance-Approved: <keys>`.
   */
  approve?: string;
}

const last = (r: { stderr: string; stdout: string }) =>
  (r.stderr || r.stdout).trim().split("\n").pop() ?? "";

/**
 * What changed, by fleet and host, from `git status --porcelain` lines:
 * "olympia: host.ts; fcr: fleet.ts; README.md".
 */
export function describeChanges(porcelain: string): string {
  const groups = new Map<string, Set<string>>();
  for (const line of porcelain.split("\n").filter((l) => l.trim())) {
    let path = line.slice(3).trim().replace(/^"|"$/g, "");
    if (path.includes(" -> ")) path = path.split(" -> ")[1] ?? path;
    const host = path.match(/^fleets\/[^/]+\/hosts\/([^/]+)\/(.+)$/);
    const fleet = path.match(/^fleets\/([^/]+)\/(.+)$/);
    const [, key = "", file = path] = host ?? fleet ?? ["", "", path];
    const group = groups.get(key) ?? new Set<string>();
    groups.set(key, group);
    group.add(file);
  }
  const parts = [...groups.entries()].map(([k, files]) => {
    const list = [...files].sort();
    const shown = list.length > 6 ? [...list.slice(0, 6), `${list.length - 6} more`] : list;
    return (k ? `${k}: ` : "") + shown.join(", ");
  });
  return parts.length > 8
    ? [...parts.slice(0, 8), `${parts.length - 8} more`].join("; ")
    : parts.join("; ");
}

/** `stolos apply`: check, catch up, build, commit (signed), verify, push. */
export async function fleetApply(o: FleetApplyOptions = {}): Promise<number> {
  const git = (args: string[]) => run(["git", "-C", P.repo, ...args]);
  const fail = () => 1;

  // 1. Checks.
  const c = ui.phase("Checks");
  if (!(await git(["rev-parse", "--git-dir"])).ok) {
    c.fail(`${P.repo} is not a Git checkout`, "cd into your fleet repository first");
    return fail();
  }
  if (!P.fleetId) {
    c.fail("no fleet chosen", "bun run stolos fleet use <id>");
    return fail();
  }
  const { loadFleet } = await import("../model/load.ts");
  const branch = (await loadFleet().catch(() => undefined))?.repository?.branch ?? "main";
  // symbolic-ref names the branch even before its first commit.
  const here = (await git(["symbolic-ref", "--short", "HEAD"])).stdout.trim();
  if (here !== branch) {
    c.fail(`this checkout is on ${here}, not ${branch}`, `git switch ${branch}`);
    return fail();
  }
  const { keyChecksNow } = await import("../identity/keys-commands.ts");
  const blocking = (await keyChecksNow()).filter((k) => !k.ok && k.level === "fail");
  for (const k of blocking) c.fail(k.what, k.fix, k.code);
  if (blocking.length) return fail();
  c.done(`fleet ${P.fleetId}, branch ${branch}, your keys can sign`);

  // 2. Catch up (never a merge).
  const u = ui.phase("Catch up");
  // A new repository: GitHub has no branch yet, so there is nothing to catch up with.
  // A remote-tracking branch from an earlier fetch says it exists without asking GitHub again.
  const exists =
    (await git(["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}`])).ok ||
    (await git(["ls-remote", "--heads", "origin", branch])).stdout.trim() !== "";
  const fetch = exists ? await fetchOnce(P.repo, branch) : { ok: true, stderr: "", stdout: "" };
  if (!fetch.ok) {
    u.fail(
      `git fetch: ${last(fetch)}`,
      "check the network and gh auth status, then run this again",
    );
    return fail();
  }
  const remote = `origin/${branch}`;
  const count = async (range: string) =>
    exists ? Number((await git(["rev-list", "--count", range])).stdout.trim()) || 0 : 0;
  const hasHead = (await git(["rev-parse", "--verify", "--quiet", "HEAD"])).ok;
  const behind = hasHead ? await count(`HEAD..${remote}`) : 0;
  const ahead = !hasHead
    ? 0
    : exists
      ? await count(`${remote}..HEAD`)
      : Number((await git(["rev-list", "--count", "HEAD"])).stdout.trim()) || 0;
  if (behind && ahead) {
    u.fail(
      `your ${ahead} commit(s) and ${behind} new one(s) on GitHub went different ways`,
      "git pull --rebase (Git signs yours again: your passphrase once per commit), then run this again",
    );
    return fail();
  }
  if (behind && !o.check) {
    const ff = await git(["merge", "--ff-only", "--quiet", remote]);
    if (!ff.ok) {
      u.fail(
        `GitHub's ${behind} new commit(s) touch files you changed: ${last(ff)}`,
        "commit or set aside your change (git stash), bun run stolos update, then put it back (git stash pop)",
      );
      return fail();
    }
    u.done(`${behind} new commit(s) from GitHub first`);
  } else {
    u.done(
      !exists
        ? `GitHub has no ${branch} yet: this will be its first push`
        : behind
          ? `${behind} new commit(s) on GitHub (not pulled: --check)`
          : "up to date",
    );
  }

  // 3. Build: an invalid model commits nothing.
  const { build } = await import("../build.ts");
  if (!(await build())) return fail();

  // 4. What changes.
  const s = ui.phase("Changes");
  const porcelain = (await git(["status", "--porcelain", "--untracked-files=all"])).stdout;
  const what = describeChanges(porcelain);
  // Nothing changed here, but commits on top not signed by a fleet signer (made elsewhere,
  // for example by a tool): servers refuse them until a signed commit lands on top.
  const approve = what ? [] : await unapproved(git);
  if (!what && !ahead && !approve.length) {
    s.done("nothing to commit or push: up to date");
    return 0;
  }
  const files = porcelain.split("\n").filter(Boolean).map(porcelainPath);
  const upgrade = what ? await waitingUpgrade(P.repo, files) : undefined;
  if (what) s.done(what);
  else if (approve.length) {
    s.done(
      `${approve.length} commit(s) here are not signed by a fleet signer: one signed commit approves them`,
    );
  } else s.done(`${ahead} commit(s) to push`);
  const message =
    o.message?.trim() ||
    (upgrade
      ? adoptMessage(upgrade.to)
      : approve.length
        ? `${P.fleetId}: approve ${approve.length} commit(s) not signed by a fleet signer`
        : `${P.fleetId}: ${what || "changes"}`
    ).slice(0, 200);
  // Pushing is approval (Article 9): what is about to leave, before the passphrase is asked (spec 105-calm-output FR-012).
  const unseen = approve.length
    ? approve
    : ahead
      ? (await git(["log", "--format=%h %s", `${exists ? `${remote}..` : ""}HEAD`])).stdout
          .split("\n")
          .filter(Boolean)
      : [];
  if (unseen.length && !o.check) {
    ui.live(
      approve.length
        ? `${approve.length} commit${approve.length > 1 ? "s" : ""} made elsewhere, not signed by a fleet signer (your signed commit approves ${approve.length > 1 ? "them" : "it"}):`
        : `Sending ${unseen.length} commit${unseen.length > 1 ? "s" : ""} made here:`,
    );
    for (const c of unseen.slice(0, 10)) {
      const [sha = "", ...subject] = c.split(" ");
      ui.live(`  ${sha} ${describeCommit(subject.join(" "))}`);
    }
    if (unseen.length > 10) ui.live(`  and ${unseen.length - 10} more`);
  }

  // 4b. Spec 074: the controls this change weakens or strengthens, and the fleet's gate.
  if (what || ahead) {
    const { applyImpact } = await import("../compliance/impact.ts");
    const pass = await applyImpact({
      ...(exists ? { base: remote } : {}),
      ...(o.approve ? { approve: o.approve } : {}),
    });
    if (!pass && !o.check) return fail();
  }
  if (o.check) {
    s.action(
      "This is not sent yet: --check changed nothing",
      `bun run stolos apply -m "${message}"`,
      "E105-UNSENT",
    );
    return 0;
  }

  // 5. One signed commit (one passphrase).
  if (what || approve.length) {
    const k = ui.phase("Commit");
    const { gitIdentity } = await import("../identity/keys.ts");
    if (!(await gitIdentity(P.repo))) {
      k.fail(
        "Git does not know who you are in this checkout, so nothing can be committed",
        "bun run stolos keys setup (sets it from your GitHub account), then run this again",
        "E057-IDENTITY",
      );
      return fail();
    }
    const add = what ? await git(["add", "-A"]) : { ok: true, stdout: "", stderr: "" };
    if (!add.ok) {
      k.fail(`git add: ${last(add)}`, "git status");
      return fail();
    }
    if (what)
      ui.live(
        `Signing ${files.length} file${files.length === 1 ? "" : "s"}: ${describeSigning(files, upgrade)}`,
      );
    else ui.live(`Signing one approval of ${approve.length} commit(s)`);
    const commit = await commitSigned(P.repo, [
      "-q",
      "-S",
      ...(what ? [] : ["--allow-empty"]),
      "-m",
      message,
      // Spec 074: the approval travels in the signed commit, as a trailer.
      ...(o.approve ? ["-m", `Compliance-Approved: ${o.approve.trim()}`] : []),
    ]);
    if (!commit.ok) {
      // Cause first, what happened to the person's data, one command (spec 105-calm-output FR-007).
      k.fail(
        commit.wrongPassphrase
          ? `That passphrase didn't unlock your daily key, three times. Nothing was sent. Your ${files.length} file${files.length === 1 ? " is" : "s are"} safe.`
          : "The commit could not be made, so nothing was sent. Your files are safe.",
        "bun run stolos apply",
        commit.wrongPassphrase ? "E105-SIGN-PASSPHRASE" : "E105-FAILED",
      );
      return fail();
    }
    k.done(`"${message}"`);
  }

  // 6. Verify: the same check servers make, before anything leaves this PC.
  const v = ui.phase("Verify");
  const head = (await git(["rev-parse", "HEAD"])).stdout.trim();
  const base = exists ? (await git(["rev-parse", remote])).stdout.trim() : "0".repeat(40);
  const { keysCheckPush } = await import("../identity/keys-commands.ts");
  if (await keysCheckPush(`refs/heads/${branch} ${head} refs/heads/${branch} ${base}\n`)) {
    v.fail(
      "servers would refuse this commit (above)",
      "git commit --amend --no-edit -S, then: bun run stolos apply",
    );
    return fail();
  }
  v.done("signed by a key the servers trust");

  // 7. Push: pushing is approval (Article 9).
  const p = ui.phase("Push");
  const push = await git(["push", "-q", "-u", "origin", `HEAD:${branch}`]);
  if (!push.ok) {
    // The pre-push check (or Git) says why: show its own words, not only Git's last line.
    for (const l of push.stderr
      .split("\n")
      .filter((x) => x.trim() && !/^error: failed to push/.test(x))
      .slice(-6))
      p.note(l);
    p.fail(
      /rejected|fetch first|non-fast-forward/.test(push.stderr)
        ? "GitHub moved while this ran: nothing is lost"
        : /pre-push|archon: push refused/.test(push.stderr)
          ? `the push check refused it: ${
              push.stderr.match(/archon: push refused here: (.*)/)?.[1] ?? last(push)
            }`
          : `git push: ${last(push)}`,
      "run this again: bun run stolos apply",
    );
    return fail();
  }
  p.done(`on GitHub (${branch}): every machine applies it within 15 minutes`);
  ui.outcome("Sent: every server applies it within 15 minutes");

  // 8. After: a secret that changed is one thing for the person to do, shown once at the end.
  const { assess } = await import("../vault/state.ts");
  const { preparePanel } = await import("../vault/reminder.ts");
  const assessed = await assess().catch(() => undefined);
  if (assessed?.unbacked.length) await preparePanel(assessed);
  return 0;
}

/**
 * The commits at the top of this checkout that are not signed by one of the
 * fleet's signers (as servers check it), newest first, as "sha subject (author)";
 * empty when the newest commit is signed by one, or the fleet lists no signer.
 */
export async function unapproved(
  git: (args: string[]) => Promise<{ ok: boolean; stdout: string; stderr: string }>,
  repo = P.repo,
): Promise<string[]> {
  const { allowedSignersText, checkTip, loadSigners } = await import("../identity/signers.ts");
  const signers = await loadSigners().catch(() => []);
  if (!signers.some((x) => x.role === "daily")) return [];
  const dir = await fs.makeTempDir({ prefix: "stolos-approve-" });
  try {
    const allowed = `${dir}/allowed_signers`;
    await fs.writeTextFile(allowed, allowedSignersText(signers));
    const log = (await git(["log", "-50", "--format=%H%x09%s (%an)"])).stdout.trim().split("\n");
    const out: string[] = [];
    for (const line of log.filter(Boolean)) {
      const [sha = "", rest = ""] = line.split("\t");
      if ((await checkTip(repo, sha, "", allowed)).ok) break;
      out.push(`${sha.slice(0, 10)} ${rest}`);
    }
    return out;
  } finally {
    await fs.remove(dir, { recursive: true });
  }
}
