/**
 * Spec 083: the auditor portal's JSON routes in the console's OpenAPI
 * document (`GET /v1/openapi.json`), under `/v1/audit/{engagement}/`. The
 * REST API's document (spec 094) adds these paths and schemas as they are.
 *
 * @module
 */

/** A JSON Schema, or an OpenAPI object, as plain JSON. */
export type Schema = Record<string, unknown>;

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const errorOf = (description: string) => ({
  description,
  content: { "application/json": { schema: ref("error") } },
});
const refusals = {
  "401": errorOf("No signed-in session, or the audit session has ended."),
  "403": errorOf("The audit session is for another engagement."),
  "404": errorOf("No such engagement, control, sample, or item."),
  "410": errorOf("The engagement's access has expired, or it was closed."),
};
const ok = (schema: Schema, description: string) => ({
  "200": { description, content: { "application/json": { schema } } },
});
const engagementParam = {
  name: "engagement",
  in: "path",
  required: true,
  description: "The engagement's id (fleets/<fleet>/audits/<id>/).",
  schema: { type: "string", pattern: "^[a-z0-9][a-z0-9-]{0,62}$" },
};
const zip = (description: string) => ({
  "200": {
    description,
    content: {
      "application/zip": { schema: { type: "string", contentMediaType: "application/zip" } },
    },
  },
});

/** The schemas the audit routes use. */
export const AUDIT_SCHEMAS: Record<string, Schema> = {
  audit_item: {
    type: "object",
    description: "An evidence bundle item: its manifest entry (spec 072).",
    properties: {
      sha256: { type: "string", description: "Its SHA-256: objects/<sha256> in the bundle." },
      kind: { type: "string" },
      name: { type: "string" },
      at: { type: "string" },
      size: { type: "integer" },
      manifest: {
        type: "object",
        description: "Its place in the signed manifest: its index and its chain link.",
        properties: { index: { type: "integer" }, chain: { type: "string" } },
      },
      href: { type: "string", description: "Where to download it." },
    },
    required: ["sha256", "kind", "name", "at", "size", "manifest"],
  },
  audit_unit: {
    type: "object",
    description: "One unit of a population, with its evidence items.",
    properties: {
      id: { type: "string" },
      label: { type: "string" },
      at: { type: "string" },
      facts: { type: "object" },
      items: { type: "array", items: { type: "string" }, description: "Evidence, by SHA-256." },
      evidence: { type: "array", items: ref("audit_item") },
    },
    required: ["id"],
  },
  audit_engagement: {
    type: "object",
    description:
      "An engagement: engagement.ts, its state, its bundle, its controls with their populations' sizes and hashes, and every problem found.",
    properties: {
      engagement: { type: "object" },
      state: { type: "string", enum: ["open", "expired", "closed"] },
      accessEnds: { type: "string" },
      commit: { type: ["string", "null"] },
      signer: { type: ["string", "null"] },
      bundle: { type: ["object", "null"] },
      controls: { type: "array", items: { type: "object" } },
      samples: { type: "array", items: { type: "object" } },
      problems: { type: "array", items: { type: "string" } },
    },
    required: ["engagement", "state", "controls", "problems"],
  },
  audit_entry: {
    type: "object",
    description:
      "A trail entry (request, response, sample, note) with the commit that vouches for it and its signer.",
    properties: {
      path: { type: "string" },
      seq: { type: "integer" },
      kind: { type: "string", enum: ["request", "response", "sample", "note"] },
      at: { type: "string" },
      by: { type: "string" },
      control: { type: "string" },
      re: { type: "integer" },
      sample: { type: "object" },
      body: { type: "string" },
      sha256: { type: "string" },
      commit: { type: ["string", "null"] },
      signer: { type: ["string", "null"] },
      problems: { type: "array", items: { type: "string" } },
    },
    required: ["path", "sha256", "problems"],
  },
};

