/**
 * Path helpers built on Node's native `path` module (bundled with Deno, no
 * download needed).
 *
 * @module
 */

import * as nodePath from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** Join path segments (node:path). */
export const join: (...paths: string[]) => string = nodePath.join;
/** The folder of a path. */
export const dirname: (path: string) => string = nodePath.dirname;
/** The last segment of a path. */
export const basename: (path: string, suffix?: string) => string = nodePath.basename;
/** A path relative to another. */
export const relative: (from: string, to: string) => string = nodePath.relative;
/** An absolute path. */
export const resolve: (...paths: string[]) => string = nodePath.resolve;
/** This platform's separator. */
export const sep: string = nodePath.sep;
/** A file: URL to a path. */
export const fromFileUrl = (u: string | URL): string => fileURLToPath(u);
/** A path to a file: URL. */
export const toFileUrl = (p: string): URL => pathToFileURL(p);
