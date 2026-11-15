# 090: Estate graph v2

Epic intellectual-frontiers/stolos#7; issue intellectual-frontiers/stolos#27.

## Why

Spec 085's estate graph joined four flat tables by email. Cartography's graph design shows what an
estate graph needs: tenants, typed nodes, edges with active verbs, cross-provider labels, a source
of truth for people, provenance, and history. Stolos keeps it in SQLite, declared in TypeScript
(spec 089), with history from Git, and with names only from published standards.

## Requirements

- **FR-001** The schema (`src/archon/estate/schema.ts`), declared with spec 089's language. Every
  name is cited.
  - Universal Data Model tables: `party`, `person`, `organization`, `party_role`,
    `party_relationship`, `contact_mechanism`, `party_contact_mechanism`, `fixed_asset`,
    `party_fixed_asset_assignment`.
  - Property graph tables: `tenant` (ISO/IEC 22123-1), `node`, `node_label`, `edge` (OCSF, GQL).
  - Provenance: `node_property_provenance` (W3C PROV-O).
  - Evidence: `finding` and `observation` (OCSF, OSCAL).
  - Label views: `user_account` and `code_repository` (D3FEND).
  - OCSF views: `user_inventory` (class 5003), `device`, `compliance_finding` (class 2003).
- **FR-002** People are created only by the source of truth: the first connected source in
  `fleet.ts`'s `estate.personSources` (default bamboohr, rippling, okta, microsoft, google). An
  identity provider as the source of truth contributes its non-service accounts' people. Reporting
  lines become `party_relationship`; roles become `party_role`; work emails are contact mechanisms.
- **FR-003** Accounts and repositories are nodes. `has_account` edges link a person to an account by
  work email (any case), or by `links.ts` (`basis: manual`, with who asserted it).
- **FR-004** Machines (managed hosts, adopted machines, SNMP devices, and any connector's devices)
  are fixed assets.
  - They are deduplicated by serial number, then hostname; `links.ts` (`device:<source>:<id>`)
    overrides.
  - Sources take precedence in this order: managed, then adopted, then SNMP. Each property records
    its source in `node_property_provenance`.
  - Each source's record is linked by `observed_as`, and owners by `party_fixed_asset_assignment`.
- **FR-005** History from Git:
  - first seen and last seen come from every committed version of each observation file;
  - `readSnapshot` reads the fleet as it is or at any commit, without running its code (every file
    Stolos writes is a TypeScript literal; `parseTsLiteral` reads it);
  - when an observation has gaps, the previous version's missing nodes are kept with `stale = 1`,
    and the gaps are rows of `observation`.
- **FR-006** The six cross-system policies run on the new tables (leavers, orphans,
  devices-for-people, admins-mfa, devices-encrypted, repos-protected) and write `finding` rows.
- **FR-007** Commands:
  - `estate query` takes one SELECT;
  - `estate build` writes the canonical `estate.sql` (schema plus every row, stable order) and
    `estate.auto.sqlite.db` made from it, in the PC's state directory;
  - `estate diff "<select>" --since <date|commit>` shows the rows added and removed;
  - `estate schema [--docs]` prints the SQL or the docs.

  `estate observe` points to `estate build`.

## Success criteria

- **SC-001** `tests/estate090.test.ts` covers:
  - cited names;
  - the source of truth (HR, an identity provider, the fleet's order);
  - email-case and manual links;
  - deduplicated machines with provenance and manual overrides;
  - the policies and their findings;
  - refusals;
  - stale nodes behind a gap;
  - a real Git repository read now and at a commit, with first-seen and last-seen times and a diff;
  - estate.sql reloaded elsewhere giving the same rows, and the SQLite file made from it.

## Later

Spec 091 ports the connectors to declared records (`node` rows with OCSF classes directly); spec 093
serves `estate.auto.sqlite.db` to osquery through ATC.
