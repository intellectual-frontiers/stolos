/**
 * Spec 109-integrations-api: the typed entities an integration reads, one for each capability of each kind (a router's clients, its
 * devices, its VLANs; a DNS provider's zones and records; an email provider's domains and routes). They are plain data with no secret
 * and no personal field: what a control needs, and no more.
 *
 * Each entity joins the estate graph (spec 085, 090) through the observation a connector writes: as a record with a label named from OCSF
 * or D3FEND and its OCSF class (spec 089), and a network device also as a device entity, so that it is a fixed asset beside the fleet's
 * machines. {@link entityParts} is that one mapping, a `switch` over every capability of every kind that the compiler checks is
 * complete.
 *
 * @module
 */
// Spec: 109-integrations-api FR-001, FR-002, FR-003, FR-015
// Spec: 111-network-posture FR-012

import type { Asset } from "./connector.ts";
import type { Device } from "./entities.ts";
import {
  COMPUTER_NETWORK_NODE,
  DNS_RECORD,
  DOMAIN_NAME,
  EMAIL_RULE,
  FIREWALL_RULE,
  LOCAL_AREA_NETWORK,
  MAIL_SERVICE,
  NETWORK,
  NETWORK_ENDPOINT,
  NETWORK_INTERFACE,
} from "./labels.ts";
import { type ObservedRecord, ocsfUid } from "./sdk.ts";
import type { ApiCapability, ApiKind, DeviceClass, DeviceFacet } from "../ontology.auto.ts";

/** What every entity says of where it was read: the integration (its connector's id) and, for a router, the site. */
export interface Origin {
  /** The integration's id (the connector's, the vault folder and the observation's file name). */
  source: string;
  /** The site of the controller it belongs to, when the product has sites. */
  site?: string;
}

/** An address a router's DHCP server has given to a client (`stolos:Lease`). */
export interface Lease extends Origin {
  /** The client's MAC address. */
  mac: string;
  /** The address it was given. */
  ip: string;
  /** The client's host name, when it said one. */
  hostname?: string;
  /** The network it was given on. */
  network?: string;
  /** When the lease ends (ISO). */
  ends?: string;
}

/** A device connected to a network, as its router sees it (`stolos:NetworkClient`). */
export interface Client extends Origin {
  /** Its id at the controller. */
  id: string;
  /** Its name, as the controller shows it. */
  name: string;
  /** How it is connected. */
  kind: "wired" | "wireless" | "vpn" | "teleport";
  /** Its MAC address (a VPN client has none). */
  mac?: string;
  /** Its IP address. */
  ip?: string;
  /** The id of the network device it connects through. */
  uplink?: string;
  /** It is a guest of the network. */
  guest?: boolean;
  /** When it connected (ISO). */
  connectedAt?: string;
}

/** A device a network is made of and a controller has adopted (`stolos:NetworkDevice`). */
export interface NetworkDevice extends Origin {
  /** Its id at the controller. */
  id: string;
  /** Its name. */
  name: string;
  /** What it does, from the features the controller says it has. */
  kind: "gateway" | "switch" | "access-point" | "other";
  /** Its model. */
  model: string;
  /** Its MAC address. */
  mac: string;
  /** Its IP address. */
  ip: string;
  /** Its state at the controller (ONLINE, OFFLINE, UPDATING, ...). */
  state: string;
  /** Its firmware version. */
  firmware?: string;
  /** A firmware update is waiting for it. */
  firmwareUpdatable?: boolean;
  /** The controller supports it. */
  supported?: boolean;
  /** Whether it has ports (a switch or a gateway), for the port reads. */
  hasPorts?: boolean;
  /** Spec 110-network-assets FR-001: its class (`stolos:DeviceClass`), from what the API gives. */
  class?: DeviceClass;
  /** Spec 110-network-assets FR-001: its facets (`stolos:DeviceFacet`). */
  facets?: DeviceFacet[];
  /** Spec 110-network-assets FR-007: the id of the device it connects through (its uplink), where the API gives one. */
  uplink?: string;
}

