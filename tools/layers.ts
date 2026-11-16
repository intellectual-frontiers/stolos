/**
 * `bun run check:layers` (spec 101-ladder FR-002, FR-003, FR-008; commons 0015-trace): every file on exactly one rung of the ladder
 * (constitution Article 0, `ontology/stolos/architecture.ts`), and every relative import climbing it only the way the ladder allows: a
 * rung relies on the rungs below it that it names, never on one above and never around the rung under it. The findings are held against
 * `tools/layers.baseline.txt`, which may only shrink.
 *
 * ```sh
 * bun run check:layers                    # hold the findings to the baseline
 * bun tools/layers.ts --write-baseline    # write the baseline from today's findings (only ever to shrink it)
 * ```
 *
 * @module
 */
// Spec: 101-ladder FR-002, FR-003, FR-008
import { layers, type trace } from "@intellectual-frontiers/commons/ts/kernel";
import { path, proc, trace as files } from "@intellectual-frontiers/commons/ts/runtime";
import { ladder } from "../ontology/stolos/mod.ts";

const ROOT = path.resolve(path.dirname(path.fromFileUrl(import.meta.url)), "..");

/** The baseline, from the repository's root. */
export const BASELINE = "tools/layers.baseline.txt";

/** The files whose rung and imports are held: every TypeScript file of the repository's own folders. */
export const ROOTS = ["ontology", "src", "tools", "tests", "examples", "docs.config.ts"] as const;

/** Every finding of the layers check in a repository (this one by default). */
export async function findings(root = ROOT): Promise<readonly trace.Finding[]> {
  const sources = (await files.readSources(root, ROOTS)).filter(
    (f) => !f.path.startsWith("examples/out/"),
  );
  return layers.layerFindings(ladder(), sources);
}

/** The comment a written baseline begins with. */
export const COMMENTS = [
  "The layers' baseline (spec 101-ladder FR-008): findings of bun run check:layers that existed when it was first held.",
  "It only shrinks: when you fix one, delete its line. Never add a line to make the check pass.",
];

/** The check: 0 when nothing is new and nothing is stale; with `--write-baseline`, writes the baseline. */
export async function main(argv: readonly string[], root = ROOT): Promise<number> {
  const held = await files.holdBaseline({
    root,
    file: BASELINE,
    findings: await findings(root),
    name: "check:layers",
    write: argv.includes("--write-baseline"),
    comments: COMMENTS,
  });
  for (const line of held.lines) (held.code === 0 ? console.log : console.error)(line);
  return held.code;
}

if (import.meta.main) proc.exit(await main(proc.args));
