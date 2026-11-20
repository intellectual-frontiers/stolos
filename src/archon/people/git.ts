/**
 * Spec 077: what Git says about people. A signed commit is an e-signature:
 * an access review is approved, and a policy acknowledged, by a commit signed
 * with the person's own key (`people/keys.ts`, its principal their work
 * email) or, for a review, by a fleet signer (`signers.ts`, its principal the
 * signer's name). Git checks each signature with `ssh-keygen` against an
 * allowed-signers file made from both lists.
 *
 * Git's history also gives each account's activity: the last observation in
 * which it could sign in, and the first after that in which it could not (or
 * was gone), which measures how long a leaver's account stayed active.
 *
 * ```mermaid
 * flowchart LR
 *   keys["people/keys.ts (email)"] & signers["signers.ts (name)"] --> allowed["allowed signers (temporary file)"]
 *   allowed --> verify["git verify-commit"]
 *   verify --> reviews["review approved: who, which commit"]
 *   verify --> acks["Acknowledges: policy@version, by whom"]
 *   hist["estate/*.ts, each version"] --> act["accountActivity: last active, off by"]
 * ```
 *
 * @module
 */
// Spec: 077-people-controls

import { errors, fs } from "@intellectual-frontiers/commons/ts/runtime";
import {
  array,
  boolean,
  type Decoder,
  object,
  record,
  string,
  unknownValue,
} from "@intellectual-frontiers/core";
import { exportedLiteral } from "@intellectual-frontiers/commons/ts/kernel";
import { run } from "../core/exec.ts";
import type { Item } from "../evidence/bundle.ts";
import type { SignerDef } from "../model/types.ts";
import type { PeopleKeys, Quarter } from "./records.ts";
import { reviewTicks } from "./reviews.ts";

const KEY = /^(ssh-ed25519|sk-ssh-ed25519@openssh\.com) [A-Za-z0-9+/]+={0,2}$/;
const enc = new TextEncoder();

/** Git's allowed signers for people and fleet signers (commit signatures only). */
export function peopleAllowedSigners(keys: PeopleKeys, signers: readonly SignerDef[]): string {
  const lines = [
    ...signers.map((s) => `${s.name} namespaces="git" ${s.key.trim()}`),
    ...Object.entries(keys)
      .filter(([, k]) => KEY.test(k))
      .map(([email, k]) => `${email} namespaces="git" ${k}`),
  ];
  return lines.join("\n") + "\n";
}

/** Problems with people/keys.ts: each value must be one ed25519 public key. */
export function keyProblems(keys: PeopleKeys): string[] {
  return Object.entries(keys)
    .filter(([, k]) => !KEY.test(k))
    .map(
      ([email]) =>
        `people/keys.ts: ${email}: not an ed25519 public key (the one line of its .pub file, without a comment)`,
    );
}

/** Runs git in a repository (tests pass their own). */
export type Git = (args: string[]) => Promise<{ ok: boolean; stdout: string; stderr: string }>;

/** git -C repo. */
export function gitIn(repo: string): Git {
  return (args) => run(["git", "-C", repo, ...args]);
}

/** Who signed a commit (the principal in the allowed-signers file), or undefined. */
export async function commitSigner(
  git: Git,
  sha: string,
  allowedFile: string,
): Promise<string | undefined> {
  const v = await git([
    "-c",
    "gpg.format=ssh",
    "-c",
    "gpg.ssh.program=ssh-keygen",
    "-c",
    `gpg.ssh.allowedSignersFile=${allowedFile}`,
    "verify-commit",
    "--raw",
    sha,
  ]);
  const who = (v.stderr + v.stdout).match(/Good "git" signature for (\S+) with/)?.[1];
  return v.ok && who ? who : undefined;
}

/** Run `fn` with an allowed-signers file made from `text`, removed after. */
export async function withAllowed<T>(text: string, fn: (file: string) => Promise<T>): Promise<T> {
  const file = await fs.makeTempFile({ prefix: "stolos-people-", suffix: ".allowed" });
  let out: T;
  try {
    await fs.writeTextFile(file, text);
    out = await fn(file);
  } finally {
    await removeTemp(file);
  }
  return out;
}

