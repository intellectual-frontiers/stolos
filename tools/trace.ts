/**
 * `bun run check:trace` (spec 101-ladder FR-007, FR-008; commons 0015-trace): no code without a requirement or an ontology term.
 * Every source file (`src/`, `tools/`, `ontology/`) names its requirements on a `// Spec:` line, every requirement of a spec in force is
 * proved by a test (`proves([...])` or a `// Proves:` line under `tests/` and `examples/`) or reviewed in its spec's `reviewed.tsv`,
 * and every term of the ontology cites a spec that exists. The findings are held against `tools/trace.baseline.txt`, which may only
 * shrink: a new finding fails, and so does a line that no longer occurs.
 *
 * ```sh
 * bun run check:trace                    # hold the findings to the baseline
 * bun tools/trace.ts --write-baseline    # write the baseline from today's findings (only ever to shrink it)
 * ```
 *
 * @module
 */
// Spec: 101-ladder FR-007, FR-008
import { trace } from "@intellectual-frontiers/mizan";
import { path, proc } from "@intellectual-frontiers/system";
import * as files from "@intellectual-frontiers/mizan/host/trace";
import { citingSchemas, curieOf, files as ontologyFiles } from "../ontology/stolos/mod.ts";

const ROOT = path.resolve(path.dirname(path.fromFileUrl(import.meta.url)), "..");

/** The baseline, from the repository's root. */
export const BASELINE = "tools/trace.baseline.txt";

/** The roots of the source files, of the tests, and the specs' folder. */
export const ROOTS = {
  sources: ["src", "tools", "ontology", "docs.config.ts"],
  tests: ["tests", "examples"],
  specs: "specs",
} as const;

/** The ontology's citations: every individual of a schema with a `spec` field, by its CURIE and module. */
export function ontologyCitations(): readonly trace.OntologyCitation[] {
  return ontologyFiles.flatMap((f) =>
    trace.citationsOf(citingSchemas, f.individuals, f.module, "spec", curieOf),
  );
}

/** Every finding of the trace in a repository (this one by default). */
export async function findings(root = ROOT): Promise<readonly trace.Finding[]> {
  return trace.traceFindings({
    specs: await files.readSpecs(root, ROOTS.specs),
    sources: await files.readSources(root, ROOTS.sources),
    tests: (await files.readSources(root, ROOTS.tests)).filter((t) => t.path.endsWith(".test.ts")),
    ontology: ontologyCitations(),
    specsFolder: ROOTS.specs,
  });
}

/** The comment a written baseline begins with. */
export const COMMENTS = [
  "The trace's baseline (spec 101-ladder FR-008): findings of bun run check:trace that existed when it was first held.",
  "It only shrinks: when you fix one, delete its line. Never add a line to make the check pass.",
];

/** The check: 0 when nothing is new and nothing is stale; with `--write-baseline`, writes the baseline. */
export async function main(argv: readonly string[], root = ROOT): Promise<number> {
  const held = await files.holdBaseline({
    root,
    file: BASELINE,
    findings: await findings(root),
    name: "check:trace",
    write: argv.includes("--write-baseline"),
    comments: COMMENTS,
  });
  for (const line of held.lines) (held.code === 0 ? console.log : console.error)(line);
  return held.code;
}

if (import.meta.main) proc.exit(await main(proc.args));
