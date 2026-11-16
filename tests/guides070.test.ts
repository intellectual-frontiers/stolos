/**
 * Spec 070: the guides are module documentation, beside the code, and cannot drift from it: each
 * guide's module exists and documents itself, its links reach real guides and headings, and every
 * command it names is one the engine has.
 *
 * @module
 */
import { fs } from "@intellectual-frontiers/ifc-ts/runtime";
import {
  assert,
  assertEquals,
  assertStringIncludes,
  proves,
  test,
} from "@intellectual-frontiers/ifc-ts/runtime/test";
import { guideComment, guideMarkdown, GUIDES } from "../src/archon/core/guides.ts";
import { engineFile } from "../src/archon/core/assets.ts";
import { COMMANDS } from "../src/archon/commands/registry.ts";

const slug = (s: string): string =>
  s
    .toLowerCase()
    .replace(/<[^>]+>/g, "")
    .replace(/[^a-z0-9 -]/g, "")
    .trim()
    .replace(/\s+/g, "-");
const md = (name: string): string => engineFile(`docs/${name}.md`);

proves(
  ["070-docs-in-code FR-001", "070-docs-in-code FR-003", "070-docs-in-code FR-005"],
  "070: each guide is its module's documentation, and the assets carry it unchanged",
  async () => {
    assertEquals(new Set(GUIDES.map((g) => g.name)).size, GUIDES.length, "unique names");
    for (const g of GUIDES) {
      const src = await fs.readTextFile(g.module);
      assertEquals(guideMarkdown(src), md(g.name), `${g.name}: run bun run gen`);
      assert(md(g.name).startsWith("# "), `${g.name} starts with its title`);
    }
    assert(
      !(await fs.stat("docs").then(
        () => true,
        () => false,
      )),
      "no docs/ folder: guides live in modules",
    );
  },
);

test("070: a guide round-trips through a doc comment (even with */ in it)", () => {
  const text = "# T\n\nA `/* x */` comment, and an empty line:\n\nend\n";
  assertEquals(guideMarkdown(guideComment(text)), text);
});

