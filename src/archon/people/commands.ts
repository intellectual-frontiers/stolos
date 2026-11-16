/**
 * Spec 077: `stolos people [status|review|ack]`, on the controller PC.
 *
 * - `people status`: every people control now (the estate's `leavers` first),
 *   and each leaver account's time to deprovision. Read-only.
 * - `people review [--quarter 2026-Q4]`: one review file per manager, on a
 *   branch, signed, pushed, and opened as a pull request with `gh`.
 * - `people ack <policy>`: your acknowledgement of a policy's current
 *   version: a line in `policies/acks/<policy>.ts`, in a commit signed with
 *   your own key that carries `Acknowledges: <policy>@<version>`.
 *
 * @module
 */

import { fs, path as paths, proc, stdio } from "@intellectual-frontiers/commons/ts/runtime";
import { tsLiteral } from "@intellectual-frontiers/commons/ts/kernel";
import { ui } from "../core/ui.ts";
import { run } from "../core/exec.ts";
import { P, repoRel } from "../core/paths.ts";
import type { PolicyResult } from "../adopt/policy.ts";
import type { Acceptance } from "../adopt/adopt.ts";
import type { SignerDef } from "../model/types.ts";
import type { Estate } from "../estate/graph.ts";
import { acceptRisks, runEstate, type SubjectResult } from "../controls/core.ts";
import { type PackRun, runPack } from "../controls/run.ts";
import { estateQuery } from "../estate/graph.ts";
import { gitReader } from "../estate/snapshot.ts";
import {
  accountActivity,
  gitIn,
  keyProblems,
  observedVersions,
  quarterReviews,
  type ReviewStatus,
  verifiedAcks,
} from "./git.ts";
import {
  type DeprovisionMeasure,
  deprovisionMeasures,
  LEAVERS,
  peopleControls,
  type PeopleFacts,
  peoplePack,
} from "./controls.ts";
import {
  isQuarter,
  type PeopleFiles,
  type PolicyAck,
  previousQuarter,
  quarterOf,
  readPeopleFiles,
} from "./records.ts";
import { reviewFiles } from "./reviews.ts";

/** What `gatherPeople` found: the facts the controls compare, and the files as read. */
export interface PeopleGathered {
  /** The facts. */
  facts: PeopleFacts;
  /** The people files. */
  files: PeopleFiles;
  /** This quarter's reviews so far. */
  current: ReviewStatus[];
  /** What could not be read. */
  problems: string[];
}

/** The people facts of a fleet repository: its files (working tree) and what Git proves (at HEAD). */
export async function gatherPeople(
  repo: string,
  fleet: string,
  o: { now?: Date; signers?: SignerDef[] } = {},
): Promise<PeopleGathered> {
  const now = o.now ?? new Date();
  const base = `fleets/${fleet}`;
  const files = await readPeopleFiles(gitReader(repo), base);
  const signers =
    o.signers ??
    (await (async () => {
      const { loadSigners } = await import("../identity/signers.ts");
      return await loadSigners(paths.join(repo, base, "signers.ts")).catch(() => []);
    })());
  const git = gitIn(repo);
  const q = quarterOf(now);
  const reviewQuarter = previousQuarter(q);
  const estateFiles = (await gitReader(repo).list(`${base}/estate`))
    .filter((f) => f.endsWith(".ts") && f !== "links.ts")
    .map((f) => `${base}/estate/${f}`);
  const reviews = files.inUse
    ? await quarterReviews(git, base, reviewQuarter, files.keys, signers)
    : undefined;
  return {
    facts: {
      ...(files.roles ? { roles: files.roles } : {}),
      reviewQuarter,
      ...(reviews ? { reviews } : {}),
      policies: files.policies,
      acks: await verifiedAcks(git, files.keys),
      ...(files.training ? { training: files.training } : {}),
      ...(files.screening ? { screening: files.screening } : {}),
      activity: accountActivity(await observedVersions(repo, estateFiles)),
    },
    files,
    current: files.inUse ? await quarterReviews(git, base, q, files.keys, signers) : [],
    problems: [...files.problems, ...keyProblems(files.keys)],
  };
}

