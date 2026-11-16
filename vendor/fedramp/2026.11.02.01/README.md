# FedRAMP Consolidated Rules for 2026, release 2026.11.02.01

The official, machine-readable FedRAMP 20x sources Stolos reads (spec 076), published by FedRAMP
(GSA) on GitHub. Nothing here is edited: each file is byte for byte what the pinned commit holds.

| File | Source (pinned commit) | SHA-256 |
| --- | --- | --- |
| `fedramp-consolidated-rules.json` | https://raw.githubusercontent.com/FedRAMP/rules/64fa769510416fa75fd00a4689466094265b8083/fedramp-consolidated-rules.json | `782faecae3eee4aa2aa9d32cdb0de4c929524f2e41dc1f3d143a94a9ca64c4e3` |
| `fedramp-consolidated-rules.schema.json` | https://raw.githubusercontent.com/FedRAMP/rules/64fa769510416fa75fd00a4689466094265b8083/schemas/fedramp-consolidated-rules.schema.json | `2fb59963b5b9161acb1354a2b76fda8b8a832275e1ac1ad93315c031ca350f8d` |
| `fedramp-security-decision-record-schema-2026-06-24.json` | https://raw.githubusercontent.com/FedRAMP/schemas/8fe79fa5bb1b3ac6d5d5f636f4032cc5c56ea59c/fedramp-security-decision-record-schema-2026-06-24.json | `94580404e8d4276ee3ced2a3c39cce5cc6565df6ae38a91f60f26cb96d833188` |
| `fedramp-common-definitions-schema-2026-06-24.json` | https://raw.githubusercontent.com/FedRAMP/schemas/8fe79fa5bb1b3ac6d5d5f636f4032cc5c56ea59c/fedramp-common-definitions-schema-2026-06-24.json | `b12a8d8bc2b7443c24114f4639ed49c9d3348c50b96519539a39cf3f76062c54` |

- `FedRAMP/rules` at `64fa769510416fa75fd00a4689466094265b8083` (2026-11-02, "2026.11.02.01 /
  minor adjustments & release strategy (#51)"): the rules dataset, `info.version` 2026.11.02.01,
  with its JSON Schema (draft 2020-12). It holds the 46 Key Security Indicators (KSI), each with
  the NIST SP 800-53 controls FedRAMP maps it to, and the rules that say which apply to Class A and
  Class B (`FRC-CLA-MFR`, `FRC-CSX-VVK`, `SDR-CSX-KSI`, `SDR-CSX-KMT`, `VDR-TFR-MVX`,
  `CPO-CSX-CPM`).
- `FedRAMP/schemas` at `8fe79fa5bb1b3ac6d5d5f636f4032cc5c56ea59c` (2026-10-27): the JSON Schemas
  the rules name. `SDR-CSX-KSI` names the Security Decision Record schema
  (`https://fedramp.gov/schemas/fedramp-security-decision-record-schema-2026-06-24.json`,
  `$schemaVersion` 1.1.1), which `$ref`s the common definitions (`$schemaVersion` 0.4.2). The
  copies fedramp.gov serves at those `$id`s are minified, so their bytes differ; their content is
  the same (checked when vendored). The repository's README calls them "draft JSON Schemas for
  FedRAMP Consolidated Rules 26".

Related: https://github.com/FedRAMP/2026 (the narrative and the fedramp.gov/2026 site) and
https://github.com/FedRAMP/2026-markdown.

## License

Neither repository states a license (no LICENSE file, no license field). They are works of the
United States Government (GSA's FedRAMP program office), which are not subject to copyright in the
United States (17 U.S.C. 105): in the public domain there.

## Use

`bun run fedramp` (`tools/fedramp-gen.ts`) checks the rules file's SHA-256 and writes
`src/archon/fedramp/rules.auto.ts` from it (the KSIs, the Class A list, the cadences); the tests
check every KSI against this file and validate Stolos's Security Decision Record against the
schemas with Ajv. These files are not shipped in the engine: the generated module carries what it
needs. A new release goes in a new directory, next to this one.