proves(
  ["070-docs-in-code FR-005"],
  "070: links between guides reach a guide and, with #, one of its headings",
  () => {
    const names = new Set(GUIDES.map((g) => g.name));
    const problems: string[] = [];
    for (const g of GUIDES) {
      for (const [, target = "", hash] of md(g.name).matchAll(
        /\]\(([a-z0-9-]+)\.md(?:#([^)]+))?\)/g,
      )) {
        if (!names.has(target)) problems.push(`${g.name}: ${target}.md is not a guide`);
        else if (hash) {
          const heads = [...md(target).matchAll(/^#+ (.+)$/gm)].map((m) => slug(m[1] ?? ""));
          if (!heads.includes(hash)) {
            problems.push(`${g.name}: ${target}.md#${hash} has no such heading`);
          }
        }
      }
    }
    assertEquals(problems, []);
  },
);

proves(
  ["070-docs-in-code FR-005"],
  "070: every command a guide names is a command the engine has",
  async () => {
    // The boot server's commands are dispatched in its own main (stolos boot <cmd>; serve is the default).
    const boot = [
      ...(await fs.readTextFile("src/archon-boot/main.ts")).matchAll(/cmd === "([a-z-]+)"/g),
    ].map((m) => `boot ${m[1] ?? ""}`);
    const names = [...COMMANDS.map((c) => c.name), ...boot, "boot serve"].sort(
      (a, b) => b.length - a.length,
    );
    const firsts = new Set(names.map((n) => n.split(" ")[0]));
    const problems: string[] = [];
    for (const g of GUIDES) {
      const text = md(g.name);
      const spans = [...text.matchAll(/`([^`\n]+)`/g)].map((m) => m[1] ?? "");
      const blocks = [
        ...text.matchAll(/```(?:bash|sh|console|powershell)?\n([\s\S]*?)```/g),
      ].flatMap((m) => (m[1] ?? "").split("\n"));
      for (const line of [...spans, ...blocks]) {
        for (const m of line.matchAll(
          /(?:bun run stolos|(?:^|[\s(])(?:sudo )?archon) ([a-z][a-z0-9-]*(?: [a-z][a-z0-9-]*)*)/g,
        )) {
          const words = m[1] ?? "";
          // Prose ("archon and ...") is not a command; a group ("archon pg") is the start of some.
          if (!firsts.has(words.split(" ")[0])) continue;
          const ok = names.some(
            (n) => words === n || words.startsWith(n + " ") || n.startsWith(words + " "),
          );
          if (!ok) problems.push(`${g.name}: ${m[0]?.trim()}`);
        }
      }
    }
    assertEquals([...new Set(problems)], []);
  },
);

proves(
  ["070-docs-in-code FR-002"],
  "070: bun run docs renders the guides with their diagrams; the guides first; links to guides and to GitHub at this version",
  async () => {
    const { frontPage, linkTarget, modulePage, readModule } = await import("../tools/docs.ts");
    const { VERSION } = await import("../src/archon/version.ts");
    const pkg = JSON.parse(await fs.readTextFile("package.json")) as {
      scripts: Record<string, string>;
    };
    assertEquals(pkg.scripts["docs"], "bun tools/docs.ts");
    const modules = await Promise.all(
      GUIDES.map(async (g) => readModule(g.module, await fs.readTextFile(g.module))),
    );
    // Each guide's page draws its Mermaid diagrams (and loads Mermaid only then).
    for (const [i, g] of GUIDES.entries()) {
      const page = modulePage(modules[i] ?? readModule(g.module, ""));
      const diagrams = (md(g.name).match(/^```mermaid$/gm) ?? []).length;
      assertEquals((page.match(/<pre class="mermaid">/g) ?? []).length, diagrams, g.name);
      assertEquals(page.includes("mermaid.min.js"), diagrams > 0, g.name);
    }
    // The front page: the guides first, each linked to its module's page.
    const front = frontPage(modules, new Map());
    const guides = front.indexOf("<h2>Guides</h2>");
    assert(guides > 0 && front.indexOf("<h2>archon/", guides) > guides, "the guides come first");
    let last = guides;
    for (const g of GUIDES) {
      const at = front.indexOf(`href="./${g.module.replace(/^src\//, "")}/index.html">`, last);
      assert(at > last, `${g.name}, in reading order`);
      last = at;
    }
    // Links: to another guide, its module's page; to a file of the repository, GitHub at this version.
    const pg = GUIDES.find((g) => g.name === "pg")?.module ?? "src/archon/pg/mod.ts";
    assertEquals(
      linkTarget(pg, "compliance.md#scf"),
      `https://stolos-docs.invalid/archon/compliance/mod.ts/index.html#scf`,
    );
    assertEquals(
      linkTarget(pg, "../../../specs/038-pg/spec.md"),
      `https://github.com/intellectual-frontiers/stolos/blob/v${VERSION}/specs/038-pg/spec.md`,
    );
    const page = modulePage(
      readModule(
        pg,
        "/**\n * See [the specs](../../../specs/038-pg/spec.md) and [compliance](compliance.md).\n *\n * @module\n */\n",
      ),
    );
    assertStringIncludes(
      page,
      `href="https://github.com/intellectual-frontiers/stolos/blob/v${VERSION}/specs/038-pg/spec.md"`,
    );
    assertStringIncludes(page, 'href="../../../archon/compliance/mod.ts/index.html"');
  },
);

proves(
  ["070-docs-in-code FR-004"],
  "070: stolos docs and archon docs list the guides with their pages online, or print one; messages say bun run stolos docs",
  async () => {
    const { guideUrl, guideRef } = await import("../src/archon/core/guides.ts");
    const { sandbox } = await import("./sandbox.ts");
    const sb = await sandbox("stolos-docs-");
    try {
      for (const main of ["src/stolos/main.ts", "src/archon/main.ts"]) {
        let r = await sb.run(main, ["docs"]);
        assertEquals(r.code, 0, r.out);
        for (const g of GUIDES) assertStringIncludes(r.out, `${g.name}`);
        assertStringIncludes(r.out, "Online, with diagrams: https://");
        r = await sb.run(main, ["docs", "--json"]);
        const listed = JSON.parse(
          r.out.slice(r.out.indexOf("["), r.out.lastIndexOf("]") + 1),
        ) as Array<{
          name: string;
          url: string;
        }>;
        assertEquals(
          listed.map((g) => g.name),
          GUIDES.map((g) => g.name),
        );
        for (const g of listed) assertEquals(g.url, guideUrl(g.name));
        // One guide, in the terminal: its diagrams are a link to its page.
        r = await sb.run(main, ["docs", "compliance"]);
        assertEquals(r.code, 0, r.out);
        assertStringIncludes(r.out, "# Compliance");
        assertStringIncludes(r.out, `(a diagram: ${guideUrl("compliance")})`);
        assert(!r.out.includes("```mermaid"), "no diagram source in the terminal");
        r = await sb.run(main, ["docs", "no-such-guide"]);
        assertEquals(r.code, 1, r.out);
      }
    } finally {
      await fs.remove(sb.home, { recursive: true });
    }
    // Messages point to the guide with the command that shows it.
    assertEquals(guideRef("pg"), "bun run stolos docs pg");
    const bad: string[] = [];
    for (const f of await fs.walkFiles("src")) {
      if (!f.endsWith(".ts") || f.endsWith("assets.auto.ts")) continue;
      (await fs.readTextFile(`src/${f}`)).split("\n").forEach((line, i) => {
        if (/^\s*(\*|\/\/)/.test(line)) return;
        if (/(?<!bun run )\bstolos docs [a-z]/.test(line)) bad.push(`src/${f}:${i + 1}`);
      });
    }
    assertEquals(bad, []);
  },
);
