/**
 * Spec 096-bun-runtime: the engine on Bun and IFC TypeScript. No old runtime, no registry or URL
 * imports; the dependencies pinned exactly (commons by Git at a full commit) and locked; the Bun pin
 * checked for every platform; this checkout, committed in a throwaway clone, installed as a Git
 * dependency into an empty project and run on Bun and on Node 26 with commons' hook.
 *
 * Elsewhere: `fleet init`'s layout (`tests/scaffold.test.ts`, FR-006), `fleet upgrade`
 * (`tests/upgrade.test.ts`, FR-006), the documentation (`tests/docs055.test.ts`, FR-009), PAM
 * (`tests/console065.test.ts`, FR-010), the first boot's Bun (`tests/install.test.ts`, FR-007).
 *
 * @module
 */
import { fs, path, proc } from "@intellectual-frontiers/commons/ts/runtime";
import {
  assert,
  assertEquals,
  assertStringIncludes,
  proves,
} from "@intellectual-frontiers/commons/ts/runtime/test";
import {
  BUN_SHA256,
  BUN_TARGETS,
  BUN_VERSION,
  bunDownload,
  NODE_SHA256,
  NODE_TARGETS,
  nodeDownload,
} from "../src/archon/core/bun-pin.ts";

const ROOT = path.resolve(path.dirname(path.fromFileUrl(import.meta.url)), "..");

/** The old runtime's name, made here so that this file does not name it. */
const OLD = ["d", "eno"].join("");

/** Every file of the engine's code: src/, tools/, tests/, examples/ (not rendered output). */
async function engineFiles(): Promise<string[]> {
  const out: string[] = [];
  for (const top of ["src", "tools", "tests", "examples"]) {
    for (const rel of await fs.walkFiles(path.join(ROOT, top))) {
      const f = `${top}/${rel.replace(/\\/g, "/")}`;
      if (f.startsWith("examples/out/") || f.includes("/node_modules/")) continue;
      // The generated assets carry the specs' and the constitution's text, which tell the move.
      if (f === "src/archon/assets.auto.ts") continue;
      if (/\.(ts|js|cjs|mjs|json|sh|ps1|toml|tmpl)$/.test(f)) out.push(f);
    }
  }
  return out.sort();
}

