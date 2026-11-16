/**
 * Specs 055-documentation and 096-bun-runtime FR-009: the documentation lives in the TypeScript and
 * IFC Docs (`ifc-docs`, commons 0011-documentation) makes the site from it, configured by
 * `docs.config.ts`: every module of `src/` starts with its `@module` block and is in one area,
 * `ifc-docs check` holds every export to its TSDoc (and finds one that has none), every Mermaid
 * block is one of the kinds the engine uses, drawn by the Mermaid commons' package pins, and every
 * `@example` compiles (`tools/doc-examples.ts`, which finds one that does not).
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
import { checkExamples, exampleSource, examplesIn, sourceFiles } from "../tools/doc-examples.ts";
import { ifcDocs } from "./ifc-docs.ts";

const ROOT = path.resolve(path.dirname(path.fromFileUrl(import.meta.url)), "..");

proves(
  ["055-documentation FR-001"],
  "055: every engine module starts with its @module JSDoc, and is in exactly one area of the site",
  async () => {
    const missing: string[] = [];
    const files = await sourceFiles(ROOT);
    for (const f of files) {
      const first = /\/\*\*[\s\S]*?\*\//.exec(await fs.readTextFile(path.join(ROOT, f)))?.[0];
      if (first === undefined || !/@module\b/.test(first)) missing.push(f);
    }
    assertEquals(missing, [], "add a /** ... @module */ block at the top of each");
    const { config } = await import("../docs.config.ts");
    const about = config.packages[0]?.about;
    const entries = (typeof about === "object" ? (about.areas ?? []) : []).flatMap(
      (a) => a.entryPoints,
    );
    assertEquals(entries.length, new Set(entries).size, "no module is in two areas");
    // Every module but the generated assets (data, read by the engine) is documented on the site.
    const shown = new Set(entries);
    assertEquals(
      files.filter((f) => !shown.has(f)),
      [],
      "every module of src/ is in an area of docs.config.ts",
    );
  },
);

proves(
  ["055-documentation FR-001", "096-bun-runtime FR-009"],
  "096: ifc-docs check passes on the engine, and finds an export with no TSDoc",
  async () => {
    const r = await ifcDocs(["check"]);
    assertEquals(r.code, 0, r.stderr);
    assertStringIncludes(`${r.stdout}${r.stderr}`, " 0 findings");
    // A repository of one module with an undocumented export, and a plain spec kit.
    const dir = await fs.makeTempDir({ prefix: "stolos-docs-check-" });
    try {
      await fs.mkdir(path.join(dir, ".git"), { recursive: true });
      await fs.mkdir(path.join(dir, "src"), { recursive: true });
      await fs.mkdir(path.join(dir, "specs", "001-demo"), { recursive: true });
      await fs.writeTextFile(
        path.join(dir, "src", "demo.ts"),
        "/**\n * A demo.\n *\n * @module\n */\n\n/** Documented. */\nexport const a = 1;\n\nexport const b = 2;\n",
      );
      await fs.writeTextFile(
        path.join(dir, "specs", "001-demo", "spec.md"),
        "# 001: Demo\n\n## Requirements\n\n- **FR-001** It is a demo.\n",
      );
      await fs.writeTextFile(
        path.join(dir, "docs.config.ts"),
        `export default ${JSON.stringify({
          name: "Demo",
          repository: "https://example.invalid/demo",
          home: { dir: ".", about: { title: "Demo", summary: "A demo." } },
          packages: [
            {
              dir: ".",
              slug: "demo",
              about: {
                title: "Demo",
                summary: "A demo.",
                areas: [{ title: "Demo", slug: "demo", entryPoints: ["src/demo.ts"] }],
              },
            },
          ],
          specKits: [{ layout: "spec-kit", dir: "specs", constitution: false }],
          citations: { prefix: "demo", digits: 3 },
        })};\n`,
      );
      const bad = await ifcDocs(["check", "--config", path.join(dir, "docs.config.ts")]);
      assertEquals(bad.code, 1, `${bad.stdout}${bad.stderr}`);
      assertStringIncludes(bad.stderr, "b is exported with no TSDoc");
      assert(!bad.stderr.includes("a is exported"), bad.stderr);
    } finally {
      await fs.remove(dir, { recursive: true });
    }
  },
  { timeout: 120_000 },
);

