/**
 * Spec 083: the audit trail. Every request the auditor makes, every response
 * the company gives, and every sample drawn is one file in
 * `fleets/<fleet>/audits/<id>/trail/`, numbered in order
 * (`0001-request.md`, `0002-response.md`, `0003-sample.md`), added in a
 * commit of its own signed with a fleet signer's key. The commit names the
 * file and its SHA-256 in a trailer, so the signature covers the entry's
 * exact text and an auditor checks it with the commit alone:
 *
 * ```text
 * audit soc2-2026: request 3 (CC6.2)
 *
 * Audit-Entry: fleets/lab/audits/soc2-2026/trail/0003-request.md sha256:<hex>
 * ```
 *
 * engagement.ts carries the same trailer in each commit that writes it. An
 * entry is a Markdown file with front matter, each value one line of JSON:
 *
 * ```markdown
 * ---
 * seq: 3
 * kind: "request"
 * at: "2026-11-02T15:04:05Z"
 * by: "Dana Example (Example CPA)"
 * control: "CC6.2"
 * ---
 *
 * Please show each sampled leaver's accounts on their last day.
 * ```
 *
 * ```mermaid
 * sequenceDiagram
 *   participant A as Auditor
 *   participant C as Company (a fleet signer)
 *   participant G as Fleet repository
 *   A->>C: a request (email, the portal's address)
 *   C->>G: stolos audit request: trail/000n-request.md, a signed commit
 *   C->>G: stolos audit respond: trail/000m-response.md, a signed commit
 *   A->>G: the portal or the export: each entry, its commit, its signer
 * ```
 *
 * @module
 */
// Spec: 083-auditor-portal

import { sha256 as sha256Hex } from "@intellectual-frontiers/commons/ts/kernel";
import { fs, path, proc } from "@intellectual-frontiers/commons/ts/runtime";
import { run } from "../core/exec.ts";
import { commitSignature, forNamespace, sshVerify } from "../evidence/bundle.ts";
import type { SampleRecord } from "./sample.ts";

/** What an entry is. */
export type EntryKind = "request" | "response" | "sample" | "note";

/** The kinds, in the order the command line lists them. */
export const ENTRY_KINDS: readonly EntryKind[] = ["request", "response", "sample", "note"];

/** One entry of the trail. */
export interface TrailEntry {
  /** Its number: entries are shown in this order. */
  seq: number;
  /** What it is. */
  kind: EntryKind;
  /** When it was recorded (ISO time). */
  at: string;
  /** Who made it: the auditor for a request, the company's person for a response. */
  by: string;
  /** The control it is about, when it is about one. */
  control?: string;
  /** The request a response answers (its seq). */
  re?: number;
  /** The sample, for a sample entry. */
  sample?: SampleRecord;
  /** Its text (Markdown). */
  body: string;
}

/** The trail folder, relative to the repository. */
export function trailDir(fleet: string, id: string): string {
  return `fleets/${fleet}/audits/${id}/trail`;
}

/** An entry's file name. */
export function entryFile(e: Pick<TrailEntry, "seq" | "kind">): string {
  return `${String(e.seq).padStart(4, "0")}-${e.kind}.md`;
}

/** An entry file's name: its number and kind. */
export const ENTRY_FILE = /^(\d{4})-(request|response|sample|note)\.md$/;

