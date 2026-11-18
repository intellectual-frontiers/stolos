# Tasks: Network assets: what a router's controller manages, adopted as machines of the fleet

**Input**: `specs/110-network-assets/spec.md`, `plan.md`

**Tests**: every requirement but FR-013 and FR-014 is proved with `proves([...])` in `tests/network110.test.ts`,
`tests/network110-unifi.test.ts` and `tests/network110-console.test.ts`; FR-013 and FR-014 are reviewed (`reviewed.tsv`).

## Phase 1: Ontology and specification (rungs 0 and 1)

- [x] T001 `stolos:DeviceClass`, `stolos:DeviceFacet`, `stolos:joined-integration`, `stolos:answer-skipped` in `ontology/stolos/`, each citing `110-network-assets`; both classes mapped to W3C SKOS in `audit.ts`; `bun run gen`
- [x] T002 This specification, its plan and tasks, the standards considered

## Phase 2: Headless operations (rungs 3 to 6)

- [x] T003 Classes, facets, the OCSF type table, the classifier (FR-001) in `src/archon/connect/network-class.ts`
- [x] T004 UniFi: class, facets, uplink from the device details, the Wi-Fi advertisement, the gaps (FR-001, FR-007, FR-012) in `src/archon/connect/{unifi,integration-entities,integration}.ts`
- [x] T005 The record, its names, the rules, reconcile, the policies (FR-003, FR-004, FR-005) in `src/archon/connect/network-asset.ts`; the way of joining (FR-002) in `src/archon/adopt/joining.ts`
- [x] T006 The view: devices, discovered, gone, clients matched by MAC, unmanaged, edges (FR-005, FR-006, FR-007) in `src/archon/connect/network-view.ts`
- [x] T007 `stolos network discover | adopt | status`, auto-adopt after `estate observe`, release (FR-003, FR-004, FR-005) in `src/archon/connect/network-commands.ts`, `src/archon/commands/registry.ts`, `src/archon/adopt/commands.ts`, `src/archon/build.ts`
- [x] T008 Assets are machines for tags; helpers over network facts (FR-002, FR-010) in `src/archon/fleet/tags.ts`, `src/archon/model/tags.ts`
- [x] T009 The estate graph's edges (FR-007) in `src/archon/estate/{schema,graph}.ts`
- [x] T010 Ask every machine skips an asset (FR-011) in `src/archon/adopt/{query,commands}.ts`

## Phase 3: The Stolos Console (rung 6, windowed)

- [x] T011 The topology layout and SVG (FR-008) in `src/archon/connect/network-topology.ts`
- [x] T012 The Network page, a device page, the menu entry, badges, the Overview card, the CSV (FR-002, FR-008, FR-009) in `src/archon/console/{network-page,pc,stolos-pages,stolos-server,table}.ts`; `fleet status` (FR-009) in `src/archon/observe/fleet-status.ts`

## Phase 4: Proof and documentation (rung 7)

- [x] T013 Prove every requirement (SC-001 to SC-003): `tests/network110*.test.ts`
- [x] T014 The guide with its Mermaid diagram in `src/archon/connect/mod.ts`

## Later (not built)

- [ ] L001 Cameras, recorders, door controllers and phones: they belong to UniFi Protect, Access and Talk, which the Network API does not list. The class table (`MODEL_FAMILIES`) is ready for an integration that does.
- [ ] L002 A serial number for an asset: the Network API gives none; an SNMP read or the other UniFi applications may.
- [ ] L003 A client's VLAN from its address and the network's subnet (the network details give the subnet), and `inVlan` for clients; the API gives no VLAN to a client or a port.
- [ ] L004 A client's port and Wi-Fi network: not in the official 10.3.58 API; re-run `bun run unifi-api` on a newer document.
- [ ] L005 Switch ports as nodes with `connected_to` edges and a port-level topology; LLDP neighbours (IEEE 802.1AB) as a second source of uplinks.
- [ ] L006 Open in UniFi for a standalone Network application (another path than UniFi OS's) and for a site other than `default`.
- [ ] L007 Another router integration (OPNsense, MikroTik) through the same layer: the class, facets, uplink and the page are vendor neutral.
- [ ] L008 A tag rule helper over a client that is not a machine, and tags on clients; clients stay observed, never adopted.
- [ ] L009 Not verified in this change: a real UniFi controller (the tests run against responses shaped by the document), Windows and macOS sessions (CI's suite matrix runs them), a real browser (the console tests render the pages and call the handler; the SVG and AG Grid were not looked at in a browser).
- [ ] L010 Spec 111: the network posture (not here).
