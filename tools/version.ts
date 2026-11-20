/**
 * `bun run version <bump|check|show|sync|set> [base|version]` (specs 046-engine-instance,
 * 096-bun-runtime, 114-release-record): the engine's version lives in `src/archon/version.ts`; the
 * `version` of `package.json` and of the work's record `release.ts` (commons 0026-works-versioning)
 * are kept equal to it by this tool, never by hand. `release.ts` is never the source: the tool
 * changes its `version` line and nothing else.
 *
 * - `bump`: raise the minor number (0.1.0 to 0.2.0) in the three files and print it.
 * - `set <version>`: write that version (`major.minor.patch`) in the three files and print it.
 * - `check`: fail unless the three agree and the version is newer than the one on `base` (default
 *   `origin/main`), or `base` has no version yet; prints the release tag, `stolos-v<version>`.
 * - `show`: print the version.
 * - `slug`: print the work's slug (`stolos`); `tag`: print the release tag (`stolos-v<version>`). CI reads both
 *   from here, so the spelling is written once (`src/archon/version.ts`).
 * - `sync`: write `src/archon/version.ts`'s version into `package.json` and `release.ts`.
 *
 * @module
 */
// Spec: 046-engine-instance
// Spec: 096-bun-runtime
// Spec: 114-release-record FR-002, FR-003
import { bump, compareSemVer, formatSemVer, parseSemVer, type SemVer } from "@intellectual-frontiers/formats";
import { fs, path, proc } from "@intellectual-frontiers/commons/ts/runtime";
import { tagOf, WORK_SLUG } from "../src/archon/version.ts";

/** The repository: the folder above `tools/`, or the one `STOLOS_VERSION_ROOT` names (the tool's test makes its own). */
const ROOT =
  proc.env.get("STOLOS_VERSION_ROOT") ??
  path.resolve(path.dirname(path.fromFileUrl(import.meta.url)), "..");
const VERSION_FILE = path.join(ROOT, "src/archon/version.ts");
const PACKAGE_FILE = path.join(ROOT, "package.json");
const RECORD_FILE = path.join(ROOT, "release.ts");
const IN_TS = /export const VERSION = "(\d+\.\d+\.\d+)";/;
const IN_JSON = /^(\s*"version":\s*)"([^"]*)"/m;
const IN_RECORD = /^(\s+version: )"(\d+\.\d+\.\d+)",$/m;

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

/** `release.ts` with its version replaced: the one line that changes, everything else as it was. */
function withRecordVersion(text: string, v: SemVer): string {
  return text.replace(IN_RECORD, (_all, head: string) => `${head}"${formatSemVer(v)}",`);
}

/** Write `v` into `package.json` and `release.ts` (and `src/archon/version.ts` when `ts` is given). */
async function writeAll(v: SemVer, pkg: string, record: string, ts?: string): Promise<void> {
  if (ts !== undefined) {
    await fs.writeTextFile(
      VERSION_FILE,
      ts.replace(IN_TS, `export const VERSION = "${formatSemVer(v)}";`),
    );
  }
  await fs.writeTextFile(PACKAGE_FILE, withPackageVersion(pkg, v));
  await fs.writeTextFile(RECORD_FILE, withRecordVersion(record, v));
}

async function main(args: readonly string[]): Promise<number> {
  const [cmd = "show", arg] = args;
  const base = arg ?? "origin/main";
  const ts = await fs.readTextFile(VERSION_FILE);
  const pkg = await fs.readTextFile(PACKAGE_FILE);
  const record = await fs.readTextFile(RECORD_FILE);
  const v = versionIn(ts, IN_TS, "src/archon/version.ts");
  switch (cmd) {
    case "show":
      console.log(formatSemVer(v));
      return 0;
    case "slug":
      console.log(WORK_SLUG);
      return 0;
    case "tag":
      console.log(tagOf(formatSemVer(v)));
      return 0;
    case "sync":
      await writeAll(v, pkg, record);
      console.log(formatSemVer(v));
      return 0;
    case "bump": {
      const next = bump(v, "minor");
      await writeAll(next, pkg, record, ts);
      console.log(formatSemVer(next));
      return 0;
    }
    case "set": {
      const given = arg === undefined ? undefined : parseSemVer(arg);
      if (given === undefined || given.kind === "err" || formatSemVer(given.value) !== arg) {
        console.error("usage: bun run version set <major.minor.patch> (for example 0.150.0)");
        return 2;
      }
      await writeAll(given.value, pkg, record, ts);
      console.log(formatSemVer(given.value));
      return 0;
    }
    case "check": {
      const inPackage = versionIn(pkg, IN_JSON, "package.json");
      const inRecord = versionIn(record, IN_RECORD, "release.ts");
      if (!record.includes(`slug: "${WORK_SLUG}",`)) {
        console.error(
          `release.ts does not name the work \`${WORK_SLUG}\` (src/archon/version.ts WORK_SLUG)`,
        );
        return 1;
      }
      if (compareSemVer(inPackage, v) !== 0 || compareSemVer(inRecord, v) !== 0) {
        console.error(
          `package.json says ${formatSemVer(inPackage)}, release.ts ${formatSemVer(inRecord)}, ` +
            `src/archon/version.ts ${formatSemVer(v)}: run \`bun run version sync\``,
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
        console.log(`${tagOf(formatSemVer(v))} (no version on ${base} yet)`);
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
      console.log(`${tagOf(formatSemVer(v))} (was ${formatSemVer(prev)} on ${base})`);
      return 0;
    }
    default:
      console.error("usage: bun run version <bump|check|show|sync|set|slug|tag> [base|version]");
      return 2;
  }
}

proc.exit(await main(proc.args));
