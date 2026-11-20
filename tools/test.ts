/**
 * `bun run test` (spec 096-bun-runtime FR-004): the engine's suite through IFC TypeScript's test
 * runner (`ifc test`, `runTests` of `@intellectual-frontiers/commons/ts/runtime/test-run`), into one
 * OTLP test record with its reports and the evidence ledger, held to every requirement of every
 * spec.
 *
 * - The requirements are read from `specs/*\/spec.md`: each line `- **FR-NNN** ...` is the
 *   requirement `<spec folder> FR-NNN` (`096-bun-runtime FR-001`), written to
 *   `<out>/requirements.txt` for the runner.
 * - A requirement proven by review, not by a test, is listed in its spec's `reviewed.tsv` (the
 *   requirement, a tab, the reason); they are joined into `<out>/reviewed.tsv`.
 * - The whole suite is held to every requirement (spec 096 FR-004, on Linux); a run of some files,
 *   or with `--no-requirements` (macOS and Windows, where the tests that apply only on Linux are
 *   skipped), passes when its tests pass.
 * - Before anything runs, every requirement a test file names (`"096-bun-runtime FR-001"`) and every
 *   reviewed one must be a requirement of a spec, so a mistyped id fails here and not silently.
 *
 * ```sh
 * bun run test                                   # Bun, every *.test.ts under tests/ and examples/
 * bun run test tests/proposals095.test.ts        # one file (not held to every requirement)
 * bun run test --no-requirements                 # macOS, Windows: the parts that apply there
 * bun run test:ci                                # Bun and Node, every report, the ledger
 * ```
 *
 * @module
 */
// Spec: 096-bun-runtime
import { err, ok, type Result } from "@intellectual-frontiers/core";
import * as cli from "@intellectual-frontiers/terminal/args";
import { fs, path, proc } from "@intellectual-frontiers/system";
import {
  REPORT_FORMATS,
  type ReportFormat,
  RUNTIMES,
  type Runtime,
  runTests,
} from "@intellectual-frontiers/commons/ts/runtime/test-run";

const ROOT = path.resolve(path.dirname(path.fromFileUrl(import.meta.url)), "..");

/** A line of a spec that opens a requirement: `- **FR-...**`. */
const FR_LINE = /^\s*-\s*\*\*(FR-[A-Za-z0-9]+)\*\*/;
/**
 * A requirement's id: three digits, and a letter where one was inserted (`FR-003a`), which is what
 * IFC Docs anchors on a specification's page (spec 096 FR-009, commons 0011-documentation FR-024).
 */
