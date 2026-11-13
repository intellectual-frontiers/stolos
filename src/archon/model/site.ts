// The site (spec 028, constitution Article 21): the UniFi network as typed
// data. Archon checks hosts against it and renders the network reference from
// it, but never changes the router: the owner (or the network assistant)
// changes the router, then this model is updated to match. The data is
// fleets/<fleet>/site.ts; this file is the ontology and its rules.
//
// Addresses, prefixes, VLANs, and ports are branded types: a plain string or
// number does not type-check where an IPv4 is expected, and the constructors
// (ipv4(), cidr(), vlan(), port()) reject a malformed literal when the model
// loads, before anything is rendered (Article 10).

declare const BRAND: unique symbol;
type Brand<T, B extends string> = T & { readonly [BRAND]: B };

export type IPv4 = Brand<string, "IPv4">;
export type Cidr = Brand<string, "Cidr">;
export type VlanId = Brand<number, "VlanId">;
export type Port = Brand<number, "Port">;

const OCTET = "(25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)";
const IPV4_RE = new RegExp(`^${OCTET}(\\.${OCTET}){3}$`);

export function ipv4(s: string): IPv4 {
  if (!IPV4_RE.test(s)) throw new Error(`site: '${s}' is not an IPv4 address`);
  return s as IPv4;
}

export function cidr(s: string): Cidr {
  const [a, bits] = s.split("/");
  if (!IPV4_RE.test(a) || !/^\d+$/.test(bits ?? "") || Number(bits) > 32) {
    throw new Error(`site: '${s}' is not an IPv4 prefix (a.b.c.d/n)`);
  }
  return s as Cidr;
}

export function vlan(n: number): VlanId {
  if (!Number.isInteger(n) || n < 1 || n > 4094) {
    throw new Error(`site: VLAN ${n} is not 1 to 4094`);
  }
  return n as VlanId;
}

export function port(n: number): Port {
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new Error(`site: port ${n} is not 1 to 65535`);
  }
  return n as Port;
}

const toInt = (ip: string) => ip.split(".").reduce((a, o) => (a << 8) + Number(o), 0) >>> 0;

/** Is the address inside the prefix? */
export function inCidr(ip: IPv4 | string, c: Cidr | string): boolean {
  const [net, bits] = c.split("/");
  const b = Number(bits);
  const mask = b === 0 ? 0 : (~0 << (32 - b)) >>> 0;
  return ((toInt(ip) & mask) >>> 0) === ((toInt(net) & mask) >>> 0);
}

// ------------------------------------------------------------------ ontology

/** UniFi's firewall zones as this site uses them (a closed set; Gateway is UniFi's own). */
export type Zone =
  | "Internal"
  | "IoT"
  | "Servers"
  | "DMZ"
  | "Hotspot"
  | "VPN"
  | "External"
  | "Gateway";

export interface SiteNetwork {
  name: string;
  /** Absent for a VPN, which has no VLAN. */
  vlan?: VlanId;
  cidr: Cidr;
  /** A VPN's IPv6 prefix (ULA), when it has one. */
  cidr6?: string;
  gateway: IPv4;
  zone: Zone;
  dhcp: { from: IPv4; to: IPv4; leaseSeconds?: number } | "unifi-managed" | "static-per-client";
  /** UniFi's Network Boot (DHCP next-server and file). */
  netboot?: { server: IPv4; file: string };
  /** In the gateway's mDNS proxy (reflector) scope. Never for Servers or DMZ (Article 20). */
  mdnsReflect: boolean;
  /** Does this network route IPv6 to hosts? (spec 009: apt and Postfix use IPv4 only when not.) */
  ipv6: boolean;
  notes?: string;
}

export interface FirewallPolicy {
  /** UniFi's policy number, as listed in the network reference. */
  id: number;
  name: string;
  from: { zone: Zone; network?: string; cidr?: Cidr };
  to: { zone: Zone; address?: IPv4 };
  protocol: "tcp" | "udp" | "tcp/udp" | "any";
  /** Ports matched, or matched by exception ("all ports except"). */
  ports?: Port[];
  exceptPorts?: Port[];
  ipVersion?: "ipv4" | "both";
  action: "allow" | "allow-return" | "block";
  purpose: string;
}

export interface LocalDnsRecord {
  name: string;
  address: IPv4;
}

