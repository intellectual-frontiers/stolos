/**
 * The engine's documentation, from its TypeScript (spec 055): `deno doc`
 * renders every module's JSDoc to HTML, and `deno doc --lint` checks it.
 *
 * ```mermaid
 * flowchart LR
 *   src["src/**.ts<br/>JSDoc, @module, @example"] --> lint["deno doc --lint<br/>(ratchet: tools/doc-baseline.ts)"]
 *   src --> html["deno doc --html"]
 *   html --> post["Mermaid diagrams<br/>(pinned, SHA-256 checked)"]
 *   post --> out["out/docs/"]
 *   out --> pages["GitHub Pages<br/>/vX.Y.Z/ and /latest/"]
 * ```
 *
 * Usage:
 *
 * - `deno task docs`: the HTML, in `out/docs/` (open `out/docs/index.html`).
 * - `deno task docs:lint`: fails when there are more documentation problems
 *   than `tools/doc-baseline.ts` allows, or an `@example` does not compile;
 *   `deno task docs:baseline` lowers the baseline after you fixed some (it never
 *   rises).
 *
 * @module
 */

import { DOC_LINT_BASELINE } from "./doc-baseline.ts";
import { VERSION } from "../src/archon/version.ts";

/** Mermaid, pinned: the diagrams in the HTML are drawn by this exact file. */
export const MERMAID = {
  url: "https://cdn.jsdelivr.net/npm/mermaid@11.4.1/dist/mermaid.min.js",
  sha256: "a43bc1afd446f9c4cc66ac5dd45d02e8d65e26fc5344ec0ef787f88d6ddb6f9e",
};

/** Every engine module the documentation covers (generated `.auto.ts` files are not). */
export async function sourceFiles(root = "src"): Promise<string[]> {
  const out: string[] = [];
  const walk = async (d: string) => {
    for await (const e of Deno.readDir(d)) {
      const p = `${d}/${e.name}`;
      if (e.isDirectory) await walk(p);
      else if (p.endsWith(".ts") && !p.endsWith(".auto.ts")) out.push(p);
    }
  };
  await walk(root);
  return out.sort();
}

/** How many problems `deno doc --lint` finds in these files. */
export async function lintCount(files: string[]): Promise<{ count: number; text: string }> {
  const r = await new Deno.Command(Deno.execPath(), {
    args: ["doc", "--lint", ...files],
    env: { NO_COLOR: "1" },
    stdout: "piped",
    stderr: "piped",
  }).output();
  const text = new TextDecoder().decode(r.stdout) + new TextDecoder().decode(r.stderr);
  if (r.success) return { count: 0, text };
  const m = text.match(/Found (\d+) documentation lint errors?/);
  if (!m) throw new Error(`deno doc --lint failed:\n${text.slice(-2000)}`);
  return { count: Number(m[1]), text };
}

/**
 * The script that turns ```mermaid blocks into diagrams: deno doc renders
 * them as code; this replaces each with a drawing, light or dark as the page.
 */
export const MERMAID_BOOT = `<script src="{{root}}mermaid.min.js"></script>
<script>
  (() => {
    const blocks = document.querySelectorAll("pre > code.language-mermaid");
    if (!blocks.length || !window.mermaid) return;
    for (const code of blocks) {
      const div = document.createElement("div");
      div.className = "mermaid";
      div.textContent = code.textContent;
      code.parentElement.replaceWith(div);
    }
    const dark = document.documentElement.classList.contains("dark") ||
      matchMedia("(prefers-color-scheme: dark)").matches;
    mermaid.initialize({ startOnLoad: false, theme: dark ? "dark" : "default", securityLevel: "strict" });
    mermaid.run({ querySelector: ".mermaid" });
  })();
</script>
`;

/** Add the diagram script to every page, with the path back to the root. */
export async function addMermaid(dir: string): Promise<number> {
  let pages = 0;
  const walk = async (d: string, depth: number) => {
    for await (const e of Deno.readDir(d)) {
      const p = `${d}/${e.name}`;
      if (e.isDirectory) await walk(p, depth + 1);
      else if (p.endsWith(".html")) {
        const html = await Deno.readTextFile(p);
        if (!html.includes("language-mermaid") || html.includes("mermaid.min.js")) continue;
        const root = "../".repeat(depth);
        await Deno.writeTextFile(
          p,
          html.replace("</body>", MERMAID_BOOT.replace("{{root}}", root) + "</body>"),
        );
        pages++;
      }
    }
  };
  await walk(dir, 0);
  return pages;
}

