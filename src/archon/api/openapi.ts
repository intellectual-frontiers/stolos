/**
 * Spec 094: the REST API's OpenAPI 3.1 document, generated from the estate
 * schema's declarations (the same ones the SQL views come from), so the
 * document cannot drift from what the API serves. Each table and view is one
 * path; its row schema comes from the declared column types, its column docs
 * become descriptions, and declared values become an `enum`.
 *
 * ```mermaid
 * flowchart LR
 *   decl["ESTATE_SCHEMA (defineTable, defineView, defineLabel)"] --> sql["SQL tables and views"]
 *   decl --> res["RESOURCES: typed columns"]
 *   res --> api["GET /v1/&lt;name&gt;"]
 *   res --> doc["GET /v1/openapi.json"]
 * ```
 *
 * @module
 */

import { VERSION } from "../version.ts";
import type { ColumnType, TypedColumn } from "../schema/define.ts";
import { DEFAULT_LIMIT, MAX_LIMIT, type Resource, RESOURCES } from "./resources.ts";
import { AUDIT_PATHS, AUDIT_SCHEMAS } from "../audit/openapi.ts";

/** The OSCAL documents (spec 071) the API serves, by name. */
export const OSCAL_DOCUMENTS: readonly string[] = [
  "component-definition",
  "system-security-plan",
  "assessment-results",
  "poam",
];

/** The media type a client asks for to get findings as OCSF Compliance Findings. */
export const OCSF_MEDIA_TYPE = "application/vnd.ocsf+json";

/** The session cookie's name (the Stolos Console's). */
export const SESSION_COOKIE = "stolos_session";

/** A JSON Schema, or an OpenAPI object, as plain JSON. */
export type Schema = Record<string, unknown>;

const JSON_TYPE: Record<ColumnType, string> = {
  text: "string",
  integer: "integer",
  real: "number",
  boolean: "boolean",
  json: "object",
};

/** A column's JSON Schema: its type (with null unless it is never null), its doc, its values. */
export function columnSchema(c: TypedColumn): Schema {
  const t = JSON_TYPE[c.type];
  return {
    type: c.required ? t : [t, "null"],
    description: c.doc,
    ...(c.values ? { enum: c.required ? [...c.values] : [...c.values, null] } : {}),
  };
}

/** A resource's row schema. */
export function rowSchema(r: Resource): Schema {
  return {
    type: "object",
    description: r.doc,
    properties: Object.fromEntries(r.columns.map((c) => [c.name, columnSchema(c)])),
    required: r.columns.map((c) => c.name),
    additionalProperties: false,
  };
}

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });

/** A page of some item schema. */
function pageSchema(item: Schema, what: string): Schema {
  return {
    type: "object",
    description: `A page of ${what}.`,
    properties: {
      items: { type: "array", items: item },
      limit: { type: "integer", minimum: 1, maximum: MAX_LIMIT, description: "The page size." },
      offset: { type: "integer", minimum: 0, description: "Rows skipped before this page." },
      total: { type: "integer", minimum: 0, description: "Rows that match, across every page." },
    },
    required: ["items", "limit", "offset", "total"],
    additionalProperties: false,
  };
}

const json = (schema: Schema, description: string) => ({
  description,
  content: { "application/json": { schema } },
});

const errors = (...codes: number[]) =>
  Object.fromEntries(codes.map((c) => [String(c), { $ref: `#/components/responses/e${c}` }]));

/** A filter parameter for a column (JSON columns are not filterable). */
function filterParam(c: TypedColumn): Schema {
  const base = c.type === "boolean"
    ? { type: "boolean" }
    : c.type === "integer"
    ? { type: "integer" }
    : c.type === "real"
    ? { type: "number" }
    : { type: "string", ...(c.values ? { enum: [...c.values] } : {}) };
  return {
    name: c.name,
    in: "query",
    required: false,
    description: `Only rows whose ${c.name} equals this. ${c.doc}`,
    schema: base,
  };
}