proves(
  ["096-bun-runtime FR-001", "096-bun-runtime FR-008"],
  "096: no file of the engine or its documentation names the old runtime, or imports npm:, jsr: or a URL",
  async () => {
    // A word of its own, or a part of a name (`OTEL_` and the old name, spec 096 FR-008).
    const named = new RegExp(`(?<![a-z])${OLD}(?![a-z])`, "i");
    const registry = /(?:from\s+|import\(\s*)["'](?:npm:|jsr:|https?:\/\/)/;
    const bad: string[] = [];
    for (const f of await engineFiles()) {
      const text = await fs.readTextFile(path.join(ROOT, f));
      text.split("\n").forEach((line, i) => {
        if (named.test(line)) bad.push(`${f}:${i + 1} names ${OLD}`);
        if (registry.test(line)) bad.push(`${f}:${i + 1} ${line.trim()}`);
        if (line.includes("bun:ffi") && /^\s*import\b/.test(line)) {
          if (f !== "src/archon/console/pam.ts") bad.push(`${f}:${i + 1} imports bun:ffi`);
        }
      });
    }
    // FR-001: the documentation says what is true now, so it names no other runtime either.
    for (const f of await docFiles()) {
      const text = await fs.readTextFile(path.join(ROOT, f));
      text.split("\n").forEach((line, i) => {
        if (named.test(line)) bad.push(`${f}:${i + 1} names ${OLD}`);
      });
    }
    for (const f of [`${OLD}.json`, `${OLD}.jsonc`, `${OLD}.lock`]) {
      if (await fs.exists(path.join(ROOT, f))) bad.push(`${f} configures the engine`);
    }
    assertEquals(bad, []);
  },
);

/** The engine's documentation: the specs, the constitution, AGENTS.md, README.md and docs/ (not vendor/). */
async function docFiles(): Promise<string[]> {
  const out: string[] = [];
  for (const top of ["specs", "docs", ".specify/memory"]) {
    if (!(await fs.exists(path.join(ROOT, top)))) continue;
    for (const rel of await fs.walkFiles(path.join(ROOT, top))) {
      const f = `${top}/${rel.replace(/\\/g, "/")}`;
      if (/\.(md|tsv)$/.test(f)) out.push(f);
    }
  }
  for (const f of ["AGENTS.md", "README.md", "LICENSING.md"]) {
    if (await fs.exists(path.join(ROOT, f))) out.push(f);
  }
  return out.sort();
}

/** A JSON object's field as a map of strings ({} where it is not one). */
function strings(o: unknown, key: string): Record<string, string> {
  const v: unknown = typeof o === "object" && o !== null ? Reflect.get(o, key) : undefined;
  if (typeof v !== "object" || v === null) return {};
  return Object.fromEntries(
    Object.entries(v).filter((e): e is [string, string] => typeof e[1] === "string"),
  );
}

proves(
  ["096-bun-runtime FR-002"],
  "096: package.json pins every dependency exactly, and bun.lock holds the same",
  async () => {
    const pkg: unknown = JSON.parse(await fs.readTextFile(path.join(ROOT, "package.json")));
    const deps = strings(pkg, "dependencies");
    const dev = strings(pkg, "devDependencies");
    assertEquals(Object.keys(deps).sort(), [
      "@intellectual-frontiers/commons",
      "@intellectual-frontiers/core",
      "@intellectual-frontiers/terminal",
      "ajv",
    ]);
    assertEquals(Object.keys(dev).sort(), ["@types/node", "typescript"]);
    assert(/^7\.\d+\.\d+$/.test(dev["typescript"] ?? ""), "TypeScript 7, exactly");
    const commons = deps["@intellectual-frontiers/commons"] ?? "";
    assert(
      /^github:intellectual-frontiers\/\.github#[0-9a-f]{40}$/.test(commons),
      `commons by Git at a full commit, not ${commons}`,
    );
    for (const [name, spec] of Object.entries({ ...deps, ...dev })) {
      if (spec.startsWith("github:")) continue;
      assert(/^\d+\.\d+\.\d+$/.test(spec), `${name}@${spec} is pinned exactly`);
    }
    // bun.lock (JSON with trailing commas): the root workspace asks for the same.
    const lock = await fs.readTextFile(path.join(ROOT, "bun.lock"));
    const root: unknown = JSON.parse(lock.replace(/,(\s*[}\]])/g, "$1"));
    const ws: unknown = Reflect.get(Reflect.get(Object(root), "workspaces") ?? {}, "");
    assertEquals(strings(ws, "dependencies"), deps);
    assertEquals(strings(ws, "devDependencies"), dev);
    for (const [name, spec] of Object.entries({ ...deps, ...dev })) {
      // A github: dependency is locked by its short commit, with the integrity of its archive.
      const at = spec.startsWith("github:") ? spec.slice(0, spec.indexOf("#") + 8) : spec;
      assertStringIncludes(lock, `"${name}@${at}`, `bun.lock resolves ${name}`);
    }
    const entry = lock
      .split("\n")
      .find((l) => l.includes('"@intellectual-frontiers/commons@github:'));
    assert(entry !== undefined && /"sha512-[A-Za-z0-9+/=]+"\]/.test(entry), "commons' integrity");
  },
);

