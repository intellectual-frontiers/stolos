/**
 * Spec 088: the connector registry. A fleet adds a connector Stolos does not
 * ship from a TypeScript module at a pinned URL (a tag or a commit). The module
 * is copied, as checked, into the fleet repository
 * (`fleets/<fleet>/connectors/<id>.ts`) and declared in
 * `fleets/<fleet>/connectors.ts` with Stolos's lock entry: where it came from,
 * the module's SHA-256, the engine versions it supports, and which engine
 * checked it and its fixtures. The engine loads the added connectors beside
 * its own (`CONNECTORS`), each only while its copy still hashes as locked.
 *
 * There is no central server: an index anyone can host is a JSON file
 * ({@link RegistryIndex}) that names connectors and their tags.
 *
 * ```mermaid
 * flowchart LR
 *   src["github.com/owner/repo @ tag"] --> url["raw.githubusercontent.com/owner/repo/tag/mod.ts"]
 *   url --> probe["probe: its own process, fixtures"] --> checks["checks: id, labels, SCF, engine range"]
 *   checks --> copy["fleets/&lt;fleet&gt;/connectors/&lt;id&gt;.ts (as checked)"]
 *   checks --> file["fleets/&lt;fleet&gt;/connectors.ts (import + entry, SHA-256)"]
 *   copy & file --> engine["the engine: CONNECTORS + these"]
 * ```
 *
 * @module
 */

import {
  array,
  compareSemVer,
  type Decoder,
  exportedLiteral,
  formatDecodeError,
  integer,
  literal,
  object,
  parseSemVer,
  type SemVer,
  string,
  tsLiteral,
} from "@intellectual-frontiers/ifc-ts/kernel";
import { fs, path } from "@intellectual-frontiers/ifc-ts/runtime";
import { schemaProblems, type ViewDef } from "../schema/define.ts";
import { OCSF_CLASSES } from "../ocsf/classes.ts";
import { type Connector, MARKET_CATEGORIES, SERVICE_MODELS } from "./connector.ts";
import { CONNECTOR_LABELS } from "./labels.ts";
import type { Declaration } from "./registry-contract.ts";

/** Stolos's own lock entry for one added connector. */
export type RegistryEntry = {
  /** Its id (unique among the engine's and the fleet's connectors). */
  id: string;
  /** Its name for people. */
  title: string;
  /** Where it was added from (`https://github.com/<owner>/<repo>[/<path>]`). */
  source: string;
  /** The tag or commit it is pinned to. */
  ref: string;
  /** The module's URL, pinned (where its copy came from). */
  module: string;
  /** The module's SHA-256 (hex), as added; its copy in the fleet repository hashes the same. */
  sha256: string;
  /** The engine versions it supports, as it declares (a range). */
  engine: string;
  /** The engine version that checked it and ran its fixtures. */
  checkedWith: string;
  /** How many fixture tests passed then. */
  fixtures: number;
  /** When it was added or moved to this ref (YYYY-MM-DD). */
  added: string;
};

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
  const [owner, repo, ...rest] = u.pathname.split("/").filter(Boolean);
  if (!owner || !repo) throw new Error(`${source}: name the repository (<host>/<owner>/<repo>)`);
  const origin = u.host === "github.com" ? "https://raw.githubusercontent.com" : u.origin;
  const file = rest.length ? rest.join("/") : "mod.ts";
  if (!/\.(ts|js|mjs)$/.test(file)) throw new Error(`${file}: a connector is a TypeScript module`);
  return { source, ref, module: `${origin}/${owner}/${repo}/${ref}/${file}` };
}

/** A version ("0.112.0", "v0.112.0"), or undefined. */
function semver(v: string): SemVer | undefined {
  const r = parseSemVer(v.trim());
  return r.kind === "ok" ? r.value : undefined;
}

/** `^w`'s upper bound: the next major, or before 1.0 the next minor. */
const caretLimit = (w: SemVer): SemVer =>
  w.major > 0
    ? { major: w.major + 1, minor: 0, patch: 0 }
    : { major: 0, minor: w.minor + 1, patch: 0 };

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
    const w = m?.[2] === undefined ? undefined : semver(m[2]);
    if (!m || !w) return undefined;
    const c = compareSemVer(v, w);
    const op = m[1] ?? "=";
    const ok =
      op === ">="
        ? c >= 0
        : op === "<="
          ? c <= 0
          : op === ">"
            ? c > 0
            : op === "<"
              ? c < 0
              : op === "="
                ? c === 0
                : c >= 0 && compareSemVer(v, caretLimit(w)) < 0;
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
      "its default export is not a connector made with defineConnector (@intellectual-frontiers/stolos/archon/connect/sdk)",
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
  return path.join(fleetDir, "connectors.ts");
}

/** An added connector's copy, relative to the fleet's folder: `connectors/<id>.ts`. */
export function copyPath(id: string): string {
  return `connectors/${id}.ts`;
}

const importName = (id: string): string => `connector_${id.replace(/-/g, "_")}`;

