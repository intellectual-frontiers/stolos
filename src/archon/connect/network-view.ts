/**
 * Spec 110-network-assets: the network as the fleet sees it, from the connectors' last observations and the fleet's own records: the
 * devices (adopted or only discovered), the clients (matched to the fleet's machines by MAC, or unmanaged), the VLANs and Wi-Fi networks,
 * the edges the official API gives (uplink, connected-to, member-of, advertises), what it does not give (the gaps), and the counts by class.
 * It is one pure function over data, so the console, `stolos fleet status` and the tests draw the same view.
 *
 * ```mermaid
 * flowchart LR
 *   o["observations (router connectors)"] --> v["buildNetworkView"]
 *   a["assets (adopted/&lt;name&gt;/network.ts)"] --> v
 *   m["machines: names, MACs, addresses"] --> v
 *   v --> d["devices, discovered, gone"] & c["clients: matched, unmanaged"] & e["edges"] & g["gaps"]
 * ```
 *
 * @example
 * ```ts
 * import { buildNetworkView } from "./network-view.ts";
 * const v = buildNetworkView({ observations: [], assets: [], machines: [] });
 * v.devices.length; // 0
 * ```
 *
 * @module
 */
// Spec: 110-network-assets FR-005, FR-006, FR-007, FR-009, FR-012

import type { Observation } from "./connector.ts";
import {
  type AssetStatus,
  type NetworkAssetDef,
  type ObservedClient,
  type ObservedDevice,
  type ObservedSsid,
  type ObservedVlan,
  macKey,
  notAdopted,
  observedClients,
  observedDevices,
  observedSsids,
  observedVlans,
  reconcile,
} from "./network-asset.ts";
import type { NetworkFacts } from "../model/tags.ts";
import { DEVICE_CLASSES, type DeviceClass } from "./network-class.ts";

/** A machine of the fleet, as far as the network cares: its name and how a client may be matched to it. */
export interface MachineKey {
  /** Its name in the fleet. */
  name: string;
  /** Its MAC addresses, where it records them (a check-in, a host's registration). */
  macs?: readonly string[];
  /** Its address, the fallback where it records no MAC. */
  address?: string;
}

/** What the integration gives of the verbs of the estate graph, the edge of the topology. */
export interface NetworkEdge {
  /** `uplinked_to`, `connected_to`, `member_of` or `advertises` (the estate graph's verbs). */
  verb: "uplinked_to" | "connected_to" | "member_of" | "advertises";
  /** The id of where it starts (a device, a client, a Wi-Fi network, an access point). */
  from: string;
  /** The id of where it ends. */
  to: string;
}

/** A client matched to a machine of the fleet. */
export interface ClientMatch {
  /** The client. */
  client: ObservedClient;
  /** The machine it is. */
  machine: string;
  /** How: by MAC, or (the fallback, said so) by address. */
  by: "mac" | "address";
  /** The name of the device it is connected through. */
  uplinkName?: string;
}

/** One device, as the Network page lists it. */
export interface DeviceRow {
  /** What the controller says. */
  device: ObservedDevice;
  /** The fleet's name for it, when it is adopted. */
  asset?: string;
  /** The Wi-Fi networks it broadcasts. */
  ssids: string[];
  /** The name of the device it connects through. */
  uplinkName?: string;
  /** How many clients are connected through it. */
  clients: number;
}

/** What the integration does not give, said once, for the Network page and the guide (spec 110-network-assets FR-012). */
export const NOT_GIVEN: readonly string[] = [
  "DHCP leases, port forwards and routes: the official API (10.3.58) has no operation for them",
  "a client's port, its VLAN and the Wi-Fi network it is on: the API gives a client its MAC, address and the device it connects through, and nothing more",
  "a device's serial number: the API gives the MAC, the model and the firmware",
];