/** The leavers control and every people control over an estate, accepted risks applied. */
export function peopleResults(
  e: Estate,
  f: PeopleFacts,
  o: { now?: Date; accepted?: readonly Acceptance[] } = {},
): PolicyResult[] {
  const now = o.now ?? new Date();
  const q = (sql: string) => estateQuery(e, sql);
  const out: PolicyResult[] = [];
  const add = (r: SubjectResult | undefined, prefix: string) => {
    if (!r) return;
    const { subjects: _, ...rest } = r;
    out.push({ ...rest, id: `${prefix}${rest.id}` });
  };
  add(runEstate(LEAVERS, q, now), "");
  for (const c of peopleControls(f)) add(runEstate(c, q, now), "people/");
  return acceptRisks(o.accepted ?? [], out, now.getTime());
}

/** The people pack's run (results `people/<control>`), for Compliance; undefined when the fleet keeps no people files. */
export async function peoplePackRun(
  e: Estate,
  o: { repo?: string; fleet?: string; now?: Date; accepted?: readonly Acceptance[] } = {},
): Promise<PackRun | undefined> {
  const repo = o.repo ?? P.repo;
  const fleet = o.fleet ?? P.fleetId;
  if (!(await readPeopleFiles(gitReader(repo), `fleets/${fleet}`)).inUse) return undefined;
  const g = await gatherPeople(repo, fleet, { ...(o.now ? { now: o.now } : {}) });
  return await runPack(peoplePack(g.facts), {
    estate: e,
    ...(o.accepted ? { accepted: o.accepted } : {}),
    ...(o.now ? { now: o.now } : {}),
  });
}

/** Each leaver account's time to deprovision. */
export function deprovisionTable(
  e: Estate,
  f: PeopleFacts,
  now = new Date(),
): DeprovisionMeasure[] {
  const rows = estateQuery(
    e,
    `SELECT u.email_addr AS email, u.end_date, a.connector AS system, a.display_name AS account,
  a.user_account_uid AS uid, a.active
FROM user_inventory u
JOIN edge e ON e.src_uid = u.uid AND e.verb = 'has_account'
JOIN user_account a ON a.user_account_uid = e.dst_uid
WHERE u.status = 'terminated' AND u.end_date IS NOT NULL ORDER BY u.email_addr, a.connector`,
  );
  return deprovisionMeasures(rows, f.activity, now);
}

const failed = (): number => (ui.problems.some((x) => x.level === "fail") ? 1 : 0);

/** `stolos people status`: every people control now, and the time to deprovision. */
export async function peopleStatus(json = false): Promise<number> {
  const { loadEstate } = await import("../estate/commands.ts");
  const { loadAccepted } = await import("../controls/run.ts");
  const now = new Date();
  const e = await loadEstate();
  const g = await gatherPeople(P.repo, P.fleetId, { now });
  const accepted = await loadAccepted().catch(() => []);
  const results = peopleResults(e, g.facts, { now, accepted });
  const measures = deprovisionTable(e, g.facts, now);
  if (json) {
    stdio.stdout.writeSync(
      `${JSON.stringify(
        {
          results,
          deprovision: measures,
          reviews: { [g.facts.reviewQuarter]: g.facts.reviews ?? [], [quarterOf(now)]: g.current },
          problems: g.problems,
        },
        null,
        2,
      )}\n`,
    );
    return results.some((r) => r.status === "fail") ? 1 : 0;
  }
  const p = ui.phase("People");
  for (const x of g.problems) p.warn(x);
  const { table } = await import("../state/query.ts");
  if (results.length) {
    stdio.stdout.writeSync(
      `${table(results.map((r) => ({ control: r.id, status: r.status, detail: r.detail })))}\n`,
    );
  }
  if (measures.length) {
    stdio.stdout.writeSync("\nTime to deprovision (days active after the end date, from Git)\n");
    stdio.stdout.writeSync(
      `${table(
        measures.map((m) => ({
          person: m.email,
          end: m.end,
          system: m.system,
          account: m.account,
          days: m.days,
          now: m.active ? "active" : "off",
        })),
      )}\n`,
    );
  }
  for (const r of results.filter((x) => x.status === "fail")) p.fail(`${r.id}: ${r.detail}`, r.fix);
  if (!g.files.inUse) {
    ui.next.push(
      "keep people files: fleets/<fleet>/people/ and policies/ (bun run stolos docs people)",
    );
  }
  p.done(
    `${results.length} control(s): ${results.filter((r) => r.status === "pass").length} pass, ${
      results.filter((r) => r.status === "fail").length
    } fail`,
  );
  return failed();
}

