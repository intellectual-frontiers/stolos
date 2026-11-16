/**
 * `bun run version <bump|check|show|sync> [base]` (specs 046-engine-instance, 096-bun-runtime): the
 * engine's version lives in `src/archon/version.ts`, and `package.json`'s `version` is kept equal to
 * it by this tool, never by hand.
 *
 * - `bump`: raise the minor number (0.1.0 to 0.2.0) in both files and print it.
 * - `check`: fail unless both files agree and the version is newer than the one on `base` (default
 *   `origin/main`), or `base` has no version yet; prints the tag.
 * - `show`: print the version.
 * - `sync`: write `src/archon/version.ts`'s version into `package.json`.
 *
 * @module
 */
// Spec: 046-engine-instance
// Spec: 096-bun-runtime
import {
  bump,
  compareSemVer,
  formatSemVer,
  parseSemVer,
  type SemVer,
} from "@intellectual-frontiers/commons/ts/kernel";
import { fs, path, proc } from "@intellectual-frontiers/commons/ts/runtime";

const ROOT = path.resolve(path.dirname(path.fromFileUrl(import.meta.url)), "..");
const VERSION_FILE = path.join(ROOT, "src/archon/version.ts");
const PACKAGE_FILE = path.join(ROOT, "package.json");
const IN_TS = /export const VERSION = "(\d+\.\d+\.\d+)";/;
const IN_JSON = /^(\s*"version":\s*)"([^"]*)"/m;

/** The version a file's text holds, by the pattern given, or an error naming the file. */
function versionIn(text: string, pattern: RegExp, file: string): SemVer {
  const m = pattern.exec(text);
  const v = m === null ? undefined : parseSemVer(m[m.length - 1] ?? "");
  if (v === undefined || v.kind === "err") throw new Error(`${file} has no version`);
  return v.value;
}

/** `package.json` with its version replaced, everything else as it was. */
function withPackageVersion(text: string, v: SemVer): string {
  return text.replace(IN_JSON, (_all, head: string) => `${head}"${formatSemVer(v)}"`);
}

async function main(args: readonly string[]): Promise<number> {
  const [cmd = "show", base = "origin/main"] = args;
  const ts = await fs.readTextFile(VERSION_FILE);
  const pkg = await fs.readTextFile(PACKAGE_FILE);
  const v = versionIn(ts, IN_TS, "src/archon/version.ts");
  switch (cmd) {
    case "show":
      console.log(formatSemVer(v));
      return 0;
    case "sync":
      await fs.writeTextFile(PACKAGE_FILE, withPackageVersion(pkg, v));
      console.log(formatSemVer(v));
      return 0;
    case "bump": {
      const next = bump(v, "minor");
      await fs.writeTextFile(
        VERSION_FILE,
        ts.replace(IN_TS, `export const VERSION = "${formatSemVer(next)}";`),
      );
      await fs.writeTextFile(PACKAGE_FILE, withPackageVersion(pkg, next));
      console.log(formatSemVer(next));
      return 0;
    }
    case "check": {
      const inPackage = versionIn(pkg, IN_JSON, "package.json");
      if (compareSemVer(inPackage, v) !== 0) {
        console.error(
          `package.json says ${formatSemVer(inPackage)}, src/archon/version.ts ${formatSemVer(v)}: ` +
            "run `bun run version sync`",
        );
        return 1;
      }
      const known = await proc.run(["git", "rev-parse", "-q", "--verify", `${base}^{commit}`], {
        cwd: ROOT,
      });
      if (!known.success) {
        console.error(
          `unknown base ${base}: fetch it first (git fetch origin), so the check can compare`,
        );
        return 1;
      }
      const r = await proc.run(["git", "show", `${base}:src/archon/version.ts`], { cwd: ROOT });
      if (!r.success) {
        console.log(`v${formatSemVer(v)} (no version on ${base} yet)`);
        return 0;
      }
      const prev = versionIn(r.stdout, IN_TS, `${base}:src/archon/version.ts`);
      if (compareSemVer(v, prev) <= 0) {
        console.error(
          `version ${formatSemVer(v)} is not newer than ${formatSemVer(prev)} on ${base}: ` +
            "run `bun run version bump`",
        );
        return 1;
      }
      console.log(`v${formatSemVer(v)} (was ${formatSemVer(prev)} on ${base})`);
      return 0;
    }
    default:
      console.error("usage: bun run version <bump|check|show|sync> [base]");
      return 2;
  }
}

proc.exit(await main(proc.args));
