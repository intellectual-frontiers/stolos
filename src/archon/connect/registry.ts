/**
 * Spec 088: the connector registry. A fleet adds a connector Stolos does not
 * ship the way it takes the engine itself: a TypeScript module at a pinned
 * URL (a tag or a commit), declared in the fleet repository
 * (`fleets/<fleet>/connectors.ts`), with a lock entry: Deno's own `deno.lock`
 * hash of every file, and Stolos's own entry (the module's SHA-256, the
 * engine versions it supports, and which engine checked it and its fixtures).
 * The engine loads the added connectors beside its own (`CONNECTORS`).
 *
 * There is no central server: an index anyone can host is a JSON file
 * ({@link RegistryIndex}) that names connectors and their tags.
 *
 * ```mermaid
 * flowchart LR
 *   src["github.com/owner/repo @ tag"] --> url["raw.githubusercontent.com/owner/repo/tag/mod.ts"]
 *   url --> probe["probe: restricted Deno, fixtures"] --> checks["checks: id, labels, SCF, engine range"]
 *   checks --> file["fleets/&lt;fleet&gt;/connectors.ts (import + entry)"] --> lock["deno.lock (hash)"]
 *   file --> engine["the engine: CONNECTORS + these"]
 * ```
 *
 * @module
 */

import { exportedLiteral, tsLiteral } from "../core/ts-literal.ts";
import { join, toFileUrl } from "../core/path.ts";
import { schemaProblems, type ViewDef } from "../schema/define.ts";
import { OCSF_CLASSES } from "../ocsf/types.auto.ts";
import { type Connector, MARKET_CATEGORIES, SERVICE_MODELS } from "./connector.ts";
import { CONNECTOR_LABELS } from "./labels.ts";
import type { Declaration } from "./registry-contract.ts";

/** Stolos's own lock entry for one added connector. */
export interface RegistryEntry {
  /** Its id (unique among the engine's and the fleet's connectors). */
  id: string;
  /** Its name for people. */
  title: string;
  /** Where it was added from (`https://github.com/<owner>/<repo>[/<path>]`). */
  source: string;
  /** The tag or commit it is pinned to. */
  ref: string;
  /** The module's URL, pinned (what connectors.ts imports). */
  module: string;
  /** The module's SHA-256 (hex), as added; deno.lock holds the same. */
  sha256: string;
  /** The engine versions it supports, as it declares (a range). */
  engine: string;
  /** The engine version that checked it and ran its fixtures. */
  checkedWith: string;
  /** How many fixture tests passed then. */
  fixtures: number;
  /** When it was added or moved to this ref (YYYY-MM-DD). */
  added: string;
}

/** A source and a ref, resolved to the module's pinned URL. */
export interface PinnedSource {
  /** The source, without the ref. */
  source: string;
  /** The ref: a version tag or a full commit SHA. */
  ref: string;
  /** The module's URL. */
  module: string;
}

const TAG = /^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const COMMIT = /^[0-9a-f]{40}$/;
const ID = /^[a-z][a-z0-9-]{1,39}$/;

/**
 * `<source>@<ref>` as a pinned module URL. The source is
 * `https://github.com/<owner>/<repo>[/<path>]` (read from
 * raw.githubusercontent.com, as the engine is), or any
 * `http(s)://<host>/<owner>/<repo>[/<path>]` laid out the same way; the path
 * defaults to `mod.ts`. The ref must be a version tag or a full commit SHA: a
 * branch moves, so it is refused.
 */
