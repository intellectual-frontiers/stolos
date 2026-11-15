# 084: Connectors: clouds, SaaS, and devices behind one interface

Epic intellectual-frontiers/stolos#7; issue intellectual-frontiers/stolos#12.

## Requirements

- **FR-001** The cloud providers of spec 067 become connectors (`src/archon/connect/`). Each is
  labeled with the world's terms, never Stolos's own: its service models as NIST SP 800-145 defines
  them (IaaS, PaaS, SaaS: what FedRAMP calls a cloud service offering's service model), and its
  market categories as the analyst firms name them (Gartner Magic Quadrants and Market Guides,
  Forrester Waves: Strategic Cloud Platform Services, Access Management, DevOps Platforms, Cloud HCM
  Suites, Unified Endpoint Management Tools, IT Service Management Platforms, ...), each with its
  source. The principles stay: a read-only credential in the vault
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

- **SC-001** `tests/connect084.test.ts`: each connector against recorded API responses.
