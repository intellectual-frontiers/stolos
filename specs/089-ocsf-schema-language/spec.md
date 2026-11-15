# 089: OCSF core and a typed schema language

Epic intellectual-frontiers/stolos#7; issue intellectual-frontiers/stolos#26.

## Why

Integrations are Stolos's own TypeScript, need only Bun (or Node 26), and must speak the world's
standards rather than a schema of Stolos's own. One typed declaration per table, view, label, and
connector should produce everything else, so nothing drifts.

## Requirements

- **FR-001** The OCSF 1.9.0 TypeScript types are IFC TypeScript's (kernel `ocsf`, generated in
  commons from the OCSF 1.9.0 schema; required attributes are required in the types, profile
  attributes optional). `src/archon/ocsf/classes.ts` names the classes Stolos emits (5001, 5003,
  5020, 5004, 5023, 5040, 2003, 2002, 2008) by uid, caption, and category, and every object they
  use; the kernel types 5001, 5003, 5023, 2003, and 2002. `bun run ocsf` (`tools/ocsf-gen.ts`)
  writes MITRE D3FEND's artifact names (`src/archon/schema/d3fend.auto.ts`) and the JSON Schema,
  with no profiles, of each class whose events the tests validate (`vendor/ocsf/1.9.0/`). Every
  source's SHA-256 is in `src/archon/ocsf/ocsf.lock.json`; `--check` fails when a source differs.
  Run deliberately; CI does not fetch.
- **FR-002** Names come from published vocabularies only (`src/archon/schema/vocabulary.ts`):
  - physical tables in Universal Data Model terms (`person`, `party`, `fixed_asset`, ...);
  - OCSF object and class names;
  - D3FEND artifacts where OCSF has no term;
  - ISO/IEC 39075 GQL (node, edge, label);
  - ISO/IEC 22123-1 (tenant);
  - W3C PROV-O (provenance);
  - OSCAL (observation, finding).

  Every table and view cites the term each part of its name is. Names are singular lower_snake_case
  and never an SQL keyword (SQLite's, the SQL standard's, PostgreSQL's).

- **FR-003** `src/archon/schema/define.ts`: `defineTable`, `defineView`, and `defineLabel` (a typed
  view over the graph's nodes). From them:
  - `schemaSql` gives the canonical SQL, ordered by references;
  - `upsertSql` and `rowParams` give the typed upsert, checking required and allowed values;
  - `schemaDoc` gives the docs with a Mermaid ER diagram;
  - `schemaProblems` gives the naming and reference problems.
- **FR-004** `src/archon/connect/sdk.ts`: `defineConnector` with typed credential fields and
  resources (async generators mapped to a label and an OCSF class), producing the existing
  `Connector`. Every connector gets:
  - a read-only guard (GET, plus declared token endpoints);
  - Link-header and cursor paging;
  - backoff on 429 and 503 (Retry-After);
  - denials as gaps;
  - optional keeping of the vendor's record (OCSF `unmapped`);
  - bearer and OAuth 2.0 client-credentials helpers;
  - a recorded-response harness for tests.
- **FR-005** `src/archon/ocsf/finding.ts`: every piece of evidence becomes one OCSF Compliance
  Finding (2003) per SCF control, written by IFC TypeScript's kernel (`ocsf.complianceFinding`) from
  the evidence's GRC findings. The compliance object carries the standard (SCF by release), the
  control, and the framework requirements from the SCF catalog when it is on the PC. Results map as
  follows:
  - pass is compliance 1 Pass and finding 4 Resolved;
  - warn is 2 Warning and 1 New;
  - fail is 3 Fail and 1 New;
  - accepted is 3 Fail and 3 Suppressed;
  - unknown is 0 Unknown and 1 New.

  Severity is 0 Unknown: Stolos does not rate severity on its own. `stolos compliance --ocsf` prints
  them as JSON Lines.

## Success criteria

- **SC-001** `tests/schema089.test.ts` covers:
  - the generated vocabularies;
  - the naming rules (case, keywords, plurals, uncited terms);
  - a declared graph whose generated SQL runs in `node:sqlite`, whose upsert updates rather than
    duplicates, and whose label view returns typed rows;
  - row checks;
  - the ER diagram;
  - findings for every status, validated against OCSF's own JSON Schema with Ajv;
  - the read-only guard and backoff;
  - a declared connector paging by Link header, mapping to OCSF classes, keeping the vendor's
    record, and turning a 403 into a gap.

## Later

Spec 090 declares the estate graph with this language; spec 091 ports the connectors to
`defineConnector`.