/** Run git with the terminal (it may ask for the signing key's passphrase). */
async function gitInteractive(repo: string, args: string[]): Promise<boolean> {
  ui.pause();
  try {
    const r = await proc.output(["git", "-C", repo, ...args], {
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    return r.success;
  } finally {
    ui.resume();
  }
}

/** What `stolos people review` is told. */
export interface ReviewOptions {
  /** The quarter (default: this one). */
  quarter?: string;
  /** Show what would be written; change nothing. */
  check?: boolean;
  /** Commit on the branch here; push nothing, open no pull request. */
  local?: boolean;
  /** Now. */
  now?: Date;
}

/** `stolos people review`: the quarter's review files, on a branch, signed, as a pull request. */
export async function peopleReview(o: ReviewOptions = {}): Promise<number> {
  const now = o.now ?? new Date();
  const q = o.quarter ?? quarterOf(now);
  const p = ui.phase("Access review");
  if (!isQuarter(q)) {
    p.fail(`${q} is not a quarter`, "for example --quarter 2026-Q4");
    return 1;
  }
  const { loadEstate } = await import("../estate/commands.ts");
  const files = reviewFiles(await loadEstate(), q, now);
  if (!files.length) {
    p.fail(
      "no managers: the HR system gives no reporting lines (party_relationship reports_to)",
      "connect the HR system (bun run stolos connect), then bun run stolos estate observe",
    );
    return 1;
  }
  const repo = P.repo;
  const git = gitIn(repo);
  const fleet = repoRel(P.fleetDir);
  const fresh = [];
  for (const f of files) {
    const kept = await git(["cat-file", "-e", `HEAD:${fleet}/${f.path}`]);
    if (kept.ok) ui.say(`${f.path}: already on this branch, kept as it is`);
    else fresh.push(f);
  }
  for (const f of fresh) ui.say(`${fleet}/${f.path}: ${f.lines} line(s) for ${f.manager}`);
  if (o.check || !fresh.length) {
    p.done(
      fresh.length
        ? `${fresh.length} review(s) would be written for ${q} (--check: nothing changed)`
        : `${q}: every manager's review is already here`,
    );
    return 0;
  }
  if ((await git(["status", "--porcelain"])).stdout.trim()) {
    p.fail(
      "this checkout has uncommitted changes",
      "commit them (bun run stolos apply) or set them aside, then run this again",
    );
    return 1;
  }
  const here = (await git(["symbolic-ref", "--short", "HEAD"])).stdout.trim();
  const branch = `people/review-${q}`;
  if ((await git(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`])).ok) {
    p.fail(`the branch ${branch} exists already`, `git switch ${branch} (or delete it first)`);
    return 1;
  }
  const sw = await git(["switch", "-q", "-c", branch]);
  if (!sw.ok) {
    p.fail(`git switch: ${sw.stderr.trim()}`, "git status");
    return 1;
  }
  const back = async () => void (await git(["switch", "-q", here]));
  for (const f of fresh) {
    const path = paths.join(P.fleetDir, f.path);
    await fs.mkdir(paths.join(path, ".."), { recursive: true });
    await fs.writeTextFile(path, f.text);
  }
  await git(["add", "--", ...fresh.map((f) => `${fleet}/${f.path}`)]);
  const message = `people: access reviews for ${q} (${fresh.length} manager(s))`;
  stdio.stdout.writeSync("\n  Signing the commit: type your daily key's passphrase.\n\n");
  if (!(await gitInteractive(repo, ["commit", "-q", "-S", "-m", message]))) {
    await git(["reset", "-q", "--hard", "HEAD"]);
    await back();
    await git(["branch", "-q", "-D", branch]);
    p.fail("the commit was not made (a wrong passphrase, or it was cancelled)", "run this again");
    return 1;
  }
  if (o.local) {
    await back();
    p.done(
      `${branch}: ${fresh.length} review(s) committed; push it and open a pull request when ready`,
    );
    return 0;
  }
  const push = await git(["push", "-q", "-u", "origin", branch]);
  if (!push.ok) {
    await back();
    p.fail(`git push: ${push.stderr.trim().split("\n").pop()}`, `git push -u origin ${branch}`);
    return 1;
  }
  const body = [
    `Access reviews for ${q}, one file per manager, from the estate graph (spec 077).`,
    "",
    ...fresh.map((f) => `- ${f.manager}: \`${fleet}/${f.path}\` (${f.lines} line(s))`),
    "",
    "Each manager ticks every line they confirm and commits the file signed with their own key",
    "(people/keys.ts) or asks a fleet signer to. Merge with a merge commit or a fast-forward, never a",
    "squash or a rebase: the signed commits are the approvals.",
  ].join("\n");
  const pr = await run(
    ["gh", "pr", "create", "--base", here, "--head", branch, "--title", message, "--body", body],
    { cwd: repo },
  );
  await back();
  if (!pr.ok) {
    p.fail(
      `gh pr create: ${pr.stderr.trim().split("\n").pop()}`,
      `gh pr create --base ${here} --head ${branch} (the branch is pushed)`,
    );
    return 1;
  }
  p.done(`${fresh.length} review(s) for ${q}: ${pr.stdout.trim()}`);
  return 0;
}

/** The text of policies/acks/<policy>.ts. */
export function acksSource(acks: readonly PolicyAck[]): string {
  const sorted = [...acks].sort(
    (a, b) => a.email.localeCompare(b.email) || a.version.localeCompare(b.version),
  );
  return `// Written by stolos people ack (spec 077): who acknowledged which version of this policy.
// Each line counts only with its commit, signed by that person's own key (people/keys.ts).
import type { PolicyAck } from "@intellectual-frontiers/stolos/archon/people/records";

export const acks: PolicyAck[] = ${tsLiteral(sorted)};
`;
}

/** `stolos people ack <policy>`: acknowledge its current version, in a commit signed with your own key. */
export async function peopleAck(policy: string, o: { now?: Date } = {}): Promise<number> {
  const p = ui.phase("Acknowledge");
  const repo = P.repo;
  const git = gitIn(repo);
  const fleet = repoRel(P.fleetDir);
  const files = await readPeopleFiles(gitReader(repo), fleet);
  const pol = files.policies.find((x) => x.id === policy);
  if (!pol) {
    p.fail(
      `no policy ${policy}`,
      `one of: ${
        files.policies.map((x) => x.id).join(", ") || "none (fleets/<fleet>/policies/*.md)"
      }`,
    );
    return 1;
  }
  if (!pol.version) {
    p.fail(`policies/${policy}.md has no version in its front matter`, "ask its owner to set one");
    return 1;
  }
  const email = (await git(["config", "user.email"])).stdout.trim().toLowerCase();
  if (!email) {
    p.fail("Git does not know who you are here", "git config user.email <your work email>");
    return 1;
  }
  const key = files.keys[email];
  if (!key) {
    p.fail(
      `${email} has no key in people/keys.ts: an acknowledgement is a commit signed with your own key`,
      `add "${email}": "<your ssh-ed25519 public key>" to fleets/<fleet>/people/keys.ts (in a commit a fleet signer signs)`,
    );
    return 1;
  }
  const list = files.acks[policy] ?? [];
  if (!list.some((a) => a.email === email && a.version === pol.version)) {
    list.push({
      email,
      version: pol.version,
      date: (o.now ?? new Date()).toISOString().slice(0, 10),
    });
  }
  const path = paths.join(P.fleetDir, "policies", "acks", `${policy}.ts`);
  await fs.mkdir(paths.join(path, ".."), { recursive: true });
  await fs.writeTextFile(path, acksSource(list));
  await git(["add", "--", `${fleet}/policies/acks/${policy}.ts`]);
  const message = `people: ${email} acknowledges ${pol.title} ${pol.version}\n\nAcknowledges: ${policy}@${pol.version}`;
  stdio.stdout.writeSync("\n  Signing with your own key: type its passphrase.\n\n");
  if (!(await gitInteractive(repo, ["commit", "-q", "-S", "--allow-empty", "-m", message]))) {
    p.fail("the commit was not made (a wrong passphrase, or it was cancelled)", "run this again");
    return 1;
  }
  const acks = await verifiedAcks(git, { [email]: key });
  if (!acks.some((a) => a.policy === policy && a.version === pol.version)) {
    p.fail(
      "the commit is not signed by the key people/keys.ts lists for you",
      "git config user.signingkey <your key>, then git commit --amend --no-edit -S",
    );
    return 1;
  }
  p.done(`${email} acknowledged ${policy} ${pol.version}`);
  ui.next.push(
    "send it to main: a pull request (git push, gh pr create), or, as a fleet signer, bun run stolos apply",
  );
  return 0;
}