/** A network of a router with its VLAN id (`stolos:Vlan`). */
export interface Vlan extends Origin {
  /** Its id at the controller. */
  id: string;
  /** Its name. */
  name: string;
  /** Its VLAN id (IEEE 802.1Q). */
  vlanId: number;
  /** It is on. */
  enabled: boolean;
  /** It is the default network. */
  default: boolean;
  /** Who manages it: gateway, switch or unmanaged. */
  management?: string;
  /** The id of its firewall zone. */
  zone?: string;
  /** Spec 111-network-posture FR-012: the network's details say it is isolated from all other networks (absent: the details were not read). */
  isolated?: boolean;
}

/** One port of a switch or gateway (`stolos:SwitchPort`). */
export interface SwitchPort extends Origin {
  /** The id of the device it is on. */
  device: string;
  /** The name of the device it is on. */
  deviceName: string;
  /** Its index on the device. */
  index: number;
  /** UP, DOWN or UNKNOWN. */
  state: string;
  /** Its speed now (Mbps). */
  speedMbps?: number;
  /** Its highest speed (Mbps). */
  maxSpeedMbps: number;
  /** RJ45, SFP, ... */
  connector: string;
  /** Whether it supplies power now (UP, DOWN, LIMITED), when it can. */
  poeState?: string;
  /** Spec 111-network-posture FR-012: power over Ethernet is enabled on it. */
  poeEnabled?: boolean;
}

/** A rule that sends traffic arriving at the router to an address inside (`stolos:PortForward`). */
export interface PortForward extends Origin {
  /** Its id. */
  id: string;
  /** Its name. */
  name: string;
  /** It is on. */
  enabled: boolean;
  /** tcp, udp or both. */
  protocol: string;
  /** The port it listens on, at the router. */
  externalPort: string;
  /** The address it sends to. */
  internalIp: string;
  /** The port it sends to. */
  internalPort: string;
}

/** A rule of a router's firewall (`stolos:FirewallRule`). */
export interface FirewallRule extends Origin {
  /** Its id. */
  id: string;
  /** Its name. */
  name: string;
  /** It is on. */
  enabled: boolean;
  /** What it does to the traffic it matches. */
  action: "allow" | "block" | "reject";
  /** The name of the zone traffic comes from. */
  sourceZone?: string;
  /** The name of the zone traffic goes to. */
  destinationZone?: string;
  /** Its place in the order of the rules. */
  index?: number;
  /** It writes a log entry when it matches. */
  logging?: boolean;
  /** Who made it. */
  origin: "system" | "user" | "derived" | "orchestrated" | "unknown";
}

/** A Wi-Fi network an access point broadcasts (`stolos:WifiNetwork`). */
export interface WifiNetwork extends Origin {
  /** Its id. */
  id: string;
  /** Its name (the SSID). */
  name: string;
  /** It is on. */
  enabled: boolean;
  /** How it is secured: OPEN, WPA2_PERSONAL, WPA3_PERSONAL, ... (the controller's word). */
  security: string;
  /** The frequencies it uses (GHz). */
  frequenciesGHz: number[];
  /** It is a guest network: a hotspot with a portal or a voucher. */
  guest: boolean;
  /** Spec 110-network-assets FR-007: the ids of the access points that broadcast it; absent where every access point does. */
  broadcastBy?: string[];
  /** Spec 110-network-assets FR-007: the id of the network it carries, or `native` for the default network, where the document says. */
  network?: string;
  /** Spec 111-network-posture FR-012: the broadcast's details say its clients are isolated from each other (absent: the details were not read). */
  clientIsolation?: boolean;
}

/** An entry of a router's routing table (`stolos:Route`). */
export interface Route extends Origin {
  /** The destination network (CIDR). */
  destination: string;
  /** The next hop, when it has one. */
  nextHop?: string;
  /** The interface it leaves by. */
  interface?: string;
  /** Its metric. */
  metric?: number;
}

