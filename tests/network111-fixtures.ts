/**
 * Spec 111-network-posture: observations of a router made from the typed entities the integration layer reads (spec 109), so a test of the
 * posture pack feeds it records as the connector writes them, never hand-made ones. Documentation addresses only (192.0.2.0/24,
 * 10.0.0.0/16, example.net).
 *
 * @module
 */

import type { Observation } from "../src/archon/connect/connector.ts";
import {
  type Client,
  entityParts,
  type FirewallRule,
  type NetworkDevice,
  type SwitchPort,
  type Vlan,
  type WifiNetwork,
} from "../src/archon/connect/integration-entities.ts";
import type { NetworkAssetDef } from "../src/archon/connect/network-asset.ts";
import { buildNetworkView, type MachineKey } from "../src/archon/connect/network-view.ts";
import {
  evaluateNetworkPosture,
  type PostureInput,
  type PostureRun,
} from "../src/archon/connect/network-posture.ts";

/** What a fixture overrides: a member set to `undefined` is taken away (the API did not give it). */
export type Over<T> = { [K in keyof T]?: T[K] | undefined };

/** `base` with `over` laid over it; a member of `over` that is `undefined` is removed. */
function laid<T extends object>(base: T, over: Over<T>): T {
  const out = { ...base } as Record<string, unknown>;
  for (const [k, v] of Object.entries(over)) {
    if (v === undefined) delete out[k];
    else out[k] = v;
  }
  return out as T;
}

/** A device of the controller. */
export const device = (id: string, name: string, over: Over<NetworkDevice> = {}): NetworkDevice =>
  laid<NetworkDevice>(
    {
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
      firmwareUpdatable: false,
      class: "other",
      facets: [],
    },
    over,
  );

/** The gateway, a switch and an access point, linked by uplinks. */
export const GW = device("g1", "Gateway", {
  class: "gateway",
  facets: ["routing"],
  model: "UDM-Pro",
});
export const SW = device("s2", "Office Switch", {
  class: "switch",
  facets: ["switching"],
  model: "USW-24",
  uplink: "g1",
  hasPorts: true,
});
export const AP = device("a3", "AP Hall", {
  class: "access-point",
  facets: ["wireless"],
  model: "U7-Pro",
  uplink: "s2",
});

/** A client, numbered (its id, MAC and address follow the number). */
export const client = (n: number, name: string, over: Over<Client> = {}): Client =>
  laid<Client>(
    {
      source: "unifi",
      id: `c${n}`,
      name,
      kind: "wired",
      mac: `02:00:00:00:10:${n.toString(16).padStart(2, "0")}`,
      ip: `10.0.0.${n}`,
      uplink: "s2",
    },
    over,
  );

/** A Wi-Fi network. */
export const wifi = (id: string, name: string, over: Partial<WifiNetwork> = {}): WifiNetwork => ({
  source: "unifi",
  id,
  name,
  enabled: true,
  security: "WPA3_PERSONAL",
  frequenciesGHz: [5],
  guest: false,
  broadcastBy: ["a3"],
  ...over,
});

/** A network. */
export const vlan = (id: string, name: string, over: Partial<Vlan> = {}): Vlan => ({
  source: "unifi",
  id,
  name,
  vlanId: 1,
  enabled: true,
  default: false,
  ...over,
});

/** A port. */
export const port = (index: number, over: Over<SwitchPort> = {}): SwitchPort =>
  laid<SwitchPort>(
    {
      source: "unifi",
      device: "s2",
      deviceName: "Office Switch",
      index,
      state: "UP",
      maxSpeedMbps: 1000,
      connector: "RJ45",
      poeState: "UP",
      poeEnabled: true,
    },
    over,
  );

/** A firewall rule. */
export const rule = (id: string, name: string, over: Partial<FirewallRule> = {}): FirewallRule => ({
  source: "unifi",
  id,
  name,
  enabled: true,
  action: "block",
  origin: "user",
  ...over,
});

/** What an observation is made of. */
export interface Parts {
  devices?: NetworkDevice[];
  clients?: Client[];
  wifi?: WifiNetwork[];
  vlans?: Vlan[];
  ports?: SwitchPort[];
  rules?: FirewallRule[];
  gaps?: string[];
  at?: string;
}

/** An observation of a router, from entities, as the connector writes it. */
export function observation(p: Parts = {}): Observation {
  const parts = [
    entityParts({ kind: "router", capability: "devices", items: p.devices ?? [GW, SW, AP] }),
    entityParts({ kind: "router", capability: "clients", items: p.clients ?? [] }),
    entityParts({ kind: "router", capability: "wifi", items: p.wifi ?? [] }),
    entityParts({ kind: "router", capability: "networks-and-vlans", items: p.vlans ?? [] }),
    entityParts({ kind: "router", capability: "ports", items: p.ports ?? [] }),
    entityParts({ kind: "router", capability: "firewall-rules", items: p.rules ?? [] }),
  ];
  return {
    at: p.at ?? "2026-11-18T12:00:00Z",
    provider: "unifi",
    account: "192.0.2.1",
    assets: [],
    posture: {},
    gaps: p.gaps ?? [],
    records: parts.flatMap((x) => x.records),
  };
}

/** An adopted network asset. */
export const asset = (
  name: string,
  deviceId: string,
  over: Partial<NetworkAssetDef> = {},
): NetworkAssetDef => ({
  name,
  via: "unifi",
  account: "192.0.2.1",
  deviceId,
  mac: `02:00:00:00:00:0${deviceId.slice(-1)}`,
  class: "switch",
  model: "USW-24",
  adopted: "2026-11-18T12:00:00Z",
  joined: "integration",
  ...over,
});

/** The pack over an observation, the way the command runs it (a view over the observation, the assets and the machines). */
export function run(
  obs: Observation | undefined,
  o: Partial<Omit<PostureInput, "observations" | "view">> & { machines?: MachineKey[] } = {},
): PostureRun {
  const observations = obs === undefined ? [] : [obs];
  const assets = o.assets ?? [];
  const view = buildNetworkView({ observations, assets, machines: o.machines ?? [] });
  const { machines: _machines, ...rest } = o;
  return evaluateNetworkPosture({
    observations,
    assets,
    view,
    now: Date.parse("2026-11-19T12:00:00Z"),
    ...rest,
  });
}
