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