/** The audit routes, by path. */
export const AUDIT_PATHS: Record<string, Schema> = {
  "/v1/audit/{engagement}/": {
    get: {
      operationId: "audit_engagement",
      summary: "An audit engagement",
      tags: ["audit"],
      parameters: [engagementParam],
      responses: { ...ok(ref("audit_engagement"), "The engagement."), ...refusals },
    },
  },
  "/v1/audit/{engagement}/controls/{control}": {
    get: {
      operationId: "audit_control",
      summary: "A control in scope and its population",
      description:
        "Every unit of the control's population, with its facts and its evidence items. With seed and size, also a draw preview (not recorded).",
      tags: ["audit"],
      parameters: [
        engagementParam,
        { name: "control", in: "path", required: true, schema: { type: "string" } },
        { name: "seed", in: "query", required: false, schema: { type: "string", maxLength: 256 } },
        { name: "size", in: "query", required: false, schema: { type: "integer", minimum: 1 } },
      ],
      responses: {
        ...ok({ type: "object" }, "The control and its population."),
        "400": errorOf("The seed or the size is not one."),
        ...refusals,
      },
    },
  },
  "/v1/audit/{engagement}/samples/{seq}": {
    get: {
      operationId: "audit_sample",
      summary: "A recorded sample and each unit's evidence",
      tags: ["audit"],
      parameters: [
        engagementParam,
        { name: "seq", in: "path", required: true, schema: { type: "integer", minimum: 1 } },
      ],
      responses: {
        ...ok(ref("audit_entry"), "The sample, its units, their evidence."),
        ...refusals,
      },
    },
  },
  "/v1/audit/{engagement}/items/{sha256}": {
    get: {
      operationId: "audit_item",
      summary: "An evidence item's manifest entry",
      tags: ["audit"],
      parameters: [
        engagementParam,
        {
          name: "sha256",
          in: "path",
          required: true,
          schema: { type: "string", pattern: "^[0-9a-f]{64}$" },
        },
      ],
      responses: { ...ok(ref("audit_item"), "The item."), ...refusals },
    },
  },
  "/v1/audit/{engagement}/items/{sha256}/raw": {
    get: {
      operationId: "audit_item_raw",
      summary: "Download an evidence item",
      tags: ["audit"],
      parameters: [
        engagementParam,
        {
          name: "sha256",
          in: "path",
          required: true,
          schema: { type: "string", pattern: "^[0-9a-f]{64}$" },
        },
      ],
      responses: {
        "200": {
          description: "Its bytes, as in the bundle (sha256sum gives its name).",
          content: { "application/octet-stream": { schema: { type: "string" } } },
        },
        ...refusals,
      },
    },
  },
  "/v1/audit/{engagement}/trail": {
    get: {
      operationId: "audit_trail",
      summary: "Requests, responses, and samples, in order",
      tags: ["audit"],
      parameters: [engagementParam],
      responses: {
        ...ok(
          { type: "object", properties: { entries: { type: "array", items: ref("audit_entry") } } },
          "The trail.",
        ),
        ...refusals,
      },
    },
  },
  "/v1/audit/{engagement}/verify": {
    get: {
      operationId: "audit_verify",
      summary: "verifyBundle, and every check of the engagement, run now",
      tags: ["audit"],
      parameters: [engagementParam],
      responses: { ...ok({ type: "object" }, "What the checks found."), ...refusals },
    },
  },
  "/v1/audit/{engagement}/bundle.zip": {
    get: {
      operationId: "audit_bundle",
      summary: "Download the engagement's evidence bundle",
      tags: ["audit"],
      parameters: [engagementParam],
      responses: { ...zip("The signed bundle (spec 072)."), ...refusals },
    },
  },
  "/v1/audit/{engagement}/export.zip": {
    get: {
      operationId: "audit_export",
      summary: "Download the export package, to verify offline",
      tags: ["audit"],
      parameters: [engagementParam],
      responses: { ...zip("The package (stolos audit verify)."), ...refusals },
    },
  },
};
