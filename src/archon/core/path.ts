/**
 * Path helpers built on Node's native `path` module (bundled with Deno, no
 * download needed).
 *
 * @module
 */

import * as nodePath from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const join = nodePath.join;
export const dirname = nodePath.dirname;
export const basename = nodePath.basename;
export const relative = nodePath.relative;
export const resolve = nodePath.resolve;
export const sep = nodePath.sep;
export const fromFileUrl = (u: string | URL) => fileURLToPath(u);
export const toFileUrl = (p: string) => pathToFileURL(p);
