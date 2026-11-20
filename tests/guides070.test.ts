/**
 * Spec 070: the guides are module documentation, beside the code, and cannot drift from it: each
 * guide's module exists and documents itself, its links reach real guides and headings, and every
 * command it names is one the engine has.
 *
 * @module
 */
import { fs } from "@intellectual-frontiers/system";
import {
  assert,
  assertEquals,
  assertStringIncludes,
  proves,
  test,
} from "@intellectual-frontiers/commons/ts/runtime/test";
import { guideComment, guideMarkdown, GUIDES } from "../src/archon/core/guides.ts";
import { engineFile } from "../src/archon/core/assets.ts";
import { COMMANDS } from "../src/archon/commands/registry.ts";
import { ifcDocs } from "./ifc-docs.ts";

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

/** A relative link's target from the file it is written in: `../mcp/mod.ts` from `src/archon/guide/mod.ts`. */
function resolveFrom(file: string, dest: string): string {
  const parts = file.split("/").slice(0, -1);
  for (const seg of dest.split("/")) {
    if (seg === "..") parts.pop();
    else if (seg !== "." && seg !== "") parts.push(seg);
  }
  return parts.join("/");
}

proves(
  ["070-docs-in-code FR-002", "070-docs-in-code FR-005"],
  "070: links between guides name the other guide's module and reach it and, with #, one of its headings",
  () => {
    const byModule = new Map(GUIDES.map((g) => [g.module, g.name]));
    const names = new Set(GUIDES.map((g) => g.name));
    const problems: string[] = [];
    for (const g of GUIDES) {
      for (const [, dest = "", hash] of md(g.name).matchAll(/\]\(([^)#\s]+)(?:#([^)]+))?\)/g)) {
        if (/^[a-z][a-z0-9+.-]*:/i.test(dest)) continue;
        const named = /^([a-z0-9-]+)\.md$/.exec(dest)?.[1];
        if (named !== undefined && names.has(named)) {
          problems.push(`${g.name}: ${dest}: link to the guide's module, so the site links it too`);
          continue;
        }
        if (!dest.endsWith(".ts")) continue;
        const target = byModule.get(resolveFrom(g.module, dest));
        if (target === undefined) {
          problems.push(`${g.name}: ${dest} is not a guide's module`);
        } else if (hash) {
          const heads = [...md(target).matchAll(/^#+ (.+)$/gm)].map((m) => slug(m[1] ?? ""));
          if (!heads.includes(hash))
            problems.push(`${g.name}: ${dest}#${hash} has no such heading`);
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
  ["070-docs-in-code FR-002", "055-documentation FR-004"],
  "070: bun run docs renders each guide as its area's overview, with its diagrams; stolos docs links there",
  async () => {
    const { docsArea, guideUrl, PAGES } = await import("../src/archon/core/guides.ts");
    const { TAG } = await import("../src/archon/version.ts");
    const pkg = JSON.parse(await fs.readTextFile("package.json")) as {
      scripts: Record<string, string>;
    };
    assertEquals(pkg.scripts["docs"], "ifc-docs build");
    // docs.config.ts: each guide's module opens the area docsArea names.
    const { config } = await import("../docs.config.ts");
    const pkgAbout = config.packages[0]?.about;
    const areas = typeof pkgAbout === "object" ? (pkgAbout.areas ?? []) : [];
    for (const g of GUIDES) {
      const area = areas.find((a) => a.slug === docsArea(g.module));
      assertEquals(area?.entryPoints[0], g.module, `${g.name}: its module opens its area`);
      assertEquals(guideUrl(g.name), `${PAGES}${TAG}/api/${docsArea(g.module)}/index.html`);
    }
    assertEquals(docsArea("src/archon/pg/mod.ts"), "archon-pg");
    assertEquals(docsArea("src/releasing.ts"), "releasing");
    assertEquals(docsArea("src/mod.ts"), "overview");
    // The site, built: each guide's page holds its text and one Mermaid block per diagram.
    const out = await fs.makeTempDir({ prefix: "stolos-docs-" });
    try {
      const r = await ifcDocs(["build", "--out", out]);
      assertEquals(r.code, 0, r.stderr);
      // Spec 055 FR-004: a home page, the overview module first, every specification (each
      // requirement anchored) and the constitution.
      assertStringIncludes(await fs.readTextFile(`${out}/index.html`), "Stolos");
      const overview = await fs.readTextFile(`${out}/api/overview/index.html`);
      assertStringIncludes(overview, "Two repositories, one approval");
      assertStringIncludes(
        await fs.readTextFile(`${out}/specs/096-bun-runtime.html`),
        'id="fr-009"',
      );
      assertStringIncludes(await fs.readTextFile(`${out}/specs/constitution.html`), "Article 24");
      for (const g of GUIDES) {
        const page = await fs.readTextFile(`${out}/api/${docsArea(g.module)}/index.html`);
        const diagrams = (md(g.name).match(/^```mermaid$/gm) ?? []).length;
        assertEquals((page.match(/class="lang-mermaid"/g) ?? []).length, diagrams, g.name);
      }
      // A link to another guide goes to its page; to another file of the repository, to GitHub.
      const guide = await fs.readTextFile(`${out}/api/archon-guide/index.html`);
      assertStringIncludes(guide, 'href="../archon-mcp/index.html"');
      const boot = await fs.readTextFile(`${out}/api/archon-doctor/index.html`);
      assertStringIncludes(
        boot,
        'href="../archon-boot/index.html#point-network-boots-at-this-pc-unifi"',
      );
      const commands = await fs.readTextFile(`${out}/api/archon-commands/index.html`);
      assertStringIncludes(
        commands,
        'href="https://github.com/intellectual-frontiers/stolos/blob/main/AGENTS.md"',
      );
    } finally {
      await fs.remove(out, { recursive: true });
    }
  },
  { timeout: 120_000 },
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
