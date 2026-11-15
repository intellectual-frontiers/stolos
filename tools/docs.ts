/**
 * The engine's documentation, from its TypeScript (specs 055-documentation, 096-bun-runtime
 * FR-009), read and rendered by this tool itself, with no other documentation tool.
 *
 * The code is formatted (`bun fmt`), so a declaration starts its line. The reader goes through each
 * module once, keeping track of comments, strings, template literals, regular expressions and
 * nesting, and takes:
 *
 * - the module's `@module` block: its first doc comment;
 * - every top-level export (`export function`, `async function`, `function*`, `const`, `let`,
 *   `class`, `abstract class`, `type`, `interface`, `enum`, `namespace`, `default`), with the doc
 *   comment right above it. Overloads are one export: one doc comment on any of them documents it.
 *   `export { a, b as c }` takes the doc comment of the local declaration it names; a re-export
 *   from another module (`export { x } from`, `export * from`) is documented where it is declared;
 * - every ```ts block in an `@example` section.
 *
 * ```mermaid
 * flowchart LR
 *   src["src/**.ts<br/>@module, JSDoc, @example"] --> read["the reader<br/>(line by line)"]
 *   read --> lint["lint: every module and export<br/>documented (zero allowed)"]
 *   read --> ex["examples: each ts block<br/>type-checked with tsc"]
 *   read --> html["HTML: one page per module,<br/>the index (guides first)"]
 *   html --> mer["Mermaid diagrams<br/>(pinned, SHA-256 checked)"]
 *   mer --> out["out/docs/"]
 *   out --> pages["GitHub Pages<br/>/vX.Y.Z/ and /latest/"]
 * ```
 *
 * Usage:
 *
 * - `bun run docs [out]`: the HTML, in `out/docs/` (open `out/docs/index.html`).
 * - `bun run docs:lint`: fails on a module without its `@module` block, an export without JSDoc,
 *   or an `@example` that does not compile (`--no-examples` leaves the examples out).
 * - `bun tools/docs.ts examples`: only the examples: each is written to `out/docs-examples/`, its
 *   relative imports turned into the package's name (`@intellectual-frontiers/stolos/...`), and
 *   type-checked with the repository's `tsc` and strict configuration.
 *
 * @module
 */

import { sha256 } from "@intellectual-frontiers/ifc-ts/kernel";
import { fs, path, proc, stdio } from "@intellectual-frontiers/ifc-ts/runtime";
import { GUIDES } from "../src/archon/core/guides.ts";
import { VERSION } from "../src/archon/version.ts";
import { markdownToHtml } from "../src/archon/web/markdown.ts";

const ROOT = path.resolve(path.dirname(path.fromFileUrl(import.meta.url)), "..");

/**
 * Mermaid, pinned: the diagrams in the HTML are drawn by this exact file, the same one the
 * consoles serve (`console/assets.ts`). The copy in `vendor/` is used where its SHA-256 matches;
 * otherwise it is downloaded and checked.
 */
export const MERMAID = {
  url: "https://cdn.jsdelivr.net/npm/mermaid@12.2.0/dist/mermaid.min.js",
  sha256: "a8a6a6f805b074a8261a2825c86f99c8054acb3b35f50bb7e24a4f9f2c3c3b9f",
  vendored: "vendor/mermaid/mermaid-12.2.0.min.js",
} as const;

/** The package's name, by which an example imports the engine. */
export const PACKAGE = "@intellectual-frontiers/stolos";

/**
 * Generated modules that are documented like any other (the FedRAMP 20x rules and the D3FEND names
 * carry JSDoc from their sources, specs 076 and 089); other `.auto.ts` files are data.
 */
const DOCUMENTED_AUTO = ["src/archon/fedramp/rules.auto.ts", "src/archon/schema/d3fend.auto.ts"];

/** Every engine module the documentation covers, as repository paths (`src/archon/core/ui.ts`). */
export async function sourceFiles(root = ROOT): Promise<string[]> {
  const out: string[] = [];
  for (const rel of await fs.walkFiles(path.join(root, "src"))) {
    const p = `src/${rel.replace(/\\/g, "/")}`;
    if (p.endsWith(".ts") && (!p.endsWith(".auto.ts") || DOCUMENTED_AUTO.includes(p))) out.push(p);
  }
  return out.sort();
}

// ---------------------------------------------------------------------------------------------
// The reader

/** What kind of declaration an export is. */
export type ExportKind =
  | "function"
  | "const"
  | "let"
  | "var"
  | "class"
  | "type"
  | "interface"
  | "enum"
  | "namespace"
  | "default"
  | "re-export";

/** One export of a module. */
export type ExportDoc = {
  /** Its name (`default` for the default export, `*` for `export * from`). */
  readonly name: string;
  /** What it is. */
  readonly kind: ExportKind;
  /** The line it starts on (1-based). */
  readonly line: number;
  /** Its JSDoc as Markdown, without the tags' lines; undefined where it has none. */
  readonly doc: string | undefined;
  /** Its declaration, without a body (a function's signature, a type's whole text). */
  readonly signature: string;
  /** Where a re-export comes from. */
  readonly from?: string;
  /** The ```ts blocks of its `@example` sections. */
  readonly examples: readonly Example[];
};