/** What a controller says of its own health (`stolos:RouterHealth`). */
export interface RouterHealth extends Origin {
  /** The version of its application. */
  version?: string;
  /** How many devices it manages. */
  devices: number;
  /** How many of them are online. */
  devicesOnline: number;
  /** How many are not (offline, isolated, interrupted). */
  devicesOffline: number;
  /** How many have a firmware update waiting. */
  devicesUpdatable: number;
}

/** A zone a DNS provider serves (`stolos:DnsZone`). */
export interface DnsZone extends Origin {
  /** Its id at the provider. */
  id: string;
  /** Its name (the domain). */
  name: string;
  /** Its status at the provider. */
  status: string;
  /** The provider's plan, when it says. */
  plan?: string;
  /** DNSSEC is on (undefined: not readable). */
  dnssec?: boolean;
}

/** A record of a zone (`stolos:DnsRecord`). */
export interface DnsRecord extends Origin {
  /** Its id at the provider. */
  id: string;
  /** The name of its zone. */
  zone: string;
  /** Its name. */
  name: string;
  /** A, AAAA, CNAME, MX, TXT, ... */
  type: string;
  /** What it points to. */
  content: string;
  /** Behind the provider's proxy. */
  proxied?: boolean;
  /** Its time to live (seconds; 1 is automatic at some providers). */
  ttl?: number;
}

/** A domain as its email depends on it (`stolos:EmailDomain`). */
export interface EmailDomain extends Origin {
  /** The domain. */
  domain: string;
  /** Its MX hosts. */
  mx: string[];
  /** Its SPF record (RFC 7208), when it has one. */
  spf?: string;
  /** It publishes at least one DKIM key (RFC 6376). */
  dkim: boolean;
  /** Its DMARC record (RFC 7489), when it has one. */
  dmarc?: string;
  /** Email routing is on at the provider (undefined: not readable). */
  routing?: boolean;
}

/** A rule of an email routing service (`stolos:EmailRoute`). */
export interface EmailRoute extends Origin {
  /** Its id at the provider. */
  id: string;
  /** The domain it belongs to. */
  zone: string;
  /** Its name. */
  name: string;
  /** It is on. */
  enabled: boolean;
  /** Its priority (lower runs first). */
  priority?: number;
  /** The kinds of match it has (one address, or all), never the addresses: a local part can be a person. */
  matches: Array<"address" | "all">;
  /** What it does: forward, worker, drop. */
  actions: string[];
  /** How many addresses it forwards to (never which). */
  destinations: number;
  /** It is the rule for every other address. */
  catchAll: boolean;
}

/** A way a domain sends email through a provider (`stolos:EmailSender`). */
export interface EmailSender extends Origin {
  /** The sending domain. */
  domain: string;
  /** It is authenticated (SPF and DKIM align with it). */
  authenticated: boolean;
}

/** The kinds of API an integration may be: the ontology's `stolos:ApiKind`. */
export type Kind = ApiKind;

/**
 * The capabilities of a kind: the ontology's `stolos:ApiCapability` codes that start with `<kind>-`, without it. One list of words, so a
 * capability added there is a capability of its kind here.
 */
export type CapabilityOf<K extends Kind> = ApiCapability extends infer X
  ? X extends `${K}-${infer C}`
    ? C
    : never
  : never;

/** What each capability of each kind reads: the typed entities. The compiler checks that this is exactly the ontology's capabilities. */
export interface Results {
  /** A router's. */
  router: {
    "dhcp-leases": Lease[];
    clients: Client[];
    devices: NetworkDevice[];
    "networks-and-vlans": Vlan[];
    ports: SwitchPort[];
    "port-forwards": PortForward[];
    "firewall-rules": FirewallRule[];
    wifi: WifiNetwork[];
    routes: Route[];
    health: RouterHealth[];
  };
  /** A DNS provider's. */
  dns: { zones: DnsZone[]; records: DnsRecord[] };
  /** An email provider's. */
  email: { domains: EmailDomain[]; sending: EmailSender[]; routing: EmailRoute[] };
}