function listOperation(r: Resource): Schema {
  const isFinding = r.name === "finding";
  const ok: Schema = {
    description: `A page of ${r.name} rows${
      isFinding
        ? `, or of OCSF Compliance Findings (?format=ocsf or Accept: ${OCSF_MEDIA_TYPE})`
        : ""
    }.`,
    content: {
      "application/json": { schema: ref(`${r.name}_page`) },
      ...(isFinding ? { [OCSF_MEDIA_TYPE]: { schema: ref("ocsf_compliance_finding_page") } } : {}),
    },
  };
  return {
    operationId: `list_${r.name}`,
    summary: `${r.kind === "table" ? "Table" : "View"} ${r.name}`,
    description: r.doc,
    tags: [r.kind === "table" ? "tables" : "views"],
    parameters: [
      { $ref: "#/components/parameters/limit" },
      { $ref: "#/components/parameters/offset" },
      ...(isFinding ? [{ $ref: "#/components/parameters/format" }] : []),
      ...r.columns.filter((c) => c.type !== "json").map(filterParam),
    ],
    responses: { "200": ok, ...errors(400, 401, 500) },
  };
}

/** The OpenAPI 3.1 document for the REST API. */
export function openApiDocument(o: { port?: number; version?: string } = {}): Schema {
  const schemas: Record<string, Schema> = {
    error: {
      type: "object",
      description: "Why a request was not answered.",
      properties: { error: { type: "string", description: "Why, in plain words." } },
      required: ["error"],
      additionalProperties: false,
    },
    index: {
      type: "object",
      description: "What the API serves.",
      properties: {
        version: { type: "string", description: "The Stolos engine's version." },
        openapi: { type: "string", description: "The OpenAPI document's path." },
        resources: {
          type: "array",
          description: "Every estate table and view.",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              kind: { type: "string", enum: ["table", "view"] },
              doc: { type: "string" },
              href: { type: "string" },
            },
            required: ["name", "kind", "doc", "href"],
            additionalProperties: false,
          },
        },
        oscal: {
          type: "array",
          description: "The OSCAL documents.",
          items: { type: "string" },
        },
        evidence: { type: "string", description: "The evidence bundles' path." },
      },
      required: ["version", "openapi", "resources", "oscal", "evidence"],
      additionalProperties: false,
    },
    evidence_bundle: {
      type: "object",
      description:
        "A signed evidence bundle (spec 072) in this PC's state directory, written by stolos evidence export.",
      properties: {
        name: { type: "string", description: "Its file name." },
        size: { type: "integer", minimum: 0, description: "Its size in bytes." },
        modified: {
          type: ["string", "null"],
          description: "When it was written (ISO time), when known.",
        },
        href: { type: "string", description: "Where to download it." },
      },
      required: ["name", "size", "modified", "href"],
      additionalProperties: false,
    },
    evidence_bundle_page: pageSchema(ref("evidence_bundle"), "evidence bundles"),
    ocsf_compliance_finding: {
      type: "object",
      description:
        "An OCSF 1.9.0 Compliance Finding (class 2003), one per finding row (spec 089's mapping).",
      externalDocs: { url: "https://schema.ocsf.io/1.9.0/classes/compliance_finding" },
      properties: {
        class_uid: { const: 2003 },
        category_uid: { const: 2 },
      },
      required: ["class_uid", "category_uid", "finding_info", "compliance", "metadata", "time"],
    },
    ocsf_compliance_finding_page: pageSchema(
      ref("ocsf_compliance_finding"),
      "OCSF Compliance Findings",
    ),
    oscal_document: {
      type: "object",
      description: "An OSCAL 1.2 document (spec 071), for an assessor's tools.",
      externalDocs: { url: "https://pages.nist.gov/OSCAL/" },
      minProperties: 1,
    },
  };
  const paths: Record<string, Schema> = {
    "/v1/": {
      get: {
        operationId: "index",
        summary: "What the API serves",
        tags: ["meta"],
        responses: { "200": json(ref("index"), "The resources."), ...errors(401) },
      },
    },
    "/v1/openapi.json": {
      get: {
        operationId: "openapi",
        summary: "This document",
        tags: ["meta"],
        responses: {
          "200": json({ type: "object" }, "The OpenAPI 3.1 document."),
          ...errors(401),
        },
      },
    },
  };
  for (const r of RESOURCES) {
    schemas[r.name] = rowSchema(r);
    schemas[`${r.name}_page`] = pageSchema(ref(r.name), `${r.name} rows`);
    paths[`/v1/${r.name}`] = { get: listOperation(r) };
  }
  paths["/v1/oscal/{document}"] = {
    get: {
      operationId: "oscal",
      summary: "An OSCAL document",
      description:
        "The fleet's OSCAL component definition, system security plan, assessment results, or POA&M (spec 071). They need the SCF catalog on this PC (stolos compliance --download).",
      tags: ["compliance"],
      parameters: [{
        name: "document",
        in: "path",
        required: true,
        schema: { type: "string", enum: [...OSCAL_DOCUMENTS] },
      }],
      responses: {
        "200": json(ref("oscal_document"), "The document."),
        ...errors(401, 404),
      },
    },
  };
  paths["/v1/evidence/"] = {
    get: {
      operationId: "evidence_bundles",
      summary: "The evidence bundles on this PC",
      tags: ["compliance"],
      parameters: [
        { $ref: "#/components/parameters/limit" },
        { $ref: "#/components/parameters/offset" },
      ],
      responses: {
        "200": json(ref("evidence_bundle_page"), "The bundles, newest first."),
        ...errors(400, 401),
      },
    },
  };
  paths["/v1/evidence/{bundle}"] = {
    get: {
      operationId: "evidence_bundle",
      summary: "Download an evidence bundle",
      description: "The signed ZIP; check it with stolos evidence verify.",
      tags: ["compliance"],
      parameters: [{
        name: "bundle",
        in: "path",
        required: true,
        description: "Its file name (letters, digits, dot, dash, underscore; ends in .zip).",
        schema: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*\\.zip$" },
      }],
      responses: {
        "200": {
          description: "The bundle.",
          content: {
            "application/zip": { schema: { type: "string", contentMediaType: "application/zip" } },
          },
        },
        ...errors(400, 401, 404),
      },
    },
  };
  // Spec 083: the auditor portal's JSON routes.
  Object.assign(paths, AUDIT_PATHS);
  Object.assign(schemas, AUDIT_SCHEMAS);
  const errorResponse = (d: string) => json(ref("error"), d);
  return {
    openapi: "3.1.0",
    info: {
      title: "Stolos estate API",
      version: o.version ?? VERSION,
      summary: "Read-only estate data, on this PC, through the Stolos Console.",
      description:
        "Every estate table and view (spec 090), the findings also as OCSF Compliance Findings, the OSCAL documents (spec 071), and the evidence bundles (spec 072). It answers only on 127.0.0.1, only GET and HEAD, and only for the console's signed-in session (its cookie). Generated from the estate schema's declarations (spec 094).",
    },
    servers: [{
      url: "http://127.0.0.1:{port}",
      description: "The Stolos Console on this PC.",
      variables: { port: { default: String(o.port ?? 8091) } },
    }],
    security: [{ session: [] }],
    tags: [
      { name: "meta", description: "The API itself." },
      {
        name: "tables",
        description: "The estate's tables (Universal Data Model, property graph).",
      },
      { name: "views", description: "The estate's views (OCSF and D3FEND names)." },
      { name: "compliance", description: "OSCAL documents and evidence bundles." },
      { name: "audit", description: "The auditor portal (spec 083): one engagement's routes." },
    ],
    paths,
    components: {
      schemas,
      parameters: {
        limit: {
          name: "limit",
          in: "query",
          required: false,
          description: `Rows per page (default ${DEFAULT_LIMIT}, at most ${MAX_LIMIT}).`,
          schema: { type: "integer", minimum: 1, maximum: MAX_LIMIT, default: DEFAULT_LIMIT },
        },
        offset: {
          name: "offset",
          in: "query",
          required: false,
          description: "Rows to skip.",
          schema: { type: "integer", minimum: 0, default: 0 },
        },
        format: {
          name: "format",
          in: "query",
          required: false,
          description:
            `ocsf: the findings as OCSF Compliance Findings (as Accept: ${OCSF_MEDIA_TYPE}).`,
          schema: { type: "string", enum: ["json", "ocsf"], default: "json" },
        },
      },
      responses: {
        e400: errorResponse("The request's parameters are not ones this resource takes."),
        e401: errorResponse(
          "No signed-in console session: open the launch link `deno task stolos console` prints.",
        ),
        e404: errorResponse("No such resource."),
        e500: errorResponse(
          "The estate could not be read (the console's terminal has the details).",
        ),
      },
      securitySchemes: {
        session: {
          type: "apiKey",
          in: "cookie",
          name: SESSION_COOKIE,
          description:
            "The Stolos Console's session cookie, set by its one-time launch link. Local tools may send it (curl --cookie).",
        },
      },
    },
  };
}
