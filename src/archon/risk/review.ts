/**
 * Spec 080: review through signed pull requests. A review changes a file in
 * the fleet repository (a risk's next review date in risks.ts; new vendors
 * in vendors.ts) on a branch of its own, in a commit signed with the
 * reviewer's daily key, and opens a pull request with `gh`. The approval is
 * the merge: a merge commit on the fleet's main branch signed by a fleet
 * signer (`git merge --no-ff -S`, then `stolos apply`), checked like spec
 * 072's evidence: `git verify-commit` against the fleet's signers.ts. A
 * merge made on GitHub's website is signed by GitHub, not by a signer: it is
 * approved by the next signed commit on main (`stolos apply` makes one),
 * and {@link approvalOf} says which.
 *
 * ```mermaid
 * sequenceDiagram
 *   participant R as Reviewer (stolos risks review)
 *   participant G as Git (fleet repository)
 *   participant H as GitHub
 *   participant S as Signer
 *   R->>G: branch risks/review-<id>-<day> from origin/main
 *   R->>G: edit risks.ts, commit -S (daily key)
 *   R->>H: push, gh pr create
 *   S->>H: review the pull request
 *   S->>G: git merge --no-ff -S, stolos apply (push)
 *   G-->>R: approvalOf(risks.ts): the merge commit, signed by a fleet signer
 * ```
 *
 * @module
 */

import { run } from "../core/exec.ts";
import { type Literal, tsLiteral } from "@intellectual-frontiers/ifc-ts/kernel";
import { fs, path as paths, proc, toError } from "@intellectual-frontiers/ifc-ts/runtime";
import { log } from "../core/log.ts";
import { isDay } from "./register.ts";
import type { Vendor } from "./vendors.ts";