/** The result of one capability of a kind: its entity list. */
export type ResultOf<K extends Kind, C extends CapabilityOf<K>> = Results[K] extends infer R
  ? C extends keyof R
    ? R[C]
    : never
  : never;

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

/**
 * `R` where it has exactly the capabilities of kind `K`, and `never` otherwise: a result type that lacks a capability of its kind, or
 * has one the kind does not, is a compile error where it is used (`Results` is checked below).
 */
export type Complete<K extends Kind, R> = Same<keyof R, CapabilityOf<K>> extends true ? R : never;

/** The compile-time check that every kind of {@link Results} has exactly its capabilities (assigning `false` to `true` fails). */
export const RESULTS_ARE_COMPLETE: {
  [K in Kind]: Same<keyof Results[K], CapabilityOf<K>>;
} = { router: true, dns: true, email: true };

/** One capability of one integration, read: the kind and capability as words, and the entities as their type says. */
export type Reading = {
  [K in Kind]: {
    [C in CapabilityOf<K>]: {
      readonly kind: K;
      readonly capability: C;
      readonly items: ResultOf<K, C>;
    };
  }[CapabilityOf<K>];
}[Kind];

/** What the entities of a reading become in an observation. */
export interface Parts {
  /** Nodes of the estate graph. */
  records: ObservedRecord[];
  /** How `estate assets` lists them. */
  assets: Asset[];
  /** Devices that join the fleet's machines as fixed assets. */
  devices: Device[];
}

const NONE: Parts = { records: [], assets: [], devices: [] };

/** A record of a label, with its OCSF class by name. */
function record(
  label: { readonly name: string },
  ocsf: "inventory_info" | "cloud_resources_inventory_info",
  native_id: string,
  display_name: string,
  props: Record<string, unknown>,
): ObservedRecord {
  return {
    label: label.name,
    ocsf_class_uid: ocsfUid(ocsf),
    native_id,
    display_name,
    props,
  };
}

/** The properties that have a value (an undefined one is left out). */
function defined(o: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
}

/** A site, as a `where` for an asset. */
const at = (e: Origin): { where?: string } => (e.site === undefined ? {} : { where: e.site });

/** The asset facts that have a value. */
function facts(
  o: Record<string, string | number | boolean | undefined>,
): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined) out[k] = v;
  return out;
}

/**
 * One reading's entities as the parts of an observation: records (with their labels), assets and devices. The `switch` is over the
 * kinds and capabilities of the ontology and `items` is typed by them, so a capability added to `stolos:ApiCapability` without a
 * mapping here does not compile; the capabilities that no integration has implemented yet, or that are posture and not nodes
 * (`dhcp-leases`, `port-forwards`, `routes`, `health`, `sending`), map to nothing (`tasks.md`, L003).
 */
export function entityParts(r: Reading): Parts {
  switch (r.kind) {
    case "router":
      switch (r.capability) {
        case "clients":
          return clientParts(r.items);
        case "devices":
          return deviceParts(r.items);
        case "networks-and-vlans":
          return vlanParts(r.items);
        case "ports":
          return portParts(r.items);
        case "firewall-rules":
          return firewallParts(r.items);
        case "wifi":
          return wifiParts(r.items);
        case "dhcp-leases":
        case "port-forwards":
        case "routes":
        case "health":
          return NONE;
        default:
          return absurd(r);
      }
    case "dns":
      switch (r.capability) {
        case "zones":
          return zoneParts(r.items);
        case "records":
          return recordParts(r.items);
        default:
          return absurd(r);
      }
    case "email":
      switch (r.capability) {
        case "domains":
          return emailDomainParts(r.items);
        case "routing":
          return emailRouteParts(r.items);
        case "sending":
          return NONE;
        default:
          return absurd(r);
      }
    default:
      return absurd(r);
  }
}

