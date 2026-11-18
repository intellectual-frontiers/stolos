/**
 * The shape of a seam, as a digest (spec 115-compatibility FR-003): a stable SHA-256 of text derived from the code itself, so that a
 * golden test and `bun run compat:digest` can tell that a seam changed without anyone listing its fields by hand. The model's shape is the
 * text of its types with comments and layout removed; the query interface's is its views and their columns, sorted; the MCP tool surface's
 * (`src/archon/mcp/compat-shape.ts`, one rung up) is each tool with its arguments and tier. `tests/compat.digest.txt` holds each digest with
 * the version it belongs to, and {@link reconcileDigests} is the one rule: a changed digest under an unchanged version is refused.
 *
 * ```mermaid
 * flowchart LR
 *   t["model/types.ts, model/site.ts<br/>comments and layout removed"] --> d["SHA-256"]
 *   v["VIEWS: names and columns, sorted"] --> d
 *   m["MCP tools served at mutate:<br/>name, tier, arguments"] --> d
 *   d --> r{"reconcileDigests<br/>against tests/compat.digest.txt"}
 *   r -->|"digest changed, version not"| no["refused: raise the seam"]
 *   r -->|"digest changed, version raised"| w["written"]
 *   r -->|"same"| ok["nothing to do"]
 * ```
 *
 * @example Comments and layout do not move a digest
 * ```ts
 * import { shapeText } from "./compat-shapes.ts";
 *
 * console.log(shapeText("interface A { x: string; // why\n }") === shapeText("interface A {\n x: string;\n}")); // true
 * ```
 *
 * @module
 */
// Spec: 115-compatibility FR-001, FR-003

import { createHash } from "node:crypto";
import { fs, path } from "@intellectual-frontiers/commons/ts/runtime";
import { compareSemVer, parseSemVer, SEAMS } from "../core/compat.ts";
import type { Seam } from "../ontology.auto.ts";
import { VIEWS } from "../state/store.ts";

/** The seams whose shape is a digest of the code (the other two are versioned by hand, FR-003). */
export const DIGESTED_SEAMS = ["model", "query", "mcp"] as const satisfies readonly Seam[];

/** One of {@link DIGESTED_SEAMS}. */
export type DigestedSeam = (typeof DIGESTED_SEAMS)[number];

/**
 * TypeScript text with its comments removed and every run of whitespace made one space: what a type says, not how it is laid out or
 * documented. Strings and template literals are kept whole (a `//` inside one is not a comment).
 */
export function shapeText(source: string): string {
  let out = "";
  let i = 0;
  while (i < source.length) {
    const c = source[i] ?? "";
    const next = source[i + 1] ?? "";
    if (c === "/" && next === "/") {
      while (i < source.length && source[i] !== "\n") i++;
    } else if (c === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2);
      i = end < 0 ? source.length : end + 2;
      out += " ";
    } else if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < source.length && source[j] !== c) j += source[j] === "\\" ? 2 : 1;
      out += source.slice(i, j + 1);
      i = j + 1;
    } else {
      out += c;
      i++;
    }
  }
  return out.replace(/\s+/g, " ").trim();
}

/** The SHA-256 of a text, in hex. */
export const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

/** The engine's own source folder, where the model's types are read from (a checkout, or the package under node_modules). */
const SRC = path.resolve(path.dirname(path.fromFileUrl(import.meta.url)), "..");

/** The model's shape: the types of the fleet and its hosts, and the site's, as text (spec 115-compatibility FR-003). */
export async function modelShape(src: string = SRC): Promise<string> {
  const parts = await Promise.all(
    ["model/types.ts", "model/site.ts"].map(async (f) =>
      shapeText(await fs.readTextFile(path.join(src, f))),
    ),
  );
  return parts.join("\n");
}

/** The query interface's shape: every view of the machine's state database with its columns, sorted. */
export function queryShape(views: Readonly<Record<string, readonly string[]>> = VIEWS): string {
  return Object.keys(views)
    .sort()
    .map((v) => `${v}(${[...(views[v] ?? [])].sort().join(",")})`)
    .join("\n");
}

/** One line of `tests/compat.digest.txt`: a seam, the version it was recorded at, and its digest. */
export interface DigestEntry {
  /** The seam. */
  seam: DigestedSeam;
  /** Its version when the digest was recorded. */
  version: string;
  /** The SHA-256 of its shape. */
  digest: string;
}

/** The header of the committed file. */
export const DIGEST_HEADER = [
  "# The shape of each seam of the contract between a PC and its machines, as a digest (spec 115-compatibility FR-003).",
  "# Written by bun run compat:digest; checked by it (--check, in bun run ci) and by tests/compat115.test.ts. Never edit by hand.",
  "# A changed digest is recorded only under a raised version: the major for a change that breaks a reader, the minor for an addition",
  "# (src/archon/core/compat.ts).",
];

/** The file's text for these entries. */
export function formatDigests(entries: readonly DigestEntry[]): string {
  return [...DIGEST_HEADER, ...entries.map((e) => `${e.seam} ${e.version} ${e.digest}`), ""].join(
    "\n",
  );
}

/** The entries in a committed file's text (a line that is not one is ignored). */
export function parseDigests(text: string): DigestEntry[] {
  const out: DigestEntry[] = [];
  for (const line of text.split("\n")) {
    const m = /^(model|query|mcp) (\d+\.\d+\.\d+) ([0-9a-f]{64})$/.exec(line.trim());
    if (m) out.push({ seam: m[1] as DigestedSeam, version: m[2] ?? "", digest: m[3] ?? "" });
  }
  return out;
}

/** What {@link reconcileDigests} decided. */
export interface DigestOutcome {
  /** What is wrong, in words: a changed shape under an unchanged version. */
  problems: string[];
  /** The entries the file should hold (what is there, with what may be recorded). */
  next: DigestEntry[];
  /** Whether `next` differs from what was recorded. */
  changed: boolean;
}

/**
 * The one rule (spec 115-compatibility FR-003): for each digested seam, a digest that differs from the recorded one is accepted only
 * where the seam's version is higher than the recorded version; a version raised without a change of shape is accepted too; a seam with no
 * record is recorded. `current` is the version of {@link SEAMS}, `now` the digests of the code.
 */
export function reconcileDigests(
  recorded: readonly DigestEntry[],
  now: Readonly<Record<DigestedSeam, string>>,
  current: Readonly<Record<Seam, { current: string }>> = SEAMS,
): DigestOutcome {
  const problems: string[] = [];
  const next: DigestEntry[] = [];
  for (const seam of DIGESTED_SEAMS) {
    const was = recorded.find((e) => e.seam === seam);
    const version = current[seam].current;
    const entry: DigestEntry = { seam, version, digest: now[seam] };
    if (was && was.digest !== now[seam]) {
      const a = parseSemVer(was.version);
      const b = parseSemVer(version);
      if (!a || !b || compareSemVer(b, a) <= 0) {
        problems.push(
          `the shape of ${seam} changed, and its version is still ${was.version}: raise ${seam} in src/archon/core/compat.ts (the major for a change that breaks a reader, the minor for an addition), then run bun run compat:digest`,
        );
        next.push(was);
        continue;
      }
    }
    next.push(entry);
  }
  const changed =
    next.length !== recorded.length ||
    next.some((e, i) => {
      const r = recorded[i];
      return !r || r.seam !== e.seam || r.version !== e.version || r.digest !== e.digest;
    });
  return { problems, next, changed };
}
