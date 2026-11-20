/**
 * Spec 099: the newest Stolos release, as `stolos update`, the Stolos Console and the Archon
 * Console show it. One `git ls-remote --tags` of the engine's repository (a release is its tag
 * `stolos-v<version>`, specs 096, 114-release-record), kept for an hour in a small cache file so a console page never waits on GitHub twice
 * in a row. Unreachable: undefined, and the pages say nothing rather than something wrong.
 *
 * @module
 */
// Spec: 099-engine-update FR-001, FR-002, FR-003
// Spec: 114-release-record FR-006

import { fs, path } from "@intellectual-frontiers/system";
import { run } from "../core/exec.ts";
import { TAG, TAG_PREFIX } from "../version.ts";
import { compare, parseTag } from "./upgrade.ts";

/** How long a lookup is kept. */
export const RELEASE_CACHE_MS = 60 * 60_000;

/** The newest `stolos-vX.Y.Z` tag in `git ls-remote --tags` output; no other tag is a release. */
export function newestTag(lsRemote: string): string | undefined {
  let best: string | undefined;
  for (const m of lsRemote.matchAll(
    new RegExp(`refs/tags/(${TAG_PREFIX}\\d+\\.\\d+\\.\\d+)$`, "gm"),
  )) {
    const tag = m[1] ?? "";
    const v = parseTag(tag);
    if (v && (!best || compare(v, parseTag(best) ?? [0, 0, 0]) > 0)) best = tag;
  }
  return best;
}

/** Whether `newest` is a newer release than `current` (both stolos-vX.Y.Z; false when either is not). */
export function isNewer(newest: string | undefined, current: string | undefined): boolean {
  const a = newest ? parseTag(newest) : undefined;
  const b = current ? parseTag(current) : undefined;
  return !!a && !!b && compare(a, b) > 0;
}

/**
 * The newest release of `repo` (owner/name on GitHub): from the cache when it is fresher than
 * `maxAgeMs`, else asked now (and cached). Undefined when GitHub cannot be reached.
 */
export async function newestRelease(
  repo: string,
  o: { cacheFile: string; maxAgeMs?: number; now?: number },
): Promise<string | undefined> {
  const now = o.now ?? Date.now();
  try {
    const c = JSON.parse((await fs.readTextOr(o.cacheFile)) ?? "{}") as {
      repo?: string;
      tag?: string;
      at?: number;
    };
    if (
      c.repo === repo &&
      c.tag &&
      parseTag(c.tag) &&
      c.at &&
      now - c.at < (o.maxAgeMs ?? RELEASE_CACHE_MS)
    ) {
      return c.tag;
    }
  } catch {
    // An unreadable cache is asked again.
  }
  const ls = await run(["git", "ls-remote", "--tags", "--refs", `https://github.com/${repo}.git`]);
  const tag = ls.ok ? newestTag(ls.stdout) : undefined;
  if (tag) {
    await fs
      .mkdir(path.dirname(o.cacheFile), { recursive: true })
      .then(() => fs.writeTextFile(o.cacheFile, JSON.stringify({ repo, tag, at: now }) + "\n"))
      .catch(() => undefined);
  }
  return tag;
}

/** The engine a console shows: what runs here, and the newest release when it is newer. */
export interface EngineVersions {
  /** The engine running here (its tag, stolos-vX.Y.Z). */
  running: string;
  /** The newest release, only when it is newer than what runs here. */
  newer?: string;
}

/** What runs here and, when there is one, the newer release (from the fleet repository's pin). */
export async function engineVersions(cacheFile: string): Promise<EngineVersions> {
  const { P } = await import("../core/paths.ts");
  const { engineRepository, PIN_FILE, readPin } = await import("./upgrade.ts");
  const running = TAG;
  const pin = readPin((await fs.readTextOr(path.join(P.repo, PIN_FILE))) ?? "");
  const repo = pin ? engineRepository(pin) : undefined;
  const newest = repo ? await newestRelease(repo, { cacheFile }).catch(() => undefined) : undefined;
  return { running, ...(newest && isNewer(newest, running) ? { newer: newest } : {}) };
}
