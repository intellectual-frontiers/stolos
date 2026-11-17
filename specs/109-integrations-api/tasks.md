# Tasks: Integrations: one typed layer over routers, DNS and email, and UniFi as the first router

**Input**: `specs/109-integrations-api/spec.md`, `plan.md`

**Tests**: every requirement is proved with `proves([...])` in `tests/integrations109.test.ts` and `tests/unifi109.test.ts` (fixtures and the
local HTTPS server in `tests/unifi-fixtures.ts`); FR-020 and FR-021 are reviewed (`reviewed.tsv`).

## Phase 1: Ontology and specification (rungs 0 and 1)

- [x] T001 `stolos:ApiKind`, `stolos:ApiCapability` (code lists), `stolos:ApiIntegration` and the entity classes in `ontology/stolos/`, each citing `109-integrations-api`; the basis of each in `ontology/stolos/audit.ts` (mapped where a standard names it, six listed with their candidates); `bun run gen`
- [x] T002 This specification, its plan and tasks, the standards considered

## Phase 2: The layer (rung 5)

- [x] T003 The typed entities, the capability sets and results, the mapping to records and device entities (FR-001, FR-003, FR-015) in `src/archon/connect/integration-entities.ts`, the labels in `labels.ts`
- [x] T004 The algebra: `Has`, `Integration`, `defineIntegration`, `readCapability`, `readAll`, the typed queries, `memoGets` (FR-002, FR-004, FR-005) in `src/archon/connect/integration.ts`
- [x] T005 The connector family: `integrationConnector`, `withIntegrations`; `optional` fields, the `trust` step and `selfHosted` of a connector (FR-006) in `src/archon/connect/{integration-connector,connector,commands}.ts`
- [x] T006 Cloudflare as `dns` and `email` (FR-007, FR-008) in `src/archon/connect/cloudflare-integration.ts`; the connector of spec 067 is not touched
- [x] T007 A device of the source `unifi` is a network device in the estate graph (FR-003) in `src/archon/estate/graph.ts`

## Phase 3: UniFi Network (rungs 5 and 6)

- [x] T008 The pinned document, its origin and SHA-256 (FR-009) in `vendor/unifi-network/10.3.58/`
- [x] T009 The generator and the generated types (FR-010) in `tools/unifi-api-gen.ts`, `src/archon/connect/unifi-api.auto.ts`; `bun run unifi-api [--check]`
- [x] T010 Pinned or CA-verified TLS on a socket, the probe for trust on first use (FR-012) in `src/archon/connect/unifi-tls.ts`
- [x] T011 The router integration, the connector, the policies (FR-011, FR-013, FR-014, FR-016, FR-018) in `src/archon/connect/unifi.ts`

## Phase 4: Proof and documentation (rung 7)

- [x] T012 Prove every requirement (SC-001, SC-002): `tests/integrations109.test.ts`, `tests/unifi109.test.ts`, `tests/unifi-fixtures.ts`
- [x] T013 The guide with its Mermaid diagram (FR-019) in `src/archon/connect/mod.ts`, listed in `src/archon/core/guides.ts`

## Later (not built)

- [ ] L001 Move the web front door's use of Cloudflare (spec 032: the server's own certificate challenges and records, `src/archon/web/cloudflare.ts`, `src/archon/access/tls.ts`) onto the `dns` kind of the layer, with writes: this release leaves that code as it is, and the layer is read-only, so the migration needs a write side of the algebra (a capability with an effect, behind the destructive and approval rules) first.
- [ ] L002 Retire the duplicate reads: the Cloudflare connector's `zones` and `dns` resources become the layer's `dns` readings, so the connector and the integration are one reading (today they share requests through `memoGets` and read twice).
- [ ] L003 The capabilities no implementation has yet: `dhcp-leases`, `port-forwards`, `routes` (and `health` as nodes) have entities and no label of their own; add the labels with the first integration that offers them (another router: OPNsense, pfSense, MikroTik, or a UniFi API version that has them: re-run `bun run unifi-api` on a new vendored document and see which gaps close).
- [ ] L004 UniFi as a `dns` integration: the document's DNS policies (A, AAAA, CNAME, MX, SRV, TXT and forward domains) are records a router serves, which spec 110's Network page and the fleet's `.localdomain` names (Article 20) could check.
- [ ] L005 Cloudflare `email` `sending`, and other email providers (the `email` kind is two providers wide only when a second exists); outbound sending settings and domain authentication of senders.
- [ ] L006 Tags (specs 108, 113): rules over network facts (`kindIs`-like helpers for a client's VLAN, a device's model, an unmanaged client), so that `env:lab` follows a machine's network; this release leaves the hook in the observation's records (`local_area_network`, `network_endpoint`) and `Entities.devices`.
- [ ] L007 Spec 110 (the Network page) draws what the estate graph now holds (clients, VLANs, ports, firewall rules, Wi-Fi); spec 111 is separate. No page is built here.
- [ ] L008 `stolos connect unifi --fingerprint` rotation without re-entering the key, `stolos unifi pin` to show the controller's current certificate, and a doctor line when a pinned certificate is within 30 days of its expiry.
- [ ] L009 Read per-device statistics (`statistics/latest`: CPU, memory, uptime) and `pending-devices` for `health`; the document offers both, and this release derives health from `/v1/info` and the devices' states only.
- [ ] L010 Not verified in this change: a real UniFi controller was never contacted (the tests run against responses shaped by the document); the TLS code is tested on Linux on Bun and Node, and not yet on Windows or macOS sessions (CI's suite matrix runs it there); Cloudflare's Email Routing endpoints (`/zones/{id}/email/routing`, `/rules`) are from Cloudflare's documentation and were not contacted, and the fixtures for them are written by hand.