const FR_ID = /^FR-\d{3}[a-z]?$/;
/** A requirement id as a test names it: `"096-bun-runtime FR-001"`. */
const NAMED = /["'`](\d{3}[a-z0-9-]*) (FR-[A-Z0-9]+[a-z]?)["'`]/g;

function listOf<T extends string>(all: readonly T[], what: string): cli.Parser<readonly T[]> {
  return (t) => {
    const parts = t
      .split(",")
      .map((p) => p.trim())
      .filter((p) => p !== "");
    const bad = parts.find((p) => !(all as readonly string[]).includes(p));
    if (bad !== undefined) return err(`${bad} is not a ${what} (${all.join(", ")})`);
    return ok(parts.filter((p): p is T => (all as readonly string[]).includes(p)));
  };
}

const OPTIONS = {
  runtime: cli.value({
    help: "The runners, in turn (bun by default).",
    valueName: "LIST",
    parse: listOf(RUNTIMES, "runtime"),
    default: ["bun"],
  }),
  out: cli.value({
    help: "Where the record and the reports go.",
    valueName: "DIR",
    default: "test-results",
  }),
  report: cli.value({
    help: `The reports: ${REPORT_FORMATS.join(", ")}.`,
    valueName: "LIST",
    parse: listOf(REPORT_FORMATS, "report"),
    default: [],
  }),
  ledger: cli.value({
    help: "The evidence ledger (JSON lines) the record's digest is appended to.",
    valueName: "FILE",
  }),
  requirements: cli.flag({
    help:
      "Hold the run to every requirement of every spec (the default for the whole suite); " +
      "--no-requirements for some files, or the parts of the suite another system runs.",
    negatable: true,
  }),
};

const PATHS: readonly cli.Operand[] = [
  { name: "PATH", help: "Test files and folders (tests and examples by default).", arity: "many" },
];

/**
 * Every requirement of every spec, in the order of the specs and their lines, and a problem for each
 * requirement whose id is not `FR-NNN`.
 */
async function requirements(): Promise<{ all: string[]; problems: string[] }> {
  const all: string[] = [];
  const problems: string[] = [];
  for (const spec of await fs.listDirs(path.join(ROOT, "specs"))) {
    const text = await fs.readTextOr(path.join(ROOT, "specs", spec, "spec.md"));
    if (text === undefined) continue;
    for (const line of text.split("\n")) {
      const id = FR_LINE.exec(line)?.[1];
      if (id === undefined) continue;
      if (FR_ID.test(id)) all.push(`${spec} ${id}`);
      else problems.push(`specs/${spec}/spec.md: ${id} is not a requirement id (FR-NNN)`);
    }
  }
  return { all, problems };
}

/** Every spec's `reviewed.tsv`, joined, with the problems of the ones that name no requirement. */
async function reviewed(known: ReadonlySet<string>): Promise<{ text: string; problems: string[] }> {
  let text = "";
  const problems: string[] = [];
  for (const spec of await fs.listDirs(path.join(ROOT, "specs"))) {
    const file = path.join("specs", spec, "reviewed.tsv");
    const t = await fs.readTextOr(path.join(ROOT, file));
    if (t === undefined) continue;
    for (const line of t.split("\n")) {
      if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
      const id = line.split("\t")[0]?.trim() ?? "";
      if (!known.has(id)) problems.push(`${file}: ${id} is not a requirement of any spec`);
      text += `${line}\n`;
    }
  }
  return { text, problems };
}

/** Requirement ids that test files name and no spec has. */
async function unknownNamed(
  paths: readonly string[],
  known: ReadonlySet<string>,
): Promise<string[]> {
  const problems: string[] = [];
  for (const p of paths) {
    const abs = path.resolve(ROOT, p);
    const files = (await fs.stat(abs)).isDirectory
      ? (await fs.walkFiles(abs))
          .filter((f) => f.endsWith(".test.ts"))
          .map((f) => path.join(abs, f))
      : [abs];
    for (const f of files) {
      for (const m of (await fs.readTextFile(f)).matchAll(NAMED)) {
        const id = `${m[1]} ${m[2]}`;
        if (!known.has(id))
          problems.push(`${path.relative(ROOT, f)}: ${id} is not a requirement of any spec`);
      }
    }
  }
  return problems;
}

/**
 * How long a test may run before Bun cancels it (Node has no limit): long enough for the slowest
 * runner (Windows, where a test that makes real Git commits, keys and processes takes up to half a
 * minute), against Bun's default of 5 s. A test that needs more says so with its own `timeout`.
 */
const TEST_TIMEOUT_MS = 120_000;

/**
 * Bun's options for its runner: the timeout, after any the caller set. `ifc test` starts `bun test`
 * with the files alone, so the default goes through `BUN_OPTIONS`, which Bun reads as arguments
 * (`--timeout`, a test runner's option, is ignored by any other bun a test starts).
 */
function bunOptions(): string {
  const given = proc.env.get("BUN_OPTIONS") ?? "";
  return `${given} --timeout=${TEST_TIMEOUT_MS}`.trim();
}

async function main(argv: readonly string[]): Promise<number> {
  const p = cli.parseArgs(argv, OPTIONS, PATHS);
  if (p.kind === "err") {
    console.error(`test: ${cli.formatUsageError(p.error, "bun run test")}`);
    return 2;
  }
  if (p.value.kind === "help") {
    console.log(
      cli.helpText("bun run test", "Run the engine's suite through ifc test.", OPTIONS, PATHS),
    );
    return 0;
  }
  const o = p.value.options;
  const paths = p.value.positionals.length === 0 ? ["tests", "examples"] : p.value.positionals;
  const { all, problems: ids } = await requirements();
  const known = new Set(all);
  const review = await reviewed(known);
  const problems = [...ids, ...review.problems, ...(await unknownNamed(paths, known))];
  for (const problem of problems) console.error(`test: ${problem}`);
  if (problems.length > 0) return 1;

  const out = path.resolve(ROOT, o.out);
  await fs.ensureDir(out);
  const requirementsFile = path.join(out, "requirements.txt");
  const reviewedFile = path.join(out, "reviewed.tsv");
  await fs.writeTextFile(requirementsFile, `${all.join("\n")}\n`);
  await fs.writeTextFile(reviewedFile, review.text);

  // Every requirement is proven by the whole suite on Linux (spec 096 FR-004); some files, or the
  // parts that apply on macOS and Windows, prove only their own, so they are not held to them all.
  const holdAll = o.requirements ?? p.value.positionals.length === 0;
  const runtimes: readonly Runtime[] = o.runtime;
  const reports: readonly ReportFormat[] = o.report;
  const r: Result<{ readonly code: 0 | 1 }, string> = await runTests({
    runtimes,
    paths,
    cwd: ROOT,
    out,
    reports,
    ...(holdAll ? { requirements: requirementsFile } : {}),
    reviewed: reviewedFile,
    ...(o.ledger === undefined ? {} : { ledger: path.resolve(ROOT, o.ledger) }),
    env: { BUN_OPTIONS: bunOptions() },
  }).then((x) => {
    if (x.kind === "err") return x;
    const c = x.value.run.counts;
    console.log(
      `test: ${x.value.run.status === "success" ? "PASSED" : "FAILED"}: ${c.tests} tests, ` +
        `${c.passed} passed, ${c.failed} failed, ${c.skipped} skipped, ${c.todo} todo, ` +
        `${c.cancelled} cancelled`,
    );
    for (const f of x.value.run.failures) console.log(`test: ${f}`);
    console.log(`test: record ${x.value.recordPath} sha256 ${x.value.digest}`);
    for (const report of x.value.reports) console.log(`test: report ${report}`);
    return ok({ code: x.value.code });
  });
  if (r.kind === "err") {
    console.error(`test: ${r.error}`);
    return 1;
  }
  return r.value.code;
}

proc.exit(await main(proc.args));