function absurd(x: never): never {
  throw new Error(`unhandled reading ${JSON.stringify(x)}`);
}

function clientParts(items: readonly Client[]): Parts {
  return {
    records: items.map((c) =>
      record(
        NETWORK_ENDPOINT,
        "inventory_info",
        c.id,
        c.name,
        defined({
          kind: c.kind,
          mac: c.mac,
          ip: c.ip,
          site: c.site,
          uplink: c.uplink,
          guest: c.guest,
          connected_at: c.connectedAt,
        }),
      ),
    ),
    assets: items.map((c) => ({
      kind: "client",
      id: c.id,
      name: c.name,
      ...at(c),
      facts: facts({ type: c.kind, ip: c.ip, mac: c.mac, guest: c.guest }),
    })),
    devices: [],
  };
}

function deviceParts(items: readonly NetworkDevice[]): Parts {
  return {
    records: items.map((d) =>
      record(
        COMPUTER_NETWORK_NODE,
        "inventory_info",
        d.id,
        d.name,
        defined({
          kind: d.kind,
          model: d.model,
          mac: d.mac,
          ip: d.ip,
          state: d.state,
          firmware: d.firmware,
          firmware_updatable: d.firmwareUpdatable,
          site: d.site,
          device_class: d.class,
          facets: d.facets?.join(","),
          uplink: d.uplink,
        }),
      ),
    ),
    assets: items.map((d) => ({
      kind: "network-device",
      id: d.id,
      name: d.name,
      ...at(d),
      facts: facts({
        type: d.kind,
        class: d.class,
        model: d.model,
        ip: d.ip,
        state: d.state,
        firmware: d.firmware,
      }),
    })),
    // The estate graph keeps a device of the source `unifi` as a network device, beside the fleet's machines (spec 090).
    devices: items.map((d) => ({
      source: d.source,
      id: d.id,
      name: d.name,
      managed: false,
    })),
  };
}

function vlanParts(items: readonly Vlan[]): Parts {
  return {
    records: items.map((v) =>
      record(
        LOCAL_AREA_NETWORK,
        "cloud_resources_inventory_info",
        v.id,
        v.name,
        defined({
          vlan_id: v.vlanId,
          enabled: v.enabled,
          is_default: v.default,
          management: v.management,
          site: v.site,
          zone: v.zone,
          isolated: v.isolated,
        }),
      ),
    ),
    assets: items.map((v) => ({
      kind: "vlan",
      id: v.id,
      name: v.name,
      ...at(v),
      facts: facts({ vlan: v.vlanId, enabled: v.enabled, default: v.default }),
    })),
    devices: [],
  };
}

function portParts(items: readonly SwitchPort[]): Parts {
  const id = (p: SwitchPort): string => `${p.device}:port-${p.index}`;
  return {
    records: items.map((p) =>
      record(
        NETWORK_INTERFACE,
        "inventory_info",
        id(p),
        `${p.deviceName} port ${p.index}`,
        defined({
          device: p.device,
          device_name: p.deviceName,
          port: p.index,
          state: p.state,
          speed_mbps: p.speedMbps,
          max_speed_mbps: p.maxSpeedMbps,
          connector: p.connector,
          poe_state: p.poeState,
          poe_enabled: p.poeEnabled,
        }),
      ),
    ),
    assets: items.map((p) => ({
      kind: "switch-port",
      id: id(p),
      name: `${p.deviceName} port ${p.index}`,
      ...at(p),
      facts: facts({ state: p.state, speedMbps: p.speedMbps, poe: p.poeState }),
    })),
    devices: [],
  };
}

