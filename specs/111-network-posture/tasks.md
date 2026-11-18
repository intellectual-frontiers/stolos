# Tasks: Network posture: the network as an asset class, with policies, evidence, an inventory and change events

**Input**: `specs/111-network-posture/spec.md`, `plan.md`

**Tests**: every requirement but FR-020 is proved with `proves([...])` in `tests/network111.test.ts`, `tests/network111-unifi.test.ts` and
`tests/network111-console.test.ts`; FR-020 is reviewed (`reviewed.tsv`).

## Phase 1: Ontology and specification (rungs 0 and 1)

- [x] T001 No ontology term is new (`stolos:Check`, `stolos:Finding` and the network terms of specs 109 and 110 are reused); `ontology/stolos/audit.ts` and `tools/mizan.baseline.txt` unchanged
- [x] T002 This specification, its plan and tasks, the standards considered

## Phase 2: Headless operations (rungs 3 to 6)

- [x] T003 The SCF controls the pack and the change events name, in `src/archon/compliance/scf.ts` (AST-05.1, AST-11, CFG-03, NET-04, NET-06, NET-22, NET-24.1), checked against the catalog (FR-001)
- [x] T004 The reader: a network's isolation, a Wi-Fi broadcast's client isolation, a port's PoE setting, each a GET of the pinned document and a gap where it fails (FR-012) in `src/archon/connect/{unifi,integration-entities,labels}.ts`
- [x] T005 Observed ports and firewall rules, `readingUnread`, `knownClients` and `requiredTags` with their build validation (FR-002, FR-009, FR-010, FR-021) in `src/archon/connect/network-asset.ts`
- [x] T006 The pack: `NETWORK_POLICIES`, `NETWORK_GAPS`, `evaluateNetworkPosture` (FR-001 to FR-011) in `src/archon/connect/network-posture.ts`; explain codes `E111-*` (FR-001) in `src/archon/core/explain.ts`
- [x] T007 `stolos network check` with its scoping by tags (FR-013), `stolos network inventory` (FR-016) and `stolos network changes` (FR-018) in `src/archon/connect/{network-check,network-inventory,network-changes}.ts` and `src/archon/commands/registry.ts`
- [x] T008 The evidence: the source `network`, its freshness and refresh command, the exports (FR-014) in `src/archon/compliance/{report,freshness,drift,oscal,commands}.ts`, `src/archon/{fedramp,export,trust}/`; the OSCAL component and inventory entries (FR-017)
- [x] T009 `compliance drift` with the network's change events (FR-019) in `src/archon/compliance/drift.ts`
- [x] T010 `fleet status` and `network status` (FR-015) in `src/archon/connect/network-commands.ts`

## Phase 3: The Stolos Console (rung 6, windowed)

- [x] T011 The Network posture card on the Network page and the Overview (FR-015) in `src/archon/console/{network-page,stolos-pages,pc}.ts`

## Phase 4: Proof and documentation (rung 7)

- [x] T012 Prove every requirement (SC-001 to SC-003): `tests/network111*.test.ts`
- [x] T013 The guide with its Mermaid diagram in `src/archon/connect/mod.ts`

## Later (not built)

- [ ] L001 `stolos network accept <policy> --reason --until`: a command that writes `controls/accepted.ts` the way `host accept` writes `machine.ts` (today the file is edited by hand, spec 078).
- [ ] L002 Management interface reachable from guest networks (a policy): the document has firewall policies by zone and filter but no evaluation of reachability and no management address. Missing: an evaluation operation, or a typed fleet declaration of the management addresses plus a model of the zone filters.
- [ ] L003 Legacy Wi-Fi security (WEP, WPA v1): not a security type of the 10.3.58 document. Missing: a type for it. Re-run `bun run unifi-api` on a newer document.
- [ ] L004 Disabled ports: a port has a link `state` and a PoE setting but no administrative state. Missing: `Port overview.enabled`.
- [ ] L005 How far a firmware is behind (days, versions): the document has `firmwareUpdatable` only. Missing: the latest version and its release date.
- [ ] L006 The effect of a firewall rule (a rule that allows any to any, an allow from the external zone): the rule's filters are not evaluated. A later policy could read the zones' names and the filters, as the document types them.
- [ ] L007 DHCP guarding (the network details' `dhcpGuarding`): readable, but whether a network must have it is the fleet's decision; a typed `requiredGuarding` in `network.ts`.
- [ ] L008 A client's VLAN from its address and the network's subnet (spec 110 L003) would let `unknown-clients` say which network an unknown client is on.
- [ ] L009 Tags at a past commit for `compliance drift` (so ownership is judged there too), and per-asset accepted risks (a record field), beside the fleet's `accepted.ts`.
- [ ] L010 Another router integration (OPNsense, MikroTik) through the same pack: the policies read the integration's typed entities, not UniFi.
- [ ] L011 Not verified in this change: a real UniFi controller (the tests run against responses shaped by the document), Windows and macOS sessions (CI's suite matrix runs them), a real browser (the console tests render the pages and call the handler; the card was not looked at in a browser).
