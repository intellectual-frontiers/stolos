// Spec 070: the guides are module documentation, beside the code, and cannot drift from it: each
// guide's module exists and documents itself, its links reach real guides and headings, and every
// command it names is one the engine has.
import { assert, assertEquals } from "./assert.ts";
import { guideComment, guideMarkdown, GUIDES } from "../src/archon/core/guides.ts";
import { engineFile } from "../src/archon/core/assets.ts";
import { COMMANDS } from "../src/archon/commands/registry.ts";

const slug = (s: string) =>
  s.toLowerCase().replace(/<[^>]+>/g, "").replace(/[^a-z0-9 -]/g, "").trim().replace(/\s+/g, "-");
const md = (name: string) => engineFile(`docs/${name}.md`);

Deno.test("070: each guide is its module's documentation, and the assets carry it unchanged", async () => {
  assertEquals(new Set(GUIDES.map((g) => g.name)).size, GUIDES.length, "unique names");
  for (const g of GUIDES) {
    const src = await Deno.readTextFile(g.module);
    assertEquals(guideMarkdown(src), md(g.name), `${g.name}: run deno task gen`);
    assert(md(g.name).startsWith("# "), `${g.name} starts with its title`);
  }
  assert(
    !(await Deno.stat("docs").then(() => true, () => false)),
    "no docs/ folder: guides live in modules",
  );
});

Deno.test("070: a guide round-trips through a doc comment (even with */ in it)", () => {
  const text = "# T\n\nA `/* x */` comment, and an empty line:\n\nend\n";
  assertEquals(guideMarkdown(guideComment(text)), text);
});

Deno.test("070: links between guides reach a guide and, with #, one of its headings", () => {
  const names = new Set(GUIDES.map((g) => g.name));
  const problems: string[] = [];
  for (const g of GUIDES) {
    for (const [, target, hash] of md(g.name).matchAll(/\]\(([a-z0-9-]+)\.md(?:#([^)]+))?\)/g)) {
      if (!names.has(target)) problems.push(`${g.name}: ${target}.md is not a guide`);
      else if (hash) {
        const heads = [...md(target).matchAll(/^#+ (.+)$/gm)].map((m) => slug(m[1]));
        if (!heads.includes(hash)) {
          problems.push(`${g.name}: ${target}.md#${hash} has no such heading`);
        }
      }
    }
  }
  assertEquals(problems, []);
});

Deno.test("070: every command a guide names is a command the engine has", async () => {
  // The boot server's commands are dispatched in its own main (stolos boot <cmd>; serve is the default).
  const boot = [
    ...(await Deno.readTextFile("src/archon-boot/main.ts")).matchAll(/cmd === "([a-z-]+)"/g),
  ]
    .map((m) => `boot ${m[1]}`);
  const names = [...COMMANDS.map((c) => c.name), ...boot, "boot serve"].sort((a, b) =>
    b.length - a.length
  );
  const firsts = new Set(names.map((n) => n.split(" ")[0]));
  const problems: string[] = [];
  for (const g of GUIDES) {
    const text = md(g.name);
    const spans = [...text.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]);
    const blocks = [...text.matchAll(/```(?:bash|sh|console|powershell)?\n([\s\S]*?)```/g)].flatMap(
      (m) => m[1].split("\n"),
    );
    for (const line of [...spans, ...blocks]) {
      for (
        const m of line.matchAll(
          /(?:deno task stolos|(?:^|[\s(])(?:sudo )?archon) ([a-z][a-z0-9-]*(?: [a-z][a-z0-9-]*)*)/g,
        )
      ) {
        const words = m[1];
        // Prose ("archon and ...") is not a command; a group ("archon pg") is the start of some.
        if (!firsts.has(words.split(" ")[0])) continue;
        const ok = names.some((n) =>
          words === n || words.startsWith(n + " ") || n.startsWith(words + " ")
        );
        if (!ok) problems.push(`${g.name}: ${m[0].trim()}`);
      }
    }
  }
  assertEquals([...new Set(problems)], []);
});
