/**
 * `bun run ocsf` (spec 089): what Stolos still takes from the OCSF and D3FEND publications itself.
 * The OCSF 1.9.0 TypeScript types are IFC TypeScript's (kernel `ocsf`, generated in commons), so
 * this tool no longer writes any; it writes:
 *
 * - the JSON Schema (draft-07) of each OCSF class whose events the tests validate with Ajv, the
 *   base class with no profiles, into `vendor/ocsf/1.9.0/` (not shipped in the engine);
 * - MITRE D3FEND's digital and physical artifact names (`src/archon/schema/d3fend.auto.ts`), the
 *   terms Stolos may use where OCSF has none.
 *
 * Each source's SHA-256 is recorded in `src/archon/ocsf/ocsf.lock.json`; `--check` fetches again
 * and fails when a source differs from the lock (a pinned OCSF version never changes; D3FEND
 * publishes one current release, so a new D3FEND release is adopted by running this again). Run
 * deliberately; CI does not fetch.
 *
 * ```sh
 * bun run ocsf            # fetch, write the schemas, the D3FEND names and the lock
 * bun run ocsf --check    # fetch, and fail if anything differs from the lock
 * ```
 *
 * @module
 */
import { sha256 } from "@intellectual-frontiers/crypto";
import { fs, path, proc, stdio, toError } from "@intellectual-frontiers/commons/ts/runtime";

const ROOT = path.resolve(path.dirname(path.fromFileUrl(import.meta.url)), "..");
const VERSION = "1.9.0";
/** The classes whose events the tests validate against OCSF's own schema. */
const CLASSES = [
  "inventory_info",
  "user_inventory",
  "cloud_resources_inventory_info",
  "compliance_finding",
  "vulnerability_finding",
] as const;
const LOCK = path.join(ROOT, "src/archon/ocsf/ocsf.lock.json");
const SCHEMAS = path.join(ROOT, `vendor/ocsf/${VERSION}`);
const D3FEND_URL = "https://d3fend.mitre.org/ontologies/d3fend.json";
const D3FEND_OUT = path.join(ROOT, "src/archon/schema/d3fend.auto.ts");

const say = (line: string): void => {
  stdio.stderr.writeSync(`${line}\n`);
};

/** A URL's bytes, tried up to three times (the schema server can be slow). */
async function bytes(url: string): Promise<Uint8Array> {
  for (let i = 1; ; i++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(180_000) });
      if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
      return new Uint8Array(await r.arrayBuffer());
    } catch (e) {
      if (i >= 3) throw e;
      say(`${url}: ${toError(e).message}; trying again`);
    }
  }
}

const hashes: Record<string, string> = {};
const schemas = new Map<string, Uint8Array>();
for (const c of CLASSES) {
  const b = await bytes(`https://schema.ocsf.io/schema/${VERSION}/classes/${c}?profiles=`);
  schemas.set(c, b);
  hashes[`schema/classes/${c}`] = await sha256(b);
}

// MITRE D3FEND (MIT license): the names of its digital and physical artifact classes.
const d3Bytes = await bytes(D3FEND_URL);
const d3Sha = await sha256(d3Bytes);
type D3 = {
  readonly "@id"?: string;
  readonly "@type"?: string | readonly string[];
  readonly "rdfs:label"?: unknown;
  readonly "rdfs:subClassOf"?: unknown;
  readonly "d3f:release-date"?: { readonly "@value"?: string };
};
const parsed: unknown = JSON.parse(new TextDecoder().decode(d3Bytes));
const graph: readonly D3[] =
  typeof parsed === "object" &&
  parsed !== null &&
  "@graph" in parsed &&
  Array.isArray(parsed["@graph"])
    ? (parsed["@graph"] as D3[])
    : [];
const byId = new Map(graph.flatMap((x) => (x["@id"] ? [[x["@id"], x] as const] : [])));
const listOf = (v: unknown): readonly unknown[] =>
  Array.isArray(v) ? v : v === undefined ? [] : [v];
