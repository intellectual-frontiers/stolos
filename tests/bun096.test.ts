/**
 * Spec 096-bun-runtime: the engine on Bun and IFC TypeScript. No old runtime, no registry or URL
 * imports; the dependencies pinned exactly and locked; the Bun pin checked for every platform; the
 * release package built, installed into an empty project and run on Bun and on Node.
 *
 * Elsewhere: `fleet init`'s layout (`tests/scaffold.test.ts`, FR-006), the docs tool finding an
 * undocumented export and a broken example (`tests/docs055.test.ts`, FR-009), PAM
 * (`tests/console065.test.ts`, FR-010), the first boot's Bun (`tests/install.test.ts`, FR-007).
 *
 * @module
 */
import { fs, path, proc } from "@intellectual-frontiers/ifc-ts/runtime";
import {
  assert,
  assertEquals,
  assertStringIncludes,
  proves,
} from "@intellectual-frontiers/ifc-ts/runtime/test";
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
  ["096-bun-runtime FR-001"],
  "096: no file of the engine names the old runtime or imports npm:, jsr: or a URL",
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
    for (const f of [`${OLD}.json`, `${OLD}.jsonc`, `${OLD}.lock`]) {
      if (await fs.exists(path.join(ROOT, f))) bad.push(`${f} configures the engine`);
    }
    assertEquals(bad, []);
  },
);

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
    assertEquals(Object.keys(deps).sort(), ["@intellectual-frontiers/ifc-ts", "ajv"]);
    assertEquals(Object.keys(dev).sort(), ["@types/node", "typescript"]);
    assert(/^7\.\d+\.\d+$/.test(dev["typescript"] ?? ""), "TypeScript 7, exactly");
    assertStringIncludes(
      deps["@intellectual-frontiers/ifc-ts"] ?? "",
      "https://github.com/intellectual-frontiers/.github/releases/download/ifc-ts-v",
      "IFC TypeScript by its release URL",
    );
    for (const [name, spec] of Object.entries({ ...deps, ...dev })) {
      if (spec.startsWith("https://")) continue;
      assert(/^\d+\.\d+\.\d+$/.test(spec), `${name}@${spec} is pinned exactly`);
    }
    // bun.lock (JSON with trailing commas): the root workspace asks for the same.
    const lock = await fs.readTextFile(path.join(ROOT, "bun.lock"));
    const root: unknown = JSON.parse(lock.replace(/,(\s*[}\]])/g, "$1"));
    const ws: unknown = Reflect.get(Reflect.get(Object(root), "workspaces") ?? {}, "");
    assertEquals(strings(ws, "dependencies"), deps);
    assertEquals(strings(ws, "devDependencies"), dev);
    for (const [name, spec] of Object.entries({ ...deps, ...dev })) {
      assertStringIncludes(lock, `"${name}@${spec}"`, `bun.lock resolves ${name}`);
    }
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

const BUN = proc.runtimeName() === "bun" ? proc.execPath() : proc.which("bun");

proves(
  ["096-bun-runtime FR-005"],
  "096: the package is built with tsc, packed, installed into an empty project, and runs on Bun and on Node",
  async () => {
    assert(BUN !== undefined);
    await fs.withTempDir(
      async (out) => {
        const built = await proc.run([BUN, "tools/release.ts", "build", out], { cwd: ROOT });
        assertEquals(built.code, 0, built.stderr);
        const tgz = built.stdout.trim().split("\n").pop() ?? "";
        assert(tgz.endsWith(".tgz") && (await fs.exists(tgz)), tgz);
        const sum = await fs.readTextFile(`${tgz}.sha256`);
        assert(/^[0-9a-f]{64} {2}\S+\.tgz\n$/.test(sum), sum);
        const smoke = await proc.run([BUN, "tools/release.ts", "smoke", tgz], { cwd: ROOT });
        assertEquals(smoke.code, 0, `${smoke.stdout}${smoke.stderr}`);
        const { VERSION } = await import("../src/archon/version.ts");
        assertStringIncludes(smoke.stdout, `bun: archon ${VERSION}`);
        assertStringIncludes(smoke.stdout, `node: archon ${VERSION}`);
      },
      { prefix: "stolos-release-" },
    );
  },
  { skip: BUN === undefined && "Bun is not installed (the package is packed by Bun)" },
);
