/**
 * Spec 110-network-assets: the Stolos Console's Network page (present only where a router is connected), its topology and tables, a
 * device's page with the link to the native console, the machines table's class and badge, a network asset's and a client's machine
 * page, the Overview's Network card, and the machines CSV.
 *
 * @module
 */

import { assert, assertEquals, assertStringIncludes, proves } from "@intellectual-frontiers/test";
import type { Observation } from "../src/archon/connect/connector.ts";
import { entityParts } from "../src/archon/connect/integration-entities.ts";
import type {
  Client,
  NetworkDevice,
  WifiNetwork,
} from "../src/archon/connect/integration-entities.ts";
import { buildNetworkView } from "../src/archon/connect/network-view.ts";
import type { NetworkAssetDef } from "../src/archon/connect/network-asset.ts";
import { assetPolicies } from "../src/archon/connect/network-asset.ts";
import {
  networkDevicePage,
  networkPage,
  openInUnifi,
  withNetworkNav,
} from "../src/archon/console/network-page.ts";
import {
  machinePage,
  machinesCsv,
  machinesPage,
  STOLOS_NAV,
  stolosOverview,
} from "../src/archon/console/stolos-pages.ts";
import type { PcFacts } from "../src/archon/console/pc.ts";
import { FACTS, fakeConsole } from "./console/serve-stolos.ts";

/** Markup with its whitespace collapsed (the formatter wraps template text). */
const flat = (s: string): string => s.replace(/\s+/g, " ");

const dev = (id: string, name: string, over: Partial<NetworkDevice>): NetworkDevice => ({
  source: "unifi",
  site: "Default",
  id,
  name,
  kind: "other",
  model: "X",
  mac: `02:00:00:00:00:0${id.slice(-1)}`,
  ip: `192.0.2.${id.slice(-1)}`,
  state: "ONLINE",
  firmware: "7.0.1",
  class: "other",
  facets: [],
  ...over,
});
const GW = dev("g1", "Gateway", { class: "gateway", facets: ["routing"], model: "UDM-Pro" });
const SW = dev("s2", "Office Switch", {
  class: "switch",
  facets: ["switching"],
  model: "USW-24",
  uplink: "g1",
});
const AP = dev("a3", "AP Hall", {
  class: "access-point",
  facets: ["wireless"],
  model: "U7-Pro",
  uplink: "s2",
});
const clients: Client[] = [
  {
    source: "unifi",
    id: "c1",
    name: "front-desk-pc",
    kind: "wired",
    mac: "02:00:00:00:10:10",
    ip: "10.0.0.10",
    uplink: "s2",
  },
  {
    source: "unifi",
    id: "c2",
    name: "<img src=x onerror=alert(1)>",
    kind: "wireless",
    mac: "02:00:00:00:10:11",
    ip: "10.0.0.11",
    uplink: "a3",
  },
];
const wifi: WifiNetwork = {
  source: "unifi",
  id: "w1",
  name: "home",
  enabled: true,
  security: "WPA3_PERSONAL",
  frequenciesGHz: [5],
  guest: false,
  broadcastBy: ["a3"],
};

const OBS: Observation = {
  at: "2026-11-18T12:00:00Z",
  provider: "unifi",
  account: "192.0.2.1",
  assets: [],
  posture: {},
  gaps: [],
  records: [
    ...entityParts({ kind: "router", capability: "devices", items: [GW, SW, AP] }).records,
    ...entityParts({ kind: "router", capability: "clients", items: clients }).records,
    ...entityParts({ kind: "router", capability: "wifi", items: [wifi] }).records,
  ],
};

const ASSET: NetworkAssetDef = {
  name: "office-switch",
  title: "Office Switch",
  via: "unifi",
  account: "192.0.2.1",
  deviceId: "s2",
  mac: "02:00:00:00:00:02",
  class: "switch",
  model: "USW-24",
  adopted: "2026-11-18T12:00:00Z",
  joined: "integration",
};

/** The console's facts with a router connected, one asset adopted (and one gone), and a machine that is a client. */
function withNetwork(over: { gone?: boolean; auto?: boolean } = {}): PcFacts {
  const asset: NetworkAssetDef = { ...ASSET, ...(over.auto ? { auto: true as const } : {}) };
  const view = buildNetworkView({
    observations: [
      over.gone
        ? { ...OBS, records: (OBS.records ?? []).filter((r) => r.native_id !== "s2") }
        : OBS,
    ],
    assets: [asset],
    machines: [{ name: "front-desk", macs: ["02:00:00:00:10:10"] }],
  });
  const st = view.assets[0];
  const results = st ? assetPolicies(st) : [];
  const f = structuredClone(FACTS);
  f.machines.push({
    name: asset.name,
    kind: "device",
    joined: "integration",
    os: "USW-24",
    where: "192.0.2.2",
    seen: OBS.at,
    score: { pass: results.filter((r) => r.status === "pass").length, total: results.length },
    failing: [],
    network: {
      class: "switch",
      facets: ["switching"],
      via: "unifi",
      viaTitle: "UniFi Network",
      account: "192.0.2.1",
      auto: over.auto === true,
      model: "USW-24",
      mac: asset.mac,
      presence: st?.presence ?? "unread",
      firmware: "7.0.1",
      state: "ONLINE",
      uplink: "Gateway",
      deviceId: "s2",
    },
  });
  const fd = f.machines.find((m) => m.name === "front-desk");
  const match = view.matches.get("front-desk");
  if (fd && match) {
    fd.client = { by: match.by, kind: "wired", ip: "10.0.0.10", uplink: match.uplinkName ?? "" };
  }
  f.network = { view, connectors: [{ id: "unifi", title: "UniFi Network", account: "192.0.2.1" }] };
  return f;
}