proves(
  ["055-documentation FR-003"],
  "055: every Mermaid diagram is one of the kinds we use, and closed; commons pins the Mermaid that draws it",
  async () => {
    const kinds =
      /^(flowchart (TB|TD|LR|RL|BT)|sequenceDiagram|stateDiagram-v2|classDiagram|erDiagram)$/;
    let n = 0;
    for (const f of await sourceFiles(ROOT)) {
      const text = await fs.readTextFile(path.join(ROOT, f));
      for (const m of text.matchAll(/```mermaid\n([\s\S]*?)```/g)) {
        // A diagram may open with Mermaid's front matter (--- config ... ---): its kind comes after.
        const lines = (m[1] ?? "").split("\n").map((l) => l.replace(/^\s*\*\s?/, "").trim());
        const first =
          lines[0] === "---" ? (lines[lines.indexOf("---", 1) + 1] ?? "") : (lines[0] ?? "");
        assert(kinds.test(first), `${f}: a mermaid block starts with "${first}"`);
        // A Markdown fence never closes inside the comment's own terminator.
        assert(!(m[1] ?? "").includes("*/"), `${f}: */ inside a diagram ends the comment`);
        n++;
      }
    }
    assert(n >= 15, `${n} diagrams`);
    // IFC Docs serves Mermaid from its package's dependency, pinned exactly; bun.lock holds its
    // integrity.
    const pkg: unknown = JSON.parse(
      await fs.readTextFile(
        path.join(ROOT, "node_modules", "@intellectual-frontiers", "commons", "package.json"),
      ),
    );
    const mermaid: unknown = Reflect.get(
      Object(Reflect.get(Object(pkg), "dependencies")),
      "mermaid",
    );
    assert(typeof mermaid === "string" && /^\d+\.\d+\.\d+$/.test(mermaid), String(mermaid));
    const lock = await fs.readTextFile(path.join(ROOT, "bun.lock"));
    const line = lock.split("\n").find((l) => l.includes(`"mermaid": ["mermaid@${mermaid}"`));
    assert(line !== undefined && /"sha512-[A-Za-z0-9+/=]+"\]/.test(line), "Mermaid's integrity");
  },
);

proves(
  ["055-documentation FR-002", "096-bun-runtime FR-009"],
  "096: every @example is type-checked, and a broken one is found",
  async () => {
    assertEquals(
      exampleSource(
        "src/archon/core/exec.ts",
        'import { run } from "./exec.ts";\nimport "../model/types.ts";',
      ),
      'import { run } from "@intellectual-frontiers/stolos/archon/core/exec";\nimport "@intellectual-frontiers/stolos/archon/model/types";',
    );
    // Only ts blocks of @example sections are examples; a diagram or an earlier fence is not.
    const good = examplesIn(
      "src/archon/core/sample.ts",
      '/**\n * Good.\n *\n * ```ts\n * not an example\n * ```\n *\n * @example\n * ```mermaid\n * flowchart LR\n * ```\n * ```ts\n * import { run } from "./exec.ts";\n * const r = await run(["true"]);\n * const code: number = r.code;\n * ```\n *\n * @module\n */\n',
    );
    assertEquals(good.length, 1);
    assertEquals(good[0]?.line, 13);
    const bad = examplesIn(
      "src/archon/core/broken.ts",
      '/**\n * Broken.\n *\n * @example\n * ```ts\n * const n: number = "not a number";\n * ```\n *\n * @module\n */\n',
    );
    const dir = path.join(ROOT, "out", `docs-examples-test-${proc.pid}`);
    try {
      const r = await checkExamples([...good, ...bad], ROOT, dir);
      assertEquals(r.total, 2);
      assertEquals(
        r.failures.map((f) => `${f.file}:${f.line}`),
        ["src/archon/core/broken.ts:6"],
      );
      assertStringIncludes(r.failures[0]?.errors.join("\n") ?? "", "TS2322");
    } finally {
      await fs.remove(dir, { recursive: true });
    }
  },
);

proves(
  ["055-documentation FR-006"],
  "055: a fleet repository's documentation stays local: nothing it is given publishes it",
  async () => {
    const { scaffoldFiles } = await import("../src/archon/fleet/scaffold.ts");
    const files = scaffoldFiles("v1.2.3");
    for (const [name, text] of Object.entries(files)) {
      assert(
        !/gh-pages|pages: write|deploy-pages|upload-pages-artifact/.test(text),
        `${name} publishes`,
      );
    }
    const pkg = JSON.parse(files["package.json"] ?? "{}") as { scripts?: Record<string, string> };
    assertEquals(Object.keys(pkg.scripts ?? {}).sort(), ["archon", "stolos"]);
  },
);
