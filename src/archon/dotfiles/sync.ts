// 031-dotfile-layers: write a user's composed chezmoi source from the
// repository's layers into /var/lib/archon-dotfiles/<user>: owned by root,
// readable by the user's group, so chezmoi reads it and nothing writes to it
// but archon. Files no layer provides any more are removed.

import { dirname, join } from "../core/path.ts";
import { ensureDir, exists, walkFiles } from "../core/fsx.ts";
import { run } from "../core/exec.ts";
import {
  compose,
  COMPOSED_ROOT,
  composedDir,
  composedEntries,
  type Composition,
} from "./layers.ts";

/** Compose from a checkout (the repository root on disk). */
export function composeFrom(repo: string, host: string, user: string): Promise<Composition> {
  return compose(
    host,
    user,
    (dir) => walkFiles(join(repo, dir)),
    (rel) => Deno.readTextFile(join(repo, rel)),
  );
}

const same = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((x, i) => x === b[i]);

export interface SyncResult {
  composition: Composition;
  /** Paths in the composed source that were (or would be) written or removed. */
  changed: string[];
}

export async function syncComposed(
  repo: string,
  host: string,
  user: string,
  o: { check: boolean; root?: string },
): Promise<SyncResult> {
  const c = await composeFrom(repo, host, user);
  const dir = o.root ? join(o.root, user) : composedDir(user);
  const enc = new TextEncoder();
  const want = new Map<string, Uint8Array>();
  for (const e of composedEntries(c)) {
    want.set(e.path, e.from ? await Deno.readFile(join(repo, e.from)) : enc.encode(e.text!));
  }
  const changed: string[] = [];
  for (const [path, bytes] of want) {
    const target = join(dir, path);
    const have = await Deno.readFile(target).catch(() => undefined);
    if (have && same(have, bytes)) continue;
    changed.push(path);
    if (o.check) continue;
    await ensureDir(dirname(target));
    await Deno.writeFile(target, bytes);
  }
  for (const path of await walkFiles(dir)) {
    if (want.has(path)) continue;
    changed.push(path);
    if (!o.check) await Deno.remove(join(dir, path));
  }
  if (!o.check && changed.length && !o.root) await lockDown(dir, user);
  return { composition: c, changed };
}

/** root:<user's group>, directories 0750, files 0640; the parent is 0755. */
async function lockDown(dir: string, user: string) {
  await ensureDir(COMPOSED_ROOT);
  await Deno.chmod(COMPOSED_ROOT, 0o755);
  // Empty directories left by removed files.
  await run(["find", dir, "-mindepth", "1", "-type", "d", "-empty", "-delete"]);
  const group = (await run(["id", "-gn", user])).stdout.trim() || user;
  await run(["chown", "-R", `root:${group}`, dir]);
  await run(["find", dir, "-type", "d", "-exec", "chmod", "0750", "{}", "+"]);
  await run(["find", dir, "-type", "f", "-exec", "chmod", "0640", "{}", "+"]);
}

/** Whether a composed source exists yet for this user. */
export function composedExists(user: string): Promise<boolean> {
  return exists(composedDir(user));
}