const parentsOf = (x: D3 | undefined): readonly string[] =>
  listOf(x?.["rdfs:subClassOf"]).flatMap((p) =>
    p && typeof p === "object" && "@id" in p && typeof p["@id"] === "string" ? [p["@id"]] : [],
  );
const anc = new Map<string, Set<string>>();
const ancestors = (id: string, seen = new Set<string>()): Set<string> => {
  const known = anc.get(id);
  if (known) return known;
  const out = new Set<string>();
  for (const p of parentsOf(byId.get(id))) {
    if (seen.has(p)) continue;
    seen.add(p);
    out.add(p);
    for (const q of ancestors(p, seen)) out.add(q);
  }
  anc.set(id, out);
  return out;
};
const ROOTS = ["d3f:DigitalArtifact", "d3f:PhysicalArtifact"];
const release =
  graph.find((x) => x["@type"] === "owl:Ontology")?.["d3f:release-date"]?.["@value"] ?? "unknown";
const d3Names = [
  ...new Set(
    graph.flatMap((x) => {
      const id = x["@id"];
      const label = x["rdfs:label"];
      const isClass = listOf(x["@type"]).includes("owl:Class");
      if (!isClass || typeof label !== "string" || !id) return [];
      if (!ROOTS.includes(id) && !ROOTS.some((r) => ancestors(id).has(r))) return [];
      return [
        label
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "_")
          .replace(/^_|_$/g, ""),
      ];
    }),
  ),
].sort();
const d3Out = [
  "/**",
  " * Spec 089: the names of MITRE D3FEND's digital and physical artifact classes, in",
  " * lower_snake_case: the terms Stolos may use where OCSF has none.",
  " *",
  ` * GENERATED by \`bun run ocsf\` from MITRE D3FEND (${D3FEND_URL}, released ${release};`,
  " * MIT license). Never edit by hand.",
  " *",
  " * @module",
  " */",
  "",
  "/** The D3FEND release these names are from. */",
  `export const D3FEND_RELEASE = ${JSON.stringify(release)};`,
  "",
  "/** D3FEND artifact names, lower_snake_case. */",
  `export const D3FEND_ARTIFACTS: readonly string[] = ${JSON.stringify(d3Names)};`,
  "",
].join("\n");

const lock = `${JSON.stringify(
  { version: VERSION, sha256: hashes, d3fend: { url: D3FEND_URL, release, sha256: d3Sha } },
  null,
  2,
)}\n`;
if (proc.args.includes("--check")) {
  const old = (await fs.readTextOr(LOCK)) ?? "";
  if (old !== lock) {
    say(`the OCSF ${VERSION} schemas or D3FEND differ from ocsf.lock.json`);
    proc.exit(1);
  }
  say(`OCSF ${VERSION} and D3FEND ${release}: unchanged`);
} else {
  await fs.writeTextFile(LOCK, lock);
  await fs.mkdir(SCHEMAS, { recursive: true });
  for (const [c, b] of schemas) await fs.writeFile(path.join(SCHEMAS, `${c}.schema.json`), b);
  await fs.writeTextFile(
    path.join(SCHEMAS, "README.md"),
    `# OCSF ${VERSION} class schemas\n\nJSON Schemas (draft-07) for the OCSF classes whose events Stolos's tests validate, from\nhttps://schema.ocsf.io/schema/${VERSION}/classes/<class>?profiles= (the base classes, with no profiles; OCSF is Apache-2.0, a Linux Foundation\nproject). Written by \`bun run ocsf\`; their SHA-256s are in src/archon/ocsf/ocsf.lock.json. The\ntests validate Stolos's OCSF output against them (spec 089); they are not shipped in the engine.\n`,
  );
  await fs.mkdir(path.dirname(D3FEND_OUT), { recursive: true });
  await fs.writeTextFile(D3FEND_OUT, d3Out);
  say(
    `OCSF ${VERSION}: ${schemas.size} class schemas; D3FEND ${release}: ${d3Names.length} artifacts`,
  );
}
