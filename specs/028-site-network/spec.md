# Feature Specification: The site network as a model

**Feature Branch**: `028-site-network` (committed directly to main) **Created**: 2026-11-11
**Status**: Implemented **Input**: Describe Example Lab's UniFi network as strongly typed data
(zones, networks, policies, DNS, the mDNS proxy, Wi-Fi, WireGuard, DDNS, the boot server), check
hosts against it, export it as RDF, render the network reference from it, and keep a typed inventory
of every secret by name. Archon never changes the router (constitution Article 21).

Source of the values: the owner's network reference, `example-lab-unify-network.html` (state as of
11 Nov 2026, sent to the shared mailbox with the "Lab Network Runbook Change Log, 2026-11-09 to
2026-11-11 (initial)").

## User Scenarios & Testing _(mandatory)_

1. **Given** the model, **When** `archon build` runs, **Then** the site is validated with the fleet
   and `out/site/network-reference.html` is rendered from it.
2. **Given** the boot server moves to another address, **When** `site.bootServer.address` changes,
   **Then** validation lists exactly what to change in UniFi: each network's Network Boot and each
   policy to the old address.
3. **Given** someone adds Servers to the mDNS proxy, a guest SSID on WPA2, a host outside its
   network, two hosts on one address, or a host without a Local DNS record, **Then** validation
   names it with the UniFi change that fixes it.
4. **Given** a network change, **When** the owner sends the change log, **Then**
   `deno task boot notify --subject "Lab Network Runbook Change Log <dates>" --attach out/site/network-reference.html`
   mails it to the shared mailbox.

## Requirements _(mandatory)_

- **FR-001**: `src/archon/model/site.ts`: the ontology. Branded `IPv4`, `Cidr`, `VlanId`, `Port`
  with constructors that reject malformed literals when the model loads. `Zone` is a closed union:
  Internal, IoT, Servers, DMZ, Hotspot, VPN, External, and Gateway (UniFi's own zone, which policies
  5 and 6 target).
- **FR-002**: `fleets/<fleet>/site.ts`: the data. Networks (name, VLAN, CIDR, gateway, zone, DHCP
  range, `netboot?`, `mdnsReflect`, `ipv6`): Default 10.0.1.0/24 VLAN 1 (Internal); IoT 10.0.20.0/24
  VLAN 20; Servers 10.0.30.0/24 VLAN 30 (netboot 10.0.1.157 / bootx64.efi); DMZ 10.0.40.0/24 VLAN
  40; Guest 10.0.2.0/24 VLAN 99 (Hotspot); WireGuard 10.0.3.0/24 (VPN). Policies 1 to 7 as numbered
  in UniFi, including 4 (Servers to 10.0.1.157 UDP 69) and 7 (Servers to 10.0.1.157 TCP 8080). DNS:
  upstream 1.1.1.1 and 9.9.9.9 (Auto DNS off), Local DNS records. The mDNS proxy: Default and IoT,
  the six services UniFi repeats. Wi-Fi: Lab King, Lab IoT, Example Guest (WPA3). WireGuard and
  DDNS: names and endpoints. Devices with fixed addresses. The boot server: BOOTPC 10.0.1.157, TFTP
  69, HTTP 8080. No passwords, keys, or tokens.
- **FR-003**: `HostDef` gains `network` (a site network's name), `ip`, `dnsName`, `switchPort`, and
  `ipv6` (the per-host override). alpha: Servers, 10.0.30.57, alpha.localdomain, flex-2.5g/3.
  `networkOf()` derives IPv6 from the host's network; the override wins; `fleet.network` remains the
  fallback for hosts outside the site.
- **FR-004**: Validation (`validateSite`, run with the fleet; each problem with a fix): a network
  with `netboot` outside the boot server's zone has policies for UDP 69 and TCP 8080 to
  `bootServer.address`; every `netboot.server` is `bootServer.address`; no Servers or DMZ network is
  in the mDNS proxy; fixed addresses are unique and inside their network; guest Wi-Fi is WPA3; every
  host's `dnsName` is a Local DNS record at its address; the collector's name is a Local DNS record
  once `telemetry.collector` names one; every record is inside a site network.
- **FR-005**: The secret inventory (`src/archon/model/secret-inventory.ts`):
  `SecretRef { id, path, purpose, holder, recreate, ephemeral?, identity?, spec }`. Boot machine:
  the admin password hash, each host's deploy key and SSH host keys (and their public halves),
  `mail.json`, install tokens (ephemeral). Owner, names only: UniFi backups, Wi-Fi passwords,
  WireGuard keys, the Cloudflare DDNS token, recovery and MFA codes (including the Microsoft
  account's, whose OneDrive Personal Vault holds the secrets backups; spec 029 has no passphrase). A
  test checks that every path the code writes is in the inventory and that every secret write goes
  through `writeSecret()`.
- **FR-006**: RDF (`archon export`, `out/rdf/site.ttl`): `archon:Site`, `archon:Network`,
  `archon:Zone`, `archon:FirewallPolicy`, `archon:SecretRef` (names only) with SKOS labels. An
  export only (Article 10).
- **FR-007**: The network reference (`archon build`, `out/site/network-reference.html`, GENERATED):
  at a glance, networks, Wi-Fi, zones and policies, DNS and the mDNS proxy, remote access, network
  boot, devices and hosts, where secrets live.

### Deviations from the request, by the router's authority (Article 21)

- The mDNS proxy repeats the six services the router repeats (Amazon Devices, Apple AirPlay, Google
  Chromecast, Printers, Roku, Spotify Connect), not `_otlp-http._tcp` and the others: those were a
  proposal; the router was set to Service Scope Specific on 2026-11-11.
- The VLAN 20 network is named `IoT` in UniFi (its SSID is `Lab IoT`).
- There is no `otel.localdomain` record yet (no collector exists): the rule requires it once
  `telemetry.collector` names it.
- The zone union includes `Gateway`.

### Overrides of Ubuntu defaults

None: nothing here changes a host or the router.

## Success Criteria _(mandatory)_

- **SC-001**: The owner's network validates as modeled; each rule has a failing test.
- **SC-002**: `site.ttl` and `fleet.ttl` parse as Turtle (checked with rdflib: 247 and 591 triples).