proves(
  ["096-bun-runtime FR-007"],
  "096: the Bun pin (and Node's) has a SHA-256 for every platform, and its archive's URL",
  () => {
    assert(/^\d+\.\d+\.\d+$/.test(BUN_VERSION), BUN_VERSION);
    assertEquals([...BUN_TARGETS].sort(), Object.keys(BUN_SHA256).sort());
    for (const t of BUN_TARGETS) {
      const d = bunDownload(t);
      assert(/^[0-9a-f]{64}$/.test(d.sha256), t);
      assertEquals(
        d.url,
        `https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-${t}.zip`,
      );
    }
    assertEquals([...NODE_TARGETS].sort(), Object.keys(NODE_SHA256).sort());
    for (const t of NODE_TARGETS) assert(/^[0-9a-f]{64}$/.test(nodeDownload(t).sha256), t);
    // Every SHA-256 is its own: no platform shares another's archive.
    const all = [...Object.values(BUN_SHA256), ...Object.values(NODE_SHA256)];
    assertEquals(new Set(all).size, all.length);
  },
);

proves(
  ["096-bun-runtime FR-007"],
  "096: on Node, the launcher's hook is the file commons' package exports as ./ts/node",
  async () => {
    const { NODE_HOOK, nodeHookFile } = await import("../src/archon/install/bun.ts");
    assertEquals(NODE_HOOK, "@intellectual-frontiers/commons/ts/node");
    const pkg: unknown = JSON.parse(
      await fs.readTextFile(
        path.join(ROOT, "node_modules", "@intellectual-frontiers", "commons", "package.json"),
      ),
    );
    const target = strings(pkg, "exports")["./ts/node"] ?? "";
    assertEquals(
      nodeHookFile("/srv/archon"),
      `/srv/archon/node_modules/@intellectual-frontiers/commons/${target.replace(/^\.\//, "")}`,
    );
  },
);

const BUN = proc.runtimeName() === "bun" ? proc.execPath() : proc.which("bun");
const NODE = proc.runtimeName() === "node" ? proc.execPath() : proc.which("node");

proves(
  ["096-bun-runtime FR-005"],
  "096: this checkout, committed, installs by Git into an empty project and runs on Bun and on Node 26",
  async () => {
    assert(BUN !== undefined && NODE !== undefined);
    await fs.withTempDir(
      async (clone) => {
        // A throwaway clone: this checkout's files as they are now (committed or not, never what
        // Git ignores), in one commit, as CI installs the commit it checked.
        const listed = await proc.run(
          ["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
          { cwd: ROOT },
        );
        assertEquals(listed.code, 0, listed.stderr);
        for (const f of listed.stdout.split("\0").filter((x) => x !== "")) {
          const from = path.join(ROOT, f);
          if (!(await fs.exists(from))) continue; // deleted, not yet committed
          await fs.mkdir(path.dirname(path.join(clone, f)), { recursive: true });
          await fs.copyFile(from, path.join(clone, f));
        }
        const git = (...a: string[]) => proc.run(["git", "-C", clone, ...a]);
        assertEquals((await git("init", "-q", "-b", "main")).code, 0);
        assertEquals((await git("add", "-A")).code, 0);
        const c = await git(
          "-c",
          "user.name=t",
          "-c",
          "user.email=t@example.invalid",
          "commit",
          "-q",
          "--no-gpg-sign",
          "-m",
          "smoke",
        );
        assertEquals(c.code, 0, c.stderr);
        const smoke = await proc.run([BUN, "tools/smoke.ts", "--repo", clone], { cwd: ROOT });
        assertEquals(smoke.code, 0, `${smoke.stdout}${smoke.stderr}`);
        const { versionLine } = await import("../src/archon/version.ts");
        for (const run of ["bun archon", "bun stolos", "node archon", "node stolos"]) {
          assertStringIncludes(smoke.stdout, `${run}: ${versionLine()}`);
        }
      },
      { prefix: "stolos-git-dependency-" },
    );
  },
  {
    skip:
      (BUN === undefined || NODE === undefined) &&
      "Bun and Node are both needed (the engine is installed by Bun and run on both)",
    timeout: 180_000,
  },
);
