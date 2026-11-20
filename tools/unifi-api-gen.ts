/**
 * `bun run unifi-api` (spec 109-integrations-api FR-009, FR-010): the TypeScript types of the UniFi Network application's local integration
 * API, generated from Ubiquiti's own OpenAPI 3.1 description (`vendor/unifi-network/<version>/integration.json`, pinned by its SHA-256 and
 * the URL it came from) into `src/archon/connect/unifi-api.auto.ts`. Nothing is typed by hand: a newer API reaches Stolos by vendoring
 * the new document, moving the pin below and running this again. The module is formatted by `bun fmt`, so this tool runs on Bun
 * (Node 26 runs it too, calling `bun fmt`).
 *
 * ```sh
 * bun run unifi-api            # check the SHA-256, write src/archon/connect/unifi-api.auto.ts
 * bun run unifi-api --check    # fail when the generated module differs from what is written
 * ```
 *
 * The document uses `allOf`, `discriminator`, `additionalProperties`, `enum`, `items`, `$ref` and formats and nothing else; any other
 * keyword of a schema stops the generator (a document that uses more is a decision, never a silent loss). An `allOf` is flattened into
 * one interface; a schema with a `discriminator` mapping becomes the union of its variants, each with the discriminating property
 * narrowed to the word the mapping gives it.
 *
 * @module
 */
// Spec: 109-integrations-api FR-009, FR-010
import { sha256 } from "@intellectual-frontiers/crypto";
import { fs, path, proc, stdio } from "@intellectual-frontiers/commons/ts/runtime";

const ROOT = path.resolve(path.dirname(path.fromFileUrl(import.meta.url)), "..");
const say = (line: string): void => {
  stdio.stderr.writeSync(`${line}\n`);
};

/** The API version this module is generated from: the newest the official CDN answers for (spec 109 Decisions). */
const VERSION = "10.3.58";
const SHA256 = "c6824fe526b0a0030153b52e117348ab651af3fc6540d8c9de73e4fab57ca0d7";
const SOURCE = `https://apidoc-cdn.ui.com/network/v${VERSION}/integration.json`;
const SRC = path.join(ROOT, `vendor/unifi-network/${VERSION}/integration.json`);
const OUT = path.join(ROOT, "src/archon/connect/unifi-api.auto.ts");

/** A schema of the document, as far as this generator reads one. */
interface Schema {
  $ref?: string;
  type?: string | string[];
  format?: string;
  description?: string;
  enum?: Array<string | number | boolean | null>;
  properties?: Record<string, Schema>;
  required?: string[];
  items?: Schema;
  allOf?: Schema[];
  additionalProperties?: boolean | Schema;
  discriminator?: { propertyName: string; mapping?: Record<string, string> };
  example?: unknown;
  default?: unknown;
  [keyword: string]: unknown;
}

interface Operation {
  operationId?: string;
  summary?: string;
  parameters?: Array<{ name: string; in: string; required?: boolean }>;
  responses?: Record<string, { content?: Record<string, { schema?: Schema }> }>;
}

interface Document {
  openapi: string;
  info: { title: string; version: string };
  servers?: Array<{ url: string }>;
  paths: Record<string, Record<string, Operation>>;
  components: { schemas: Record<string, Schema> };
}

/** The keywords of a schema this generator understands; the others stop it. */
const KNOWN = new Set([
  "$ref",
  "type",
  "format",
  "description",
  "enum",
  "properties",
  "required",
  "items",
  "allOf",
  "additionalProperties",
  "discriminator",
  "example",
  "default",
  "minimum",
  "maximum",
  "minLength",
  "maxLength",
  "minItems",
  "maxItems",
  "uniqueItems",
  "deprecated",
  "title",
]);

const bytes = await fs.readFile(SRC);
const got = await sha256(bytes);
if (got !== SHA256) {
  say(`${SRC}: SHA-256 ${got}, expected ${SHA256}: not the pinned document`);
  proc.exit(1);
}
// Ubiquiti's own document, pinned by its SHA-256 above.
const doc = JSON.parse(new TextDecoder().decode(bytes)) as Document;
if (doc.openapi !== "3.1.0" || doc.info.version !== VERSION) {
  say(
    `the document says OpenAPI ${doc.openapi}, version ${doc.info.version}; expected 3.1.0, ${VERSION}`,
  );
  proc.exit(1);
}
const SCHEMAS = doc.components.schemas;

/** A schema's name as a TypeScript type name: words joined, each starting upper case. */
function typeName(name: string): string {
  const words = name.split(/[^A-Za-z0-9]+/).filter(Boolean);
  const joined = words.map((w) => w[0]?.toUpperCase() + w.slice(1)).join("");
  return /^[0-9]/.test(joined) ? `_${joined}` : joined;
}

const NAMES = new Map<string, string>();
const taken = new Set<string>();
for (const n of Object.keys(SCHEMAS)) {
  // Two schemas that differ only in case or spacing ("IP Address selector", "IP address selector") get a number after the first.
  let t = typeName(n);
  for (let i = 2; taken.has(t); i++) t = `${typeName(n)}${i}`;
  taken.add(t);
  NAMES.set(n, t);
}