/** Remove a temporary file; one already gone is fine, any other error is thrown. */
async function removeTemp(file: string): Promise<void> {
  try {
    await fs.remove(file);
  } catch (e) {
    if (!(e instanceof errors.NotFound)) throw e;
  }
}

/** One commit: its sha, its time, and its message. */
interface Commit {
  sha: string;
  at: string;
  message: string;
}

async function commits(git: Git, args: string[]): Promise<Commit[]> {
  const r = await git(["log", "--format=%H%x1f%cI%x1f%B%x1e", ...args]);
  if (!r.ok) return [];
  return r.stdout
    .split("\x1e")
    .map((x) => x.trim())
    .filter(Boolean)
    .map((x) => {
      const [sha = "", at = "", message = ""] = x.split("\x1f");
      return { sha, at, message };
    });
}

const trailers = (message: string, key: string): string[] =>
  [...message.matchAll(new RegExp(`^${key}:\\s*(\\S+)\\s*$`, "gim"))].map((m) => m[1] ?? "");

/** The trailer an acknowledgement commit carries: `Acknowledges: <policy>@<version>`. */
export const ACK_TRAILER = "Acknowledges";

/** The trailer that approves a review as it is: `Access-Review: <quarter>/<manager>`. */
export const REVIEW_TRAILER = "Access-Review";

/** One acknowledgement Git proves: a commit signed by the person's own key. */
export interface VerifiedAck {
  /** The person (their work email: the key's principal). */
  email: string;
  /** The policy. */
  policy: string;
  /** The version. */
  version: string;
  /** The commit. */
  commit: string;
  /** When it was committed (ISO). */
  at: string;
}

/**
 * Every acknowledgement in the history: a commit with `Acknowledges:
 * <policy>@<version>`, signed by a key in people/keys.ts (whose principal is
 * the person). A commit signed by anyone else acknowledges nothing.
 */
export async function verifiedAcks(
  git: Git,
  keys: PeopleKeys,
  ref = "HEAD",
): Promise<VerifiedAck[]> {
  const found = await commits(git, [`--grep=^${ACK_TRAILER}:`, "--regexp-ignore-case", ref]);
  if (!found.length || !Object.keys(keys).length) return [];
  return await withAllowed(peopleAllowedSigners(keys, []), async (file) => {
    const out: VerifiedAck[] = [];
    for (const c of found) {
      const who = await commitSigner(git, c.sha, file);
      if (!who || !(who in keys)) continue;
      for (const t of trailers(c.message, ACK_TRAILER)) {
        const at = t.lastIndexOf("@");
        if (at <= 0) continue;
        out.push({
          email: who,
          policy: t.slice(0, at),
          version: t.slice(at + 1),
          commit: c.sha,
          at: c.at,
        });
      }
    }
    return out;
  });
}

/** A review file's state on a branch (main, as a host would see it). */
export interface ReviewStatus {
  /** The quarter. */
  quarter: Quarter;
  /** The manager (work email). */
  manager: string;
  /** Its path in the repository. */
  path: string;
  /** Lines ticked, and lines in all. */
  ticked: number;
  /** Lines in all. */
  lines: number;
  /** Who approved it (a fleet signer's name, or the manager's email), when it is approved. */
  approvedBy?: string;
  /** The approving commit. */
  commit?: string;
  /** When it was approved (ISO). */
  at?: string;
  /** The last commit that changed it, and when (ISO). */
  changed?: { commit: string; at: string };
  /** Why it is not approved, in words. */
  why?: string;
}

/** The review files of a quarter, committed at `ref` (`fleets/<fleet>/people/reviews/<quarter>/*.md`). */
export async function reviewPaths(
  git: Git,
  base: string,
  q: Quarter,
  ref = "HEAD",
): Promise<string[]> {
  const r = await git(["ls-tree", "--name-only", `${ref}:${base}/people/reviews/${q}`]);
  return r.ok
    ? r.stdout
        .split("\n")
        .filter((x) => x.endsWith(".md"))
        .sort()
        .map((f) => `${base}/people/reviews/${q}/${f}`)
    : [];
}

