# 084: Connectors: clouds, SaaS, and devices behind one interface

Epic intellectual-frontiers/stolos#7; issue intellectual-frontiers/stolos#12.

## Requirements

- **FR-001** The cloud providers of spec 067 become connectors (`src/archon/connect/`), each with a
  category: cloud, identity, code, hr, endpoint, ticketing, collaboration, secrets, vulnerability,
  training. The principles stay: a read-only credential in the vault
  (`connectors/<id>/credential.json`), a recipe for making it, observations as GENERATED TypeScript
  in `fleets/<fleet>/estate/<id>.ts`, gaps reported rather than failing, posture policies with SCF
  controls.
- **FR-002** Commands: `stolos connect <id>`, `stolos disconnect <id>`, and
  `stolos estate observe |
  check | assets` (the estate: every connected account). The console's
  page is Connected accounts.
- **FR-003** Normalized entities (Person, Account, Device, Repository, Resource, Vendor, Finding)
  for the estate graph (spec 085) come from each connector.

## Success criteria

- **SC-001** `tests/connect084_test.ts`: each connector against recorded API responses.
