/**
 * `bun run compat:digest` (spec 115-compatibility FR-003): write `tests/compat.digest.txt`, the digest of the shape of the seams `model`,
 * `query` and `mcp` with the version each belongs to; `--check` writes nothing and fails where the file differs from the code. A changed
 * shape is recorded only under a raised version (the major for a change that breaks a reader, the minor for an addition, in
 * `src/archon/core/compat.ts`): without that the tool refuses and says which seam to raise. `bun run ci` runs `--check`.
 *
 * ```sh
 * bun run compat:digest           # record the shapes (after raising the seam's version)
 * bun run compat:digest --check   # what CI runs
 * ```
 *
 * @module
 */
// Spec: 115-compatibility FR-003

import { fs, path, proc } from "@intellectual-frontiers/system";
import { mcpShape } from "../src/archon/mcp/compat-shape.ts";
import {
  type DigestedSeam,
  formatDigests,
  modelShape,
  parseDigests,
  queryShape,
  reconcileDigests,
  sha256,
} from "../src/archon/observe/compat-shapes.ts";

const ROOT = path.resolve(path.dirname(path.fromFileUrl(import.meta.url)), "..");

/** The committed file of digests, from the repository's root. */
export const DIGEST_FILE = "tests/compat.digest.txt";

/** The digest of each digested seam's shape, from the code. */
export async function shapes(): Promise<Record<DigestedSeam, string>> {
  return {
    model: sha256(await modelShape()),
    query: sha256(queryShape()),
    mcp: sha256(mcpShape()),
  };
}

/** The check, or the write: 0 when the file holds the code's shapes (or was written), 1 with the reason otherwise. */
export async function main(argv: readonly string[], root = ROOT): Promise<number> {
  const file = path.join(root, DIGEST_FILE);
  const recorded = parseDigests((await fs.readTextOr(file)) ?? "");
  const outcome = reconcileDigests(recorded, await shapes());
  for (const p of outcome.problems) console.error(`compat:digest: ${p}`);
  if (outcome.problems.length) return 1;
  if (argv.includes("--check")) {
    if (outcome.changed) {
      console.error(
        `compat:digest: ${DIGEST_FILE} does not match the code: run bun run compat:digest and commit it`,
      );
      return 1;
    }
    console.log("compat:digest: the seams' shapes match their recorded versions");
    return 0;
  }
  if (outcome.changed) await fs.writeTextFile(file, formatDigests(outcome.next));
  console.log(
    outcome.changed
      ? `compat:digest: wrote ${DIGEST_FILE}`
      : `compat:digest: ${DIGEST_FILE} is current`,
  );
  return 0;
}

if (import.meta.main) proc.exit(await main(proc.args));
