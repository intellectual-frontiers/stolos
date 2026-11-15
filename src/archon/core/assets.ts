/**
 * Spec 046-engine-instance: read the engine's own text files (constitution,
 * specifications, guides, the base dotfile layer) from the generated module,
 * wherever the engine was loaded from (a checkout or GitHub).
 *
 * @module
 */

import { ASSETS } from "../assets.auto.ts";

/** One engine file by its path in the engine repository ("docs/guide.md": a guide, extracted from its module). */
export function engineFile(path: string): string {
  const t = ASSETS[path];
  if (t === undefined) throw new Error(`the engine has no file ${path}`);
  return t;
}

/** Engine files under a folder ("home"), as paths relative to it. */
export function engineFiles(dir: string): string[] {
  const pre = dir.replace(/\/$/, "") + "/";
  return Object.keys(ASSETS).filter((k) => k.startsWith(pre)).map((k) => k.slice(pre.length));
}

/** The engine's specifications, by id ("004-install"). */
export function engineSpecs(): string[] {
  return [
    ...new Set(
      Object.keys(ASSETS).filter((k) => k.startsWith("specs/")).map((k) => k.split("/")[1]),
    ),
  ].sort();
}

/** One engine file, or undefined when the engine has none by that path. */
export function engineFileOr(path: string): string | undefined {
  return ASSETS[path];
}