proves(
  ["110-network-assets FR-008"],
  "110: the Network page has the topology as SVG, tables of devices, clients, VLANs and Wi-Fi, what the API does not give, and escapes what a controller says",
  () => {
    const page = flat(networkPage(withNetwork()).s);
    assertStringIncludes(page, "<svg");
    assertStringIncludes(page, `aria-label="Network topology`);
    assertStringIncludes(page, "tbl-grid");
    for (const id of ["devices", "clients", "vlans", "ssids"])
      assertStringIncludes(page, `id="${id}"`);
    assertStringIncludes(
      page,
      "Office Switch".replace("Office Switch", "office-switch"),
      "an adopted device shows its name in the fleet",
    );
    assertStringIncludes(page, "What the API does not give");
    assertStringIncludes(page, "DHCP leases, port forwards and routes");
    assert(!page.includes("<img src=x"), "a client's name is escaped");
    assertStringIncludes(page, "Open in UniFi");
    // The device page: its facts, the link to the native console built from the controller's address.
    const d = networkDevicePage(withNetwork(), "s2")?.s ?? "";
    assertStringIncludes(d, openInUnifi("192.0.2.1", "02:00:00:00:00:02"));
    assertStringIncludes(
      d,
      "https://192.0.2.1/network/default/devices/properties/02%3A00%3A00%3A00%3A00%3A02",
    );
    assertStringIncludes(d, "USW-24");
    assertEquals(networkDevicePage(withNetwork(), "nope"), undefined);
    // A device gone from the integration is a notice, with its fix, on the page.
    assertStringIncludes(
      networkPage(withNetwork({ gone: true })).s,
      "office-switch is gone from the integration",
    );
  },
);

proves(
  ["110-network-assets FR-002", "110-network-assets FR-009"],
  "110: the machines table shows an asset with its class and the badge naming UniFi (Auto-adopted via UniFi for a rule's), the filter lists the way, and the CSV and Overview carry it",
  () => {
    const f = withNetwork();
    const t = flat(machinesPage(f).s);
    assertStringIncludes(t, "Adopted via UniFi");
    assertStringIncludes(t, "Switch");
    assertStringIncludes(t, `<option value="integration">Via integration</option>`);
    assertStringIncludes(t, `data-joined="integration"`);
    assertStringIncludes(
      flat(machinesPage(withNetwork({ auto: true })).s),
      "Auto-adopted via UniFi",
    );
    const csv = machinesCsv(f);
    assertStringIncludes(csv, "network_class");
    assertStringIncludes(csv, "office-switch,,device,integration");
    assertStringIncludes(csv, ",switch,unifi");
    const o = flat(stolosOverview(f).s);
    assertStringIncludes(o, 'id="network-group"');
    assertStringIncludes(o, "asset(s) (1 switch)");
    assert(
      !stolosOverview(structuredClone(FACTS)).s.includes("network-group"),
      "no Network card without a router",
    );
  },
);

proves(
  ["110-network-assets FR-002", "110-network-assets FR-005", "110-network-assets FR-006"],
  "110: an asset's page says what the controller says, warns when it is gone (kept), and offers Release; a machine matching a client says where the router sees it",
  () => {
    const p = flat(machinePage(withNetwork(), "office-switch")?.s ?? "");
    assertStringIncludes(p, "Adopted via UniFi");
    assertStringIncludes(p, "Open in UniFi");
    assertStringIncludes(p, "host%20release");
    assertStringIncludes(p, "never changes it");
    assert(!p.includes('id="gone"'));
    const gone = flat(machinePage(withNetwork({ gone: true }), "office-switch")?.s ?? "");
    assertStringIncludes(gone, "Gone from the integration");
    const c = flat(machinePage(withNetwork(), "front-desk")?.s ?? "");
    assertStringIncludes(c, "On the network");
    assertStringIncludes(c, "connected through Office Switch");
    assertStringIncludes(c, "by MAC address");
    assertStringIncludes(c, "The API gives no port, VLAN or Wi-Fi network for a client");
  },
);

proves(
  ["110-network-assets FR-008"],
  "110: the Network page and its menu entry exist only where a router is connected",
  async () => {
    assertEquals(
      withNetworkNav(STOLOS_NAV, {}).some((n) => n.href === "/network"),
      false,
    );
    const nav = withNetworkNav(STOLOS_NAV, withNetwork());
    assertEquals(nav.filter((n) => n.href === "/network").length, 1);
    const port = 8110;
    const B = `http://127.0.0.1:${port}`;
    for (const [facts, status] of [
      [() => Promise.resolve(structuredClone(FACTS)), 404],
      [() => Promise.resolve(withNetwork()), 200],
    ] as const) {
      const { handler, launch } = await fakeConsole(port, { facts });
      const r = await handler(
        new Request(`${B}/launch?t=${launch.issue()}`, { headers: { host: `127.0.0.1:${port}` } }),
      );
      const cookie = (r.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
      const get = (p: string) =>
        handler(new Request(B + p, { headers: { host: `127.0.0.1:${port}`, cookie } }));
      assertEquals((await get("/network")).status, status);
      assertEquals((await get("/network/devices/s2")).status, status === 200 ? 200 : 404);
      const home = await (await get("/")).text();
      assertEquals(home.includes('href="/network"'), status === 200);
    }
  },
  { timeout: 180_000 },
);
