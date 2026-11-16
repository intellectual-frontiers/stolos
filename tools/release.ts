/**
 * `bun tools/release.ts <build|smoke> ...` (spec 096-bun-runtime FR-005): the engine's release
 * package, as CI makes it for each tag `v<version>`.
 *
 * - `build [out]` (default `out/release`): `tsc` compiles `src/` into JavaScript with declarations
 *   (`dist/`, each module keeping its place under the package's root, relative imports rewritten
 *   from `.ts` to `.js`), a `package.json` for the release maps `./*` to `dist/*.js` and
 *   `dist/*.d.ts` (the repository's own maps it to `src/*.ts`), `vendor/` goes beside `dist/` (the
 *   large vendored files the consoles read from beside the engine, each checked against its
 *   SHA-256 where it is used), and `bun pm pack` packs it as
 *   `intellectual-frontiers-stolos-<version>.tgz`, written into `out` with its SHA-256 beside it
 *   (`<name>.tgz.sha256`, in `sha256sum`'s format). Prints the tarball's path.
 * - `smoke <tarball>`: installs the tarball into an empty project, as a fleet repository depends on
 *   it, and runs `archon --version` there through the fleet's own `archon.ts`, on Bun and on Node;
 *   fails unless both print the package's version.
 *
 * JavaScript, not TypeScript, because Node does not strip types under `node_modules`.
 *
 * ```mermaid
 * flowchart LR
 *   src["src/**.ts"] -->|"tsc (rootDir src)"| dist["dist/**.js + .d.ts"]
 *   dist --> pkg["package.json<br/>./* to dist/*"]
 *   pkg -->|"bun pm pack"| tgz["intellectual-frontiers-stolos-&lt;version&gt;.tgz<br/>+ .sha256"]
 *   tgz -->|smoke| empty["an empty project:<br/>bun archon.ts --version<br/>node archon.ts --version"]
 *   tgz -->|"gh release create"| rel["GitHub release v&lt;version&gt;"]
 * ```
 *
 * @module
 */
import { sha256 } from "@intellectual-frontiers/ifc-ts/kernel";
import { fs, path, proc, stdio } from "@intellectual-frontiers/ifc-ts/runtime";

const ROOT = path.resolve(path.dirname(path.fromFileUrl(import.meta.url)), "..");

/** The repository's `package.json`, as far as the release reads it. */
type Manifest = {
  readonly name: string;
  readonly version: string;
  readonly description?: string;
  readonly license?: string;
  readonly engines?: Readonly<Record<string, string>>;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly repository?: unknown;
};

/** A string field of a JSON object, or undefined. */
function stringField(o: Record<string, unknown>, key: string): string | undefined {
  const v = o[key];
  return typeof v === "string" ? v : undefined;
}

/** A field of string values (`dependencies`, `engines`), or undefined. */
function stringMap(o: Record<string, unknown>, key: string): Record<string, string> | undefined {
  const v = o[key];
  if (typeof v !== "object" || v === null || Array.isArray(v)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, x] of Object.entries(v)) if (typeof x === "string") out[k] = x;
  return out;
}

/** The repository's `package.json`, read and checked. */
export async function readManifest(root = ROOT): Promise<Manifest> {
  const raw: unknown = JSON.parse(await fs.readTextFile(path.join(root, "package.json")));
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("package.json is not an object");
  }
  const o = raw as Record<string, unknown>;
  const name = stringField(o, "name");
  const version = stringField(o, "version");
  if (name === undefined || version === undefined)
    throw new Error("package.json has no name or version");
  const description = stringField(o, "description");
  const license = stringField(o, "license");
  const engines = stringMap(o, "engines");
  const dependencies = stringMap(o, "dependencies");
  return {
    name,
    version,
    ...(description === undefined ? {} : { description }),
    ...(license === undefined ? {} : { license }),
    ...(engines === undefined ? {} : { engines }),
    ...(dependencies === undefined ? {} : { dependencies }),
    ...(o["repository"] === undefined ? {} : { repository: o["repository"] }),
  };
}

/**
 * The release's `package.json`: the repository's name, version, licence, engines and run-time
 * dependencies (no development ones, no scripts), with `./*` mapped to the compiled modules.
 */
export function releaseManifest(m: Manifest): Record<string, unknown> {
  return {
    name: m.name,
    version: m.version,
    ...(m.description === undefined ? {} : { description: m.description }),
    ...(m.license === undefined ? {} : { license: m.license }),
    type: "module",
    exports: {
      "./package.json": "./package.json",
      "./*": { types: "./dist/*.d.ts", default: "./dist/*.js" },
    },
    files: ["dist", "vendor", "LICENSE", "LICENSING.md", "README.md"],
    ...(m.engines === undefined ? {} : { engines: m.engines }),
    ...(m.dependencies === undefined ? {} : { dependencies: m.dependencies }),
    ...(m.repository === undefined ? {} : { repository: m.repository }),
  };
}

