# 076: FedRAMP 20x Key Security Indicators, and the Class A and B package

Issue intellectual-frontiers/stolos#16.

## Why

FedRAMP 20x is the realistic route for a small cloud vendor into federal work. It asks for Key
Security Indicators (KSI) shown persistently, with automation, rather than a document per control,
and it publishes its rules as machine-readable data. Stolos already observes much of what the KSIs
ask; it should say, KSI by KSI, what it shows and what it cannot, and write the package FedRAMP asks
for in FedRAMP's own format.

## Sources (official, pinned)

- The FedRAMP Consolidated Rules for 2026, release 2026.11.02.01: `FedRAMP/rules` at commit
  `64fa769510416fa75fd00a4689466094265b8083`, `fedramp-consolidated-rules.json` (SHA-256
  `782faecae3eee4aa2aa9d32cdb0de4c929524f2e41dc1f3d143a94a9ca64c4e3`) and its JSON Schema.
- FedRAMP's JSON Schemas: `FedRAMP/schemas` at commit `8fe79fa5bb1b3ac6d5d5f636f4032cc5c56ea59c`:
  the Security Decision Record schema (`fedramp-security-decision-record-schema-2026-06-24.json`,
  version 1.1.1), which `SDR-CSO-FRR`, `SDR-CSX-KSI`, and `SDR-CSX-KMT` name, and the common
  definitions it references.

Both are vendored in `vendor/fedramp/2026.11.02.01/` with a README (URLs, commits, hashes). They
state no license; they are works of the United States Government (17 U.S.C. 105).

## Requirements

- **FR-001** `tools/fedramp-gen.ts` (`bun run fedramp`) checks the vendored rules' SHA-256 and
  generates `src/archon/fedramp/rules.auto.ts`: every KSI (id, theme, name, statement, its statement
  per class, the classes FedRAMP marks it optional for, its SP 800-53 controls), the Class A KSIs
  (parsed from `FRC-CLA-MFR`), and for Class A and B the rules `FRC-CSX-VVK` (automation, with its
  minimum methods), `VDR-TFR-MVX` (machine validation cadence), `CPO-CSX-CPM` (package maintenance
  cadence), `SDR-CSX-KMT` (metrics), and `SDR-CSX-KSI`. No list is typed by hand; `--check` fails
  when the module is stale.
- **FR-002** `src/archon/fedramp/mapping.ts` maps every KSI exactly once (a record over FedRAMP's
  KSI ids): either the SCF controls of the Stolos checks that give evidence for it (optionally
  limited to some sources of evidence), with a plain-words reason; or not observable (a process, a
  document, a contract, or not read), with the reason. That is the only mapping Stolos writes. Where
  the SCF Council's STRM links a cited SCF control to one of the KSI's own SP 800-53 controls,
  `strmLinks` shows it (with the catalog loaded).
- **FR-003** `src/archon/fedramp/package.ts` builds the package for Class A (the seven KSIs of
  `FRC-CLA-MFR`) or Class B (every KSI, the five FedRAMP marks optional for B flagged): each KSI's
  status from its evidence, its automated tests, its evidence with when each was observed, and
  whether that is within the class's machine validation cadence; and the Security Decision Record
  (`certificationPackageOverviewUri`, `metadata`, `fedRampRequirements` for `SDR-CSX-KSI`,
  `FRC-CSX-VVK`, `VDR-TFR-MVX`, `CPO-CSX-CPM`, `SDR-CSX-KMT`, and `keySecurityIndicators`), valid
  against FedRAMP's schema. A KSI Stolos cannot observe has no status and says why, so the provider
  supplies it. Assessment statements are left to the independent assessor.
- **FR-004** Observation times: `Evidence.observedAt` when present (spec 073 may add it), otherwise
  the times the Stolos Console knows (`evidenceObservedAt`: an adopted machine's or device's probe,
  a cloud's observation, the estate's newest cloud observation, a managed server's last pull, apply,
  or install, the repository's newest commit).
- **FR-005** `stolos compliance fedramp [--class A|B] [--out <file>] [--overview <uri>]` (tier read,
  on the PC; offered in the Stolos Console, not over MCP since `--out` writes a file) prints each
  KSI's status, writes the record with `--out`, prints the whole package with `--json`, and exits 1
  when a KSI's checks fail. Without `--overview` the record names a placeholder URI
  (`urn:stolos:fleet:<id>:certification-package-overview`) and says so.
- **FR-006** The compliance guide (`src/archon/compliance/mod.ts`) explains FedRAMP 20x, with a
  diagram.

## Success criteria

- **SC-001** `tests/fedramp076.test.ts`: the vendored files match their recorded SHA-256s; the rules
  validate against FedRAMP's own schema; the generated module is fresh; every official KSI (read
  from the vendored JSON, not the generated module) appears exactly once, covered or not observable
  with a reason; Class A is exactly `FRC-CLA-MFR`'s KSIs and Class B every KSI with FedRAMP's
  optional ones; the cadences per class are the rules'; both packages validate with Ajv (draft
  2020-12, formats checked) against the vendored SDR schema; evidence ten days old meets Class A's
  monthly validation and not Class B's 7 days.

## Decisions

- Class B is the default class (it is the superset); Class A is `--class A`.
- Classes C and D are out of scope (Stolos writes what A and B ask).
- The Compliance page is unchanged here (spec 073 is changing it); the command is offered in the
  Stolos Console's group with `compliance`.

## Later

Historical metrics (`SDR-CSX-KMT`: 30 days and a year, from the observation commits), the
Certification Package Overview (`FRC-CSO-PKG`'s schema), a FedRAMP 20x view in the Compliance page,
delivery by an export job, and Classes C and D (two and four automated methods per KSI).
