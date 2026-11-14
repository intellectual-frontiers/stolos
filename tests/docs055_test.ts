/**
 * Spec 055: the documentation lives in the TypeScript, and stays there.
 *
 * @module
 */
import { assert, assertEquals } from "./assert.ts";
import { firstSentence, MERMAID, sourceFiles } from "../tools/docs.ts";

Deno.test("055: every engine module starts with its @module JSDoc", async () => {
  const missing: string[] = [];
  for (const f of await sourceFiles()) {
    const head = (await Deno.readTextFile(f)).match(/^\/\*\*[\s\S]*?\*\//)?.[0] ?? "";
    if (!head.includes("@module")) missing.push(f);
  }
  assertEquals(missing, [], "add a /** ... @module */ block at the top of each");
});

Deno.test("055: every Mermaid diagram is one of the kinds we use, and closed", async () => {
  const kinds =
    /^(flowchart (TB|TD|LR|RL|BT)|sequenceDiagram|stateDiagram-v2|classDiagram|erDiagram)$/;
  let n = 0;
  for (const f of await sourceFiles()) {
    const text = await Deno.readTextFile(f);
    for (const m of text.matchAll(/```mermaid\n([\s\S]*?)```/g)) {
      const first = m[1].split("\n")[0].replace(/^\s*\*\s?/, "").trim();
      assert(kinds.test(first), `${f}: a mermaid block starts with "${first}"`);
      // A Markdown fence never closes inside the comment's own terminator.
      assert(!m[1].includes("*/"), `${f}: */ inside a diagram ends the comment`);
      n++;
    }
  }
  assert(n >= 15, `${n} diagrams`);
});

Deno.test("055: the front page's one line per module, and Mermaid pinned", () => {
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
});