/** The Network page's data: everything the observations and the records say, in one place. */
export interface NetworkView {
  /** The router-kind connectors that were observed, each with the account and when. */
  connectors: Array<{ id: string; account: string; at: string }>;
  /** Every device the controller reports. */
  devices: DeviceRow[];
  /** The assets against the observations (present, gone, unread). */
  assets: AssetStatus[];
  /** Devices the controller reports that no asset records: discovered via the integration. */
  discovered: ObservedDevice[];
  /** The assets that are gone from the integration. */
  gone: AssetStatus[];
  /** Every client, with the machine it matched when it did. */
  clients: Array<{ client: ObservedClient; match?: ClientMatch; uplinkName?: string }>;
  /** The clients no machine of the fleet matches. */
  unmanaged: ObservedClient[];
  /** The machines a client matched, by machine name. */
  matches: Map<string, ClientMatch>;
  /** The networks (VLANs). */
  vlans: ObservedVlan[];
  /** The Wi-Fi networks. */
  ssids: ObservedSsid[];
  /** The edges the API gave. */
  edges: NetworkEdge[];
  /** What the observations could not read, and what the API does not give. */
  gaps: string[];
  /** How many devices of each class the fleet has adopted. */
  counts: Array<{ class: DeviceClass; adopted: number; discovered: number }>;
}

/** Match clients to machines: by MAC first, then (said so) by address; each machine and each client at most once. */
export function matchClients(
  clients: readonly ObservedClient[],
  machines: readonly MachineKey[],
  deviceName: (id: string) => string | undefined = () => undefined,
): { matches: Map<string, ClientMatch>; unmanaged: ObservedClient[] } {
  const matches = new Map<string, ClientMatch>();
  const taken = new Set<ObservedClient>();
  const attach = (m: MachineKey, c: ObservedClient, by: "mac" | "address"): void => {
    const uplinkName = c.uplink === undefined ? undefined : deviceName(c.uplink);
    matches.set(m.name, {
      client: c,
      machine: m.name,
      by,
      ...(uplinkName === undefined ? {} : { uplinkName }),
    });
    taken.add(c);
  };
  for (const m of machines) {
    const keys = new Set((m.macs ?? []).map(macKey).filter(Boolean));
    if (!keys.size) continue;
    const c = clients.find((x) => !taken.has(x) && x.mac !== undefined && keys.has(macKey(x.mac)));
    if (c) attach(m, c, "mac");
  }
  for (const m of machines) {
    if (matches.has(m.name) || m.address === undefined) continue;
    const c = clients.find((x) => !taken.has(x) && x.ip !== undefined && x.ip === m.address);
    if (c) attach(m, c, "address");
  }
  return { matches, unmanaged: clients.filter((c) => !taken.has(c)) };
}

