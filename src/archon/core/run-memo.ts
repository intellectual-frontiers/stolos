/**
 * What one run asks only once (spec 106-one-passphrase-speed FR-009). A run is one command, with the
 * runs nested in it: `update` fetches `origin`, then the send, then the doctor each wanted to, and
 * each read the fleet's model again. Here, `git fetch origin` is done once per run, and a file
 * read once is read again only after it changed (its size and time). Every command's start
 * forgets what the last one knew.
 *
 * @module
 */
// Spec: 106-one-passphrase-speed FR-009

import { fs } from "@intellectual-frontiers/system";
import { run, type RunResult } from "./exec.ts";
import { ui } from "./ui.ts";

/** How long a `git fetch` may take before it is stopped (a failed fetch is a warning, not a hang). */
export const FETCH_LIMIT_MS = 120_000;

/** What this run has fetched: each repository, and what of its origin (everything, or some branches). */
const fetched = new Map<
  string,
  { all?: Promise<RunResult>; branches: Map<string, Promise<RunResult>> }
>();
/** What this run has read, with the file's size and time when it was. */
const read = new Map<string, { stamp: string; value: Promise<unknown> }>();

/** A command starts: forget what the last one knew. */
export function resetRunMemo(): void {
  fetched.clear();
  read.clear();
}

/**
 * `git fetch --quiet origin [branch]` in `repo`, once per run: a second ask (a fetch of everything
 * covers a fetch of one branch) is answered with the first one's result, with a line in the log.
 */
export function fetchOnce(repo: string, branch?: string): Promise<RunResult> {
  const mine = fetched.get(repo) ?? { branches: new Map<string, Promise<RunResult>>() };
  fetched.set(repo, mine);
  const earlier = mine.all ?? (branch === undefined ? undefined : mine.branches.get(branch));
  if (earlier) {
    ui.log(`   git fetch origin${branch ? ` ${branch}` : ""}: done already in this run`);
    return earlier;
  }
  // A hard limit: a fetch that waits on a credential or a dead network never holds the run.
  const r = run(["git", "-C", repo, "fetch", "--quiet", "origin", ...(branch ? [branch] : [])], {
    signal: AbortSignal.timeout(FETCH_LIMIT_MS),
  });
  if (branch === undefined) mine.all = r;
  else mine.branches.set(branch, r);
  return r;
}

/** A file's size and modification time as text, or "none" where it is not there. */
async function stampOf(file: string): Promise<string> {
  try {
    const s = await fs.stat(file);
    return `${s.size}:${s.mtime?.getTime() ?? 0}`;
  } catch {
    return "none";
  }
}

/**
 * `load()`, once per run for as long as none of `files` changes: the fleet's `fleet.ts` and
 * signers are parsed once, however many steps ask for them. `key` names what is loaded.
 */
export async function readOnce<T>(
  key: string,
  files: readonly string[],
  load: () => Promise<T>,
): Promise<T> {
  const stamp = (await Promise.all(files.map(stampOf))).join("|");
  const had = read.get(key);
  if (had && had.stamp === stamp) return (await had.value) as T;
  const value = load();
  read.set(key, { stamp, value });
  value.catch(() => read.delete(key));
  return await value;
}
