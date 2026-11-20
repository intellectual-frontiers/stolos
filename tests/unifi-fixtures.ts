/**
 * Spec 109-integrations-api FR-017: recorded responses of a UniFi controller, shaped by the pinned official document, and a real local
 * HTTPS server that serves them with a self-signed certificate (made by the real `openssl`, as the other TLS tests of this repository do).
 *
 * A fixture is made from the document: {@link sample} builds the smallest valid instance of a schema of
 * `vendor/unifi-network/10.3.58/integration.json` (its required members, with the document's own examples where it has them), a test
 * overrides the members it cares about with made-up data (documentation addresses only), and {@link fixture} checks the result against the
 * document's JSON Schema (Ajv, draft 2020-12) before the server serves it, so a fixture the document would call invalid is a failing test,
 * not a lie the connector then believes.
 *
 * @module
 */

import { fs, path, proc } from "@intellectual-frontiers/system";
import { assert, assertEquals } from "@intellectual-frontiers/commons/ts/runtime/test";
import { Ajv2020 } from "ajv/dist/2020.js";
import { serveTls, type TlsServer } from "../src/archon/access/https.ts";

/** The pinned document, read from the repository. */
export const DOC_URL = new URL("../vendor/unifi-network/10.3.58/integration.json", import.meta.url);

interface Schema {
  $ref?: string;
  type?: string;
  format?: string;
  example?: unknown;
  enum?: unknown[];
  minimum?: number;
  minItems?: number;
  properties?: Record<string, Schema>;
  required?: string[];
  items?: Schema;
  allOf?: Schema[];
  discriminator?: { propertyName: string; mapping?: Record<string, string> };
  additionalProperties?: boolean | Schema;
}

interface Doc {
  components: { schemas: Record<string, Schema> };
  paths: Record<string, Record<string, { operationId?: string }>>;
}

/** The pinned document as data. */
export function document(): Doc {
  return JSON.parse(new TextDecoder().decode(fs.readFileSync(DOC_URL))) as Doc;
}

const DOC = document();

/** The schema a name or a `$ref` stands for. */
function schemaOf(name: string): Schema {
  const s = DOC.components.schemas[name];
  if (s === undefined) throw new Error(`the document has no schema "${name}"`);
  return s;
}

let counter = 0;
/** A made-up UUID, distinct on each call (the document types its ids as `uuid`). */
export function uuid(): string {
  counter += 1;
  return `00000000-0000-4000-8000-${String(counter).padStart(12, "0")}`;
}

/** The members of a schema, through its `allOf`. */
function members(s: Schema): { props: Record<string, Schema>; required: Set<string> } {
  const props: Record<string, Schema> = {};
  const required = new Set<string>();
  for (const part of s.allOf ?? []) {
    const inner = part.$ref === undefined ? part : schemaOf(part.$ref.split("/").pop() ?? "");
    const m = members(inner);
    Object.assign(props, m.props);
    for (const r of m.required) required.add(r);
  }
  Object.assign(props, s.properties ?? {});
  for (const r of s.required ?? []) required.add(r);
  return { props, required };
}

/** The smallest valid instance of a schema: its required members, the document's examples where it has them. */
export function sample(s: Schema, depth = 0): unknown {
  if (s.$ref !== undefined) return sample(schemaOf(s.$ref.split("/").pop() ?? ""), depth);
  if (s.enum !== undefined) return s.type === "integer" ? Number(s.enum[0]) : s.enum[0];
  if (s.example !== undefined && typeof s.example !== "object") return s.example;
  if (s.allOf !== undefined || s.properties !== undefined || s.type === "object") {
    const { props, required } = members(s);
    const out: Record<string, unknown> = {};
    if (depth > 6) return out;
    for (const [k, v] of Object.entries(props)) if (required.has(k)) out[k] = sample(v, depth + 1);
    return out;
  }
  switch (s.type) {
    case "string":
      return s.format === "uuid" ? uuid() : s.format === "date-time" ? "2026-11-17T12:00:00Z" : "x";
    case "integer":
    case "number":
      return s.minimum ?? 1;
    case "boolean":
      return false;
    case "array":
      return s.minItems && s.items ? [sample(s.items, depth + 1)] : [];
    case undefined:
    default:
      return {};
  }
}

/** Deep merge of what a test says over what the document's sample is. */
function merge(base: unknown, over: unknown): unknown {
  if (
    typeof base === "object" &&
    base !== null &&
    !Array.isArray(base) &&
    typeof over === "object" &&
    over !== null &&
    !Array.isArray(over)
  ) {
    const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
    for (const [k, v] of Object.entries(over)) out[k] = merge(out[k], v);
    return out;
  }
  return over;
}

const ajv = new Ajv2020({ strict: false, validateFormats: false, allErrors: true });
ajv.addSchema({ $id: "unifi", components: DOC.components });

/**
 * An instance of the schema `name` of the document: its sample with `over` laid over it, checked against the document (an Error that
 * says what is wrong where it is not valid).
 */
