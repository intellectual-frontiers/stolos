/**
 * 035-welcome-guide: the engine's guides (each module's @module JSDoc, src/archon/core/guides.ts) as HTML on the welcome
 * page, so one text serves the repository, the man pages, and the server.
 * Handles what those guides use: headings, paragraphs, lists, tables, code
 * blocks, blockquotes, inline code, bold, italics, and links. Everything is
 * escaped first; links to other guides stay on the page, the rest go to GitHub.
 *
 * @module
 */
// Spec: 035-welcome-guide

import { guideDef, GUIDES, guideUrl } from "../core/guides.ts";

const ENTITIES: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ENTITIES[c] ?? c);

/** Where a guide's relative links go: guides served here, or the repository on GitHub. */
export interface LinkContext {
  /** Guides served here: docs/<name>.md -> /guide/<name>. */
  served: string[];
  /** https://github.com/<owner>/<repo>/blob/main/ for everything else in the repository. */
  repoBlob: string;
}

/**
 * The guide a link names: `name.md` (the guides' own form), or the relative path of its module, as
 * the guides write a link to another so that IFC Docs links it too (`../mcp/mod.ts`, spec 070
 * FR-002), matched by the end of its path where one guide's module ends so.
 */
function guideNamed(path: string): string | undefined {
  const doc = path.match(/^(?:\.\.\/docs\/|docs\/|\.\/)?([a-z0-9-]+)\.md$/)?.[1];
  if (doc !== undefined) return doc;
  if (!path.endsWith(".ts")) return undefined;
  const rest = path.replace(/^(?:\.\.?\/)+/, "");
  const found = GUIDES.filter((g) => g.module === `src/${rest}` || g.module.endsWith(`/${rest}`));
  return found.length === 1 ? found[0]?.name : undefined;
}

function href(target: string, ctx: LinkContext): string {
  if (/^(https?:|mailto:|#)/.test(target)) return target;
  const [path = "", hash] = target.split("#");
  const doc = guideNamed(path);
  if (doc && ctx.served.includes(doc)) return `/guide/${doc}${hash ? `#${hash}` : ""}`;
  // Another guide, not served here: its page online, at this engine's version.
  if (doc && guideDef(doc)) return `${guideUrl(doc)}${hash ? `#${hash}` : ""}`;
  const rel = path.replace(/^(?:\.\.?\/)+/, "");
  return `${ctx.repoBlob}${rel}${hash ? `#${hash}` : ""}`;
}

/** Inline markup on already-escaped text. */
export function inline(text: string, ctx: LinkContext): string {
  const codes: string[] = [];
  let s = esc(text).replace(/`([^`]+)`/g, (_, c: string) => {
    codes.push(`<code>${c}</code>`);
    return `⟦${codes.length - 1}⟧`;
  });
  s = s.replace(
    /\[([^\]]+)\]\(([^)\s]+)\)/g,
    (_, label: string, target: string) =>
      `<a href="${esc(href(target.replace(/&amp;/g, "&"), ctx))}">${label}</a>`,
  );
  s = s
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[\s(])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>");
  return s.replace(/⟦(\d+)⟧/g, (_, i: string) => codes[Number(i)] ?? "");
}

const slug = (s: string): string =>
  s
    .toLowerCase()
    .replace(/<[^>]+>/g, "")
    .replace(/[^a-z0-9 -]/g, "")
    .trim()
    .replace(/\s+/g, "-");

/** A guide's Markdown as HTML (the subset described above); headings get ids for `#` links. */
export function markdownToHtml(md: string, ctx: LinkContext): string {
  const out: string[] = [];
  const lines = md.replace(/\r/g, "").split("\n");
  let para: string[] = [];
  let list: { tag: "ul" | "ol"; items: string[] } | undefined;
  let table: string[][] | undefined;
  const flush = (): void => {
    if (para.length) out.push(`<p>${inline(para.join(" "), ctx)}</p>`);
    para = [];
    if (list) {
      out.push(`<${list.tag}>${list.items.map((i) => `<li>${i}</li>`).join("")}</${list.tag}>`);
    }
    list = undefined;
    if (table) {
      const [head = [], ...rows] = table;
      out.push(
        `<table><thead><tr>${head
          .map((c) => `<th>${inline(c, ctx)}</th>`)
          .join("")}</tr></thead><tbody>${rows
          .map((r) => `<tr>${r.map((c) => `<td>${inline(c, ctx)}</td>`).join("")}</tr>`)
          .join("")}</tbody></table>`,
      );
    }
    table = undefined;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const fence = line.match(/^\s*```(\w*)/);
    if (fence) {
      flush();
      const code: string[] = [];
      for (i++; i < lines.length && !/^\s*```/.test(lines[i] ?? ""); i++) code.push(lines[i] ?? "");
      const indent = Math.min(
        ...code.filter((l) => l.trim()).map((l) => (l.match(/^ */)?.[0] ?? "").length),
        Infinity,
      );
      out.push(
        `<pre><code>${esc(
          code.map((l) => l.slice(isFinite(indent) ? indent : 0)).join("\n"),
        )}</code></pre>`,
      );
      continue;
    }
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      flush();
      const n = Math.min((h[1] ?? "").length + 1, 4);
      const text = inline(h[2] ?? "", ctx);
      out.push(`<h${n} id="${slug(text)}">${text}</h${n}>`);
      continue;
    }
    if (/^\|/.test(line.trim())) {
      if (para.length || list) flush();
      if (/^\|[\s:|-]+\|$/.test(line.trim())) continue;
      const cells = line
        .trim()
        .replace(/^\||\|$/g, "")
        .split(/(?<!\\)\|/)
        .map((c) => c.trim().replace(/\\\|/g, "|"));
      (table ??= []).push(cells);
      continue;
    }
    const li = line.match(/^(\s*)([-*]|\d+\.)\s+(.*)$/);
    if (li) {
      if (para.length || table) flush();
      const tag = /\d/.test(li[2] ?? "") ? "ol" : "ul";
      if (!list || list.tag !== tag) {
        flush();
        list = { tag, items: [] };
      }
      list.items.push(inline(li[3] ?? "", ctx));
      continue;
    }
    if (list && /^\s{2,}\S/.test(line)) {
      // A list item's continuation line.
      list.items.push(`${list.items.pop() ?? ""} ${inline(line.trim(), ctx)}`);
      continue;
    }
    if (line.startsWith(">")) {
      flush();
      out.push(`<blockquote>${inline(line.replace(/^>\s?/, ""), ctx)}</blockquote>`);
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    if (table) flush();
    para.push(line.trim());
  }
  flush();
  return out.join("\n");
}
