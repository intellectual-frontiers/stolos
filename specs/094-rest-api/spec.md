# 094: a read-only REST API for estate data

Issue intellectual-frontiers/stolos#31.

## Why

The estate graph (spec 090) answers SQL in the terminal, and the Stolos Console shows it to a
person. Scripts and tools on the operator's PC (a spreadsheet's import, a notebook, an assessor's
tool) need the same data as JSON, with a contract they can read: an OpenAPI 3.1 document. That
document must come from the same TypeScript declarations as the SQL (spec 089), so it cannot drift.

## Requirements

- **FR-001** Routes under `/v1/` in the Stolos Console's server only (`src/archon/api/`, mounted by
  `src/archon/console/stolos-server.ts`), never the Archon Console on servers. No new listener: the
  console stays on 127.0.0.1, with its Host check.
  - `GET /v1/` lists the resources; `GET /v1/openapi.json` is the OpenAPI 3.1 document.
  - `GET /v1/<table or view>` for every table and view in `ESTATE_SCHEMA`: `?limit` (default 100, 1
    to 1000), `?offset`, and equality filters on declared columns (`?status=active`). Names in the
    SQL come only from the declarations; values are bound parameters. The answer is
    `{ items, limit, offset, total }`. A bad parameter is 400 with the reason; an unknown name is
    404.
  - `GET /v1/finding` also as OCSF Compliance Findings (spec 089's mapping) with
    `Accept: application/vnd.ocsf+json` or `?format=ocsf` (`?format=json` wins over Accept).
  - `GET /v1/oscal/<document>`: the four OSCAL documents of spec 071 (`component-definition`,
    `system-security-plan`, `assessment-results`, `poam`); 404 with the reason when the SCF catalog
    is not on the PC.
  - `GET /v1/evidence/` lists the evidence bundles (spec 072) in the PC's state directory;
    `GET /v1/evidence/<bundle>` downloads one. A name is letters, digits, `.`, `-`, `_`, ending in
    `.zip`, not starting with a dot (else 400); only regular files listed in that directory are
    served (no links, no traversal).
- **FR-002** Read-only: any method but GET and HEAD is 405 (`Allow: GET, HEAD`).
- **FR-003** Authentication is the console's signed-in session (the launch link's cookie). The
  console has no token model, so there is no bearer access: a request without the session is 401
  (JSON), and the docs say the API is for the session and local tools using its cookie.
- **FR-004** The OpenAPI document is generated from `ESTATE_SCHEMA`: one path per table and view;
  row schemas from the declared column types (text to string, integer to integer, real to number,
  boolean to boolean, json to object), nullable unless required or a key, the column docs as
  descriptions, declared values as `enum`; plus the other routes, the session cookie as an `apiKey`
  security scheme, and error responses.
- **FR-005** Views may declare a column's type (`{ type, doc, required?, values? }`); a column given
  only as its doc is text. Label views carry their properties' types. `device.is_encrypted` and
  `device.is_managed` are booleans; the API returns booleans (stored 0 and 1) as `true` and `false`,
  and JSON columns as objects.
- **FR-006** Docs: a REST section in the Console guide (`src/archon/console/mod.ts`) with a `curl`
  example using the session cookie, and a card on the console's How it works page.

## Decisions

- The OpenAPI 3.1 JSON Schema is vendored from OAI/OpenAPI-Specification, release tag
  `3.1.0-schemas` (`schemas/v3.1/schema.json`, schema version 2022-10-07, Apache-2.0), under
  `vendor/openapi/3.1/`, for the tests only. Ajv resolves `$dynamicAnchor` only at a resource's
  root, so the test replaces the schema's one `$dynamicRef: "#meta"` target with a static `$ref` to
  the same definition in memory; the file stays unchanged.
- Out-of-range paging is refused (400), not clamped, so a client learns its mistake.
- The real console builds the estate graph (with its findings) at most once a minute.

## Success criteria

- `tests/api094_test.ts`: the document validates against the official schema; every route's answer
  validates against its schema in the document; filters, paging, and bound values; booleans as
  booleans; 401 without a session; 405 for other methods; 404 for unknown resources; path traversal
  refused; OCSF findings valid against OCSF 1.9.0's class schema.
- `tests/console066_test.ts` passes, with the API routes in its list of pages.
