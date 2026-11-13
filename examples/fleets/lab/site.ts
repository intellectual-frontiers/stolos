// The example lab's site (spec 028): a UniFi network as typed data. The router
// is the authority (Article 21): change the router first, then this file.
// Names and addresses only, never secrets (Article 13).

import { cidr, ipv4, port, type SiteDef, vlan } from "@stolos/archon/model/site.ts";

export const site: SiteDef = {
  name: "Example Lab",
  gateway: {
    model: "UniFi Cloud Gateway Ultra",
    name: "Lab Cloud Gateway Ultra",
    network: "Default",
  },
  zones: ["Internal", "IoT", "Servers", "DMZ", "Hotspot", "VPN", "External", "Gateway"],

  networks: [
    {
      name: "Default",
      vlan: vlan(1),
      cidr: cidr("10.0.1.0/24"),
      gateway: ipv4("10.0.1.1"),
      zone: "Internal",
      dhcp: { from: ipv4("10.0.1.6"), to: ipv4("10.0.1.254"), leaseSeconds: 86400 },
      // Still names netboot.xyz's old file; Archon answers any name with bootx64.efi.
      netboot: { server: ipv4("10.0.1.157"), file: "netboot.xyz-snponly.efi" },
      mdnsReflect: true,
      ipv6: false,
      notes: "Trusted LAN and UniFi management. DHCP Manual for the network-boot options.",
    },
    {
      name: "IoT",
      vlan: vlan(20),
      cidr: cidr("10.0.20.0/24"),
      gateway: ipv4("10.0.20.1"),
      zone: "IoT",
      dhcp: { from: ipv4("10.0.20.6"), to: ipv4("10.0.20.254") },
      mdnsReflect: true,
      ipv6: false,
      notes: "Smart-home, media, and print devices.",
    },
    {
      name: "Servers",
      vlan: vlan(30),
      cidr: cidr("10.0.30.0/24"),
      gateway: ipv4("10.0.30.1"),
      zone: "Servers",
      dhcp: { from: ipv4("10.0.30.6"), to: ipv4("10.0.30.254") },
      netboot: { server: ipv4("10.0.1.157"), file: "bootx64.efi" },
      mdnsReflect: false,
      ipv6: false,
      notes: "Installed and re-installed by Archon from BOOTPC. DHCP guarding on.",
    },
    {
      name: "DMZ",
      vlan: vlan(40),
      cidr: cidr("10.0.40.0/24"),
      gateway: ipv4("10.0.40.1"),
      zone: "DMZ",
      dhcp: { from: ipv4("10.0.40.6"), to: ipv4("10.0.40.254") },
      mdnsReflect: false,
      ipv6: false,
      notes:
        "Public-facing servers, published only through Cloudflare Tunnel. Device Isolation on. No network boot.",
    },
    {
      name: "Guest",
      vlan: vlan(99),
      cidr: cidr("10.0.2.0/24"),
      gateway: ipv4("10.0.2.1"),
      zone: "Hotspot",
      dhcp: "unifi-managed",
      mdnsReflect: false,
      ipv6: false,
      notes: "Captive-portal Hotspot network for the guest SSID.",
    },
    {
      name: "WireGuard",
      cidr: cidr("10.0.3.0/24"),
      cidr6: "fd00:0:0:3::/64",
      gateway: ipv4("10.0.3.1"),
      zone: "VPN",
      dhcp: "static-per-client",
      mdnsReflect: false,
      ipv6: false,
      notes: "Remote-access VPN clients.",
    },
  ],

  // The custom zone policies (UniFi numbers). The zone matrix's defaults
  // (Internal reaches everything; contained zones only return) are UniFi's.
  policies: [
    {
      id: 1,
      name: "Allow Internal to IoT",
      from: { zone: "Internal" },
      to: { zone: "IoT" },
      protocol: "any",
      action: "allow-return",
      purpose: "Phones and laptops control, cast to, and print on IoT devices",
    },
    {
      id: 2,
      name: "Allow Internal to Servers",
      from: { zone: "Internal" },
      to: { zone: "Servers" },
      protocol: "any",
      action: "allow-return",
      purpose: "Administer internal servers; carries TFTP data replies from BOOTPC",
    },
    {
      id: 3,
      name: "Allow VPN to Servers",
      from: { zone: "VPN" },
      to: { zone: "Servers" },
      protocol: "any",
      action: "allow-return",
      purpose: "Remote SSH and admin access to servers",
    },
    {
      id: 4,
      name: "Allow Servers netboot TFTP to BOOTPC",
      from: { zone: "Servers" },
      to: { zone: "Internal", address: ipv4("10.0.1.157") },
      protocol: "udp",
      ports: [port(69)],
      ipVersion: "ipv4",
      action: "allow",
      purpose: "Network boot, part 1: PXE and GRUB files from Archon over TFTP",
    },
    {
      id: 5,
      name: "Block IoT to Gateway except DNS DHCP NTP mDNS",
      from: { zone: "IoT" },
      to: { zone: "Gateway" },
      protocol: "tcp/udp",
      exceptPorts: [port(53), port(67), port(123), port(5353)],
      action: "block",
      purpose: "IoT can't reach the console UI or SSH",
    },
    {
      id: 6,
      name: "Block Servers to Gateway except DNS DHCP NTP",
      from: { zone: "Servers" },
      to: { zone: "Gateway" },
      protocol: "tcp/udp",
      // The same port-list object as policy 5 ("IoT Gateway Services").
      exceptPorts: [port(53), port(67), port(123), port(5353)],
      action: "block",
      purpose: "The same lockdown for Servers",
    },
    {
      id: 7,
      name: "Allow Servers netboot HTTP to Archon",
      from: { zone: "Servers", cidr: cidr("10.0.30.0/24") },
      to: { zone: "Internal", address: ipv4("10.0.1.157") },
      protocol: "tcp",
      ports: [port(8080)],
      ipVersion: "ipv4",
      action: "allow-return",
      purpose: "Network boot, part 2: installer image, install config, progress reports",
    },
  ],

  dns: {
    upstream: [ipv4("1.1.1.1"), ipv4("9.9.9.9")],
    autoDns: false,
    localRecords: [],
  },

  // Custom, Service Scope Specific (set 2026-11-11). Servers and DMZ stay out (Article 20).
  mdnsProxy: {
    networks: ["Default", "IoT"],
    services: [
      "Amazon Devices",
      "Apple AirPlay",
      "Google Chromecast",
      "Printers",
      "Roku",
      "Spotify Connect",
    ],
  },

  wifi: [
    {
      ssid: "Lab King",
      network: "Default",
      bands: ["2.4", "5", "6"],
      security: "wpa2/wpa3",
      pmf: "optional",
      notes: "Primary trusted SSID",
    },
    {
      ssid: "Lab IoT",
      network: "IoT",
      bands: ["2.4", "5"],
      security: "wpa2",
      pmf: "disabled",
      notes: "For older IoT radios",
    },
    {
      ssid: "Example Guest",
      network: "Guest",
      bands: ["2.4", "5", "6"],
      security: "wpa3",
      pmf: "required",
      guest: true,
      notes: "Hotspot with captive portal; client device isolation on",
    },
  ],

  wireguard: {
    name: "Lab WireGuard",
    listen: port(51820),
    endpoint: "lab.example.net",
    network: "WireGuard",
    clients: [{ name: "Alice Example VPN Client 01", address: ipv4("10.0.3.2") }],
    reach: ["Internal", "Servers", "DMZ", "Hotspot", "Gateway"],
  },

  ddns: {
    provider: "cloudflare",
    record: "lab.example.net",
    type: "A",
    proxied: false,
    zone: "example.net",
  },

  bootServer: {
    host: "BOOTPC",
    address: ipv4("10.0.1.157"),
    network: "Default",
    tftp: port(69),
    http: port(8080),
  },

  devices: [
    {
      name: "UCG Ultra",
      model: "UniFi Cloud Gateway Ultra",
      address: ipv4("10.0.1.1"),
      network: "Default",
      how: "gateway",
    },
    {
      name: "USW-Lite-16-PoE",
      address: ipv4("10.0.1.64"),
      network: "Default",
      how: "unifi-managed",
    },
    {
      name: "BOOTPC",
      model: "Mini PC",
      address: ipv4("10.0.1.157"),
      network: "Default",
      how: "fixed",
    },
  ],

  security: {
    ips: "CyberSecure Standard, Notify and Block, on every network",
    upnp: false,
    portForwards: 0,
    inbound: "UDP 51820 (WireGuard) only",
  },
};
