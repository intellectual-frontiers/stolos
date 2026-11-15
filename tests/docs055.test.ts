/**
 * Specs 055-documentation and 096-bun-runtime FR-009: the documentation lives in the TypeScript, and
 * `tools/docs.ts` reads it there by itself: every module's `@module` block, every export's JSDoc
 * (overloads, re-exports, `export { ... }`, and nothing inside a template literal), the
 * `@example` blocks it type-checks, and the HTML it renders (Mermaid drawn, guides linked).
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
  checkExamples,
  exampleSource,
  firstSentence,
  frontPage,
  MERMAID,
  modulePage,
  problemsOf,
  readModule,
  renderMarkdown,
  sourceFiles,
} from "../tools/docs.ts";

const ROOT = path.resolve(path.dirname(path.fromFileUrl(import.meta.url)), "..");

proves(
  ["055-documentation FR-001"],
  "055: every engine module starts with its @module JSDoc",
  async () => {
    const missing: string[] = [];
    for (const f of await sourceFiles(ROOT)) {
      const m = readModule(f, await fs.readTextFile(path.join(ROOT, f)));
      if (m.doc === undefined || m.doc === "") missing.push(f);
    }
    assertEquals(missing, [], "add a /** ... @module */ block at the top of each");
  },
);

proves(
  ["055-documentation FR-003"],
  "055: every Mermaid diagram is one of the kinds we use, and closed",
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
  },
);

proves(
  ["055-documentation FR-003", "055-documentation FR-004"],
  "055: the front page's one line per module, and Mermaid pinned",
  () => {
    assertEquals(
      firstSentence(
        "/**\n * Spec 052: every problem, by a stable code. More here.\n *\n * @module\n */",
      ),
      "Spec 052: every problem, by a stable code.",
    );
    assertEquals(
      firstSentence("/**\n * One.\n *\n * ```mermaid\n * flowchart LR\n * ```\n * @module\n */"),
      "One.",
    );
    assert(/^https:\/\/cdn\.jsdelivr\.net\/npm\/mermaid@\d+\.\d+\.\d+\//.test(MERMAID.url));
    assert(/^[0-9a-f]{64}$/.test(MERMAID.sha256));
    assertStringIncludes(MERMAID.vendored, "mermaid");
  },
);

/** A module with every form of export the reader knows, documented or not. */
const SAMPLE = `/**
 * A sample. It has every form.
 *
 * @example
 * \`\`\`ts
 * import { one } from "./sample.ts";
 * one(1);
 * \`\`\`
 *
 * @module
 */
import { x as imported } from "./other.ts";

/** One, overloaded. */
export function one(a: number): number;
export function one(a: string): string;
export function one(a: number | string): number | string {
  return a;
}

export const undocumented = 1;

/** A type. */
export type Pair = {
  readonly a: string;
};

const TEMPLATE = \`
export const insideTemplate = \${1};
\`;

/** Documented where it is declared. */
const local = /[\`"']/g;

export async function* gen(): AsyncGenerator<number> {
  yield 1;
}

/** A class. */
export class Thing {
  /** Its value. */
  value = 1;
  private hidden = 2;
}

export { local, imported, TEMPLATE };
export { other } from "./other.ts";
export * as all from "./all.ts";
`;

proves(
  ["055-documentation FR-001", "096-bun-runtime FR-009"],
  "096: the docs tool reads every export, and finds the undocumented ones",
  () => {
    const m = readModule("src/archon/sample.ts", SAMPLE);
    assertStringIncludes(m.doc ?? "", "A sample.");
    assertEquals(m.examples.length, 1);
    const names = m.exports.map((e) => `${e.kind} ${e.name}`);
    assertEquals(names, [
      "function one",
      "const undocumented",
      "type Pair",
      "function gen",
      "class Thing",
      "re-export other",
      "re-export all",
      "const local",
      "re-export imported",
      "const TEMPLATE",
    ]);
    const one = m.exports.find((e) => e.name === "one");
    assertEquals(one?.signature, "export function one(a: number): number");
    assertStringIncludes(m.exports.find((e) => e.name === "Thing")?.signature ?? "", "value = 1");
    assert(!(m.exports.find((e) => e.name === "Thing")?.signature ?? "").includes("hidden"));
    const problems = problemsOf(m).map((p) => `${p.line}: ${p.message}`);
    assertEquals(problems, [
      "21: const undocumented has no JSDoc",
      "35: function gen has no JSDoc",
      "28: const TEMPLATE has no JSDoc",
    ]);
    assertEquals(problemsOf(readModule("src/x.ts", "export const a = 1;\n")).length, 2);
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
    const good = readModule(
      "src/archon/core/sample.ts",
      `/**\n * Good.\n *\n * @example\n * \`\`\`ts\n * import { run } from "./exec.ts";\n * const r = await run(["true"]);\n * const code: number = r.code;\n * \`\`\`\n *\n * @module\n */\n`,
    );
    const bad = readModule(
      "src/archon/core/broken.ts",
      `/**\n * Broken.\n *\n * @example\n * \`\`\`ts\n * const n: number = "not a number";\n * \`\`\`\n *\n * @module\n */\n`,
    );
    const dir = path.join(ROOT, "out", `docs-examples-test-${proc.pid}`);
    try {
      const r = await checkExamples([good, bad], ROOT, dir);
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
  ["055-documentation FR-003", "055-documentation FR-004", "096-bun-runtime FR-009"],
  "096: the HTML: Mermaid blocks drawn, guides linked, the guides first on the front page",
  () => {
    const html = renderMarkdown(
      "src/archon-boot/mod.ts",
      "See [the agent](agent.md) and [compliance](../archon/compliance/mod.ts#scf).\n\n```mermaid\nflowchart LR\n  a --> b\n```\n",
      2,
    );
    assertStringIncludes(html, 'href="../../archon/mcp/mod.ts/index.html"');
    assertStringIncludes(html, 'href="../../archon/compliance/mod.ts/index.html#scf"');
    assertStringIncludes(html, '<pre class="mermaid">flowchart LR\n  a --&gt; b</pre>');
    const m = readModule("src/archon/sample.ts", SAMPLE);
    const page = modulePage(m);
    assertStringIncludes(page, 'id="one"');
    assert(!page.includes("mermaid.min.js"), "no diagram, no Mermaid script");
    const front = frontPage([m], new Map([["src/archon/sample.ts", "A sample."]]));
    const guides = front.indexOf("<h2>Guides</h2>");
    const folder = front.indexOf("<h2>archon/</h2>");
    assert(guides > 0 && folder > guides, "the guides come first, then the modules by folder");
    assertStringIncludes(
      front,
      '<a href="./archon/sample.ts/index.html"><code>sample.ts</code></a> A sample.',
    );
  },
);
