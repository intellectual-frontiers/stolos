/**
 * `ifc-docs`, commons' documentation command (specs 055-documentation, 096-bun-runtime FR-009), as
 * the tests run it: by this runtime, from the installed package's `bin`, whose `.mjs` registers
 * commons' Node hook before anything else, so it runs on Bun and on Node alike.
 *
 * @module
 */
import { fs, path, proc } from "@intellectual-frontiers/commons/ts/runtime";

const ROOT = path.resolve(path.dirname(path.fromFileUrl(import.meta.url)), "..");

/** Runs `ifc-docs <args>` in the repository's root: its exit code and what it printed. */
export async function ifcDocs(
  args: readonly string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  const dir = path.join(ROOT, "node_modules", "@intellectual-frontiers", "commons");
  const pkg: unknown = JSON.parse(await fs.readTextFile(path.join(dir, "package.json")));
  const bin: unknown = Reflect.get(Object(Reflect.get(Object(pkg), "bin")), "ifc-docs");
  if (typeof bin !== "string") throw new Error("commons' package has no command ifc-docs");
  const r = await proc.run([proc.execPath(), path.join(dir, bin), ...args], { cwd: ROOT });
  return { code: r.code, stdout: r.stdout, stderr: r.stderr };
}
