/**
 * `bun tools/doc-examples.ts` (specs 055-documentation FR-002, 096-bun-runtime FR-009): every
 * `@example` of the engine compiles. IFC Docs (`ifc-docs check`) holds every export to its TSDoc,
 * every citation and every link, but does not compile examples, so this is the one check of the
 * engine's documentation it keeps.
 *
 * Each ```ts block of an `@example` section of a doc comment of `src/` is written to
 * `out/docs-examples/` as a module, its relative imports turned into the package's name
 * (`@intellectual-frontiers/stolos/...`, as a fleet writes them), and all of them are type-checked
 * together with the repository's `tsc` and strict configuration (unused names allowed: an example
 * shows, it need not use everything). Exits 1 where one does not compile, naming its file and line.
 *
 * ```mermaid
 * flowchart LR
 *   src["src/**.ts<br/>@example ts blocks"] --> out["out/docs-examples/<br/>one module each"]
 *   out -->|"tsc, the strict configuration"| ok["0: every example compiles<br/>1: file:line and tsc's error"]
 * ```
 *
 * @module
 */
// Spec: 055-documentation
// Spec: 096-bun-runtime
import { fs, path, proc } from "@intellectual-frontiers/system";

const ROOT = path.resolve(path.dirname(path.fromFileUrl(import.meta.url)), "..");

/** The package's name, by which an example imports the engine. */
export const PACKAGE = "@intellectual-frontiers/stolos";

/** One example: the module it is in, the line its code starts on, and its code. */
export type Example = {
  readonly file: string;
  readonly line: number;
  readonly code: string;
};

/** An example that did not compile: where it is, and what `tsc` said. */
export type ExampleFailure = {
  readonly file: string;
  readonly line: number;
  readonly errors: readonly string[];
};

/** Every module of `src/` the examples are read from, as repository paths, but the generated assets. */
export async function sourceFiles(root = ROOT): Promise<string[]> {
  return (await fs.walkFiles(path.join(root, "src")))
    .map((rel) => `src/${rel.replace(/\\/g, "/")}`)
    .filter((p) => p.endsWith(".ts") && p !== "src/archon/assets.auto.ts")
    .sort();
}

function dedent(lines: readonly string[]): string[] {
  const widths = lines.filter((l) => l.trim() !== "").map((l) => /^ */.exec(l)?.[0].length ?? 0);
  const n = widths.length > 0 ? Math.min(...widths) : 0;
  return lines.map((l) => l.slice(n));
}

/**
 * The examples of a module's text: each ```ts (or ```typescript) block inside an `@example` section
 * of a doc comment, with the line its code starts on. A fence of another language, and a block
 * outside an `@example` section, are not examples.
 */
export function examplesIn(file: string, text: string): Example[] {
  const out: Example[] = [];
  for (const m of text.matchAll(/\/\*\*[\s\S]*?\*\//g)) {
    const first = text.slice(0, m.index).split("\n").length;
    const lines = m[0].split("\n").map((l) =>
      l
        .replace(/^\s*\/\*\*\s?/, "")
        .replace(/\s*\*\/\s*$/, "")
        .replace(/^\s*\* ?/, "")
        .replace(/^\s*\*$/, "")
        .replace(/\*\\\//g, "*/"),
    );
    let inExample = false;
    let fence = false;
    let code: string[] | undefined;
    let start = 0;
    lines.forEach((l, i) => {
      const t = l.trim();
      if (code !== undefined) {
        if (/^```/.test(t)) {
          out.push({ file, line: start, code: dedent(code).join("\n") });
          code = undefined;
        } else code.push(l);
        return;
      }
      if (/^```/.test(t)) {
        if (inExample && !fence && /^```(ts|typescript)\s*$/.test(t)) {
          code = [];
          start = first + i + 1;
        } else fence = !fence;
        return;
      }
      if (!fence && /^@\w+/.test(t)) inExample = /^@example\b/.test(t);
    });
  }
  return out;
}

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

/**
 * Type-check the examples, each written to `dir` as a module and checked together with the
 * repository's `tsc` and strict configuration. `dir` must be inside the repository, so that the
 * examples find its packages and the engine by its name.
 */
export async function checkExamples(
  examples: readonly Example[],
  root = ROOT,
  dir = path.join(root, "out", "docs-examples"),
): Promise<{ total: number; failures: ExampleFailure[] }> {
  await fs.remove(dir, { recursive: true }).catch(() => {});
  await fs.mkdir(dir, { recursive: true });
  const where = new Map<string, Example>();
  for (const [i, ex] of examples.entries()) {
    const name = `example-${String(i + 1).padStart(4, "0")}.ts`;
    where.set(name, ex);
    await fs.writeTextFile(
      path.join(dir, name),
      `// ${ex.file}:${ex.line}\n${exampleSource(ex.file, ex.code)}\nexport {};\n`,
    );
  }
  if (examples.length === 0) return { total: 0, failures: [] };
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
  const tsc = path.join(root, "node_modules", "typescript", "bin", "tsc");
  const r = await proc.run([proc.execPath(), tsc, "-p", dir, "--pretty", "false"], { cwd: root });
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
  return { total: examples.length, failures };
}

/** Every example of `src/`, checked; 0 where all compile. */
export async function main(root = ROOT): Promise<number> {
  const examples: Example[] = [];
  for (const f of await sourceFiles(root)) {
    examples.push(...examplesIn(f, await fs.readTextFile(path.join(root, f))));
  }
  const { total, failures } = await checkExamples(examples, root);
  for (const f of failures) {
    console.error(
      `${f.file}:${f.line}: the @example does not compile:\n    ${f.errors.join("\n    ")}`,
    );
  }
  console.log(`doc-examples: ${total} example(s), ${failures.length} that do not compile`);
  return failures.length > 0 ? 1 : 0;
}

if (import.meta.main) proc.exit(await main());