/** The connectors file's TypeScript, for these entries (none: no file). */
export function registrySource(entries: readonly RegistryEntry[]): string {
  const sorted = [...entries].sort((a, b) => a.id.localeCompare(b.id));
  return `// Kept by \`stolos connector add\` and \`stolos connector remove\` (spec 088): the
// connectors this fleet adds to the engine's own. Each module was fetched at a tag or a
// commit and copied to connectors/<id>.ts as it was checked; \`entries\` is Stolos's own
// lock entry for each (its SHA-256 among them). Change it only with those commands.

import type { RegistryEntry } from "@intellectual-frontiers/stolos/archon/connect/registry";
${sorted.map((e) => `import ${importName(e.id)} from ${JSON.stringify(`./${copyPath(e.id)}`)};`).join("\n")}

export const entries: RegistryEntry[] = ${tsLiteral(sorted)};

/** Each connector, by id. */
export const modules: Record<string, unknown> = {
${sorted.map((e) => `  ${JSON.stringify(e.id)}: ${importName(e.id)},`).join("\n")}
};
`;
}

const entryDecoder: Decoder<RegistryEntry> = object({
  id: string,
  title: string,
  source: string,
  ref: string,
  module: string,
  sha256: string,
  engine: string,
  checkedWith: string,
  fixtures: integer,
  added: string,
});

/** The entries of a connectors file's text (read as a literal: nothing runs). */
export function registryEntries(text: string | undefined): RegistryEntry[] {
  if (!text) return [];
  const literal = exportedLiteral(text, "entries");
  if (literal.kind === "err") {
    throw new Error(`entries: expected ${literal.error.expected} at ${literal.error.at}`);
  }
  const entries = array(entryDecoder)(literal.value, "entries");
  if (entries.kind === "err") throw new Error(formatDecodeError(entries.error));
  return [...entries.value];
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
/** An Error's message, or the thrown value as text. */
const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Whether a value is an object (a module's export map). */
const isRecord = (v: unknown): v is Readonly<Record<string, unknown>> =>
  typeof v === "object" && v !== null;

/** Whether a module's export is a connector: an id, and observe and policies to call. */
function isConnector(c: unknown): c is Connector {
  return (
    isRecord(c) &&
    typeof c["id"] === "string" &&
    typeof c["observe"] === "function" &&
    typeof c["policies"] === "function"
  );
}

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
          text = await fs.readTextFile(file);
        } catch {
          return { connectors: [], problems: [] };
        }
        let entries: RegistryEntry[];
        try {
          entries = registryEntries(text);
        } catch (e) {
          return { connectors: [], problems: [`${file}: ${messageOf(e)}`] };
        }
        if (!entries.length) return { connectors: [], problems: [] };
        // The lock: each copy must still hash as its entry says, or that connector is left out.
        const changed = new Set<string>();
        for (const e of entries) {
          const copy = path.join(fleetDir, copyPath(e.id));
          const hash = await fs.sha256File(copy).catch(() => undefined);
          if (hash !== e.sha256) changed.add(e.id);
        }
        let modules: Readonly<Record<string, unknown>>;
        try {
          const m: unknown = await import(path.toFileUrl(file).href);
          modules =
            typeof m === "object" && m !== null && "modules" in m && isRecord(m.modules)
              ? m.modules
              : {};
        } catch (e) {
          return {
            connectors: [],
            problems: [`${file} does not load: ${messageOf(e).split("\n")[0]}`],
          };
        }
        const connectors: Connector[] = [];
        const problems: string[] = [];
        for (const e of entries) {
          const c = modules[e.id];
          const fits = satisfies(version, e.engine);
          if (builtIns.includes(e.id)) problems.push(`${e.id}: takes an engine connector's id`);
          else if (changed.has(e.id)) {
            problems.push(
              `${e.id}: ${copyPath(e.id)} does not hash as connectors.ts locks it (restore it from Git, or add it again)`,
            );
          } else if (!fits) {
            problems.push(
              `${e.id}: supports engine ${e.engine}, this is ${version} (bun run stolos connector test ${e.id})`,
            );
          } else if (!isConnector(c) || c.id !== e.id) {
            problems.push(`${e.id}: its module is not the connector it was added as`);
          } else connectors.push(c);
        }
        return { connectors, problems };
      })(),
    );
  }
  return cache.get(key) ?? Promise.resolve({ connectors: [], problems: [] });
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
  connectors: ReadonlyArray<{
    /** The connector's id. */
    id: string;
    /** Its name for people. */
    title: string;
    /** Its repository (`https://github.com/<owner>/<repo>`). */
    source: string;
    /** The module's path in it (default mod.ts). */
    path?: string;
    /** Its released tags. */
    tags: readonly string[];
    /** The engine versions it supports. */
    engine?: string;
    /** Its market categories. */
    markets?: readonly string[];
    /** One line about it. */
    description?: string;
  }>;
}

const indexDecoder: Decoder<RegistryIndex> = object({
  format: literal("stolos-connector-index/1"),
  connectors: array(
    object(
      { id: string, title: string, source: string, tags: array(string) },
      { path: string, engine: string, markets: array(string), description: string },
    ),
  ),
});

/** An index's text, checked: the index, or why not. */
export function parseIndex(text: string): RegistryIndex {
  let x: unknown;
  try {
    x = JSON.parse(text);
  } catch {
    throw new Error("the index is not JSON");
  }
  if (
    !isRecord(x) ||
    x["format"] !== "stolos-connector-index/1" ||
    !Array.isArray(x["connectors"])
  ) {
    throw new Error('the index is not a "stolos-connector-index/1" document');
  }
  const index = indexDecoder(x);
  if (index.kind === "err") {
    throw new Error("each connector in the index names its id, title, source, and tags");
  }
  return index.value;
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