/** The view of the network: the observations of the router connectors, the fleet's assets, and the machines clients may match. */
export function buildNetworkView(i: {
  /** The observations of the connectors that are routers. */
  observations: readonly Observation[];
  /** The fleet's network assets. */
  assets: readonly NetworkAssetDef[];
  /** The fleet's machines, for matching clients. */
  machines: readonly MachineKey[];
}): NetworkView {
  const devices = i.observations.flatMap(observedDevices);
  const clients = i.observations.flatMap(observedClients);
  const ssids = i.observations.flatMap(observedSsids);
  const vlans = i.observations.flatMap(observedVlans);
  const assets = reconcile(i.assets, i.observations);
  const byId = new Map(devices.map((d) => [d.id, d]));
  const nameOf = (id: string): string | undefined => byId.get(id)?.name;
  const assetOf = (d: ObservedDevice): NetworkAssetDef | undefined =>
    i.assets.find(
      (a) =>
        a.via === d.via &&
        (a.deviceId === d.id || (d.mac !== "" && macKey(a.mac) === macKey(d.mac))),
    );
  const { matches, unmanaged } = matchClients(clients, i.machines, nameOf);
  const matchOf = new Map([...matches.values()].map((m) => [m.client, m]));
  const apIds = new Set(devices.filter((d) => d.facets.includes("wireless")).map((d) => d.id));

  const edges: NetworkEdge[] = [];
  for (const d of devices) {
    if (d.uplink !== undefined && byId.has(d.uplink)) {
      edges.push({ verb: "uplinked_to", from: d.id, to: d.uplink });
    }
  }
  for (const c of clients) {
    if (c.uplink !== undefined && byId.has(c.uplink)) {
      edges.push({ verb: "connected_to", from: c.id, to: c.uplink });
    }
  }
  const vlanIds = new Set(vlans.map((v) => v.id));
  for (const s of ssids) {
    const by = s.broadcastBy ?? [...apIds];
    for (const ap of by) if (byId.has(ap)) edges.push({ verb: "advertises", from: ap, to: s.id });
    if (s.network !== undefined && (s.network === "native" || vlanIds.has(s.network))) {
      edges.push({ verb: "member_of", from: s.id, to: s.network });
    }
  }
  const ssidsOf = (d: ObservedDevice): string[] =>
    ssids
      .filter((s) => (s.broadcastBy === undefined ? apIds.has(d.id) : s.broadcastBy.includes(d.id)))
      .map((s) => s.name);

  const rows: DeviceRow[] = devices.map((d) => {
    const asset = assetOf(d);
    const up = d.uplink === undefined ? undefined : nameOf(d.uplink);
    return {
      device: d,
      ...(asset === undefined ? {} : { asset: asset.name }),
      ssids: d.facets.includes("wireless") ? ssidsOf(d) : [],
      ...(up === undefined ? {} : { uplinkName: up }),
      clients: clients.filter((c) => c.uplink === d.id).length,
    };
  });
  const discovered = notAdopted(devices, i.assets);
  const counts = DEVICE_CLASSES.map((c) => ({
    class: c,
    adopted: i.assets.filter((a) => a.class === c).length,
    discovered: discovered.filter((d) => d.class === c).length,
  })).filter((c) => c.adopted || c.discovered);
  return {
    connectors: i.observations.map((o) => ({ id: o.provider, account: o.account, at: o.at })),
    devices: rows,
    assets,
    discovered,
    gone: assets.filter((a) => a.presence === "gone"),
    clients: clients.map((c) => {
      const match = matchOf.get(c);
      const up = c.uplink === undefined ? undefined : nameOf(c.uplink);
      return {
        client: c,
        ...(match === undefined ? {} : { match }),
        ...(up === undefined ? {} : { uplinkName: up }),
      };
    }),
    unmanaged,
    matches,
    vlans,
    ssids,
    edges,
    gaps: [...new Set(i.observations.flatMap((o) => o.gaps))],
    counts,
  };
}

/**
 * What a rule over network facts may look at for each machine of the fleet (spec 110-network-assets FR-010): a network asset has its
 * class, facets, uplink (by name), the Wi-Fi networks it broadcasts and the VLANs they carry; a machine a client matches has the name of
 * the device it is connected through.
 */
export function networkFactsFor(view: NetworkView): Map<string, NetworkFacts> {
  const out = new Map<string, NetworkFacts>();
  const vlanNames = new Map(view.vlans.map((v) => [v.id, v]));
  for (const row of view.devices) {
    if (row.asset === undefined) continue;
    const names = new Set<string>();
    for (const s of view.ssids.filter((x) => row.ssids.includes(x.name))) {
      if (s.network === undefined) continue;
      const v =
        s.network === "native" ? view.vlans.find((x) => x.default) : vlanNames.get(s.network);
      if (v) {
        names.add(v.name);
        names.add(v.id);
      }
    }
    out.set(row.asset, {
      class: row.device.class,
      facets: row.device.facets,
      model: row.device.model,
      ...(row.uplinkName === undefined ? {} : { uplink: row.uplinkName }),
      ...(row.ssids.length ? { ssids: row.ssids } : {}),
      ...(names.size ? { vlans: [...names] } : {}),
    });
  }
  for (const [machine, m] of view.matches) {
    if (m.uplinkName !== undefined && !out.has(machine)) out.set(machine, { uplink: m.uplinkName });
  }
  return out;
}