function firewallParts(items: readonly FirewallRule[]): Parts {
  return {
    records: items.map((r) =>
      record(
        FIREWALL_RULE,
        "cloud_resources_inventory_info",
        r.id,
        r.name,
        defined({
          enabled: r.enabled,
          rule_action: r.action,
          source_zone: r.sourceZone,
          destination_zone: r.destinationZone,
          position: r.index,
          logging: r.logging,
          origin: r.origin,
          site: r.site,
        }),
      ),
    ),
    assets: items.map((r) => ({
      kind: "firewall-rule",
      id: r.id,
      name: r.name,
      ...at(r),
      facts: facts({ action: r.action, enabled: r.enabled, origin: r.origin }),
    })),
    devices: [],
  };
}

function wifiParts(items: readonly WifiNetwork[]): Parts {
  return {
    records: items.map((w) =>
      record(
        NETWORK,
        "cloud_resources_inventory_info",
        w.id,
        w.name,
        defined({
          kind: "wifi",
          enabled: w.enabled,
          security: w.security,
          frequencies_ghz: w.frequenciesGHz.join(","),
          guest: w.guest,
          site: w.site,
          broadcast_by: w.broadcastBy === undefined ? "all" : w.broadcastBy.join(","),
          network: w.network,
          client_isolation: w.clientIsolation,
        }),
      ),
    ),
    assets: items.map((w) => ({
      kind: "wifi-network",
      id: w.id,
      name: w.name,
      ...at(w),
      facts: facts({ security: w.security, enabled: w.enabled, guest: w.guest }),
    })),
    devices: [],
  };
}

function zoneParts(items: readonly DnsZone[]): Parts {
  return {
    records: items.map((z) =>
      record(
        DOMAIN_NAME,
        "cloud_resources_inventory_info",
        z.id,
        z.name,
        defined({ status: z.status, dnssec: z.dnssec }),
      ),
    ),
    assets: [],
    devices: [],
  };
}

function recordParts(items: readonly DnsRecord[]): Parts {
  return {
    records: items.map((r) =>
      record(DNS_RECORD, "cloud_resources_inventory_info", r.id, r.name, {
        type: r.type,
        content: r.content,
        proxied: r.proxied === true,
      }),
    ),
    assets: [],
    devices: [],
  };
}

function emailDomainParts(items: readonly EmailDomain[]): Parts {
  const id = (d: EmailDomain): string => `email:${d.domain}`;
  return {
    records: items.map((d) =>
      record(
        MAIL_SERVICE,
        "cloud_resources_inventory_info",
        id(d),
        d.domain,
        defined({
          domain: d.domain,
          mx: d.mx.join(","),
          spf: d.spf !== undefined,
          dkim: d.dkim,
          dmarc: d.dmarc !== undefined,
          dmarc_policy: d.dmarc === undefined ? undefined : dmarcPolicy(d.dmarc),
          routing: d.routing,
        }),
      ),
    ),
    assets: items.map((d) => ({
      kind: "email-domain",
      id: id(d),
      name: d.domain,
      facts: facts({
        mx: d.mx.length,
        spf: d.spf !== undefined,
        dkim: d.dkim,
        dmarc: d.dmarc !== undefined,
        routing: d.routing,
      }),
    })),
    devices: [],
  };
}

/** The policy (`p=`) of a DMARC record (RFC 7489 section 6.3), lower case, when it names one. */
export function dmarcPolicy(value: string): string | undefined {
  return /(?:^|;)\s*p\s*=\s*([A-Za-z]+)/.exec(value)?.[1]?.toLowerCase();
}

function emailRouteParts(items: readonly EmailRoute[]): Parts {
  return {
    records: items.map((r) =>
      record(
        EMAIL_RULE,
        "cloud_resources_inventory_info",
        `email-route:${r.zone}:${r.id}`,
        r.name,
        defined({
          zone: r.zone,
          enabled: r.enabled,
          priority: r.priority,
          matches: r.matches.join(","),
          actions: r.actions.join(","),
          destinations: r.destinations,
          catch_all: r.catchAll,
        }),
      ),
    ),
    assets: [],
    devices: [],
  };
}