export function pinSource(spec: string): PinnedSource {
  const at = spec.lastIndexOf("@");
  if (at < 0) throw new Error(`pin it: ${spec}@<tag> (a version tag or a full commit SHA)`);
  const source = spec.slice(0, at).replace(/\/+$/, "");
  const ref = spec.slice(at + 1);
  if (!TAG.test(ref) && !COMMIT.test(ref)) {
    throw new Error(`${ref} is not a version tag (v1.2.3) or a full commit SHA: a branch moves`);
  }
  let u: URL;
  try {
    u = new URL(source);
  } catch {
    throw new Error(`${source} is not a URL (https://github.com/<owner>/<repo>)`);
  }
  if (
    u.protocol !== "https:" &&
    !(u.protocol === "http:" && /^(127\.0\.0\.1|localhost)$/.test(u.hostname))
  ) {
    throw new Error(`${source}: only https (or http on this machine, for tests)`);
  }
  const [owner, repo, ...path] = u.pathname.split("/").filter(Boolean);
  if (!owner || !repo) throw new Error(`${source}: name the repository (<host>/<owner>/<repo>)`);
  const origin = u.host === "github.com" ? "https://raw.githubusercontent.com" : u.origin;
  const file = path.length ? path.join("/") : "mod.ts";
  if (!/\.(ts|js|mjs)$/.test(file)) throw new Error(`${file}: a connector is a TypeScript module`);
  return { source, ref, module: `${origin}/${owner}/${repo}/${ref}/${file}` };
}

