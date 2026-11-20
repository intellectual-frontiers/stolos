/**
 * `bun tools/smoke.ts [--repo DIR] [--commit SHA]` (spec 096-bun-runtime FR-005): the engine
 * installed as a fleet repository installs it, by Git at a commit, and run on Bun and on Node 26.
 * CI runs it on the commit it checked before it tags that commit `stolos-v<version>`: the tag is the
 * release, so this is what a fleet repository gets from it.
 *
 * In an empty project, `package.json` depends on `@intellectual-frontiers/stolos` by a `git+file:`
 * URL of the repository at the commit (by default, this checkout at its `HEAD`), as a fleet's
 * depends on `github:intellectual-frontiers/stolos#stolos-v<version>`; `bun install` installs it and its
 * own dependencies (commons by Git, `ajv`); then the fleet's entry files, `archon.ts` and
 * `stolos.ts`, run `--version` on Bun, and on Node 26 with commons' hook
 * (`node --import @intellectual-frontiers/commons/ts/node archon.ts`), since Node strips no types
 * under `node_modules`. Each must print the version the commit's `package.json` says. Any failure,
 * or a runtime that is not on `PATH`, ends with status 1.
 *
 * ```mermaid
 * flowchart LR
 *   repo["the repository<br/>at a commit"] -->|"git+file:...#sha<br/>bun install"| app["an empty project:<br/>archon.ts, stolos.ts"]
 *   app --> bun["bun archon.ts --version<br/>bun stolos.ts --version"]
 *   app --> node["node --import @intellectual-frontiers/commons/ts/node<br/>archon.ts / stolos.ts --version"]
 * ```
 *
 * @module
 */
// Spec: 096-bun-runtime
// Spec: 114-release-record FR-014
import { fs, path, proc } from "@intellectual-frontiers/system";
import { versionLine } from "../src/archon/version.ts";

const ROOT = path.resolve(path.dirname(path.fromFileUrl(import.meta.url)), "..");

/** The engine's package name, as a fleet repository depends on it. */
const PACKAGE = "@intellectual-frontiers/stolos";

/** The specifier of commons' Node hook (commons 0005-typescript-runtime FR-070). */
export const NODE_HOOK = "@intellectual-frontiers/commons/ts/node";

/** What the smoke test is given. */
export type SmokeOptions = {
  /** The repository to install (a Git checkout). */
  readonly repo: string;
  /** The commit to install; its `HEAD` where none is given. */
  readonly commit?: string;
};

/** One run of an entry file, by its runtime: what it printed. */
export type SmokeRun = { readonly name: string; readonly said: string };

/** The Bun to run: this process when it is Bun, else `bun` on the PATH. */
function bunPath(): string | undefined {
  return proc.runtimeName() === "bun" ? proc.execPath() : proc.which("bun");
}

/** The Node to run: this process when it is Node, else `node` on the PATH. */
function nodePath(): string | undefined {
  return proc.runtimeName() === "node" ? proc.execPath() : proc.which("node");
}

async function output(argv: readonly string[], cwd: string): Promise<string> {
  const r = await proc.run(argv, { cwd });
  if (!r.success)
    throw new Error(`${argv.join(" ")}: ${`${r.stderr}${r.stdout}`.trim() || r.code}`);
  return r.stdout.trim();
}

/** A repository's `git+file:` URL at a commit, as `package.json` names a Git dependency. */
export function gitFileUrl(repo: string, commit: string): string {
  return `git+${path.toFileUrl(path.resolve(repo)).href}#${commit}`;
}

/**
 * Install the repository at the commit into an empty project and run its entry files on Bun and
 * on Node 26; what each printed, or an error naming the run that failed.
 */
export async function smoke(o: SmokeOptions): Promise<SmokeRun[]> {
  const bun = bunPath();
  const node = nodePath();
  if (bun === undefined) throw new Error("bun is not on PATH");
  if (node === undefined) throw new Error("node is not on PATH");
  const commit = o.commit ?? (await output(["git", "-C", o.repo, "rev-parse", "HEAD"], o.repo));
  const manifest: unknown = JSON.parse(
    await output(["git", "-C", o.repo, "show", `${commit}:package.json`], o.repo),
  );
  const version: unknown =
    typeof manifest === "object" && manifest !== null
      ? Reflect.get(manifest, "version")
      : undefined;
  if (typeof version !== "string") throw new Error(`package.json at ${commit} has no version`);
  return await fs.withTempDir(
    async (dir) => {
      await fs.writeTextFile(
        path.join(dir, "package.json"),
        `${JSON.stringify(
          {
            name: "smoke",
            private: true,
            type: "module",
            dependencies: { [PACKAGE]: gitFileUrl(o.repo, commit) },
          },
          null,
          2,
        )}\n`,
      );
      for (const entry of ["archon", "stolos"]) {
        await fs.writeTextFile(
          path.join(dir, `${entry}.ts`),
          `import { run } from "${PACKAGE}/${entry}/main";\n\nawait run();\n`,
        );
      }
      await output([bun, "install"], dir);
      const runs: SmokeRun[] = [];
      for (const [name, argv] of [
        ["bun archon", [bun, "archon.ts"]],
        ["bun stolos", [bun, "stolos.ts"]],
        ["node archon", [node, "--import", NODE_HOOK, "archon.ts"]],
        ["node stolos", [node, "--import", NODE_HOOK, "stolos.ts"]],
      ] as const) {
        const r = await proc.run([...argv, "--version"], { cwd: dir });
        const said = `${r.stdout}${r.stderr}`.trim();
        if (!r.success || !said.includes(versionLine(version))) {
          throw new Error(`${name} --version: ${said || `exit ${r.code}`}`);
        }
        runs.push({ name, said: said.split("\n")[0] ?? "" });
      }
      return runs;
    },
    { prefix: "stolos-smoke-" },
  );
}

/** The command line: `[--repo DIR] [--commit SHA]`. */
export async function main(args: readonly string[]): Promise<number> {
  let repo = ROOT;
  let commit: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const v = args[i + 1];
    if (a === "--repo" && v !== undefined) repo = path.resolve(v);
    else if (a === "--commit" && v !== undefined) commit = v;
    else {
      console.error("usage: bun tools/smoke.ts [--repo DIR] [--commit SHA]");
      return 2;
    }
    i++;
  }
  try {
    for (const r of await smoke({ repo, ...(commit === undefined ? {} : { commit }) })) {
      console.log(`${r.name}: ${r.said}`);
    }
    return 0;
  } catch (e) {
    console.error(`smoke: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}

if (import.meta.main) proc.exit(await main(proc.args));