/** The tarball's name for a package and version, as `bun pm pack` writes it. */
export function tarballName(name: string, version: string): string {
  return `${name.replace(/^@/, "").replace(/\//g, "-")}-${version}.tgz`;
}

/** The compiler's configuration for the release: the repository's strict one, emitting. */
export function releaseTsconfig(root: string, staging: string): Record<string, unknown> {
  const rel = (p: string): string => path.relative(staging, path.join(root, p)).replace(/\\/g, "/");
  return {
    extends: rel("tsconfig.json"),
    compilerOptions: {
      noEmit: false,
      declaration: true,
      rewriteRelativeImportExtensions: true,
      rootDir: rel("src"),
      outDir: "dist",
      sourceMap: false,
    },
    include: [`${rel("src")}/**/*.ts`],
    exclude: [],
  };
}

async function runOrThrow(argv: readonly string[], cwd: string): Promise<void> {
  const r = await proc.run(argv, { cwd, stdout: "inherit", stderr: "inherit" });
  if (!r.success) throw new Error(`${argv.join(" ")} failed (${r.code})`);
}

/** The Bun to run: this process when it is Bun, else `bun` on the PATH. */
function bun(): string {
  return proc.runtimeName() === "bun" ? proc.execPath() : (proc.which("bun") ?? "bun");
}

/** Build and pack the release into `out`; the tarball's path. */
export async function build(out: string, root = ROOT): Promise<string> {
  const m = await readManifest(root);
  const staging = path.join(root, "out", "package");
  await fs.remove(staging, { recursive: true }).catch(() => {});
  await fs.mkdir(staging, { recursive: true });
  await fs.writeTextFile(
    path.join(staging, "tsconfig.json"),
    `${JSON.stringify(releaseTsconfig(root, staging), null, 2)}\n`,
  );
  // tsc from the repository's own TypeScript, run by this runtime.
  await runOrThrow(
    [proc.execPath(), path.join(root, "node_modules", "typescript", "bin", "tsc"), "-p", staging],
    root,
  );
  await fs.writeTextFile(
    path.join(staging, "package.json"),
    `${JSON.stringify(releaseManifest(m), null, 2)}\n`,
  );
  for (const f of ["LICENSE", "LICENSING.md", "README.md"]) {
    if (await fs.exists(path.join(root, f))) {
      await fs.copyFile(path.join(root, f), path.join(staging, f));
    }
  }
  await fs.copy(path.join(root, "vendor"), path.join(staging, "vendor"));
  await fs.remove(path.join(staging, "tsconfig.json"));
  const dest = path.resolve(out);
  await fs.mkdir(dest, { recursive: true });
  await runOrThrow([bun(), "pm", "pack", "--destination", dest, "--ignore-scripts"], staging);
  const name = tarballName(m.name, m.version);
  const tgz = path.join(dest, name);
  const sum = await sha256(await fs.readFile(tgz));
  await fs.writeTextFile(`${tgz}.sha256`, `${sum}  ${name}\n`);
  return tgz;
}

/** Install the tarball into an empty project and run `archon --version` on Bun and on Node. */
export async function smoke(tgz: string, root = ROOT): Promise<void> {
  const m = await readManifest(root);
  await fs.withTempDir(
    async (dir) => {
      await fs.writeTextFile(
        path.join(dir, "package.json"),
        `${JSON.stringify(
          {
            name: "smoke",
            private: true,
            type: "module",
            dependencies: { [m.name]: `file:${path.resolve(tgz)}` },
          },
          null,
          2,
        )}\n`,
      );
      await fs.writeTextFile(
        path.join(dir, "archon.ts"),
        `import { run } from "${m.name}/archon/main";\n\nawait run();\n`,
      );
      await runOrThrow([bun(), "install"], dir);
      const node = proc.runtimeName() === "node" ? proc.execPath() : (proc.which("node") ?? "node");
      for (const [name, runtime] of [
        ["bun", bun()],
        ["node", node],
      ] as const) {
        const r = await proc.run([runtime, "archon.ts", "--version"], { cwd: dir });
        const said = `${r.stdout}${r.stderr}`.trim();
        if (!r.success || !said.includes(m.version)) {
          throw new Error(`${runtime} archon.ts --version: ${said || `exit ${r.code}`}`);
        }
        // By its name: its file's is bun.exe, node.EXE on Windows.
        console.log(`${name}: ${said.split("\n")[0] ?? ""}`);
      }
    },
    { prefix: "stolos-smoke-" },
  );
}

async function main(args: readonly string[]): Promise<number> {
  const [cmd, arg] = args;
  if (cmd === "build") {
    console.log(await build(arg ?? path.join(ROOT, "out", "release")));
    return 0;
  }
  if (cmd === "smoke" && arg !== undefined) {
    await smoke(arg);
    return 0;
  }
  stdio.stderr.writeSync("usage: bun tools/release.ts build [out] | smoke <tarball>\n");
  return 2;
}

if (import.meta.main) proc.exit(await main(proc.args));