/** A version ("0.112.0") as numbers, or undefined. */
function semver(v: string): [number, number, number] | undefined {
  const m = v.trim().replace(/^v/, "").match(/^(\d+)\.(\d+)\.(\d+)$/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined;
}

const cmp = (a: number[], b: number[]) => {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  return 0;
};

/**
 * Whether a version is in a range: comparators separated by spaces, all of
 * which must hold (`>=0.112.0 <1.0.0`); `^1.2.3` is `>=1.2.3 <2.0.0` (and
 * `^0.3.1`, `>=0.3.1 <0.4.0`). Undefined when the range is not readable.
 */
export function satisfies(version: string, range: string): boolean | undefined {
  const v = semver(version);
  const parts = range.trim().split(/\s+/).filter(Boolean);
  if (!v || !parts.length) return undefined;
  for (const p of parts) {
    const m = p.match(/^(>=|<=|>|<|=|\^)?(v?\d+\.\d+\.\d+)$/);
    const w = m && semver(m[2]);
    if (!m || !w) return undefined;
    const c = cmp(v, w);
    const op = m[1] ?? "=";
    const ok = op === ">="
      ? c >= 0
      : op === "<="
      ? c <= 0
      : op === ">"
      ? c > 0
      : op === "<"
      ? c < 0
      : op === "="
      ? c === 0
      : c >= 0 && cmp(v, w[0] > 0 ? [w[0] + 1, 0, 0] : [0, w[1] + 1, 0]) < 0;
    if (!ok) return false;
  }
  return true;
}

/** What the checks know besides the declaration. */
export interface CheckContext {
  /** The engine's own connectors' ids. */
  builtIns: string[];
  /** The fleet's other added connectors' ids. */
  others: string[];
  /** This engine's version. */
  version: string;
  /** The SCF ids Stolos knows (scf.ts). */
  scf: ReadonlySet<string>;
}

/** Everything wrong with a declaration, each in words (none: it may be added). */
export function declarationProblems(d: Declaration, x: CheckContext): string[] {
  const out: string[] = [];
  if (!d.sdk) {
    return [
      "its default export is not a connector made with defineConnector (@stolos/archon/connect/sdk.ts)",
    ];
  }
  if (!ID.test(d.id)) out.push(`id "${d.id}": lower case letters, digits, and hyphens, 2 to 40`);
  if (x.builtIns.includes(d.id)) out.push(`id "${d.id}" is one of the engine's own connectors`);
  if (x.others.includes(d.id)) out.push(`id "${d.id}" is already added from another source`);
  if (!d.title.trim()) out.push("it has no title");
  if (!d.engine) {
    out.push('it declares no engine range (export const engine = ">=0.112.0 <1.0.0")');
  } else {
    const ok = satisfies(x.version, d.engine);
    if (ok === undefined) out.push(`engine range "${d.engine}" is not readable (>=1.2.3 <2.0.0)`);
    else if (!ok) out.push(`it supports engine ${d.engine}; this engine is ${x.version}`);
  }
  if (!d.fields.some((f) => f.secret)) out.push("its credential has no secret field");
  for (const f of d.fields) if (!f.hint.trim()) out.push(`field ${f.name} has no hint`);
  if (!/read/i.test(d.connectHelp.join(" "))) {
    out.push("its connect steps do not say how to make a read-only credential");
  }
  const markets = new Set(MARKET_CATEGORIES.map((m) => m.id));
  for (const m of d.markets) {
    if (!markets.has(m)) out.push(`market "${m}" is not an analyst's category`);
  }
  for (const s of d.serviceModels) {
    if (!(SERVICE_MODELS as readonly string[]).includes(s)) out.push(`service model "${s}"`);
  }
  for (const o of d.ocsf) {
    if (!(o in OCSF_CLASSES)) out.push(`OCSF class "${o}" is not one Stolos emits`);
  }
  out.push(...labelProblems(d.labels));
  for (const s of d.scf) {
    if (!x.scf.has(s)) out.push(`it cites ${s}, not an SCF control Stolos knows`);
  }
  if (!d.fixtures.length) out.push("it has no fixture tests (export const fixtures = [...])");
  for (const f of d.fixtures.filter((f) => !f.ok)) {
    out.push(`fixture "${f.name}" fails: ${f.problems.join("; ")}`);
  }
  return out;
}

/**
 * A connector's labels follow the naming rules (D3FEND, OCSF, or UDM terms;
 * `schemaProblems`), and one with a built-in label's name is that label.
 */
export function labelProblems(labels: readonly ViewDef[]): string[] {
  const out: string[] = [];
  const builtIn = new Map(CONNECTOR_LABELS.map((l) => [l.name, l]));
  const fresh: ViewDef[] = [];
  for (const l of labels) {
    const b = builtIn.get(l.name);
    if (!b) fresh.push(l);
    else if (JSON.stringify(b.columns) !== JSON.stringify(l.columns)) {
      out.push(`label ${l.name} redeclares the built-in one differently: import it from labels.ts`);
    }
  }
  return [...out, ...schemaProblems(fresh).map((p) => `label ${p}`)];
}

/** `fleets/<fleet>/connectors.ts`. */
export function registryFile(fleetDir: string): string {
  return join(fleetDir, "connectors.ts");
}

const importName = (id: string) => `connector_${id.replace(/-/g, "_")}`;

/** The connectors file's TypeScript, for these entries (none: no file). */
export function registrySource(entries: readonly RegistryEntry[]): string {
  const sorted = [...entries].sort((a, b) => a.id.localeCompare(b.id));
  return `// Kept by \`stolos connector add\` and \`stolos connector remove\` (spec 088): the
// connectors this fleet adds to the engine's own. Each module is pinned to a tag or
// a commit; deno.lock holds the hash of every file it loads (as for the engine), and
// \`entries\` is Stolos's own lock entry for each. Change it only with those commands.

import type { RegistryEntry } from "@stolos/archon/connect/registry.ts";
${sorted.map((e) => `import ${importName(e.id)} from ${JSON.stringify(e.module)};`).join("\n")}

export const entries: RegistryEntry[] = ${tsLiteral(sorted)};

/** Each connector, by id. */
export const modules: Record<string, unknown> = {
${sorted.map((e) => `  ${JSON.stringify(e.id)}: ${importName(e.id)},`).join("\n")}
};
`;
}

/** The entries of a connectors file's text (read as a literal: nothing runs). */
export function registryEntries(text: string | undefined): RegistryEntry[] {
  if (!text) return [];
  return exportedLiteral(text, "entries") as RegistryEntry[];
}

/** What loading the fleet's connectors found. */
export interface Loaded {
  /** The connectors that load and suit this engine. */
  connectors: Connector[];
  /** What did not, each in words. */
  problems: string[];
}

const cache = new Map<string, Promise<Loaded>>();

/**
 * The fleet's added connectors: each entry's module, if it suits this
 * engine (its range), is a connector, and does not take an engine
 * connector's id. Loaded once per file per process.
 */
export function loadRegistry(
  fleetDir: string,
  version: string,
  builtIns: readonly string[],
): Promise<Loaded> {
  const file = registryFile(fleetDir);
  const key = `${file}\u0000${version}`;
  if (!cache.has(key)) {
    cache.set(
      key,
      (async (): Promise<Loaded> => {
        let text: string | undefined;
        try {
          text = await Deno.readTextFile(file);
        } catch {
          return { connectors: [], problems: [] };
        }
        let entries: RegistryEntry[];
        try {
          entries = registryEntries(text);
        } catch (e) {
          return { connectors: [], problems: [`${file}: ${(e as Error).message}`] };
        }
        if (!entries.length) return { connectors: [], problems: [] };
        let modules: Record<string, unknown>;
        try {
          modules = (await import(toFileUrl(file).href)).modules ?? {};
        } catch (e) {
          return {
            connectors: [],
            problems: [`${file} does not load: ${(e as Error).message.split("\n")[0]}`],
          };
        }
        const connectors: Connector[] = [];
        const problems: string[] = [];
        for (const e of entries) {
          const c = modules[e.id] as Connector | undefined;
          const fits = satisfies(version, e.engine);
          if (builtIns.includes(e.id)) problems.push(`${e.id}: takes an engine connector's id`);
          else if (!fits) {
            problems.push(
              `${e.id}: supports engine ${e.engine}, this is ${version} (deno task stolos connector test ${e.id})`,
            );
          } else if (!c || c.id !== e.id || typeof c.observe !== "function") {
            problems.push(`${e.id}: its module is not the connector it was added as`);
          } else connectors.push(c);
        }
        return { connectors, problems };
      })(),
    );
  }
  return cache.get(key)!;
}

/** Forget what was loaded (after an add or a remove, and for tests). */
export function forgetRegistry(): void {
  cache.clear();
}

/**
 * An index of connectors anyone can host (a JSON file at any URL): Stolos
 * runs no central server. `stolos connector add <id>@<tag> --index <url>`
 * reads one to find where a connector is.
 *
 * ```json
 * {
 *   "format": "stolos-connector-index/1",
 *   "connectors": [{
 *     "id": "example-scanner",
 *     "title": "Example Scanner",
 *     "source": "https://github.com/example/stolos-connector-example",
 *     "path": "mod.ts",
 *     "tags": ["v1.0.0"],
 *     "engine": ">=0.112.0 <1.0.0",
 *     "markets": ["vulnerability-assessment"]
 *   }]
 * }
 * ```
 */
export interface RegistryIndex {
  /** Always "stolos-connector-index/1". */
  format: "stolos-connector-index/1";
  /** The connectors it lists. */
  connectors: Array<{
    /** The connector's id. */
    id: string;
    /** Its name for people. */
    title: string;
    /** Its repository (`https://github.com/<owner>/<repo>`). */
    source: string;
    /** The module's path in it (default mod.ts). */
    path?: string;
    /** Its released tags. */
    tags: string[];
    /** The engine versions it supports. */
    engine?: string;
    /** Its market categories. */
    markets?: string[];
    /** One line about it. */
    description?: string;
  }>;
}

/** An index's text, checked: the index, or why not. */
export function parseIndex(text: string): RegistryIndex {
  let x: RegistryIndex;
  try {
    x = JSON.parse(text);
  } catch {
    throw new Error("the index is not JSON");
  }
  if (x?.format !== "stolos-connector-index/1" || !Array.isArray(x.connectors)) {
    throw new Error('the index is not a "stolos-connector-index/1" document');
  }
  for (const c of x.connectors) {
    if (!c || typeof c.id !== "string" || typeof c.source !== "string" || !Array.isArray(c.tags)) {
      throw new Error("each connector in the index names its id, source, and tags");
    }
  }
  return x;
}

/** `<id>@<tag>` in an index, as `<source>[/<path>]@<tag>` for {@link pinSource}. */
export function fromIndex(index: RegistryIndex, spec: string): string {
  const at = spec.lastIndexOf("@");
  const id = at < 0 ? spec : spec.slice(0, at);
  const c = index.connectors.find((x) => x.id === id);
  if (!c) throw new Error(`the index lists no connector ${id}`);
  const tag = at < 0 ? c.tags[c.tags.length - 1] : spec.slice(at + 1);
  if (!tag || !c.tags.includes(tag)) {
    throw new Error(`${id}: the index lists tags ${c.tags.join(", ") || "none"}, not ${tag}`);
  }
  return `${c.source.replace(/\/+$/, "")}${c.path ? `/${c.path}` : ""}@${tag}`;
}