/** An entry's text. */
export function entrySource(e: TrailEntry): string {
  const head: Array<[string, unknown]> = [
    ["seq", e.seq],
    ["kind", e.kind],
    ["at", e.at],
    ["by", e.by],
    ["control", e.control],
    ["re", e.re],
    ["sample", e.sample],
  ];
  return `---\n${head
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}: ${JSON.stringify(v)}\n`)
    .join("")}---\n\n${e.body.trim()}\n`;
}

/** An entry from its text; throws when it is not one. */
export function parseEntry(text: string): TrailEntry {
  const m = /^---\n([\s\S]*?)\n---\n\n?([\s\S]*)$/.exec(text.replace(/\r\n/g, "\n"));
  if (!m) throw new Error("not a trail entry (front matter between --- lines first)");
  const f: Record<string, unknown> = {};
  const [, front = "", rest = ""] = m;
  for (const line of front.split("\n")) {
    const [, key, value] = /^([a-zA-Z]+): (.*)$/.exec(line) ?? [];
    if (key === undefined || value === undefined) {
      throw new Error(`front matter line "${line}" is not key: <JSON>`);
    }
    f[key] = JSON.parse(value);
  }
  if (typeof f["seq"] !== "number" || !ENTRY_KINDS.includes(f["kind"] as EntryKind)) {
    throw new Error("an entry has a seq and a kind");
  }
  return {
    seq: f["seq"],
    kind: f["kind"] as EntryKind,
    at: typeof f["at"] === "string" ? f["at"] : "",
    by: typeof f["by"] === "string" ? f["by"] : "",
    ...(typeof f["control"] === "string" ? { control: f["control"] } : {}),
    ...(typeof f["re"] === "number" ? { re: f["re"] } : {}),
    ...(f["sample"] ? { sample: f["sample"] as SampleRecord } : {}),
    body: rest.trim(),
  };
}

/** The trailer a commit carries for a file it records. */
export const TRAILER = "Audit-Entry";

/** The trailer line for a file and its text. */
export async function trailerLine(path: string, text: string): Promise<string> {
  return `${TRAILER}: ${path} sha256:${await sha256Hex(text)}`;
}

/** Each file a commit message's trailers vouch for, and its SHA-256. */
export function trailersOf(message: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const [, file, sum] of message.matchAll(/^Audit-Entry: (\S+) sha256:([0-9a-f]{64})$/gm)) {
    if (file !== undefined && sum !== undefined) out.set(file, sum);
  }
  return out;
}

/** What checking a file against its commit found. */
export interface Proof {
  /** The file (relative to the repository). */
  path: string;
  /** Its SHA-256. */
  sha256: string;
  /** The commit that recorded it. */
  commit?: string;
  /** The fleet signer who signed that commit. */
  signer?: string;
  /** What is wrong (empty: the commit is signed by a signer and vouches for this exact text). */
  problems: string[];
}

/** A raw commit's id (SHA-1 or SHA-256, as the repository hashes objects). */
export async function commitId(raw: Uint8Array): Promise<string> {
  const head = new TextEncoder().encode(`commit ${raw.length}\0`);
  const all = new Uint8Array(head.length + raw.length);
  all.set(head);
  all.set(raw, head.length);
  return [...new Uint8Array(await crypto.subtle.digest("SHA-1", all))]
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Check a file's text against the raw commit that recorded it, offline: the
 * commit's trailer names the file with this text's SHA-256, and its Git
 * signature verifies against the allowed signers.
 */
export async function proveEntry(
  path: string,
  text: string,
  rawCommit: string,
  allowedSigners: string,
): Promise<Proof> {
  const sha256 = await sha256Hex(text);
  const problems: string[] = [];
  const commit = await commitId(new TextEncoder().encode(rawCommit));
  const message = rawCommit.split("\n\n").slice(1).join("\n\n");
  const vouched = trailersOf(message).get(path);
  if (!vouched) problems.push(`its commit ${commit.slice(0, 12)} has no ${TRAILER} for ${path}`);
  else if (vouched !== sha256) {
    problems.push(
      `changed after its commit (SHA-256 ${sha256}, the commit vouches for ${vouched})`,
    );
  }
  const c = commitSignature(rawCommit);
  let signer: string | undefined;
  if (!c.signature) problems.push(`its commit ${commit.slice(0, 12)} is not signed`);
  else {
    const v = await sshVerify(c.payload, c.signature, forNamespace(allowedSigners, "git"), "git");
    if (v.signer) signer = v.signer;
    else problems.push(`its commit's signature: ${v.reason}`);
  }
  return { path, sha256, commit, ...(signer ? { signer } : {}), problems };
}

/** Writes files and commits them, signed (Git's signing key; ssh-keygen may ask its passphrase). */
export type Committer = (files: Record<string, string>, message: string) => Promise<string>;

/**
 * A Committer for the repository at `repo`: it writes each file (paths
 * relative to the repository), adds a trailer for each, and makes one signed
 * commit of those files only. `interactive` gives the terminal to ssh-keygen
 * for a passphrase. Returns the new commit.
 */
export function gitCommitter(repo: string, interactive = true): Committer {
  return async (files, message) => {
    const paths = Object.keys(files);
    for (const [p, text] of Object.entries(files)) {
      const abs = path.join(repo, p);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeTextFile(abs, text);
    }
    const add = await run(["git", "-C", repo, "add", "--", ...paths]);
    if (!add.ok) throw new Error(`git add: ${add.stderr.trim()}`);
    const trailers = await Promise.all(paths.map((p) => trailerLine(p, files[p] ?? "")));
    const r = await proc.output(
      [
        "git",
        "-C",
        repo,
        "commit",
        "-q",
        "-S",
        "-m",
        `${message}\n\n${trailers.join("\n")}`,
        "--only",
        "--",
        ...paths,
      ],
      {
        stdin: interactive ? "inherit" : "null",
        stdout: interactive ? "inherit" : "null",
        stderr: interactive ? "inherit" : "piped",
      },
    );
    if (r.code !== 0) {
      await run(["git", "-C", repo, "reset", "-q", "--", ...paths]);
      throw new Error(
        `the commit was not made (a wrong passphrase, no signing key, or it was cancelled)${
          interactive ? "" : `: ${new TextDecoder().decode(r.stderr).trim()}`
        }`,
      );
    }
    return (await run(["git", "-C", repo, "rev-parse", "HEAD"])).stdout.trim();
  };
}
