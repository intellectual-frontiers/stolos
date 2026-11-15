# 071: Official catalogs, and the fleet in OSCAL

Epic intellectual-frontiers/stolos#7; issue intellectual-frontiers/stolos#8.

## Why

Spec 068 shipped a starter mapping written by hand. An auditor asks for the frameworks' own words,
and the SCF Council already publishes how each SCF control relates to each framework (its Set Theory
Relationship Mapping, STRM). Stolos should use that, and write nothing of its own but what it
observes and how. Assessors and agencies also read OSCAL, NIST's machine-readable format, so the
evidence should leave Stolos in it.

## Requirements

- **FR-001** Stolos's own list of SCF controls (`src/archon/compliance/scf.ts`) holds only each
  control's id, SCF's name, and what Stolos looks at. Every id is SCF 2026.3's own (the starter ids
  that were wrong are corrected everywhere they are cited).
- **FR-002** `src/archon/compliance/catalog.ts` reads the SCF workbook (XLSX) as the SCF Council
  publishes it, by column header: each control's name, description, and its requirements in SOC 2
  (AICPA TSC 2017, 2022 points of focus), HIPAA (the Security Rule and the Administrative
  Simplification columns, united), PCI DSS 4.0.1, CMMC 2.0 Level 2, NIST SP 800-53 R5.2 and SP
  800-171 R3, and FedRAMP R5 Moderate. Requirement ids are written as each framework writes them (no
  "§"; CMMC's `IA.L2-3.5.3`).
- **FR-003** The workbook and NIST's OSCAL catalogs (SP 800-53 Rev 5, SP 800-171 Rev 3) are pinned
  by commit and SHA-256 and downloaded by each PC (`stolos compliance catalog [--update]`); any
  whose hash differs is refused. Stolos does not redistribute them. They are cached for every fleet
  on the PC (`P.catalogs`).
- **FR-004** The Compliance view, the command, and both consoles use the catalog. Without it, the
  frameworks say the catalog is not loaded and how to load it; with it, they cite SCF's release. SOC
  2 is shown by criterion, its points of focus folded in.
- **FR-005** `stolos compliance export [--out <dir>]` writes four OSCAL 1.2.3 JSON documents to NIST
  SP 800-53 Rev 5, each control reached through SCF's STRM: a component definition, a system
  security plan importing NIST's moderate baseline (the fleet's machines are its inventory),
  assessment results (every observation; a finding per control, satisfied or not), and a POA&M (each
  failing check an open risk; each accepted risk a deviation approved). The Stolos Console downloads
  the same.
- **FR-006** UUIDs are UUIDv5 of what they name, so machines, controls, risks, and POA&M items keep
  their UUIDs across exports.

## Success criteria

- **SC-001** `tests/compliance071_test.ts`: a fixture workbook (built with fflate) reads by header;
  a wrong hash is refused and nothing is cached; an old cache format is read again; SOC 2 by
  criterion; every OSCAL document validates against NIST's OSCAL 1.2.3 JSON schema (`vendor/oscal/`)
  with Ajv; the same input exports the same bytes.
- **SC-002** When this PC has the real catalog cached, the test checks every cited id and name
  against SCF 2026.3.

## Later

SP 800-171 Rev 3 as an OSCAL target (NIST publishes no baseline profile for it yet), FedRAMP's own
OSCAL baselines from the FedRAMP automation repository, and OSCAL assessment plans.