/** One ```ts block of an `@example` section. */
export type Example = {
  /** The line of the source its code starts on (1-based). */
  readonly line: number;
  /** Its code. */
  readonly code: string;
};

/** One module, read. */
export type ModuleDoc = {
  /** Its repository path. */
  readonly file: string;
  /** Its `@module` block as Markdown, or undefined where it has none. */
  readonly doc: string | undefined;
  /** The ```ts blocks of the module block's `@example` sections. */
  readonly examples: readonly Example[];
  /** Its exports, in the order they are declared. */
  readonly exports: readonly ExportDoc[];
};

/** A doc comment: where it is and its lines, without the leading ` * `. */
type Comment = { readonly start: number; readonly end: number; readonly lines: readonly string[] };

/** What the scanner is inside at the start of a line. */
type Frame = "brace" | "paren" | "bracket" | "template" | "expr";

/** The scanner's state, carried from line to line. */
type ScanState = { stack: Frame[]; comment: boolean; prev: string };

const REGEX_BEFORE = new Set([..."(,=:[!&|?{};+-*%<>~^"]);
const REGEX_KEYWORDS =
  /(?:^|[^\w$])(?:return|typeof|case|of|in|instanceof|void|delete|throw|yield|await)$/;

/**
 * Scan one line, updating the state: comments, strings, template literals (with their `${}`),
 * regular expressions (told from division by what precedes them) and brackets.
 */
function scanLine(line: string, s: ScanState): void {
  let i = 0;
  const top = (): Frame | undefined => s.stack[s.stack.length - 1];
  while (i < line.length) {
    const c = line[i] ?? "";
    if (s.comment) {
      const end = line.indexOf("*/", i);
      if (end < 0) return;
      s.comment = false;
      i = end + 2;
      continue;
    }
    if (top() === "template") {
      if (c === "\\") i += 2;
      else if (c === "`") {
        s.stack.pop();
        s.prev = "`";
        i++;
      } else if (c === "$" && line[i + 1] === "{") {
        s.stack.push("expr");
        s.prev = "{";
        i += 2;
      } else i++;
      continue;
    }
    if (c === " " || c === "\t") {
      i++;
      continue;
    }
    if (c === "/" && line[i + 1] === "/") return;
    if (c === "/" && line[i + 1] === "*") {
      s.comment = true;
      i += 2;
      continue;
    }
    if (c === '"' || c === "'") {
      i++;
      while (i < line.length && line[i] !== c) i += line[i] === "\\" ? 2 : 1;
      i++;
      s.prev = c;
      continue;
    }
    if (c === "`") {
      s.stack.push("template");
      i++;
      continue;
    }
    if (c === "/") {
      const before = line.slice(0, i).trimEnd();
      if (s.prev === "" || REGEX_BEFORE.has(s.prev) || REGEX_KEYWORDS.test(before)) {
        // A regular expression: to its closing slash, past escapes and character classes.
        i++;
        let cls = false;
        while (i < line.length) {
          const d = line[i];
          if (d === "\\") i += 2;
          else {
            if (d === "[") cls = true;
            else if (d === "]") cls = false;
            else if (d === "/" && !cls) break;
            i++;
          }
        }
        i++;
        s.prev = "/";
        continue;
      }
    }
    if (c === "{") s.stack.push("brace");
    else if (c === "(") s.stack.push("paren");
    else if (c === "[") s.stack.push("bracket");
    else if (c === "}" || c === ")" || c === "]") s.stack.pop();
    s.prev = c;
    i++;
  }
}

const DECLARATION =
  /^export\s+(?:declare\s+)?(default\s+)?(?:async\s+)?(?:abstract\s+)?(function\*?|const|let|var|class|type|interface|enum|namespace)\s+([A-Za-z_$][\w$]*)/;
const LOCAL =
  /^(?:declare\s+)?(?:async\s+)?(?:abstract\s+)?(function\*?|const|let|var|class|type|interface|enum|namespace)\s+([A-Za-z_$][\w$]*)/;