export interface WifiNetwork {
  ssid: string;
  network: string;
  bands: Array<"2.4" | "5" | "6">;
  security: "wpa2" | "wpa2/wpa3" | "wpa3";
  pmf: "disabled" | "optional" | "required";
  /** Hotspot (captive portal) SSIDs: guests. */
  guest?: boolean;
  notes?: string;
}

export interface Device {
  name: string;
  model?: string;
  address: IPv4;
  network: string;
  /** How the address is kept. */
  how: "gateway" | "unifi-managed" | "fixed" | "dhcp";
}

export interface SiteDef {
  name: string;
  gateway: { model: string; name: string; network: string };
  zones: Zone[];
  networks: SiteNetwork[];
  policies: FirewallPolicy[];
  dns: {
    /** The gateway's upstream resolvers (Auto DNS Server off). */
    upstream: IPv4[];
    autoDns: boolean;
    localRecords: LocalDnsRecord[];
  };
  mdnsProxy: {
    /** Networks in the proxy's scope, by name. */
    networks: string[];
    /** The services UniFi repeats (Service Scope: Specific), by UniFi's names. */
    services: string[];
  };
  wifi: WifiNetwork[];
  /** Names and endpoints only: keys stay in UniFi and on the clients. */
  wireguard?: {
    name: string;
    listen: Port;
    endpoint: string;
    network: string;
    clients: Array<{ name: string; address: IPv4 }>;
    reach: Zone[];
  };
  /** Names only: the token stays in UniFi. */
  ddns?: { provider: "cloudflare"; record: string; type: "A"; proxied: boolean; zone: string };
  bootServer: { host: string; address: IPv4; network: string; tftp: Port; http: Port };
  devices: Device[];
  security: { ips: string; upnp: boolean; portForwards: number; inbound: string };
}

// --------------------------------------------------------------- validation

export interface SiteProblem {
  where: string;
  message: string;
  fix: string;
}

/** What a host contributes to the site checks. */
export interface SiteHost {
  name: string;
  network?: string;
  ip?: string;
  dnsName?: string;
}

/**
 * The site's rules (spec 028). Each problem names what to change, in the model
 * or (Article 21) in UniFi by the owner, then in the model to match.
 */