function refName(ref: string): string {
  const m = /^#\/components\/schemas\/(.+)$/.exec(ref);
  const n = m?.[1];
  if (n === undefined || !(n in SCHEMAS)) throw new Error(`unknown reference ${ref}`);
  return n;
}

function check(where: string, s: Schema): void {
  for (const k of Object.keys(s)) {
    // Specification extensions (`x-...`) are the document's own notes: ignored.
    if (!KNOWN.has(k) && !k.startsWith("x-"))
      throw new Error(`${where}: the keyword "${k}" is not one this generator reads`);
  }
}

/** Plain JSDoc text: no comment terminators, no tags, one line. */
const text = (s: string): string =>
  s
    .replace(/\*\//g, "* /")
    .replace(/@/g, "(at)")
    // "255-character" reads as a citation of a specification to the documentation check.
    .replace(/\b(\d{3})-(?=[a-z])/g, "$1 ")
    .replace(/\s+/g, " ")
    .trim();

/** Where each variant is mapped by a discriminator: its schema name to the property and the words it is named by. */
const VARIANTS = new Map<string, { property: string; words: Set<string> }>();
for (const [n, s] of Object.entries(SCHEMAS)) {
  const d = s.discriminator;
  if (d?.mapping === undefined) continue;
  for (const [word, ref] of Object.entries(d.mapping)) {
    const v = refName(ref);
    const at = VARIANTS.get(v) ?? { property: d.propertyName, words: new Set<string>() };
    if (at.property !== d.propertyName) {
      throw new Error(`${v} is mapped by "${at.property}" and by "${d.propertyName}" (in ${n})`);
    }
    at.words.add(word);
    VARIANTS.set(v, at);
  }
}

/** The members of a schema, flattened through its `allOf` (a reference's own members, then this one's). */
function flatten(s: Schema, where: string): { props: Map<string, Schema>; required: Set<string> } {
  check(where, s);
  const props = new Map<string, Schema>();
  const required = new Set<string>();
  for (const part of s.allOf ?? []) {
    const inner = part.$ref === undefined ? part : (SCHEMAS[refName(part.$ref)] ?? {});
    const f = flatten(inner, part.$ref ?? where);
    for (const [k, v] of f.props) props.set(k, v);
    for (const r of f.required) required.add(r);
  }
  for (const [k, v] of Object.entries(s.properties ?? {})) props.set(k, v);
  for (const r of s.required ?? []) required.add(r);
  return { props, required };
}

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const key = (k: string): string => (IDENT.test(k) ? k : JSON.stringify(k));
const literal = (v: string | number | boolean | null): string =>
  typeof v === "string" ? JSON.stringify(v) : String(v);

/** The TypeScript type of a schema used where a type is expected. */
function tsType(s: Schema, where: string): string {
  check(where, s);
  if (s.$ref !== undefined) return NAMES.get(refName(s.$ref)) ?? "unknown";
  if (s.allOf !== undefined) {
    const only = s.allOf.length === 1 ? s.allOf[0] : undefined;
    if (only?.$ref !== undefined && s.properties === undefined) return tsType(only, where);
    return objectType(flatten(s, where), where);
  }
  if (s.enum !== undefined) return s.enum.map(literal).join(" | ");
  const type = Array.isArray(s.type) ? s.type : s.type === undefined ? [] : [s.type];
  if (type.length > 1) return type.map((t) => tsType({ ...s, type: t }, where)).join(" | ");
  switch (type[0]) {
    case "string":
      return "string";
    case "integer":
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    case "null":
      return "null";
    case "array":
      return `Array<${s.items === undefined ? "unknown" : tsType(s.items, `${where}[]`)}>`;
    case "object":
    case undefined: {
      if (s.properties !== undefined) return objectType(flatten(s, where), where);
      if (typeof s.additionalProperties === "object") {
        return `Record<string, ${tsType(s.additionalProperties, `${where}{}`)}>`;
      }
      return type[0] === "object" ? "Record<string, unknown>" : "unknown";
    }
    default:
      throw new Error(`${where}: the type "${String(type[0])}" is not one this generator reads`);
  }
}

/** An object type of flattened members, each with its documentation. */
function objectType(
  f: { props: Map<string, Schema>; required: Set<string> },
  where: string,
): string {
  const lines: string[] = [];
  for (const [k, v] of f.props) {
    const d = v.description === undefined ? "" : `/** ${text(v.description)} */\n`;
    lines.push(`${d}${key(k)}${f.required.has(k) ? "" : "?"}: ${tsType(v, `${where}.${k}`)};`);
  }
  return `{\n${lines.join("\n")}\n}`;
}

const out: string[] = [];

/** One schema as an exported declaration. */
function declare(name: string, s: Schema): string {
  const t = NAMES.get(name) ?? typeName(name);
  const d =
    s.description === undefined
      ? `The "${name}" schema of the UniFi Network API.`
      : text(s.description);
  const where = `schema "${name}"`;
  check(where, s);
  // A discriminated base is the union of its variants.
  if (s.discriminator?.mapping !== undefined) {
    const variants = [
      ...new Set(Object.values(s.discriminator.mapping).map((r) => NAMES.get(refName(r)) ?? "")),
    ];
    return `/** ${d} One of its variants, by \`${s.discriminator.propertyName}\`. */\nexport type ${t} = ${variants.join(" | ")};\n`;
  }
  const isObject =
    s.properties !== undefined ||
    s.allOf !== undefined ||
    s.type === "object" ||
    VARIANTS.has(name);
  if (isObject && s.enum === undefined && (s.properties !== undefined || s.allOf !== undefined)) {
    const f = flatten(s, where);
    const variant = VARIANTS.get(name);
    if (variant !== undefined) {
      f.props.set(variant.property, {
        type: "string",
        enum: [...variant.words],
        description: `Always ${[...variant.words].join(" or ")} here: it names this variant.`,
      });
      f.required.add(variant.property);
    }
    return `/** ${d} */\nexport interface ${t} ${objectType(f, where)}\n`;
  }
  return `/** ${d} */\nexport type ${t} = ${tsType(s, where)};\n`;
}

for (const [name, s] of Object.entries(SCHEMAS)) out.push(declare(name, s));

/** Every operation the document offers, and the GET ones typed by path. */
const operations: Array<{ method: string; path: string; operationId: string; summary: string }> =
  [];
const gets: string[] = [];
for (const [p, methods] of Object.entries(doc.paths)) {
  for (const [method, op] of Object.entries(methods)) {
    const id = op.operationId ?? `${method} ${p}`;
    operations.push({
      method: method.toUpperCase(),
      path: p,
      operationId: id,
      summary: op.summary ?? "",
    });
    if (method !== "get") continue;
    const schema = op.responses?.["200"]?.content?.["application/json"]?.schema;
    const response = schema === undefined ? "unknown" : tsType(schema, `GET ${p}`);
    const query = (op.parameters ?? [])
      .filter((x) => x.in === "query")
      .map((x) => JSON.stringify(x.name));
    gets.push(
      `/** ${text(op.summary ?? id)} (\`${id}\`). */\n${JSON.stringify(p)}: {\nresponse: ${response};\nquery: ${query.join(" | ") || "never"};\n};`,
    );
  }
}

const j = (x: unknown): string => JSON.stringify(x, null, 2);
const module = [
  "/**",
  ` * Spec 109-integrations-api: the types of the UniFi Network application's local integration API ${VERSION}, one for each schema of`,
  " * Ubiquiti's OpenAPI 3.1 description, and the GET operations the description offers, by path.",
  " *",
  ` * GENERATED by \`bun run unifi-api\` (tools/unifi-api-gen.ts) from ${SOURCE}`,
  ` * (SHA-256 ${SHA256}), vendored in vendor/unifi-network/${VERSION}/. The description is Ubiquiti Inc.'s`,
  " * publication (see the README there). Never edit by hand.",
  " *",
  " * @module",
  " */",
  "// Spec: 109-integrations-api FR-010",
  "",
  "/** The document these types are from, and where it is. */",
  `export const UNIFI_API = ${j({
    title: doc.info.title,
    version: doc.info.version,
    openapi: doc.openapi,
    source: SOURCE,
    sha256: SHA256,
    vendored: `vendor/unifi-network/${VERSION}/integration.json`,
    servers: (doc.servers ?? []).map((s) => s.url),
  })} as const;`,
  "",
  ...out,
  "/** The GET operations of the document: for each path, its response type and the query parameters it takes. */",
  `export interface UnifiGet {\n${gets.join("\n")}\n}`,
  "",
  "/** Every operation of the document (any method), by path: what the API offers and so what Stolos may name. */",
  `export const UNIFI_OPERATIONS: readonly { method: string; path: string; operationId: string; summary: string }[] = ${j(operations)};`,
  "",
].join("\n");

/** The module as `bun fmt` writes it (the engine's bunfig.toml: width 100). */
async function formatted(source: string): Promise<string> {
  const bun = proc.runtimeName() === "bun" ? proc.execPath() : "bun";
  return fs.withTempDir(
    async (dir) => {
      const file = path.join(dir, "unifi-api.auto.ts");
      await fs.writeTextFile(file, source);
      const r = await proc.output([bun, "fmt", file], { cwd: ROOT, stdin: "null" });
      if (r.code !== 0) throw new Error("bun fmt refused the generated module");
      return fs.readTextFile(file);
    },
    { prefix: "stolos-unifi-api-" },
  );
}
const generated = await formatted(module);

if (proc.args.includes("--check")) {
  const old = (await fs.readTextOr(OUT)) ?? "";
  if (old !== generated) {
    say(`${OUT} is stale: bun run unifi-api`);
    proc.exit(1);
  }
  say(`UniFi Network ${VERSION}: unchanged`);
} else {
  await fs.writeTextFile(OUT, generated);
  say(
    `UniFi Network ${VERSION}: ${Object.keys(SCHEMAS).length} schemas, ${gets.length} GET operations of ${operations.length}`,
  );
}