/** A doc comment's text: its lines without the leading ` * `, and `*\/` restored. */
function commentLines(text: string): string[] {
  const body = text.replace(/^\s*\/\*\*/, "").replace(/\*\/\s*$/, "");
  return body.split("\n").map((l) =>
    l
      .replace(/^\s*\* ?/, "")
      .replace(/^\s*\*$/, "")
      .replace(/\*\\\//g, "*/"),
  );
}

/** A doc comment as Markdown: its text without the tags' lines and the `@example` sections. */
export function commentMarkdown(lines: readonly string[]): string {
  const out: string[] = [];
  let tag = false;
  let fence = false;
  for (const l of lines) {
    if (/^\s*```/.test(l)) fence = !fence;
    if (!fence && /^@\w+/.test(l.trim())) {
      tag = true;
      continue;
    }
    if (!tag) out.push(l);
  }
  return out.join("\n").trim();
}

/** The ```ts blocks of a comment's `@example` sections, with their line in the source. */
export function examplesOf(lines: readonly string[], firstLine: number): Example[] {
  const out: Example[] = [];
  let inExample = false;
  let code: string[] | undefined;
  let start = 0;
  let fence = false;
  lines.forEach((l, i) => {
    const t = l.trim();
    if (code !== undefined) {
      if (/^```/.test(t)) {
        out.push({ line: start, code: dedent(code).join("\n") });
        code = undefined;
        fence = false;
      } else code.push(l);
      return;
    }
    if (/^```/.test(t)) {
      if (inExample && /^```(ts|typescript)\s*$/.test(t)) {
        code = [];
        start = firstLine + i + 1;
      } else fence = !fence;
      return;
    }
    if (!fence && /^@\w+/.test(t)) inExample = /^@example\b/.test(t);
  });
  return out;
}

function dedent(lines: readonly string[]): string[] {
  const widths = lines.filter((l) => l.trim() !== "").map((l) => /^ */.exec(l)?.[0].length ?? 0);
  const n = widths.length > 0 ? Math.min(...widths) : 0;
  return lines.map((l) => l.slice(n));
}

/** A declaration's text for its page: a function's signature, a type's whole text, a class's members. */
function signatureOf(
  lines: readonly string[],
  at: number,
  kind: ExportKind,
  depthAfter: readonly number[],
): string {
  const first = lines[at] ?? "";
  if (kind === "const" || kind === "let" || kind === "var") {
    const out: string[] = [];
    for (let i = at; i < lines.length && out.length < 20; i++) {
      const l = lines[i] ?? "";
      const eq = l.search(/\s=(\s|$)/);
      if (eq >= 0) {
        out.push(l.slice(0, eq));
        break;
      }
      out.push(l);
      if ((depthAfter[i] ?? 0) === 0 && /;\s*$/.test(l)) break;
    }
    return out.join("\n");
  }
  if (kind === "function" || kind === "default") {
    const out: string[] = [];
    for (let i = at; i < lines.length && out.length < 40; i++) {
      const l = lines[i] ?? "";
      const d = depthAfter[i] ?? 0;
      if (d === 0 && /;\s*$/.test(l)) {
        out.push(l.replace(/;\s*$/, ""));
        break;
      }
      if (d === 1 && /\{\s*$/.test(l) && !/[:(,=|&<]\s*\{\s*$/.test(l)) {
        out.push(l.replace(/\s*\{\s*$/, ""));
        break;
      }
      out.push(l);
    }
    return out.join("\n");
  }
  // A type, an interface, an enum, a class or a namespace: to where it closes.
  const out: string[] = [first];
  if (!((depthAfter[at] ?? 0) === 0 && /[;}]\s*$/.test(first))) {
    for (let i = at + 1; i < lines.length; i++) {
      const l = lines[i] ?? "";
      const inside = (depthAfter[i - 1] ?? 0) === 1;
      if (kind === "class" || kind === "namespace") {
        // Members only: the lines one level in that start one, without their bodies.
        const t = l.trim();
        if (inside && t !== "" && !/^(\}|\/\/|\/\*|\*|@|private\b|#)/.test(t)) {
          out.push(`  ${t.replace(/\s*\{\s*$/, "").replace(/;$/, "")}`);
        }
      } else out.push(l);
      if ((depthAfter[i] ?? 0) === 0 && /[;}]\s*$/.test(l)) break;
    }
    if (kind === "class" || kind === "namespace") out.push("}");
  }
  return out.length > 80
    ? [...out.slice(0, 78), "  // ...", out[out.length - 1] ?? ""].join("\n")
    : out.join("\n");
}

/** Read one module: its `@module` block, its exports with their JSDoc, its examples. */
export function readModule(file: string, source: string): ModuleDoc {
  const lines = source.replace(/\r/g, "").split("\n");
  const state: ScanState = { stack: [], comment: false, prev: "" };
  const depthAfter: number[] = [];
  const topLevel: boolean[] = [];
  for (const l of lines) {
    topLevel.push(state.stack.length === 0 && !state.comment);
    scanLine(l, state);
    depthAfter.push(state.stack.length + (state.comment ? 1 : 0));
  }

  // Doc comments at the top level, and the line each one documents.
  const comments: Comment[] = [];
  const docFor = new Map<number, Comment>();
  let moduleComment: Comment | undefined;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i] ?? "";
    if (!(topLevel[i] ?? false) || !l.startsWith("/**")) continue;
    let end = i;
    while (end < lines.length && !(lines[end] ?? "").includes("*/")) end++;
    const c: Comment = {
      start: i,
      end,
      lines: commentLines(lines.slice(i, end + 1).join("\n")),
    };
    comments.push(c);
    if (
      moduleComment === undefined &&
      comments.length === 1 &&
      c.lines.some((x) => /^@module\b/.test(x.trim()))
    ) {
      moduleComment = c;
    } else {
      let next = end + 1;
      while (next < lines.length && (lines[next] ?? "").trim() === "") next++;
      docFor.set(next, c);
    }
    i = end;
  }

  const docOf = (i: number): Comment | undefined => docFor.get(i);
  const exports: ExportDoc[] = [];
  const locals = new Map<
    string,
    { line: number; kind: ExportKind; comment: Comment | undefined }
  >();
  const pendingLocal: { names: Array<{ local: string; name: string }>; line: number }[] = [];
  const imported = new Map<string, string>();
  for (let i = 0; i < lines.length; i++) {
    if (!(topLevel[i] ?? false)) continue;
    const l = lines[i] ?? "";
    if (/^import\s/.test(l)) {
      // Its names, so that `export { x }` of an imported `x` is known as a re-export.
      let text = l;
      let j = i;
      while (!/["'];?\s*$/.test(text) && j + 1 < lines.length) {
        j++;
        text += ` ${(lines[j] ?? "").trim()}`;
      }
      const from = /from\s+["']([^"']+)["']/.exec(text)?.[1] ?? "";
      for (const x of (/\{([^}]*)\}/.exec(text)?.[1] ?? "").split(",")) {
        const m = /^(?:type\s+)?([\w$]+)(?:\s+as\s+([\w$]+))?$/.exec(x.trim());
        if (m !== null) imported.set(m[2] ?? m[1] ?? "", from);
      }
      const def = /^import\s+(?:type\s+)?([\w$]+)\s*(?:,|from)/.exec(text)?.[1];
      if (def !== undefined) imported.set(def, from);
      const ns = /\*\s+as\s+([\w$]+)/.exec(text)?.[1];
      if (ns !== undefined) imported.set(ns, from);
      i = j;
      continue;
    }
    const local = LOCAL.exec(l);
    if (local !== null) {
      const kind = kindOf(local[1] ?? "");
      const name = local[2] ?? "";
      if (!locals.has(name)) locals.set(name, { line: i, kind, comment: docOf(i) });
      continue;
    }
    const d = DECLARATION.exec(l);
    if (d !== null) {
      const kind: ExportKind = d[1] !== undefined ? "default" : kindOf(d[2] ?? "");
      const name = d[1] !== undefined ? "default" : (d[3] ?? "");
      const comment = docOf(i);
      const same = exports.findIndex((e) => e.name === name && e.kind === kind);
      const prior = same >= 0 ? exports[same] : undefined;
      if (prior !== undefined && kind === "function") {
        // An overload, or the implementation after the overloads: one export.
        if (prior.doc === undefined && comment !== undefined) {
          exports[same] = {
            ...prior,
            doc: commentMarkdown(comment.lines),
            examples: examplesOf(comment.lines, comment.start + 1),
          };
        }
        continue;
      }
      exports.push({
        name,
        kind,
        line: i + 1,
        doc: comment === undefined ? undefined : commentMarkdown(comment.lines),
        signature: signatureOf(lines, i, kind, depthAfter),
        examples: comment === undefined ? [] : examplesOf(comment.lines, comment.start + 1),
      });
      continue;
    }
    if (/^export\s+default\b/.test(l)) {
      const comment = docOf(i);
      exports.push({
        name: "default",
        kind: "default",
        line: i + 1,
        doc: comment === undefined ? undefined : commentMarkdown(comment.lines),
        signature: l.replace(/\s*[{(]\s*$/, ""),
        examples: comment === undefined ? [] : examplesOf(comment.lines, comment.start + 1),
      });
      continue;
    }
    if (/^export\s+(type\s+)?(\*|\{)/.test(l)) {
      // export { a, b as c } [from "..."]; export * [as ns] from "..."
      let text = l;
      let j = i;
      while (!/[;}]\s*(from\s+["'][^"']+["'];?)?\s*$/.test(text) && j + 1 < lines.length) {
        j++;
        text += ` ${(lines[j] ?? "").trim()}`;
      }
      const from = /from\s+["']([^"']+)["']/.exec(text)?.[1];
      const star = /^export\s+(?:type\s+)?\*(?:\s+as\s+([\w$]+))?/.exec(text);
      if (star !== null) {
        exports.push({
          name: star[1] ?? "*",
          kind: "re-export",
          line: i + 1,
          doc: docOf(i) === undefined ? undefined : commentMarkdown(docOf(i)?.lines ?? []),
          signature: text,
          ...(from === undefined ? {} : { from }),
          examples: [],
        });
      } else {
        const inner = /\{([^}]*)\}/.exec(text)?.[1] ?? "";
        const names = inner
          .split(",")
          .map((x) => x.trim().replace(/^type\s+/, ""))
          .filter((x) => x !== "")
          .map((x) => {
            const m = /^([\w$]+)(?:\s+as\s+([\w$]+))?$/.exec(x);
            return { local: m?.[1] ?? x, name: m?.[2] ?? m?.[1] ?? x };
          });
        if (from !== undefined) {
          for (const n of names) {
            exports.push({
              name: n.name,
              kind: "re-export",
              line: i + 1,
              doc: undefined,
              signature: text,
              from,
              examples: [],
            });
          }
        } else pendingLocal.push({ names, line: i });
      }
      i = j;
    }
  }
  // `export { a, b as c }`: each takes its local declaration's documentation.
  for (const p of pendingLocal) {
    for (const n of p.names) {
      const from = imported.get(n.local);
      if (from !== undefined && !locals.has(n.local)) {
        exports.push({
          name: n.name,
          kind: "re-export",
          line: p.line + 1,
          doc: undefined,
          signature: `export { ${n.local === n.name ? n.name : `${n.local} as ${n.name}`} } from "${from}"`,
          from,
          examples: [],
        });
        continue;
      }
      const decl = locals.get(n.local);
      const comment = decl?.comment ?? docOf(p.line);
      exports.push({
        name: n.name,
        kind: decl?.kind ?? "const",
        line: (decl?.line ?? p.line) + 1,
        doc: comment === undefined ? undefined : commentMarkdown(comment.lines),
        signature:
          decl === undefined
            ? `export { ${n.local} }`
            : signatureOf(lines, decl.line, decl.kind, depthAfter),
        examples: comment === undefined ? [] : examplesOf(comment.lines, comment.start + 1),
      });
    }
  }
  return {
    file,
    doc: moduleComment === undefined ? undefined : commentMarkdown(moduleComment.lines),
    examples:
      moduleComment === undefined ? [] : examplesOf(moduleComment.lines, moduleComment.start + 1),
    exports,
  };
}

function kindOf(word: string): ExportKind {
  switch (word) {
    case "function":
    case "function*":
      return "function";
    case "const":
    case "let":
    case "var":
    case "class":
    case "type":
    case "interface":
    case "enum":
    case "namespace":
      return word;
    default:
      return "const";
  }
}

/** Read every module the documentation covers. */
export async function readModules(root = ROOT): Promise<ModuleDoc[]> {
  const out: ModuleDoc[] = [];
  for (const f of await sourceFiles(root))
    out.push(readModule(f, await fs.readTextFile(path.join(root, f))));
  return out;
}

// ---------------------------------------------------------------------------------------------
// The lint

/** One documentation problem: where, and what. */
export type Problem = { readonly file: string; readonly line: number; readonly message: string };

/** A module's documentation problems: no `@module` block, an export without JSDoc. */
export function problemsOf(m: ModuleDoc): Problem[] {
  const out: Problem[] = [];
  if (m.doc === undefined || m.doc === "") {
    out.push({ file: m.file, line: 1, message: "no /** ... @module */ block at the top" });
  }
  for (const e of m.exports) {
    if (e.kind === "re-export") continue; // documented where it is declared
    if (e.doc === undefined || e.doc === "") {
      out.push({ file: m.file, line: e.line, message: `${e.kind} ${e.name} has no JSDoc` });
    }
  }
  return out;
}

/** The problems' count by folder, most first. */
export function countByFolder(problems: readonly Problem[]): Array<[string, number]> {
  const by = new Map<string, number>();
  for (const p of problems) {
    const dir = p.file.slice(0, p.file.lastIndexOf("/"));
    by.set(dir, (by.get(dir) ?? 0) + 1);
  }
  return [...by.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

// ---------------------------------------------------------------------------------------------
// The examples

/** An example's code with its relative imports turned into the package's name. */
export function exampleSource(file: string, code: string): string {
  const dir = path.posix.dirname(file);
  return code.replace(
    /(\bfrom\s+|\bimport\s*\(\s*|\bimport\s+)(["'])(\.{1,2}\/[^"']+)\2/g,
    (all, head: string, q: string, spec: string) => {
      const target = path.posix.normalize(path.posix.join(dir, spec));
      if (!target.startsWith("src/")) return all;
      return `${head}${q}${PACKAGE}/${target.slice(4).replace(/\.ts$/, "")}${q}`;
    },
  );
}

/** An example that did not compile: where it is, and what `tsc` said. */
export type ExampleFailure = {
  readonly file: string;
  readonly line: number;
  readonly errors: readonly string[];
};

/**
 * Type-check every example: each written to `out/docs-examples/` as a module, checked together
 * with the repository's `tsc` and strict configuration (unused names allowed: an example shows,
 * it need not use everything). The examples that fail, with `tsc`'s messages. `dir` must be inside
 * the repository, so that the examples find its packages and the engine by its name.
 */
export async function checkExamples(
  modules: readonly ModuleDoc[],
  root = ROOT,
  dir = path.join(root, "out", "docs-examples"),
): Promise<{ total: number; failures: ExampleFailure[] }> {
  await fs.remove(dir, { recursive: true }).catch(() => {});
  await fs.mkdir(dir, { recursive: true });
  const where = new Map<string, { file: string; line: number }>();
  let n = 0;
  for (const m of modules) {
    for (const ex of [...m.examples, ...m.exports.flatMap((e) => e.examples)]) {
      n++;
      const name = `example-${String(n).padStart(4, "0")}.ts`;
      where.set(name, { file: m.file, line: ex.line });
      await fs.writeTextFile(
        path.join(dir, name),
        `// ${m.file}:${ex.line}\n${exampleSource(m.file, ex.code)}\nexport {};\n`,
      );
    }
  }
  if (n === 0) return { total: 0, failures: [] };
  await fs.writeTextFile(
    path.join(dir, "tsconfig.json"),
    `${JSON.stringify(
      {
        extends: path.relative(dir, path.join(root, "tsconfig.json")).replace(/\\/g, "/"),
        compilerOptions: {
          noEmit: true,
          noUnusedLocals: false,
          noUnusedParameters: false,
          moduleDetection: "force",
        },
        include: ["*.ts"],
        exclude: [],
      },
      null,
      2,
    )}\n`,
  );
  const r = await proc.run(
    [
      proc.execPath(),
      path.join(root, "node_modules", "typescript", "bin", "tsc"),
      "-p",
      dir,
      "--pretty",
      "false",
    ],
    {
      cwd: root,
    },
  );
  const errors = new Map<string, string[]>();
  for (const line of `${r.stdout}\n${r.stderr}`.split("\n")) {
    const m = /(example-\d{4}\.ts)\((\d+),(\d+)\): (error .*)$/.exec(line);
    if (m === null) continue;
    const list = errors.get(m[1] ?? "") ?? [];
    // Line 1 is the example's own comment: its code starts on line 2.
    list.push(`line ${Number(m[2]) - 1}: ${m[4] ?? ""}`);
    errors.set(m[1] ?? "", list);
  }
  const failures: ExampleFailure[] = [];
  for (const [name, list] of [...errors.entries()].sort()) {
    const w = where.get(name);
    if (w !== undefined) failures.push({ file: w.file, line: w.line, errors: list });
  }
  if (!r.success && failures.length === 0) {
    throw new Error(`tsc failed on the examples:\n${`${r.stdout}${r.stderr}`.slice(-2000)}`);
  }
  return { total: n, failures };
}

// ---------------------------------------------------------------------------------------------
// The HTML

/** A module's first sentence, from its `@module` JSDoc (plain text), for the index. */
export function firstSentence(source: string): string {
  const m = /^\/\*\*([\s\S]*?)\*\//.exec(source);
  if (m === null) return "";
  const text = (m[1] ?? "")
    .split("\n")
    .map((l) => l.replace(/^\s*\* ?/, ""))
    .filter((l) => !l.startsWith("@") && !l.startsWith("#"))
    .join(" ")
    .replace(/```[\s\S]*?```/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const end = text.search(/\.(\s|$)/);
  const first = (end > 0 ? text.slice(0, end + 1) : text).replace(/`/g, "");
  return first.length > 200 ? `${first.slice(0, 197).replace(/\s\S*$/, "")}…` : first;
}

const ESC: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
};
const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => ESC[c] ?? c);

/** Where an in-documentation link points before it is made relative to its page. */
const SITE = "https://stolos-docs.invalid/";

/** The engine's files at this version, on GitHub. */
const BLOB = `https://github.com/intellectual-frontiers/stolos/blob/v${VERSION}/`;

/** A module's page, relative to the documentation's root (`archon/pg/mod.ts/index.html`). */
export function pageOf(file: string): string {
  return `${file.replace(/^src\//, "")}/index.html`;
}

/**
 * A link in a module's documentation, made absolute: another guide (`pg.md`) goes to that guide's
 * module page; a module of the engine (`../compliance/mod.ts`) to its page; any other file of the
 * repository (`../../specs/...`) to GitHub at this version. Web links stay as they are.
 */
export function linkTarget(file: string, target: string): string {
  if (/^(https?:|mailto:|#)/.test(target)) return target;
  const [rel = "", hash] = target.split("#");
  const tail = hash === undefined ? "" : `#${hash}`;
  const guide = /^(?:\.\/)?([a-z0-9-]+)\.md$/.exec(rel)?.[1];
  const g = guide === undefined ? undefined : GUIDES.find((x) => x.name === guide);
  if (g !== undefined) return `${SITE}${pageOf(g.module)}${tail}`;
  let resolved = path.posix.normalize(path.posix.join(path.posix.dirname(file), rel));
  while (resolved.startsWith("../")) resolved = resolved.slice(3);
  if (resolved.startsWith("src/") && resolved.endsWith(".ts"))
    return `${SITE}${pageOf(resolved)}${tail}`;
  return `${BLOB}${resolved}${tail}`;
}

/** A module's Markdown as HTML for its page (`depth` folders below the root), Mermaid blocks to draw. */
export function renderMarkdown(file: string, md: string, depth: number): string {
  const root = "../".repeat(depth);
  const parts: string[] = [];
  let text: string[] = [];
  let mermaid: string[] | undefined;
  const flushText = (): void => {
    if (text.length === 0) return;
    const linked = text
      .join("\n")
      .replace(/\]\(([^)\s]+)\)/g, (all, target: string) =>
        /^[^()]*$/.test(target) ? `](${linkTarget(file, target)})` : all,
      );
    parts.push(markdownToHtml(linked, { served: [], repoBlob: BLOB }));
    text = [];
  };
  for (const l of md.split("\n")) {
    if (mermaid !== undefined) {
      if (/^\s*```/.test(l)) {
        parts.push(`<pre class="mermaid">${esc(dedent(mermaid).join("\n"))}</pre>`);
        mermaid = undefined;
      } else mermaid.push(l);
      continue;
    }
    if (/^\s*```mermaid\s*$/.test(l)) {
      flushText();
      mermaid = [];
      continue;
    }
    text.push(l);
  }
  flushText();
  return parts.join("\n").split(SITE).join(root);
}

/** The pages' shared style: plain, readable, light or dark as the reader's system. */
export const STYLE = `:root { color-scheme: light dark; --fg: #1d2330; --bg: #ffffff; --muted: #5b6475; --line: #e3e6ec; --code: #f4f5f8; --link: #1f5fbf; }
@media (prefers-color-scheme: dark) { :root { --fg: #e6e8ee; --bg: #14171d; --muted: #9aa3b5; --line: #2a2f39; --code: #1c2028; --link: #7fb0ff; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 16px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 62rem; margin: 0 auto; padding: 1.5rem 1rem 4rem; }
a { color: var(--link); }
header.top { border-bottom: 1px solid var(--line); padding: .6rem 1rem; font-size: .95rem; }
header.top a { text-decoration: none; }
h1 { font-size: 1.7rem; margin: .4rem 0 .8rem; word-break: break-word; }
h2 { font-size: 1.25rem; margin: 2rem 0 .5rem; }
h3 { font-size: 1.05rem; margin: 1.4rem 0 .4rem; }
code { font: .9em ui-monospace, "JetBrains Mono", Menlo, Consolas, monospace; background: var(--code); padding: .05em .3em; border-radius: .25em; }
pre { background: var(--code); padding: .8rem 1rem; border-radius: .4rem; overflow-x: auto; }
pre code { background: none; padding: 0; }
pre.mermaid { background: none; text-align: center; }
table { border-collapse: collapse; margin: .8rem 0; display: block; overflow-x: auto; }
th, td { border: 1px solid var(--line); padding: .3rem .6rem; text-align: left; vertical-align: top; }
blockquote { margin: .8rem 0; padding: .2rem 1rem; border-left: 3px solid var(--line); color: var(--muted); }
.symbol { border-top: 1px solid var(--line); padding-top: .4rem; }
.kind { color: var(--muted); font-size: .85rem; font-weight: normal; margin-right: .4rem; }
.muted { color: var(--muted); }
ul.modules li { margin: .15rem 0; }
.start { padding: .8rem 1rem; border-radius: .5rem; background: var(--code); }
`;

/** The script that draws a page's Mermaid blocks, light or dark as the page. */
export function mermaidBoot(root: string): string {
  return `<script src="${root}mermaid.min.js"></script>
<script>
  mermaid.initialize({ startOnLoad: true, securityLevel: "strict",
    theme: matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "default" });
</script>`;
}

/** A whole page around its body. */
function page(title: string, root: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<link rel="stylesheet" href="${root}style.css">
</head>
<body>
<header class="top"><a href="${root}index.html">Stolos v${esc(VERSION)}</a> · <a href="${root}all_symbols.html">all symbols</a></header>
<main>
${body}
</main>
${body.includes('class="mermaid"') ? mermaidBoot(root) : ""}
</body>
</html>
`;
}

/** A module's page. */
export function modulePage(m: ModuleDoc): string {
  const depth = m.file.replace(/^src\//, "").split("/").length;
  const root = "../".repeat(depth);
  const parts = [`<h1>${esc(m.file.replace(/^src\//, ""))}</h1>`];
  if (m.doc !== undefined) parts.push(renderMarkdown(m.file, m.doc, depth));
  for (const ex of m.examples)
    parts.push(`<h3>Example</h3>\n<pre><code class="language-ts">${esc(ex.code)}</code></pre>`);
  const own = m.exports.filter((e) => e.kind !== "re-export");
  const re = m.exports.filter((e) => e.kind === "re-export");
  if (own.length > 0) {
    parts.push("<h2>Exports</h2>");
    for (const e of own) {
      parts.push(`<section class="symbol" id="${esc(e.name)}">
<h3><span class="kind">${e.kind}</span><a href="#${esc(e.name)}">${esc(e.name)}</a></h3>
<pre><code class="language-ts">${esc(e.signature)}</code></pre>
${e.doc === undefined ? '<p class="muted">Not documented yet.</p>' : renderMarkdown(m.file, e.doc, depth)}
${e.examples.map((x) => `<h4>Example</h4>\n<pre><code class="language-ts">${esc(x.code)}</code></pre>`).join("\n")}
</section>`);
    }
  }
  if (re.length > 0) {
    parts.push("<h2>Re-exports</h2>\n<ul>");
    for (const e of re) {
      const from = e.from ?? "";
      const target = from.startsWith(".")
        ? linkTarget(m.file, from).split(SITE).join(root)
        : undefined;
      parts.push(
        `<li><code>${esc(e.name)}</code> from ${target === undefined ? `<code>${esc(from)}</code>` : `<a href="${esc(target)}"><code>${esc(from)}</code></a>`}</li>`,
      );
    }
    parts.push("</ul>");
  }
  parts.push(`<p class="muted"><a href="${BLOB}${esc(m.file)}">Source</a></p>`);
  return page(`${m.file.replace(/^src\//, "")}: Stolos v${VERSION}`, root, parts.join("\n"));
}

/**
 * The front page: the guides first, in reading order (`core/guides.ts`), then every module by
 * folder with its first sentence.
 */
export function frontPage(
  modules: readonly ModuleDoc[],
  firstLines: ReadonlyMap<string, string>,
): string {
  const groups = new Map<string, ModuleDoc[]>();
  for (const m of modules) {
    const rel = m.file.replace(/^src\//, "");
    if (rel === "mod.ts") continue;
    const dir = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : ".";
    groups.set(dir, [...(groups.get(dir) ?? []), m]);
  }
  const sections = [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(
      ([dir, mods]) =>
        `<h2>${esc(dir)}/</h2>\n<ul class="modules">\n${mods
          .map(
            (m) =>
              `<li><a href="./${esc(pageOf(m.file))}"><code>${esc(m.file.split("/").pop() ?? m.file)}</code></a> ${esc(firstLines.get(m.file) ?? "")}</li>`,
          )
          .join("\n")}\n</ul>`,
    )
    .join("\n");
  return page(
    `Stolos v${VERSION}`,
    "./",
    `<h1>Stolos v${esc(VERSION)}</h1>
<p>The fleet engine (its command is <code>archon</code>), documented from its TypeScript.</p>
<p class="start">Start here: <a href="./mod.ts/index.html">the overview</a>, with how the pieces fit, in
diagrams. Then the model: <a href="./archon/model/types.ts/index.html">types.ts</a>. Every symbol:
<a href="./all_symbols.html">all symbols</a>.</p>
<h2>Guides</h2>
<ul class="modules">
${GUIDES.map((g) => `<li><a href="./${esc(pageOf(g.module))}">${esc(g.title)}</a> ${esc(g.why)}</li>`).join("\n")}
</ul>
${sections}`,
  );
}

/** Every exported symbol, by name, with its module. */
export function symbolsPage(modules: readonly ModuleDoc[]): string {
  const all = modules
    .flatMap((m) => m.exports.filter((e) => e.kind !== "re-export").map((e) => ({ m, e })))
    .sort((a, b) => a.e.name.localeCompare(b.e.name) || a.m.file.localeCompare(b.m.file));
  return page(
    `All symbols: Stolos v${VERSION}`,
    "./",
    `<h1>All symbols</h1>\n<ul class="modules">\n${all
      .map(
        ({ m, e }) =>
          `<li><span class="kind">${e.kind}</span><a href="./${esc(pageOf(m.file))}#${esc(e.name)}"><code>${esc(e.name)}</code></a> <span class="muted">${esc(m.file.replace(/^src\//, ""))}</span></li>`,
      )
      .join("\n")}\n</ul>`,
  );
}

/** Mermaid's file, from `vendor/` where it matches its pin, else downloaded and checked. */
async function mermaidBytes(root: string): Promise<Uint8Array> {
  try {
    const b = await fs.readFile(path.join(root, MERMAID.vendored));
    if ((await sha256(b)) === MERMAID.sha256) return b;
  } catch {
    /* not vendored here: downloaded */
  }
  const res = await fetch(MERMAID.url);
  if (!res.ok) throw new Error(`${MERMAID.url}: HTTP ${res.status}`);
  const js = new Uint8Array(await res.arrayBuffer());
  const got = await sha256(js);
  if (got !== MERMAID.sha256)
    throw new Error(`${MERMAID.url}: SHA-256 ${got}, expected ${MERMAID.sha256}: not used`);
  return js;
}

/** Build the HTML into `out` (the default `out/docs`). */
export async function build(out = path.join(ROOT, "out", "docs"), root = ROOT): Promise<void> {
  await fs.remove(out, { recursive: true }).catch(() => {});
  await fs.mkdir(out, { recursive: true });
  const modules = await readModules(root);
  const firstLines = new Map<string, string>();
  let diagrams = 0;
  for (const m of modules) {
    firstLines.set(m.file, firstSentence(await fs.readTextFile(path.join(root, m.file))));
    const html = modulePage(m);
    if (html.includes('class="mermaid"')) diagrams++;
    const dest = path.join(out, pageOf(m.file));
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.writeTextFile(dest, html);
  }
  await fs.writeTextFile(path.join(out, "index.html"), frontPage(modules, firstLines));
  await fs.writeTextFile(path.join(out, "all_symbols.html"), symbolsPage(modules));
  await fs.writeTextFile(path.join(out, "style.css"), STYLE);
  await fs.writeFile(path.join(out, "mermaid.min.js"), await mermaidBytes(root));
  console.log(
    `docs: ${modules.length} modules · ${diagrams} page(s) with diagrams · ${path.join(out, "index.html")}`,
  );
}

/** `lint`: every module and export documented, and (unless `examples` is false) every example compiles. */
export async function lint(o: { readonly examples?: boolean } = {}, root = ROOT): Promise<number> {
  const modules = await readModules(root);
  const problems = modules.flatMap(problemsOf);
  for (const p of problems) stdio.stderr.writeSync(`${p.file}:${p.line}: ${p.message}\n`);
  let failed = problems.length > 0;
  if (problems.length > 0) {
    stdio.stderr.writeSync(
      `\ndocs:lint: ${problems.length} documentation problem(s), by folder:\n`,
    );
    for (const [dir, n] of countByFolder(problems))
      stdio.stderr.writeSync(`  ${String(n).padStart(5)}  ${dir}\n`);
  }
  if (o.examples !== false) {
    const { total, failures } = await checkExamples(modules, root);
    for (const f of failures)
      stdio.stderr.writeSync(
        `${f.file}:${f.line}: the @example does not compile:\n    ${f.errors.join("\n    ")}\n`,
      );
    console.log(`docs:lint: ${total} example(s), ${failures.length} that do not compile`);
    failed ||= failures.length > 0;
  }
  const exportsCount = modules.reduce((n, m) => n + m.exports.length, 0);
  console.log(
    `docs:lint: ${modules.length} modules, ${exportsCount} exports, ${problems.length} undocumented`,
  );
  return failed ? 1 : 0;
}

if (import.meta.main) {
  const [cmd, ...rest] = proc.args;
  if (cmd === "lint") proc.exit(await lint({ examples: !rest.includes("--no-examples") }));
  else if (cmd === "examples") {
    const { total, failures } = await checkExamples(await readModules());
    for (const f of failures)
      stdio.stderr.writeSync(
        `${f.file}:${f.line}: the @example does not compile:\n    ${f.errors.join("\n    ")}\n`,
      );
    console.log(`docs: ${total} example(s), ${failures.length} that do not compile`);
    proc.exit(failures.length > 0 ? 1 : 0);
  } else await build(cmd === undefined ? undefined : path.resolve(cmd));
}
