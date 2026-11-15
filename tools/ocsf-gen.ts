// `deno task ocsf` (spec 089): TypeScript types for the OCSF classes Stolos emits,
// generated from the OCSF schema server's resolved schema at a pinned version, and
// the MITRE D3FEND artifact names (src/archon/schema/d3fend.auto.ts) that Stolos may
// use where OCSF has no term. Each response's SHA-256 is recorded in
// src/archon/ocsf/ocsf.lock.json; `deno task ocsf --check` fails when a source differs
// from the lock (a pinned OCSF version never changes; D3FEND publishes one current
// release, so a new D3FEND release is adopted by running this again). Run
// deliberately; CI does not fetch.
//
//   deno task ocsf            fetch, write types.auto.ts and the lock
//   deno task ocsf --check    fetch, and fail if anything differs from the lock

const VERSION = "1.9.0";
const BASE = `https://schema.ocsf.io/api/${VERSION}`;
/** The classes Stolos emits (spec 089), by OCSF name. */
const CLASSES = [
  "inventory_info",
  "user_inventory",
  "software_info",
  "patch_state",
  "cloud_resources_inventory_info",
  "evidence_info",
  "compliance_finding",
  "vulnerability_finding",
  "iam_analysis_finding",
];
const OUT = new URL("../src/archon/ocsf/types.auto.ts", import.meta.url);
const LOCK = new URL("../src/archon/ocsf/ocsf.lock.json", import.meta.url);
const D3FEND_URL = "https://d3fend.mitre.org/ontologies/d3fend.json";
const D3FEND_OUT = new URL("../src/archon/schema/d3fend.auto.ts", import.meta.url);

interface Attr {
  type: string;
  description?: string;
  caption?: string;
  requirement?: string;
  is_array?: boolean;
  object_type?: string;
  enum?: Record<string, { caption?: string; description?: string }>;
  profiles?: string[];
}
interface Def {
  name: string;
  caption: string;
  description?: string;
  uid?: number;
  category_uid?: number;
  attributes: Record<string, Attr>;
}

const hashes: Record<string, string> = {};
/** A URL's bytes, tried up to three times (the schema server can be slow). */
async function bytes(url: string): Promise<Uint8Array<ArrayBuffer>> {
  for (let i = 1;; i++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(180_000) });
      if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
      return new Uint8Array(await r.arrayBuffer());
    } catch (e) {
      if (i >= 3) throw e;
      console.error(`${url}: ${(e as Error).message}; trying again`);
    }
  }
}
async function get<T>(path: string): Promise<T> {
  const b = await bytes(`${BASE}/${path}`);
  hashes[path] = [...new Uint8Array(await crypto.subtle.digest("SHA-256", b))]
    .map((x) => x.toString(16).padStart(2, "0")).join("");
  return JSON.parse(new TextDecoder().decode(b)) as T;
}