export function validateSite(
  site: SiteDef,
  hosts: SiteHost[],
  o: { collector?: string } = {},
): SiteProblem[] {
  const p: SiteProblem[] = [];
  const add = (where: string, message: string, fix: string) => p.push({ where, message, fix });
  const net = (name: string) => site.networks.find((n) => n.name === name);
  const boot = site.bootServer;
  const bootNet = net(boot.network);

  for (const n of site.networks) {
    if (!site.zones.includes(n.zone)) {
      add(
        `site.networks.${n.name}`,
        `zone ${n.zone} is not one of the site's zones`,
        "add it to site.zones or fix the network's zone",
      );
    }
    if (!inCidr(n.gateway, n.cidr)) {
      add(
        `site.networks.${n.name}`,
        `gateway ${n.gateway} is outside ${n.cidr}`,
        "fix the gateway or the prefix to match UniFi",
      );
    }
    // Servers and DMZ never in the mDNS reflector (Article 20, router side).
    if (
      (n.zone === "Servers" || n.zone === "DMZ") &&
      (n.mdnsReflect || site.mdnsProxy.networks.includes(n.name))
    ) {
      add(
        `site.networks.${n.name}`,
        `${n.name} (${n.zone}) is in the mDNS proxy's scope`,
        "UniFi: Settings > Networks > Global Network Settings > mDNS: remove it from the scope; then set mdnsReflect: false",
      );
    }
    // A network that boots from Archon needs two policies to the boot server,
    // unless it is in the boot server's own zone.
    if (n.netboot) {
      if (n.netboot.server !== boot.address) {
        add(
          `site.networks.${n.name}.netboot`,
          `Network Boot points at ${n.netboot.server}, not the boot server ${boot.address}`,
          `UniFi: Settings > Networks > ${n.name} > DHCP > Network Boot: ${boot.address} / bootx64.efi; then update the model`,
        );
      }
      if (bootNet && n.zone !== bootNet.zone) {
        const reaches = (proto: "udp" | "tcp", portNo: number) =>
          site.policies.some((x) =>
            x.from.zone === n.zone && x.to.address === boot.address &&
            (x.action === "allow" || x.action === "allow-return") &&
            (x.protocol === proto || x.protocol === "tcp/udp") &&
            (x.ports ?? []).includes(portNo as Port)
          );
        for (
          const [proto, portNo, what] of [["udp", boot.tftp, "TFTP"], [
            "tcp",
            boot.http,
            "HTTP",
          ]] as const
        ) {
          if (!reaches(proto, portNo)) {
            add(
              `site.policies`,
              `${n.name} boots from ${boot.address} but no policy allows ${n.zone} to reach it on ${proto.toUpperCase()} ${portNo} (${what})`,
              `UniFi: Settings > Policy Engine > Zones > Create Policy: ${n.zone} to Internal ${boot.address}, ${proto.toUpperCase()} ${portNo}, IPv4, Allow; then add it to site.policies`,
            );
          }
        }
      }
    }
  }
  for (const s of site.mdnsProxy.networks) {
    if (!net(s)) {
      add("site.mdnsProxy.networks", `no network named ${s}`, "use a name from site.networks");
    }
  }

  // Fixed addresses: unique, and inside their network.
  const fixed: Array<{ who: string; address: string; network?: string }> = [
    ...site.devices.map((d) => ({
      who: `device ${d.name}`,
      address: d.address,
      network: d.network,
    })),
    ...hosts.filter((h) => h.ip).map((h) => ({
      who: `host ${h.name}`,
      address: h.ip!,
      network: h.network,
    })),
  ];
  const seen = new Map<string, string>();
  for (const f of fixed) {
    const other = seen.get(f.address);
    if (other && other !== f.who) {
      add(
        f.who,
        `${f.address} is also ${other}`,
        "give each a distinct address (UniFi: Client > Settings > Fixed IP)",
      );
    }
    seen.set(f.address, f.who);
    const n = f.network ? net(f.network) : undefined;
    if (f.network && !n) {
      add(f.who, `network ${f.network} is not in the site`, "use a name from site.networks");
    } else if (n && !inCidr(f.address, n.cidr)) {
      add(
        f.who,
        `${f.address} is outside ${n.name} (${n.cidr})`,
        `pick an address in ${n.cidr}, or the right network`,
      );
    }
  }
  const bootDev = site.devices.find((d) => d.name === boot.host);
  if (bootDev && bootDev.address !== boot.address) {
    add(
      "site.bootServer",
      `${boot.host} is at ${bootDev.address}, but the boot server is ${boot.address}`,
      "make them the same",
    );
  }

  // Wi-Fi: a guest SSID is WPA3 only.
  for (const w of site.wifi) {
    if (!net(w.network)) {
      add(
        `site.wifi.${w.ssid}`,
        `network ${w.network} is not in the site`,
        "use a name from site.networks",
      );
    }
    if (w.guest && w.security !== "wpa3") {
      add(
        `site.wifi.${w.ssid}`,
        `guest Wi-Fi uses ${w.security}`,
        "UniFi: WiFi > the guest SSID > Security: WPA3 only; then update the model",
      );
    }
  }

  // Names: every host's DNS name, and the collector's, are Local DNS records (Article 20).
  const records = new Map(site.dns.localRecords.map((r) => [r.name, r.address]));
  for (const h of hosts) {
    if (!h.dnsName) continue;
    const at = records.get(h.dnsName);
    if (!at) {
      add(
        `host ${h.name}`,
        `${h.dnsName} is not in the router's Local DNS`,
        `UniFi: Settings > Routing > DNS (Policy Table) > Create Entry: ${h.dnsName} A ${
          h.ip ?? "<its address>"
        }; then add it to site.dns.localRecords`,
      );
    } else if (h.ip && at !== h.ip) {
      add(
        `host ${h.name}`,
        `${h.dnsName} points at ${at}, but the host is ${h.ip}`,
        "fix the Local DNS record in UniFi, then the model",
      );
    }
  }
  if (o.collector && !records.has(o.collector)) {
    add(
      "site.dns.localRecords",
      `${o.collector} (the OpenTelemetry collector, spec 024) is not in the router's Local DNS`,
      `UniFi: create the Local DNS record ${o.collector} for the collector's address; then add it to site.dns.localRecords`,
    );
  }
  for (const r of site.dns.localRecords) {
    if (!site.networks.some((n) => inCidr(r.address, n.cidr))) {
      add(
        `site.dns.${r.name}`,
        `${r.address} is in none of the site's networks`,
        "fix the record's address",
      );
    }
  }
  return p;
}

/** Hosts' network, in the site (for networkOf, spec 009). */
export function siteNetwork(
  site: SiteDef | undefined,
  name: string | undefined,
): SiteNetwork | undefined {
  return name ? site?.networks.find((n) => n.name === name) : undefined;
}