/**
 * Whether a review is approved at `ref`: every line ticked in the last
 * commit that changed it, and that commit signed by a fleet signer or by the
 * manager's own key; or, as it stands, a later commit with
 * `Access-Review: <quarter>/<manager>` signed the same way.
 */
export async function reviewStatus(
  git: Git,
  path: string,
  allowedFile: string,
  signers: readonly SignerDef[],
  ref = "HEAD",
): Promise<ReviewStatus> {
  const parts = path.split("/");
  const manager = (parts.pop() ?? "").replace(/\.md$/, "");
  const quarter = parts.pop() ?? "";
  const text = (await git(["show", `${ref}:${path}`])).stdout;
  const t = reviewTicks(text);
  const base: ReviewStatus = { quarter, manager, path, ticked: t.ticked, lines: t.lines };
  const may = (who?: string) => !!who && (who === manager || signers.some((s) => s.name === who));
  const [last] = await commits(git, ["-1", ref, "--", path]);
  if (!last) return { ...base, why: "not committed" };
  base.changed = { commit: last.sha, at: last.at };
  if (t.lines && t.ticked === t.lines) {
    const who = await commitSigner(git, last.sha, allowedFile);
    if (who && may(who)) return { ...base, approvedBy: who, commit: last.sha, at: last.at };
  }
  for (const c of await commits(git, [`--grep=^${REVIEW_TRAILER}:`, `${last.sha}..${ref}`])) {
    if (!trailers(c.message, REVIEW_TRAILER).includes(`${quarter}/${manager}`)) continue;
    const who = await commitSigner(git, c.sha, allowedFile);
    if (who && may(who)) return { ...base, approvedBy: who, commit: c.sha, at: c.at };
  }
  return {
    ...base,
    why:
      t.ticked < t.lines
        ? `${t.lines - t.ticked} of ${t.lines} line(s) not ticked`
        : "not signed by the manager's own key (people/keys.ts) or a fleet signer",
  };
}

/** Every review of a quarter, with its status. */
export async function quarterReviews(
  git: Git,
  base: string,
  q: Quarter,
  keys: PeopleKeys,
  signers: readonly SignerDef[],
  ref = "HEAD",
): Promise<ReviewStatus[]> {
  const paths = await reviewPaths(git, base, q, ref);
  if (!paths.length) return [];
  return await withAllowed(peopleAllowedSigners(keys, signers), async (file) => {
    const out: ReviewStatus[] = [];
    for (const p of paths) out.push(await reviewStatus(git, p, file, signers, ref));
    return out;
  });
}

/**
 * A quarter's access reviews as evidence for a bundle (spec 072): each
 * review file as committed, and the raw commit that approved it (with its
 * signature), so an auditor checks it offline.
 */
export async function reviewEvidence(git: Git, reviews: readonly ReviewStatus[]): Promise<Item[]> {
  const items: Item[] = [];
  for (const r of reviews) {
    const at = r.at ?? r.changed?.at ?? new Date().toISOString();
    const ref = r.commit ?? r.changed?.commit ?? "HEAD";
    const body = await git(["show", `${ref}:${r.path}`]);
    items.push({
      kind: "people",
      name: `${r.path} @ ${ref.slice(0, 12)}${
        r.approvedBy ? ` approved by ${r.approvedBy}` : " (not approved)"
      }`,
      at,
      content: enc.encode(body.stdout),
    });
    if (r.commit) {
      const raw = await git(["cat-file", "commit", r.commit]);
      items.push({
        kind: "commit",
        name: `commit ${r.commit}`,
        at,
        content: enc.encode(raw.stdout),
      });
    }
  }
  return items;
}

/** An account's activity, from the versions of its connector's observation. */
export interface Activity {
  /** The last observation in which it could sign in (ISO). */
  lastActive?: string;
  /** The first observation after that in which it could not, or was gone (ISO). */
  offBy?: string;
}

/**
 * What account activity reads of a connector's observation (`connect/connector.ts`'s
 * `Observation` has these fields and more).
 */