const pascal = (s: string) =>
  s.split(/[^A-Za-z0-9]+/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join("");
/** OCSF descriptions as plain JSDoc text: no HTML, no em dashes, no comment terminators. */
const doc = (s = "") =>
  s.replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&").replace(/\s*[—–]\s*/g, ", ").replace(/\*\//g, "* /")
    .replace(/@/g, "(at)").replace(/\s+/g, " ").trim();
const SCALAR: Record<string, string> = {
  boolean_t: "boolean",
  float_t: "number",
  integer_t: "number",
  long_t: "number",
  port_t: "number",
  timestamp_t: "number",
  json_t: "unknown",
};

const types: Record<string, { caption: string }> = await get("data_types");
const baseOf = (t: string): string => {
  let x = t;
  for (let i = 0; i < 5 && (types[x] as { type?: string })?.type; i++) {
    x = (types[x] as unknown as { type: string }).type;
  }
  return x;
};

const objects = new Map<string, Def>();
const pending: string[] = [];
const classes: Def[] = [];
for (const c of CLASSES) classes.push(await get<Def>(`classes/${c}`));
const want = (d: Def) => {
  for (const a of Object.values(d.attributes)) {
    if (a.object_type && !a.object_type.includes("/") && !objects.has(a.object_type)) {
      if (!pending.includes(a.object_type)) pending.push(a.object_type);
    }
  }
};
classes.forEach(want);
while (pending.length) {
  const n = pending.shift()!;
  const o = await get<Def>(`objects/${n}`);
  objects.set(n, o);
  want(o);
}
const allObjects = await get<Array<{ name: string }> | Record<string, unknown>>("objects");
const objectNames =
  (Array.isArray(allObjects) ? allObjects.map((o) => o.name) : Object.keys(allObjects))
    .filter((n) => !n.includes("/")).sort();

function tsType(a: Attr): string {
  let t: string;
  if (a.type === "object_t") {
    t = a.object_type && objects.has(a.object_type)
      ? `Ocsf${pascal(a.object_type)}`
      : "Record<string, unknown>";
  } else if (a.enum && Object.keys(a.enum).length) {
    const numeric = (SCALAR[baseOf(a.type)] ?? "string") === "number";
    t = Object.keys(a.enum).sort((x, y) => numeric ? Number(x) - Number(y) : x.localeCompare(y))
      .map((k) => numeric ? k : JSON.stringify(k)).join(" | ");
  } else t = SCALAR[baseOf(a.type)] ?? "string";
  return a.is_array ? (t.includes("|") ? `Array<${t}>` : `${t}[]`) : t;
}

function iface(name: string, d: Def, extra: string[] = []): string {
  if (!extra.length && !Object.keys(d.attributes).length) {
    // An object OCSF gives no attributes of its own (it is open): any properties.
    return `/** ${doc(d.caption)}: ${
      doc(d.description)
    } */\nexport type ${name} = Record<string, unknown>;`;
  }
  const lines = [`/** ${doc(d.caption)}: ${doc(d.description)} */`, `export interface ${name} {`];
  lines.push(...extra);
  for (const [k, a] of Object.entries(d.attributes).sort(([x], [y]) => x.localeCompare(y))) {
    if (extra.some((e) => e.includes(` ${k}:`))) continue;
    const required = a.requirement === "required" && !a.profiles?.length;
    const en = a.enum && Object.keys(a.enum).length
      ? ` Values: ${Object.entries(a.enum).map(([v, e]) => `${v} ${doc(e.caption)}`).join(", ")}.`
      : "";
    lines.push(
      `  /** ${doc(a.caption)}: ${doc(a.description)}${en} (${a.requirement ?? "optional"}) */`,
      `  ${/^[a-z_][a-z0-9_]*$/.test(k) ? k : JSON.stringify(k)}${required ? "" : "?"}: ${
        tsType(a)
      };`,
    );
  }
  lines.push("}");
  return lines.join("\n");
}

const out: string[] = [
  "/**",
  ` * Spec 089: TypeScript types for the OCSF ${VERSION} classes Stolos emits, and every object`,
  " * they use, with each attribute's requirement (required fields are not optional).",
  " *",
  ` * GENERATED by \`deno task ocsf\` from the OCSF ${VERSION} schema (schema.ocsf.io); never edit`,
  " * by hand. OCSF is Apache-2.0, a Linux Foundation project.",
  " *",
  " * @module",
  " */",
  "",
  `/** The OCSF version these types are for. */`,
  `export const OCSF_VERSION = ${JSON.stringify(VERSION)};`,
  "",
  "/** The classes Stolos emits: their uid, caption, and category. */",
  `export const OCSF_CLASSES = ${
    JSON.stringify(
      Object.fromEntries(
        classes.map((
          c,
        ) => [c.name, { uid: c.uid, caption: c.caption, category_uid: c.category_uid }]),
      ),
      null,
      2,
    )
  } as const;`,
  "",
  "/** Every OCSF object name (the vocabulary Stolos names things from). */",
  `export const OCSF_OBJECT_NAMES: readonly string[] = ${JSON.stringify(objectNames)};`,
  "",
];
for (const [n, o] of [...objects].sort(([a], [b]) => a.localeCompare(b))) {
  out.push(iface(`Ocsf${pascal(n)}`, o), "");
}
for (const c of classes) {
  out.push(
    iface(`Ocsf${pascal(c.caption)}`, c, [
      `  /** The class: always ${c.uid} (${doc(c.caption)}). (required) */`,
      `  class_uid: ${c.uid};`,
      `  /** The category: always ${c.category_uid}. (required) */`,
      `  category_uid: ${c.category_uid};`,
    ]),
    "",
  );
}

// Each class's JSON Schema (draft-07), vendored for the tests (vendor/ocsf/<version>/).
const schemas: Record<string, Uint8Array<ArrayBuffer>> = {};
for (const c of CLASSES) {
  const url = `https://schema.ocsf.io/schema/${VERSION}/classes/${c}?profiles=`; // the base class, no profiles
  const b = await bytes(url);
  schemas[c] = b;
  hashes[`schema/classes/${c}`] = [...new Uint8Array(await crypto.subtle.digest("SHA-256", b))]
    .map((x) => x.toString(16).padStart(2, "0")).join("");
}

// MITRE D3FEND (MIT license): the names of its digital and physical artifact classes.
const d3Bytes = await bytes(D3FEND_URL);
const d3Sha = [...new Uint8Array(await crypto.subtle.digest("SHA-256", d3Bytes))]
  .map((x) => x.toString(16).padStart(2, "0")).join("");
type D3 = {
  "@id"?: string;
  "@type"?: string | string[];
  "rdfs:label"?: unknown;
  "rdfs:subClassOf"?: unknown;
};
const graph = (JSON.parse(new TextDecoder().decode(d3Bytes)) as { "@graph": D3[] })["@graph"];
const byId = new Map(graph.filter((x) => x["@id"]).map((x) => [x["@id"]!, x]));
const parentsOf = (x?: D3) =>
  ([] as unknown[]).concat(x?.["rdfs:subClassOf"] ?? []).flatMap((p) =>
    p && typeof p === "object" && "@id" in p ? [(p as { "@id": string })["@id"]] : []
  );
const anc = new Map<string, Set<string>>();
const ancestors = (id: string, seen = new Set<string>()): Set<string> => {
  if (anc.has(id)) return anc.get(id)!;
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
const release = (graph.find((x) => x["@type"] === "owl:Ontology") as
  | Record<string, { "@value"?: string }>
  | undefined)?.[
    "d3f:release-date"
  ]?.["@value"] ?? "unknown";
const d3Names = [
  ...new Set(
    graph.filter((x) =>
      ([] as unknown[]).concat(x["@type"] ?? []).includes("owl:Class") &&
      typeof x["rdfs:label"] === "string" && x["@id"] &&
      (ROOTS.includes(x["@id"]) || ROOTS.some((r) => ancestors(x["@id"]!).has(r)))
    ).map((x) =>
      (x["rdfs:label"] as string).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "")
    ),
  ),
].sort();
const d3Out = [
  "/**",
  " * Spec 089: the names of MITRE D3FEND's digital and physical artifact classes, in",
  " * lower_snake_case: the terms Stolos may use where OCSF has none.",
  " *",
  ` * GENERATED by \`deno task ocsf\` from MITRE D3FEND (${D3FEND_URL}, released ${release};`,
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

const lock = JSON.stringify(
  {
    version: VERSION,
    base: BASE,
    sha256: hashes,
    d3fend: { url: D3FEND_URL, release, sha256: d3Sha },
  },
  null,
  2,
) + "\n";
if (Deno.args.includes("--check")) {
  const old = await Deno.readTextFile(LOCK).catch(() => "");
  if (old !== lock) {
    console.error(`the OCSF ${VERSION} schema differs from ocsf.lock.json`);
    Deno.exit(1);
  }
  console.log(`OCSF ${VERSION}: unchanged`);
} else {
  await Deno.mkdir(new URL(".", OUT), { recursive: true });
  await Deno.writeTextFile(OUT, out.join("\n"));
  await Deno.writeTextFile(LOCK, lock);
  const dir = new URL(`../vendor/ocsf/${VERSION}/`, import.meta.url);
  await Deno.mkdir(dir, { recursive: true });
  for (const [c, b] of Object.entries(schemas)) {
    await Deno.writeFile(new URL(`${c}.schema.json`, dir), b);
  }
  await Deno.writeTextFile(
    new URL("README.md", dir),
    `# OCSF ${VERSION} class schemas\n\nJSON Schemas (draft-07) for the OCSF classes Stolos emits, from\nhttps://schema.ocsf.io/schema/${VERSION}/classes/<class>?profiles= (the base classes, with no profiles; OCSF is Apache-2.0, a Linux Foundation\nproject). Written by \`deno task ocsf\`; their SHA-256s are in src/archon/ocsf/ocsf.lock.json. The\ntests validate Stolos's OCSF output against them (spec 089); they are not shipped in the engine.\n`,
  );
  await Deno.mkdir(new URL(".", D3FEND_OUT), { recursive: true });
  await Deno.writeTextFile(D3FEND_OUT, d3Out);
  console.log(
    `OCSF ${VERSION}: ${classes.length} classes, ${objects.size} objects; D3FEND ${release}: ${d3Names.length} artifacts`,
  );
}