/** A risk's `nextReview` in risks.ts's text, set to `next`; throws when the risk or its date is not found. */
export function setNextReview(source: string, id: string, next: string): string {
  if (!isDay(next)) throw new Error(`${next} is not a day (YYYY-MM-DD)`);
  const idRe = new RegExp(`\\bid:\\s*(["'\`])${id.replace(/[-]/g, "\\-")}\\1`);
  const m = idRe.exec(source);
  if (!m) throw new Error(`risks.ts has no risk with id "${id}"`);
  const from = m.index;
  const rest = source.slice(from + m[0].length);
  const nextId = /\bid:\s*["'`]/.exec(rest);
  const end = from + m[0].length + (nextId ? nextId.index : rest.length);
  const block = source.slice(from, end);
  const dateRe = /(\bnextReview:\s*)(["'`])\d{4}-\d{2}-\d{2}\2/;
  if (!dateRe.test(block)) {
    throw new Error(`risk "${id}" has no nextReview: "YYYY-MM-DD" written as a literal`);
  }
  return source.slice(0, from) + block.replace(dateRe, `$1"${next}"`) + source.slice(end);
}

/** A new vendors.ts, for a fleet that has none. */
export function vendorsFileSource(): string {
  return `// The fleet's vendors, triaged (spec 080): each one's criticality (FIPS 199) and the data it holds
// (OCSF data categories). Vendors are discovered (SSO applications, DNS, connected accounts);
// stolos vendors triage --write adds new ones here, in a pull request, for a person to assess.
import { defineVendors } from "@intellectual-frontiers/stolos/archon/risk/mod";

export const vendors = defineVendors([
]);
`;
}

/** One vendor's entry, for a person to assess (criticality "unassessed" until they do). */
export function vendorEntry(v: Vendor): string {
  const domains = [
    ...new Set(
      v.seen
        .filter((s) => s.kind === "dns")
        .map((s) => s.detail.split(" -> ").pop() ?? "")
        .filter(Boolean),
    ),
  ];
  const apps = [
    ...new Set(
      v.seen
        .filter((s) => s.kind === "sso")
        .map((s) => s.detail.replace(/^the SSO application /, "")),
    ),
  ];
  const entry: Record<string, Literal> = {
    id: v.id,
    name: v.name,
    criticality: "unassessed",
    data: [],
    ...(!v.known && domains.length ? { domains: [v.name] } : {}),
    ...(!v.known && apps.length ? { apps } : {}),
  };
  const seen =
    v.seen
      .slice(0, 3)
      .map((s) => s.detail)
      .join("; ") + (v.seen.length > 3 ? `; and ${v.seen.length - 3} more` : "");
  return `  // Discovered: ${seen.replace(/\n/g, " ")}. Set its criticality and data.\n  ${tsLiteral(
    entry,
    1,
  )},\n`;
}

/** vendors.ts's text with entries for `vendors` added at the end of its list. */
export function appendVendors(source: string | undefined, vendors: readonly Vendor[]): string {
  const s = source ?? vendorsFileSource();
  const start = s.search(/defineVendors\(\s*\[/);
  if (start < 0) throw new Error("vendors.ts does not call defineVendors([...])");
  const close = s.lastIndexOf("]");
  if (close < start) throw new Error("vendors.ts: defineVendors([...]) is not closed");
  let before = s.slice(0, close);
  const trimmed = before.trimEnd();
  if (!trimmed.endsWith(",") && !trimmed.endsWith("[")) before = `${trimmed},\n`;
  else before = `${trimmed}\n`;
  return before + vendors.map(vendorEntry).join("") + s.slice(close);
}

/** Who approved the last change to a file: the commit, and the fleet signer who signed it (or a later one). */
export interface Approval {
  /** The commit on the main line that last changed the file (a merge commit, for a merged pull request). */
  commit?: string;
  /** The fleet signer who signed it. */
  signer?: string;
  /** A later signed commit on the main line that approved it, when the change itself is not signed. */
  approvedBy?: { commit: string; signer: string };
  /** Why it is not approved. */
  reason?: string;
}

/**
 * The approval of the last change to `path`: the first-parent commit that
 * changed it (the merge commit of a merged pull request), checked with
 * `git verify-commit` against `allowedSigners` (the fleet's signers.ts as
 * Git's allowed_signers). An unsigned one is approved by the first later
 * signed commit on the main line, as servers do (spec 060).
 */
export async function approvalOf(
  repo: string,
  path: string,
  allowedSigners: string,
): Promise<Approval> {
  const git = (args: string[]) => run(["git", "-C", repo, ...args]);
  const last = (
    await git(["log", "--first-parent", "-1", "--format=%H", "--", path])
  ).stdout.trim();
  if (!last) return { reason: `${path} has no commit yet` };
  const { checkTip } = await import("../identity/signers.ts");
  const dir = await fs.makeTempDir({ prefix: "stolos-signers-" });
  try {
    const file = paths.join(dir, "allowed_signers");
    await fs.writeTextFile(file, allowedSigners);
    const own = await checkTip(repo, last, "", file);
    if (own.ok && own.signer) return { commit: last, signer: own.signer };
    const later = (await git(["rev-list", "--first-parent", "--reverse", `${last}..HEAD`])).stdout
      .trim()
      .split("\n")
      .filter(Boolean);
    for (const c of later) {
      const t = await checkTip(repo, c, "", file);
      if (t.ok && t.signer) return { commit: last, approvedBy: { commit: c, signer: t.signer } };
    }
    return { commit: last, reason: own.reason ?? "not signed by a fleet signer" };
  } finally {
    await fs
      .remove(dir, { recursive: true })
      .catch((e: unknown) => log.warn(`could not remove ${dir}: ${toError(e).message}`));
  }
}

/** A review to open as a pull request. */
export interface ReviewChange {
  /** The branch to make (from the base branch on GitHub). */
  branch: string;
  /** The files it changes, relative to the repository, each with its new text (from the base's). */
  edit: (read: (path: string) => Promise<string | undefined>) => Promise<Record<string, string>>;
  /** The commit message (and the pull request's title: its first line). */
  message: string;
  /** The pull request's body. */
  body: string;
}

/** What opening a review did. */
export interface ReviewResult {
  /** It worked. */
  ok: boolean;
  /** What happened, step by step (or what failed). */
  steps: string[];
  /** The pull request's URL. */
  url?: string;
  /** How to go on, when it failed. */
  fix?: string;
}

/** How to run a step: Git and gh (injectable for tests). */
export interface ReviewRunner {
  /** Run a command; its result. */
  run(argv: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }>;
  /** Run a command with the terminal (a signing key's passphrase). */
  interactive(argv: string[]): Promise<boolean>;
}

/** The real runner: processes in the repository. */
export function realRunner(repo: string): ReviewRunner {
  return {
    run: (argv) => run(argv, { cwd: repo }),
    async interactive(argv) {
      const r = await proc.output(argv, {
        cwd: repo,
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
      });
      return r.code === 0;
    },
  };
}

/**
 * Open a review: from a clean checkout, a branch from the base on GitHub,
 * the edit, one signed commit, a push of that branch, and a pull request
 * (`gh pr create`); then back to the branch it started on. Nothing is
 * merged: a signer approves by merging.
 */
export async function openReview(
  repo: string,
  c: ReviewChange,
  r: ReviewRunner = realRunner(repo),
): Promise<ReviewResult> {
  const steps: string[] = [];
  const git = (args: string[]) => r.run(["git", ...args]);
  const fail = (what: string, fix: string): ReviewResult => ({
    ok: false,
    steps: [...steps, what],
    fix,
  });
  if ((await git(["status", "--porcelain"])).stdout.trim()) {
    return fail(
      "the fleet repository has uncommitted changes",
      "commit them (bun run stolos apply) or put them aside, then run this again",
    );
  }
  const start = (await git(["rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim() || "main";
  const base =
    (await git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"])).stdout
      .trim()
      .replace(/^origin\//, "") || "main";
  const fetched = await git(["fetch", "-q", "origin", base]);
  if (!fetched.ok) {
    return fail(`git fetch: ${fetched.stderr.trim()}`, "check the network and GitHub access");
  }
  const sw = await git(["switch", "-q", "-c", c.branch, `origin/${base}`]);
  if (!sw.ok) {
    return fail(
      `git switch: ${sw.stderr.trim()}`,
      `a branch named ${c.branch} may exist: delete it (git branch -D ${c.branch}) or wait a day`,
    );
  }
  steps.push(`branch ${c.branch} from origin/${base}`);
  const back = async () => {
    await git(["switch", "-q", start]);
  };
  try {
    const files = await c.edit(async (p) => {
      try {
        return await fs.readTextFile(paths.join(repo, p));
      } catch {
        return undefined;
      }
    });
    for (const [p, text] of Object.entries(files)) {
      await fs.writeTextFile(paths.join(repo, p), text);
      steps.push(`changed ${p}`);
    }
    const add = await git(["add", "--", ...Object.keys(files)]);
    if (!add.ok) return fail(`git add: ${add.stderr.trim()}`, "git status");
    if (!(await r.interactive(["git", "commit", "-q", "-S", "-m", c.message]))) {
      await git(["reset", "-q", "--hard", `origin/${base}`]);
      return fail(
        "the commit was not made (a wrong passphrase, or it was cancelled)",
        "run this again",
      );
    }
    steps.push("one signed commit");
    const push = await git(["push", "-q", "-u", "origin", `HEAD:${c.branch}`]);
    if (!push.ok) return fail(`git push: ${push.stderr.trim()}`, `git push -u origin ${c.branch}`);
    steps.push(`pushed ${c.branch}`);
    const pr = await r.run([
      "gh",
      "pr",
      "create",
      "--base",
      base,
      "--head",
      c.branch,
      "--title",
      c.message.split("\n")[0] ?? c.message,
      "--body",
      c.body,
    ]);
    if (!pr.ok) {
      return fail(
        `gh pr create: ${pr.stderr.trim()}`,
        `open it on GitHub from the branch ${c.branch} (gh auth login, if gh is not signed in)`,
      );
    }
    const url = pr.stdout.trim().split("\n").pop();
    steps.push(`pull request ${url}`);
    return { ok: true, steps, ...(url ? { url } : {}) };
  } finally {
    await back();
  }
}