export type ObservedAccounts = {
  /** When (ISO time). */
  readonly at: string;
  /** The account (or tenant) observed. */
  readonly account: string;
  /** What could not be read. */
  readonly gaps: readonly string[];
  /** The accounts found (spec 085). */
  readonly entities?: {
    readonly accounts?: ReadonlyArray<{ readonly id: string; readonly active: boolean }>;
  };
  /** The records read (spec 089). */
  readonly records?: ReadonlyArray<{
    readonly label: string;
    readonly native_id: string;
    readonly props: Readonly<Record<string, unknown>>;
  }>;
};

/** An observation file's `observed`, as far as {@link ObservedAccounts} goes. */
const observedAccounts: Decoder<ObservedAccounts> = object(
  { at: string, account: string, gaps: array(string) },
  {
    entities: object({}, { accounts: array(object({ id: string, active: boolean })) }),
    records: array(object({ label: string, native_id: string, props: record(unknownValue) })),
  },
);

/** One version of a connector's observation. */
export interface ObservedVersion {
  /** The connector. */
  connector: string;
  /** The observation. */
  observation: ObservedAccounts;
}

/**
 * Each account's activity across versions of the observations (any order):
 * keyed by the account's node uid (`<connector>:<account>:<id>`).
 */
export function accountActivity(versions: readonly ObservedVersion[]): Map<string, Activity> {
  const states = new Map<string, Array<[string, boolean]>>(); // uid -> (at, active)
  const byConnector = new Map<string, ObservedVersion[]>();
  for (const v of versions) {
    byConnector.set(v.connector, [...(byConnector.get(v.connector) ?? []), v]);
  }
  for (const [connector, vs] of byConnector) {
    const known = new Set<string>();
    for (const v of [...vs].sort((a, b) => a.observation.at.localeCompare(b.observation.at))) {
      const o = v.observation;
      const t = `${connector}:${o.account}`;
      const here = new Map<string, boolean>();
      for (const a of o.entities?.accounts ?? []) here.set(`${t}:${a.id}`, a.active);
      for (const r of o.records ?? []) {
        if (r.label === "user_account") here.set(`${t}:${r.native_id}`, r.props["active"] === true);
      }
      // An account read before and missing now is gone (unless the source could not read it).
      if (!o.gaps.length) {
        for (const u of known) if (!here.has(u)) here.set(u, false);
      }
      for (const [u, active] of here) {
        known.add(u);
        states.set(u, [...(states.get(u) ?? []), [o.at, active]]);
      }
    }
  }
  const out = new Map<string, Activity>();
  for (const [u, s] of states) {
    const sorted = s.sort((a, b) => a[0].localeCompare(b[0]));
    const lastActive = sorted.filter(([, a]) => a).pop()?.[0];
    const offBy = sorted.find(([at, a]) => !a && (!lastActive || at > lastActive))?.[0];
    out.set(u, { ...(lastActive ? { lastActive } : {}), ...(offBy ? { offBy } : {}) });
  }
  return out;
}

/** Every committed version of the estate's observation files (`paths`), and the working tree's. */
export async function observedVersions(
  repo: string,
  paths: readonly string[],
  max = 400,
): Promise<ObservedVersion[]> {
  const git = gitIn(repo);
  const out: ObservedVersion[] = [];
  for (const path of paths) {
    const connector = (path.split("/").pop() ?? "").replace(/\.ts$/, "");
    const log = await git(["log", `-${max}`, "--format=%H", "--", path]);
    const texts = [];
    for (const sha of log.stdout.split("\n").filter(Boolean)) {
      const r = await git(["show", `${sha}:${path}`]);
      if (r.ok) texts.push(r.stdout);
    }
    texts.push(await fs.readTextFile(`${repo}/${path}`).catch(() => ""));
    for (const text of texts) {
      // Not a literal Stolos wrote, or not an observation: it adds nothing.
      const v = exportedLiteral(text, "observed");
      if (v.kind === "err") continue;
      const o = observedAccounts(v.value);
      if (o.kind === "ok") out.push({ connector, observation: o.value });
    }
  }
  return out;
}