/** A module's first sentence, from its `@module` JSDoc (plain text). */
export function firstSentence(source: string): string {
  const m = source.match(/^\/\*\*([\s\S]*?)\*\//);
  if (!m) return "";
  const text = m[1].split("\n").map((l) => l.replace(/^\s*\* ?/, "")).filter((l) =>
    !l.startsWith("@") && !l.startsWith("#")
  ).join(" ").replace(/```[\s\S]*?```/g, "").replace(/\s+/g, " ").trim();
  const end = text.search(/\.(\s|$)/);
  const first = (end > 0 ? text.slice(0, end + 1) : text).replace(/`/g, "");
  return first.length > 200 ? first.slice(0, 197).replace(/\s\S*$/, "") + "…" : first;
}

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * The front page: deno doc's own index lists one module's symbols; this one
 * starts with the overview (src/mod.ts) and lists every module by folder.
 */
export async function frontPage(out: string, files: string[]): Promise<void> {
  const groups = new Map<string, Array<{ path: string; line: string }>>();
  for (const f of files) {
    const rel = f.replace(/^src\//, "");
    if (rel === "mod.ts") continue;
    const dir = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : ".";
    const line = firstSentence(await Deno.readTextFile(f));
    if (!groups.has(dir)) groups.set(dir, []);
    groups.get(dir)!.push({ path: rel, line });
  }
  const sections = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(
    ([dir, mods]) =>
      `<h2>${esc(dir)}/</h2>\n<ul>\n${
        mods.map((m) =>
          `<li><a href="./${esc(m.path)}/index.html"><code>${
            esc(m.path.split("/").pop()!)
          }</code></a> ${esc(m.line)}</li>`
        ).join("\n")
      }\n</ul>`,
  ).join("\n");
  await Deno.writeTextFile(
    `${out}/index.html`,
    `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Stolos v${VERSION}</title>
<link rel="stylesheet" href="./styles.css">
<link rel="stylesheet" href="./page.css">
<script src="./darkmode_toggle.js"></script>
<style>
  main { max-width: 60rem; margin: 2rem auto; padding: 0 1rem; line-height: 1.5; }
  main h1 { font-size: 1.8rem; margin-bottom: .5rem; }
  main h2 { font-size: 1.1rem; margin: 1.5rem 0 .3rem; }
  main li { margin: .15rem 0; }
  .start { font-size: 1.1rem; padding: .8rem 1rem; border-radius: .5rem; background: rgba(127,127,127,.12); }
</style>
</head>
<body>
<main>
<h1>Stolos v${VERSION}</h1>
<p>The fleet engine (its command is <code>archon</code>), documented from its TypeScript.</p>
<p class="start">Start here: <a href="./mod.ts/index.html">the overview</a>, with how the
pieces fit, in diagrams. Then the model: <a href="./archon/model/types.ts/index.html">types.ts</a>.
Every symbol: <a href="./all_symbols.html">all symbols</a> (searchable).</p>
${sections}
</main>
</body>
</html>
`,
  );
}

async function sha256(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...h].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Build the HTML into `out` (the default `out/docs`). */
export async function build(out = "out/docs"): Promise<void> {
  await Deno.remove(out, { recursive: true }).catch((e) => {
    if (!(e instanceof Deno.errors.NotFound)) throw e;
  });
  await Deno.mkdir(out, { recursive: true });
  const files = await sourceFiles();
  const r = await new Deno.Command(Deno.execPath(), {
    args: ["doc", "--html", `--name=Stolos v${VERSION}`, `--output=${out}`, ...files],
    stdout: "inherit",
    stderr: "inherit",
  }).output();
  if (!r.success) throw new Error("deno doc --html failed");
  const res = await fetch(MERMAID.url);
  if (!res.ok) throw new Error(`${MERMAID.url}: HTTP ${res.status}`);
  const js = new Uint8Array(await res.arrayBuffer());
  const got = await sha256(js);
  if (got !== MERMAID.sha256) {
    throw new Error(`${MERMAID.url}: SHA-256 ${got}, expected ${MERMAID.sha256}: not used`);
  }
  await Deno.writeFile(`${out}/mermaid.min.js`, js);
  await frontPage(out, files);
  const pages = await addMermaid(out);
  console.log(`docs: ${files.length} modules · ${pages} page(s) with diagrams · ${out}/index.html`);
}

if (import.meta.main) {
  const [cmd, ...rest] = Deno.args;
  if (cmd === "lint") {
    const { count, text } = await lintCount(await sourceFiles());
    if (rest.includes("--update")) {
      if (count > DOC_LINT_BASELINE) {
        console.error(
          `${count} documentation problems: more than the baseline (${DOC_LINT_BASELINE}); fix them, it never rises`,
        );
        Deno.exit(1);
      }
      await Deno.writeTextFile(
        new URL("./doc-baseline.ts", import.meta.url),
        `/**\n * How many problems \`deno doc --lint\` may still find in the engine (spec 055).\n * It only goes down: \`deno task docs:baseline\` lowers it after a fix.\n *\n * @module\n */\n\n/** The documentation problems left to fix. */\nexport const DOC_LINT_BASELINE = ${count};\n`,
      );
      console.log(`docs:lint: baseline ${DOC_LINT_BASELINE} → ${count}`);
    } else if (count > DOC_LINT_BASELINE) {
      console.error(text.split("\n").slice(-60).join("\n"));
      console.error(
        `docs:lint: ${count} documentation problems, more than the ${DOC_LINT_BASELINE} allowed: document what you added (JSDoc on every export, @module on every file)`,
      );
      Deno.exit(1);
    } else {
      console.log(
        `docs:lint: ${count} documentation problems (baseline ${DOC_LINT_BASELINE})${
          count < DOC_LINT_BASELINE ? `: lower it with deno task docs:baseline` : ""
        }`,
      );
    }
  } else {
    await build(rest[0]);
  }
}