export function fixture<T>(name: string, over: Record<string, unknown> = {}): T {
  const value = merge(sample(schemaOf(name)), over);
  const validate = ajv.getSchema(`unifi#/components/schemas/${name}`);
  assert(validate !== undefined, `the document has no schema "${name}"`);
  const ok = validate(value);
  // The document contradicts itself in one place no value can satisfy: its "Port PoE overview" types `type` as an integer and
  // enumerates the strings "1" to "4". Errors there are not held against a fixture.
  const errors = (validate.errors ?? []).filter(
    (e) =>
      !e.schemaPath.includes("Port PoE overview/properties/type") &&
      !(name === "Port PoE overview" && e.instancePath === "/type"),
  );
  if (!ok && errors.length > 0) {
    throw new Error(`the fixture is not a "${name}": ${JSON.stringify(errors)}`);
  }
  return value as T;
}

/** A page of the document's list shape. */
export function page(data: unknown[], o: { offset?: number; totalCount?: number } = {}): unknown {
  return {
    count: data.length,
    data,
    limit: 2,
    offset: o.offset ?? 0,
    totalCount: o.totalCount ?? data.length,
  };
}

/** A certificate and its key, made by the real openssl in a temporary folder, with the address the server listens on in its names. */
export interface Certificate {
  /** The certificate (PEM). */
  cert: string;
  /** Its key (PEM). */
  key: string;
  /** Its SHA-256 fingerprint, as openssl prints it (`AA:BB:...`). */
  fingerprint: string;
}

/** A self-signed certificate for `127.0.0.1` and `unifi.example.net`, made by openssl (`proc.run`, with a time limit). */
export async function makeCertificate(cn = "unifi.example.net"): Promise<Certificate> {
  const dir = await fs.makeTempDir({ prefix: "unifi109-cert-" });
  try {
    const made = await proc.run(
      [
        "openssl",
        "req",
        "-x509",
        "-newkey",
        "ec",
        "-pkeyopt",
        "ec_paramgen_curve:P-256",
        "-nodes",
        "-days",
        "2",
        "-subj",
        `/CN=${cn}`,
        "-addext",
        `subjectAltName=DNS:${cn},IP:127.0.0.1`,
        "-keyout",
        path.join(dir, "k.pem"),
        "-out",
        path.join(dir, "c.pem"),
      ],
      { stdout: "piped", stderr: "piped", signal: AbortSignal.timeout(60_000) },
    );
    assertEquals(made.code, 0, made.stderr);
    const fp = await proc.run(
      ["openssl", "x509", "-in", path.join(dir, "c.pem"), "-noout", "-fingerprint", "-sha256"],
      { stdout: "piped", stderr: "piped", signal: AbortSignal.timeout(60_000) },
    );
    assertEquals(fp.code, 0, fp.stderr);
    return {
      cert: await fs.readTextFile(path.join(dir, "c.pem")),
      key: await fs.readTextFile(path.join(dir, "k.pem")),
      fingerprint: fp.stdout.trim().replace(/^.*Fingerprint=/, ""),
    };
  } finally {
    await fs.remove(dir, { recursive: true });
  }
}

/** A request the controller saw. */
export interface Seen {
  /** Its method. */
  method: string;
  /** Its path and query. */
  target: string;
  /** The key it carried (`X-API-KEY`), when it carried one. */
  key: string | undefined;
}

/** What a controller answers: a status and a body, by path (without the query). */
export type Routes = Record<string, { status?: number; body?: unknown }>;

/** A running controller: the HTTPS server, what it saw, and where it is. */
export interface Controller {
  /** `https://127.0.0.1:<port>`. */
  url: string;
  /** Every request it saw, in order. */
  seen: Seen[];
  /** Stop it. */
  stop(): Promise<void>;
}

/**
 * A controller served over TLS with `certificate`, answering `routes` under `base` (a path that is not a route is a 404, and a route's
 * `status` may be 403). A list route may name `pageSize`: it answers at most that many items of a list at a time, whatever `limit` asks,
 * so that paging is exercised.
 */
export async function startController(
  certificate: Certificate,
  routes: Routes,
  base = "/proxy/network/integration",
  pageSize = 2,
): Promise<Controller> {
  const seen: Seen[] = [];
  const server: TlsServer = await serveTls(
    { hostname: "127.0.0.1", port: 0, cert: certificate.cert, key: certificate.key },
    (request) => {
      const u = new URL(request.url);
      seen.push({
        method: request.method,
        target: `${u.pathname}${u.search}`,
        key: request.headers.get("x-api-key") ?? undefined,
      });
      const route = u.pathname.startsWith(base) ? routes[u.pathname.slice(base.length)] : undefined;
      if (route === undefined) return new Response('{"message":"not found"}', { status: 404 });
      let body = route.body;
      const list = body as { data?: unknown[]; totalCount?: number } | undefined;
      if (Array.isArray(list?.data)) {
        const offset = Number(u.searchParams.get("offset") ?? 0);
        const all = list.data;
        const slice = all.slice(offset, offset + pageSize);
        body = {
          count: slice.length,
          data: slice,
          limit: pageSize,
          offset,
          totalCount: list.totalCount ?? all.length,
        };
      }
      return new Response(JSON.stringify(body ?? {}), {
        status: route.status ?? 200,
        headers: { "content-type": "application/json" },
      });
    },
  );
  return {
    url: `https://127.0.0.1:${server.addr.port}`,
    seen,
    stop: () => server.shutdown(),
  };
}
