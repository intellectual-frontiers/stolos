/**
 * Small filesystem helpers on Deno's native APIs.
 *
 * @module
 */

import { dirname } from "./path.ts";

/** Whether something is at `path` (a file, folder, or link; a broken link counts). Other errors are thrown. */
export async function exists(path: string): Promise<boolean> {
  try {
    await Deno.lstat(path);
    return true;
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return false;
    throw e;
  }
}

/** A text file's content, or `fallback` (default undefined) when it does not exist. Other errors are thrown. */
export async function readTextOr(
  path: string,
  fallback: string | undefined = undefined,
): Promise<string | undefined> {
  try {
    return await Deno.readTextFile(path);
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return fallback;
    throw e;
  }
}

/** Create a folder and its parents, if missing. */
export async function ensureDir(path: string): Promise<void> {
  await Deno.mkdir(path, { recursive: true });
}

/** Write a text file only when its content changed. Returns true if written. */
export async function writeIfChanged(path: string, content: string): Promise<boolean> {
  const current = await readTextOr(path);
  if (current === content) return false;
  await ensureDir(dirname(path));
  const tmp = `${path}.archon-tmp`;
  await Deno.writeTextFile(tmp, content);
  await Deno.rename(tmp, path);
  return true;
}

/** The names of the folders directly in `path`, sorted; empty when it does not exist. */
export async function listDirs(path: string): Promise<string[]> {
  const out: string[] = [];
  try {
    for await (const e of Deno.readDir(path)) if (e.isDirectory) out.push(e.name);
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) throw e;
  }
  return out.sort();
}

/** The names of the files directly in `path` ending in `suffix`, sorted; empty when it does not exist. */
export async function listFiles(path: string, suffix = ""): Promise<string[]> {
  const out: string[] = [];
  try {
    for await (const e of Deno.readDir(path)) {
      if (e.isFile && e.name.endsWith(suffix)) out.push(e.name);
    }
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) throw e;
  }
  return out.sort();
}

/** Recursively list files under a directory, relative to it. */
export async function walkFiles(root: string, rel = ""): Promise<string[]> {
  const out: string[] = [];
  try {
    for await (const e of Deno.readDir(rel ? `${root}/${rel}` : root)) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory) out.push(...await walkFiles(root, r));
      else out.push(r);
    }
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) throw e;
  }
  return out.sort();
}
