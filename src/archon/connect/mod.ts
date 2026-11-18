/**
 * # Integrations: routers, DNS and email
 *
 * Spec 084 made every outside account a **connector**: a read-only credential in the vault, an observation in Git, posture policies.
 * Spec 109 adds a family of them, the **integrations**, for accounts that have a **kind**: a router (with its controller), a DNS
 * provider, an email provider. Every router has clients, devices, networks and VLANs, ports and firewall rules; every DNS provider
 * has zones and records; every email provider has domains, sending and routing. An integration declares its kind and which of that
 * kind's capabilities it offers, and everything a person or a function asks of "the router" is typed by that.
 *
 * ```mermaid
 * flowchart LR
 *   onto["ontology: stolos:ApiKind, stolos:ApiCapability"] --> alg["the algebra: Has&lt;kind, capability&gt;"]
 *   alg --> uni["UniFi Network 10.3.58<br/>router: devices, clients, networks-and-vlans,<br/>ports, firewall-rules, wifi, health"]
 *   alg --> cf["Cloudflare<br/>dns: zones, records<br/>email: domains, routing"]
 *   gen["tools/unifi-api-gen.ts<br/>vendor/unifi-network/10.3.58/integration.json"] -->|"unifi-api.auto.ts"| uni
 *   uni & cf --> conn["integrationConnector: stolos connect, estate observe"]
 *   conn --> obs["fleets/&lt;fleet&gt;/estate/&lt;id&gt;.ts"] --> graph["the estate graph: estate query"]
 * ```
 *
 * ## Connecting UniFi
 *
 * ```bash
 * bun run stolos connect unifi        # the address, the key, and (optionally) the base path, a CA file, a fingerprint
 * bun run stolos estate observe unifi
 * bun run stolos estate check unifi
 * ```
 *
 * In the UniFi Network application (9.0 or newer), signed in as its owner, make a key under Settings, Control Plane, Integrations.
 * UniFi does not scope that key: it has the rights of the owner's role. Stolos only reads: its transport sends GET requests and refuses
 * every other method, and the key stays in this PC's vault. The API is read from `/proxy/network/integration` on UniFi OS (a standalone
 * Network application serves it from `/integration`: give that as the base path).
 *
 * A controller's own certificate is not signed by a public authority. The first time, `stolos connect unifi` shows its SHA-256
 * fingerprint, subject and expiry, and pins that exact certificate only when you say yes, as you do for an SSH host key; or you give a
 * CA file or the fingerprint yourself. The fingerprint is public and is written into the observation in Git, so the history of
 * certificates you approved is `git log -p` on `fleets/<fleet>/estate/unifi.ts`. A certificate that later differs fails the
 * observation, saying both fingerprints, before the key is sent. Verification is never switched off.
 *
 * ## What UniFi's documented API offers, and what it does not
 *
 * Stolos reads only what Ubiquiti's official OpenAPI document (version 10.3.58, kept in `vendor/unifi-network/`) offers: sites,
 * adopted devices (model, MAC, IP, state, firmware), connected clients, networks and VLANs, the ports of switches and gateways,
 * firewall policies and zones, Wi-Fi broadcasts, and the application's version. The document has no operation for **DHCP leases**,
 * **port forwards** or **routes**: each is a gap in every observation, with its reason, and is never guessed or read from an
 * undocumented endpoint.
 *
 * ## Cloudflare as DNS and email
 *
 * Cloudflare keeps its connector as it was, and is also a `dns` integration (zones, records) and an `email` integration (the domains'
 * MX, SPF, DKIM and DMARC records, whether Email Routing is on, and its rules, without the addresses they forward to). Outbound
 * sending is not read yet. The policies `cf-email-spf`, `cf-email-dmarc` and `cf-email-dkim` apply to the domains that have email.
 *
 * ## Network assets (spec 110-network-assets)
 *
 * The devices UniFi manages become **assets of the fleet**, adopted through the integration: no SSH, no probe, read-only, with a link to
 * the native console. Each has a class (gateway, switch, access point, camera, recorder, door controller, phone, other: from the
 * document's `features`, then the model, never guessed) and facets (routing, switching, wireless, surveillance, access control), so a
 * feature asks for a facet and gets devices of any vendor.
 *
 * ```bash
 * bun run stolos estate observe unifi          # read the controller; rules in fleets/<fleet>/network.ts adopt by themselves
 * bun run stolos network discover              # what the controller manages that is not adopted yet
 * bun run stolos network adopt --all --class switch   # one signed commit; or name devices by name, MAC or id
 * bun run stolos network status                # assets by class, discovered, gone, unmanaged clients
 * ```
 *
 * ```mermaid
 * flowchart LR
 *   obs["observation: devices, clients, Wi-Fi"] --> disc["network discover"]
 *   disc --> adopt["network adopt"] --> rec["adopted/&lt;name&gt;/network.ts"]
 *   rules["network.ts: autoAdopt"] -->|"estate observe"| rec
 *   rec --> m["a machine: tags, page, evidence, estate graph"]
 *   obs -->|"a device that vanished"| w["a warning, never a deletion"]
 * ```
 *
 * A device that is no longer reported is **gone from the integration**: a warning with its fix, never an automatic deletion;
 * `stolos host release <name>` removes the record on your request, and changes nothing at the controller. Clients are observed, never
 * adopted: they are matched to machines by MAC and listed as unmanaged otherwise (`stolos pair` brings a machine in). The estate graph
 * has the edges the API gives (uplink, connected-to, member-of, advertises) and none it does not (a client's port, VLAN or Wi-Fi network).
 * The Stolos Console has a Network page, only where a router is connected. Tag rules have helpers: `ofClass`, `withFacet`, `inVlan`,
 * `onSsid`, `uplinkedTo`.
 *
 * ## Network posture (spec 111-network-posture)
 *
 * The network is an asset class with posture policies, evidence, an inventory and change events, derived only from what the official
 * 10.3.58 API gives. `stolos network check` runs a pack of nine policies over the last observation (it asks the controller nothing):
 * the observation is recent, adopted assets are still reported, devices are online, no firmware update waits (the device's own flag),
 * no enabled Wi-Fi network is open (the broadcast's security type), guest Wi-Fi is on an isolated network (the network details'
 * isolation flag), every client is a machine of the fleet or a known one, every asset has the owner and criticality tags the fleet
 * defines, and no unused port supplies PoE. Each result is pass, fail, warn, **not observed yet** (never a failure) or accepted
 * (`controls/accepted.ts`, as `network/<word>`), with its SCF controls, its fix and its code (`stolos explain E111-FIRMWARE`).
 * What the API cannot support (a management interface reachable from guests, WEP, disabled ports, how far a firmware is behind, a
 * firewall rule's effect) is a **gap** with its reason, never a policy.
 *
 * ```bash
 * bun run stolos network check [--tag criticality:high] [--json]
 * bun run stolos network inventory --out out/network-inventory.md    # CM-8, deterministic
 * bun run stolos network changes --since 2026-11-01                  # from the history of estate/unifi.ts in Git
 * ```
 *
 * ```mermaid
 * flowchart LR
 *   obs["estate/unifi.ts in Git"] --> pack["network pack: 9 policies"]
 *   net["network.ts: knownClients, requiredTags"] --> pack
 *   pack --> chk["network check"] & ev["compliance evidence: source network"] & card["fleet status, the console's card"]
 *   obs --> inv["network inventory"]
 *   obs -->|"each commit against the one before"| chg["network changes, compliance drift"]
 * ```
 *
 * `fleets/<fleet>/network.ts` may list `knownClients: [{ mac, name, reason }]` (an unknown client then fails) and
 * `requiredTags: ["owner"]` (a dimension of `tags.ts` every asset must hold).
 *
 * ## Writing an integration
 *
 * An integration is `defineIntegration` with its kind, a reader for each capability it offers and, for every capability of the kind it
 * does not offer, the reason. A function over a capability takes `Has<kind, capability>`: an integration that lacks it does not
 * compile. `integrationConnector` makes the connector (credential fields, headers, posture, policies), and what it reads joins the
 * estate graph as records and device entities. The reads share one transport, so two readers of one account send each request once.
 *
 * @module
 */
// Spec: 109-integrations-api FR-019
// Spec: 110-network-assets FR-003, FR-004, FR-005, FR-006, FR-007
// Spec: 111-network-posture FR-013, FR-016, FR-018
