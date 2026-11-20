/**
 * Spec 110-network-assets: a device a router's controller manages, as an **asset of the fleet**: adopted through the integration (no SSH,
 * no probe), recorded in Git, tagged and shown like any machine, and read (never changed) from the controller's observation.
 *
 * - **The record** (`fleets/<fleet>/adopted/<name>/network.ts`, `networkAssetSource`, `loadNetworkAssets`) is who it is: the connector it
 *   came through (`via`) and that connector's account, the device's id, MAC and serial (where the API gives one), its class and model, when
 *   it was adopted, `auto: true` where a fleet rule did it, and the tags a person gave it. `loadAdopted` (SSH machines) does not read it.
 * - **The rules** (`fleets/<fleet>/network.ts`, `defineNetwork`): `autoAdopt` rules, typed by the ontology's device classes and validated at
 *   build (`networkProblems`); `estate observe` applies them (`autoAdoptChoices`), writing records that `stolos apply` commits.
 * - **The facts** (firmware, address, state) are the connector's observation (`observedDevices`, `observedClients`), read at every use.
 *   `reconcile` says for each asset whether it is present, **gone from the integration** (a warning, never a deletion) or unread.
 *
 * ```mermaid
 * flowchart LR
 *   obs["observation (spec 109)<br/>devices, clients"] --> disc["discover: not adopted yet"]
 *   disc -->|"stolos network adopt"| rec["adopted/&lt;name&gt;/network.ts"]
 *   rules["network.ts: autoAdopt"] -->|"estate observe"| rec
 *   rec --> rec2["reconcile with the observation"]
 *   obs --> rec2
 *   rec2 --> st["present · gone from the integration · unread"]
 * ```
 *
 * @example
 * ```ts
 * import { deviceLabel } from "./network-asset.ts";
 * deviceLabel("Office Switch 1", "USW-24"); // "office-switch-1"
 * deviceLabel("3rd floor AP", "U6"); // "d-3rd-floor-ap"
 * ```
 *
 * @module
 */
// Spec: 110-network-assets FR-001, FR-002, FR-003, FR-004, FR-005, FR-006
// Spec: 111-network-posture FR-009, FR-010, FR-012, FR-021

import { tsLiteral } from "@intellectual-frontiers/formats";
import { fs, path } from "@intellectual-frontiers/commons/ts/runtime";
import { P } from "../core/paths.ts";
import type { PolicyResult } from "../adopt/policy.ts";
import type { Observation } from "./connector.ts";
import type { ObservedRecord } from "./sdk.ts";
import {
  DEVICE_CLASSES,
  type DeviceClass,
  type DeviceFacet,
  facetsFor,
  parseClass,
} from "./network-class.ts";

/** Six pairs of hexadecimal digits separated by colons. */
const MAC = /^[0-9a-fA-F]{2}(:[0-9a-fA-F]{2}){5}$/;

/** A name that can be a machine's (a DNS label: RFC 1034), the rule of `MACHINE_NAME` in `adopt.ts`. */
export const ASSET_NAME = /^[a-z][a-z0-9-]{0,62}$/;

/** A network asset, as the fleet declares it (`adopted/<name>/network.ts`); `T` is the fleet's own tag ids. */
export interface NetworkAssetDef<T extends string = string> {
  /** Its name in the fleet (a DNS label). */
  name: string;
  /** What it is, for people. */
  title?: string;
  /** Who it belongs to. */
  owner?: string;
  /** The connector it was adopted through (`unifi`). */
  via: string;
  /** What that connector calls the account (the controller's address). */
  account: string;
  /** Its id at the controller. */
  deviceId: string;
  /** Its MAC address, as the controller says it. */
  mac: string;
  /** Its serial number, where the API gives one (the UniFi Network API does not). */
  serial?: string;
  /** Its class (`stolos:DeviceClass`). */
  class: DeviceClass;
  /** Its model, as the controller says it. */
  model: string;
  /** When it was adopted (ISO time). */
  adopted: string;
  /** How it joined: through an integration (`stolos:joined-integration`). */
  joined: "integration";
  /** A fleet rule adopted it (`autoAdopt` in `network.ts`), not a person's command. */
  auto?: true;
  /** The defined tags a person gave it (spec 108), typed by the fleet's own `tags.ts`. */
  tags?: readonly T[];
  /** The free-form tags a person gave it. */
  customTags?: readonly string[];
}

/** One rule of `autoAdopt`: every device of this class (and, if given, of this connector and model prefix) is adopted at the next observation. */
export interface AutoAdoptRule {
  /** The class of devices the rule adopts. */
  class: DeviceClass;
  /** Only devices of this connector (`unifi`). */
  via?: string;
  /** Only devices whose model starts with this (case does not matter). */
  model?: string;
}

/** A MAC address as six pairs of hexadecimal digits separated by colons (`02:00:00:00:10:10`): a typed shape, validated at build. */
export type MacAddress = `${string}:${string}:${string}:${string}:${string}:${string}`;

/** One client the fleet knows and allows on its network (spec 111-network-posture FR-009), by MAC. */
export interface KnownClient {
  /** Its MAC address. */
  readonly mac: MacAddress;
  /** What it is, for people. */
  readonly name?: string;
  /** Why it is allowed, in words an auditor reads. */
  readonly reason?: string;
}

/** A fleet's network settings (`fleets/<fleet>/network.ts`). */
export interface NetworkConfig {
  /** The rules that adopt devices by themselves. */
  readonly autoAdopt: readonly AutoAdoptRule[];
  /**
   * Spec 111-network-posture FR-009: the clients the fleet allows on its network. Declaring the list makes a client that matches no
   * machine and is not on it a failure of `network/unknown-clients` (without it the finding is informational).
   */
  readonly knownClients?: readonly KnownClient[];
  /**
   * Spec 111-network-posture FR-010: the dimensions of the fleet's `tags.ts` every network asset must hold a tag of (an asset with none
   * fails `network/assets-classified`). Without it the fleet's `owner` and `criticality` dimensions are asked for, as a warning.
   */
  readonly requiredTags?: readonly string[];
}

/** A fleet's network settings, typed: a class that is not one of the ontology's, or a field that is not a rule's, does not compile. */
export function defineNetwork<const C extends NetworkConfig>(config: C): C {
  return config;
}

/** An asset that was released, remembered so that a rule does not take it again (`network-released.ts`). */
export interface ReleasedAsset {
  /** The connector. */
  via: string;
  /** Its id at the controller. */
  deviceId: string;
  /** The name it had. */
  name: string;
  /** When it was released (ISO time). */
  at: string;
}

// ------------------------------------------------------------------------------------------------ files

/** `fleets/<fleet>/adopted/<name>/`, where an asset's record is (beside the adopted machines' folders). */
export function assetDir(name: string): string {
  return path.join(P.fleetDir, "adopted", name);
}

/** An asset's record file. */
export function assetFile(name: string): string {
  return path.join(assetDir(name), "network.ts");
}

/** `fleets/<fleet>/network.ts`: the fleet's network settings. */
export function networkConfigFile(): string {
  return path.join(P.fleetDir, "network.ts");
}

/** `fleets/<fleet>/network-released.ts`: the assets a person released (generated). */
export function releasedFile(): string {
  return path.join(P.fleetDir, "network-released.ts");
}

/** An asset's record as the text of its file: a typed literal, `TagId` from the fleet's `tags.ts` where it has tags (spec 108). */
export function networkAssetSource(a: NetworkAssetDef): string {
  const typed = (a.tags?.length ?? 0) > 0;
  return `// A network asset (spec 110-network-assets): a device a router's controller manages, adopted through
// the integration. Stolos reads it and never changes it. Written by \`stolos network adopt\`;
// edit title and owner freely. Firmware, address and state are the connector's observation.

import type { NetworkAssetDef } from "@intellectual-frontiers/stolos/archon/connect/network-asset";
${typed ? `import type { TagId } from "../../tags.ts";\n` : ""}
export const asset: NetworkAssetDef${typed ? "<TagId>" : ""} = ${tsLiteral(a)};
`;
}

/** The text of `network-released.ts`. */
export function releasedSource(list: readonly ReleasedAsset[]): string {
  return `// GENERATED by \`stolos host release\` (spec 110-network-assets): the network assets a person released.
// A rule of network.ts does not adopt them again. Delete a line to let a rule take the device again.

import type { ReleasedAsset } from "@intellectual-frontiers/stolos/archon/connect/network-asset";

export const released: ReleasedAsset[] = ${tsLiteral([...list])};
`;
}

/** Every network asset of the fleet, by name. */
export async function loadNetworkAssets(): Promise<NetworkAssetDef[]> {
  const dir = path.join(P.fleetDir, "adopted");
  const out: NetworkAssetDef[] = [];
  if (!(await fs.exists(dir))) return out;
  const { fleetExport } = await import("../model/load.ts");
  const names: string[] = [];
  for await (const e of fs.readDir(dir)) if (e.isDirectory) names.push(e.name);
  for (const n of names.sort()) {
    const f = path.join(dir, n, "network.ts");
    if (!(await fs.exists(f))) continue;
    const a = await fleetExport<NetworkAssetDef>(f, "asset", true);
    if (a) out.push(a);
  }
  return out;
}

/** The fleet's network settings, none when it has no `network.ts`, or why it did not load. */
export async function loadNetworkConfig(): Promise<{ config?: NetworkConfig; error?: string }> {
  const f = networkConfigFile();
  if (!(await fs.exists(f))) return {};
  try {
    const { fleetExport } = await import("../model/load.ts");
    const config = await fleetExport<NetworkConfig>(f, "network", true);
    if (!config || typeof config !== "object" || !Array.isArray(config.autoAdopt)) {
      return {
        error:
          "network.ts does not export `network` (export const network = defineNetwork({ autoAdopt: [...] }))",
      };
    }
    return { config };
  } catch (e) {
    return { error: `network.ts does not load: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/** The assets a person released. */
export async function loadReleased(): Promise<ReleasedAsset[]> {
  const f = releasedFile();
  if (!(await fs.exists(f))) return [];
  const { fleetExport } = await import("../model/load.ts");
  return (await fleetExport<ReleasedAsset[]>(f, "released", true)) ?? [];
}

/** What is wrong with a fleet's network settings, each with where and the fix (the shape `stolos build` reports). */
export function networkProblems(
  config: NetworkConfig | undefined,
  known: readonly string[] = [],
  dimensions?: readonly string[],
): Array<{ where: string; message: string; fix: string }> {
  const out: Array<{ where: string; message: string; fix: string }> = [];
  (config?.autoAdopt ?? []).forEach((r, i) => {
    const where = `network.ts autoAdopt[${i}]`;
    if (!DEVICE_CLASSES.includes(r.class)) {
      out.push({
        where,
        message: `${String(r.class)} is not a device class`,
        fix: `one of: ${DEVICE_CLASSES.join(", ")}`,
      });
    }
    if (r.via !== undefined && known.length && !known.includes(r.via)) {
      out.push({
        where,
        message: `via "${r.via}" is not a connector`,
        fix: `one of: ${known.join(", ")}`,
      });
    }
    const extra = Object.keys(r).filter((k) => !["class", "via", "model"].includes(k));
    if (extra.length) {
      out.push({
        where,
        message: `${extra.join(", ")} is not a field of a rule`,
        fix: "a rule has class, and optionally via and model",
      });
    }
  });
  const seen = new Set<string>();
  (config?.knownClients ?? []).forEach((k, i) => {
    const where = `network.ts knownClients[${i}]`;
    if (typeof k?.mac !== "string" || !MAC.test(k.mac)) {
      out.push({
        where,
        message: `${String(k?.mac)} is not a MAC address`,
        fix: "six pairs of hexadecimal digits separated by colons, for example 02:00:00:00:10:10",
      });
      return;
    }
    const key = macKey(k.mac);
    if (seen.has(key)) {
      out.push({
        where,
        message: `${k.mac} is listed twice`,
        fix: "list each client once",
      });
    }
    seen.add(key);
    const extraKeys = Object.keys(k).filter((x) => !["mac", "name", "reason"].includes(x));
    if (extraKeys.length) {
      out.push({
        where,
        message: `${extraKeys.join(", ")} is not a field of a known client`,
        fix: "a known client has mac, and optionally name and reason",
      });
    }
  });
  (config?.requiredTags ?? []).forEach((d, i) => {
    const where = `network.ts requiredTags[${i}]`;
    if (typeof d !== "string" || !/^[a-z][a-z0-9-]{0,19}$/.test(d)) {
      out.push({
        where,
        message: `${String(d)} is not a tag dimension`,
        fix: "the id of a dimension of tags.ts (owner, criticality, ...)",
      });
    } else if (dimensions !== undefined && !dimensions.includes(d)) {
      out.push({
        where,
        message: `${d} is not a dimension of tags.ts`,
        fix: dimensions.length
          ? `one of: ${dimensions.join(", ")}`
          : "define it in tags.ts, or remove it",
      });
    }
  });
  return out;
}

/**
 * What `stolos build` says of the network: `network.ts` loads and its rules are sound (a class of the ontology, a connector that
 * exists), and each asset's record is a record of its kind (a name of a machine, a class of the ontology, joined through an integration).
 */
export async function networkBuildProblems(): Promise<
  Array<{ where: string; message: string; fix: string }>
> {
  const out: Array<{ where: string; message: string; fix: string }> = [];
  const { config, error } = await loadNetworkConfig();
  if (error) {
    out.push({ where: "network.ts", message: error, fix: "fix fleets/<fleet>/network.ts" });
  }
  let ids: string[] = [];
  try {
    const { allConnectors } = await import("./commands.ts");
    ids = (await allConnectors())
      .filter((c) => c.integrationKinds?.includes("router"))
      .map((c) => c.id);
  } catch {
    // Without the connectors the rule's `via` is not checked; its class still is.
  }
  let dimensions: string[] | undefined;
  try {
    const { loadTagSet } = await import("../fleet/tags.ts");
    const { set } = await loadTagSet();
    if (set) dimensions = Object.keys(set.dimensions);
  } catch {
    // Without the tags the dimensions named in requiredTags are not checked; a tags.ts that does not load is reported by its own check.
  }
  out.push(...networkProblems(config, ids, dimensions));
  for (const a of await loadNetworkAssets().catch(() => [])) {
    const where = `adopted/${a.name}/network.ts`;
    if (!ASSET_NAME.test(a.name)) {
      out.push({
        where,
        message: `${a.name} is not a name (a DNS label)`,
        fix: "lowercase letters, digits and hyphens",
      });
    }
    if (!DEVICE_CLASSES.includes(a.class)) {
      out.push({
        where,
        message: `${String(a.class)} is not a device class`,
        fix: `one of: ${DEVICE_CLASSES.join(", ")}`,
      });
    }
    if (a.joined !== "integration") {
      out.push({
        where,
        message: "joined must be integration",
        fix: "stolos network adopt writes it",
      });
    }
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ names

/**
 * A machine name from a device's name: lowercase, anything that is not a letter or digit becomes a hyphen (RFC 1034: a label), a name
 * that would start with a digit gets `d-` first, and an empty name falls back to the model.
 */
export function deviceLabel(name: string, model = ""): string {
  const clean = (s: string): string =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .replace(/^(\d)/, "d-$1")
      .slice(0, 63)
      .replace(/-+$/, "");
  return clean(name) || clean(model) || "device";
}

// ------------------------------------------------------------------------------------------------ what was observed

/** A device as the last observation says it is. */
export interface ObservedDevice {
  /** The connector it was read through. */
  via: string;
  /** The connector's account (the controller's address). */
  account: string;
  /** Its id at the controller. */
  id: string;
  /** Its name there. */
  name: string;
  /** Its MAC address. */
  mac: string;
  /** Its address. */
  ip: string;
  /** Its state (ONLINE, OFFLINE, ...). */
  state: string;
  /** Its model. */
  model: string;
  /** Its firmware version. */
  firmware: string;
  /** A firmware update is waiting. */
  firmwareUpdatable: boolean;
  /** Its class. */
  class: DeviceClass;
  /** Its facets. */
  facets: DeviceFacet[];
  /** The id of the device it connects through, where the API gave one. */
  uplink?: string;
  /** The site it is in. */
  site?: string;
  /** Its serial number, where the API gave one. */
  serial?: string;
}

/** A client as the last observation says it is. */
export interface ObservedClient {
  /** The connector it was read through. */
  via: string;
  /** Its id at the controller. */
  id: string;
  /** Its name there. */
  name: string;
  /** wired, wireless, vpn or teleport. */
  kind: string;
  /** Its MAC address (a VPN client has none). */
  mac?: string;
  /** Its address. */
  ip?: string;
  /** The id of the device it is connected through. */
  uplink?: string;
  /** It is a guest. */
  guest?: boolean;
  /** When it connected (ISO). */
  connectedAt?: string;
  /** The site. */
  site?: string;
}

/** A Wi-Fi network as the last observation says it is. */
export interface ObservedSsid {
  /** The connector. */
  via: string;
  /** Its id. */
  id: string;
  /** The SSID. */
  name: string;
  /** It is on. */
  enabled: boolean;
  /** How it is secured. */
  security: string;
  /** It is a guest network. */
  guest: boolean;
  /** The ids of the access points that broadcast it; undefined: every access point does. */
  broadcastBy?: string[];
  /** The id of the network it carries (`native`: the default one). */
  network?: string;
  /** Spec 111-network-posture FR-012: the broadcast's details say its clients are isolated from each other (undefined: not read). */
  clientIsolation?: boolean;
  /** The site. */
  site?: string;
}

/** A network (VLAN) as the last observation says it is. */
export interface ObservedVlan {
  /** The connector. */
  via: string;
  /** Its id. */
  id: string;
  /** Its name. */
  name: string;
  /** Its VLAN id (IEEE 802.1Q). */
  vlanId: number;
  /** It is on. */
  enabled: boolean;
  /** It is the default network. */
  default: boolean;
  /** The site. */
  site?: string;
  /** Spec 111-network-posture FR-012: the network's details say it is isolated from all other networks (undefined: not read). */
  isolated?: boolean;
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);
const bool = (v: unknown): boolean | undefined => (typeof v === "boolean" ? v : undefined);

const recordsOf = (o: Observation, label: string): ObservedRecord[] =>
  (o.records ?? []).filter((r) => r.label === label);

/** The devices of an observation (the records labelled `computer_network_node`), each with its class and facets (classified again where an older observation has none). */
export function observedDevices(o: Observation): ObservedDevice[] {
  return recordsOf(o, "computer_network_node").map((r) => {
    const p = r.props;
    const cls = parseClass(str(p["device_class"]) ?? "") ?? "other";
    const facets = (str(p["facets"]) ?? "")
      .split(",")
      .filter(Boolean)
      .map((f) => f as DeviceFacet);
    const uplink = str(p["uplink"]);
    const site = str(p["site"]);
    const serial = str(p["serial"]);
    return {
      via: o.provider,
      account: o.account,
      id: r.native_id,
      name: r.display_name,
      mac: str(p["mac"]) ?? "",
      ip: str(p["ip"]) ?? "",
      state: str(p["state"]) ?? "",
      model: str(p["model"]) ?? "",
      firmware: str(p["firmware"]) ?? "",
      firmwareUpdatable: bool(p["firmware_updatable"]) ?? false,
      class: cls,
      facets: facets.length ? facets : facetsFor(cls),
      ...(uplink === undefined ? {} : { uplink }),
      ...(site === undefined ? {} : { site }),
      ...(serial === undefined ? {} : { serial }),
    };
  });
}

/** The clients of an observation (the records labelled `network_endpoint`). */
export function observedClients(o: Observation): ObservedClient[] {
  return recordsOf(o, "network_endpoint").map((r) => {
    const p = r.props;
    const mac = str(p["mac"]);
    const ip = str(p["ip"]);
    const uplink = str(p["uplink"]);
    const guest = bool(p["guest"]);
    const at = str(p["connected_at"]);
    const site = str(p["site"]);
    return {
      via: o.provider,
      id: r.native_id,
      name: r.display_name,
      kind: str(p["kind"]) ?? "wired",
      ...(mac === undefined ? {} : { mac }),
      ...(ip === undefined ? {} : { ip }),
      ...(uplink === undefined ? {} : { uplink }),
      ...(guest === undefined ? {} : { guest }),
      ...(at === undefined ? {} : { connectedAt: at }),
      ...(site === undefined ? {} : { site }),
    };
  });
}

/** The Wi-Fi networks of an observation (the records labelled `network` of kind `wifi`). */
export function observedSsids(o: Observation): ObservedSsid[] {
  return recordsOf(o, "network")
    .filter((r) => r.props["kind"] === "wifi")
    .map((r) => {
      const p = r.props;
      const by = str(p["broadcast_by"]);
      const network = str(p["network"]);
      const site = str(p["site"]);
      return {
        via: o.provider,
        id: r.native_id,
        name: r.display_name,
        enabled: bool(p["enabled"]) ?? true,
        security: str(p["security"]) ?? "",
        guest: bool(p["guest"]) ?? false,
        ...(by === undefined || by === "all" ? {} : { broadcastBy: by.split(",") }),
        ...(network === undefined ? {} : { network }),
        ...(bool(p["client_isolation"]) === undefined
          ? {}
          : { clientIsolation: bool(p["client_isolation"]) === true }),
        ...(site === undefined ? {} : { site }),
      };
    });
}

/** The networks (VLANs) of an observation (the records labelled `local_area_network`). */
export function observedVlans(o: Observation): ObservedVlan[] {
  return recordsOf(o, "local_area_network").map((r) => {
    const p = r.props;
    const site = str(p["site"]);
    return {
      via: o.provider,
      id: r.native_id,
      name: r.display_name,
      vlanId: typeof p["vlan_id"] === "number" ? p["vlan_id"] : 0,
      enabled: bool(p["enabled"]) ?? true,
      default: bool(p["is_default"]) ?? false,
      ...(bool(p["isolated"]) === undefined ? {} : { isolated: bool(p["isolated"]) === true }),
      ...(site === undefined ? {} : { site }),
    };
  });
}

/** A port of a switch or gateway as the last observation says it is (spec 111-network-posture FR-010). */
export interface ObservedPort {
  /** The connector. */
  via: string;
  /** The id of the device it is on. */
  device: string;
  /** The name of the device it is on. */
  deviceName: string;
  /** Its index on the device. */
  index: number;
  /** UP, DOWN or UNKNOWN. */
  state: string;
  /** RJ45, SFP, ... */
  connector: string;
  /** Whether it supplies power now (UP, DOWN, LIMITED), when it can. */
  poeState?: string;
  /** PoE is enabled on it (undefined: the port has no PoE, or the observation was written before it was read). */
  poeEnabled?: boolean;
}

/** The ports of an observation (the records labelled `network_interface`). */
export function observedPorts(o: Observation): ObservedPort[] {
  return recordsOf(o, "network_interface").map((r) => {
    const p = r.props;
    const poeState = str(p["poe_state"]);
    const poeEnabled = bool(p["poe_enabled"]);
    return {
      via: o.provider,
      device: str(p["device"]) ?? "",
      deviceName: str(p["device_name"]) ?? "",
      index: typeof p["port"] === "number" ? p["port"] : 0,
      state: str(p["state"]) ?? "",
      connector: str(p["connector"]) ?? "",
      ...(poeState === undefined ? {} : { poeState }),
      ...(poeEnabled === undefined ? {} : { poeEnabled }),
    };
  });
}

/** A firewall rule of the controller as the last observation says it is (spec 111-network-posture FR-018). */
export interface ObservedFirewallRule {
  /** The connector. */
  via: string;
  /** Its id. */
  id: string;
  /** Its name. */
  name: string;
  /** It is on. */
  enabled: boolean;
  /** allow, block or reject. */
  action: string;
  /** The name of the zone traffic comes from. */
  sourceZone?: string;
  /** The name of the zone traffic goes to. */
  destinationZone?: string;
  /** Who made it (system, user, derived). */
  origin: string;
}

/** The firewall rules of an observation (the records labelled `firewall_rule`). */
export function observedFirewall(o: Observation): ObservedFirewallRule[] {
  return recordsOf(o, "firewall_rule").map((r) => {
    const p = r.props;
    const from = str(p["source_zone"]);
    const to = str(p["destination_zone"]);
    return {
      via: o.provider,
      id: r.native_id,
      name: r.display_name,
      enabled: bool(p["enabled"]) ?? true,
      action: str(p["rule_action"]) ?? "",
      ...(from === undefined ? {} : { sourceZone: from }),
      ...(to === undefined ? {} : { destinationZone: to }),
      origin: str(p["origin"]) ?? "",
    };
  });
}

/** What an observation can fail to read: a reading of the router that became a reported gap (spec 111-network-posture FR-002). */
export type Reading = "devices" | "clients" | "networks" | "wifi" | "ports" | "firewall";

const UNREAD: Record<Reading, RegExp> = {
  devices: /^devices(\s|:|$)/,
  clients: /^clients(\s|:|$)/,
  networks: /^(networks|networks-and-vlans)(\s|:|$)/,
  wifi: /^(wifi|wifi broadcasts)(\s|:|$)/,
  ports: /^(ports|[^:]* details)(\s|:|$)/,
  firewall: /^(firewall|firewall-rules|firewall policies)(\s|:|$)/,
};

/** Whether an observation could not make a reading (a gap names it): what it says of it is then not a statement of absence. */
export function readingUnread(o: Observation, what: Reading): boolean {
  return o.gaps.some((g) => UNREAD[what].test(g));
}

/** Whether an observation could not read the devices (a gap that starts with `devices`): what it says of them is then not a statement of absence. */
export function devicesUnread(o: Observation): boolean {
  return o.gaps.some((g) => /^devices(\s|:|$)/.test(g));
}

// ------------------------------------------------------------------------------------------------ MACs

/** A MAC address as one comparable word: lower case, no separators. */
export function macKey(mac: string): string {
  return mac.toLowerCase().replace(/[^0-9a-f]/g, "");
}

// ------------------------------------------------------------------------------------------------ adoption

/** A device that is discovered: it is read by the integration, and no asset records it yet. */
export function notAdopted(
  devices: readonly ObservedDevice[],
  assets: readonly NetworkAssetDef[],
): ObservedDevice[] {
  const have = new Set(assets.map((a) => `${a.via}\n${a.deviceId}`));
  const macs = new Set(assets.map((a) => `${a.via}\n${macKey(a.mac)}`));
  return devices.filter(
    (d) => !have.has(`${d.via}\n${d.id}`) && !macs.has(`${d.via}\n${macKey(d.mac)}`),
  );
}

/** What choosing devices to adopt came to: the records to write, and what was refused with why. */
export interface AdoptionPlan {
  /** The records to write. */
  records: NetworkAssetDef[];
  /** A device that was not adopted, and the plain reason. */
  refused: Array<{ what: string; why: string }>;
}

/**
 * The records for some devices. A name is the device's name made a DNS label; a name that a machine, a host or an asset has, or that two
 * of these devices share, is **refused** (a plain message, nothing written for it), never changed to make room.
 */
export function planAdoption(
  devices: readonly ObservedDevice[],
  taken: ReadonlySet<string>,
  o: { now?: Date; auto?: boolean } = {},
): AdoptionPlan {
  const at = (o.now ?? new Date()).toISOString().replace(/\.\d+Z$/, "Z");
  const used = new Set(taken);
  const plan: AdoptionPlan = { records: [], refused: [] };
  for (const d of devices) {
    const name = deviceLabel(d.name, d.model);
    if (!ASSET_NAME.test(name)) {
      plan.refused.push({
        what: d.name,
        why: `${d.name} cannot be made a machine name (${name}): rename it at the controller`,
      });
      continue;
    }
    if (used.has(name)) {
      plan.refused.push({
        what: d.name,
        why: `${name} is already a machine, a host or an asset of this fleet: rename the device at the controller (or the other machine), then adopt it`,
      });
      continue;
    }
    used.add(name);
    plan.records.push({
      name,
      title: d.name,
      via: d.via,
      account: d.account,
      deviceId: d.id,
      mac: d.mac,
      ...(d.serial === undefined ? {} : { serial: d.serial }),
      class: d.class,
      model: d.model,
      adopted: at,
      joined: "integration",
      ...(o.auto ? { auto: true as const } : {}),
    });
  }
  return plan;
}

/** The devices a person named (by name, MAC or id at the controller), or why one is not found. */
export function chooseDevices(
  devices: readonly ObservedDevice[],
  names: readonly string[],
): { chosen: ObservedDevice[]; missing: string[] } {
  const chosen: ObservedDevice[] = [];
  const missing: string[] = [];
  for (const n of names) {
    const w = n.trim().toLowerCase();
    const hit = devices.find(
      (d) =>
        d.name.toLowerCase() === w ||
        deviceLabel(d.name, d.model) === w ||
        d.id.toLowerCase() === w ||
        (macKey(n) !== "" && macKey(d.mac) === macKey(n)),
    );
    if (hit === undefined) missing.push(n);
    else if (!chosen.includes(hit)) chosen.push(hit);
  }
  return { chosen, missing };
}

/**
 * The devices the fleet's rules adopt: those of a class a rule names (and of its connector and model prefix, where it says), that are
 * not adopted and were not released. Each device once, in the order read.
 */
export function autoAdoptChoices(
  config: NetworkConfig | undefined,
  devices: readonly ObservedDevice[],
  assets: readonly NetworkAssetDef[],
  released: readonly ReleasedAsset[],
): ObservedDevice[] {
  if (!config?.autoAdopt.length) return [];
  const gone = new Set(released.map((r) => `${r.via}\n${r.deviceId}`));
  return notAdopted(devices, assets).filter(
    (d) =>
      !gone.has(`${d.via}\n${d.id}`) &&
      config.autoAdopt.some(
        (r) =>
          r.class === d.class &&
          (r.via === undefined || r.via === d.via) &&
          (r.model === undefined || d.model.toLowerCase().startsWith(r.model.toLowerCase())),
      ),
  );
}

// ------------------------------------------------------------------------------------------------ reconcile

/** Where an asset is against the integration's last observation. */
export type AssetPresence = "present" | "gone" | "unread";

/** One asset against what the integration last said. */
export interface AssetStatus {
  /** The record. */
  asset: NetworkAssetDef;
  /** Present, gone from the integration, or unread (never observed, or its devices could not be read). */
  presence: AssetPresence;
  /** The device as last observed, when present. */
  device?: ObservedDevice;
  /** Why it is unread, in words. */
  why?: string;
}

/**
 * Each asset against the observations: **present** when the controller reports its device (by id, then by MAC), **gone** when the
 * controller was read and does not, and **unread** when it could not be told (the connector was never observed, or its devices were a
 * gap): never gone on a guess. Nothing here deletes anything.
 */
export function reconcile(
  assets: readonly NetworkAssetDef[],
  observations: readonly Observation[],
): AssetStatus[] {
  return assets.map((asset): AssetStatus => {
    const o = observations.find((x) => x.provider === asset.via);
    if (o === undefined) {
      return {
        asset,
        presence: "unread",
        why: `${asset.via} has not been observed yet (stolos estate observe ${asset.via})`,
      };
    }
    if (devicesUnread(o)) {
      return {
        asset,
        presence: "unread",
        why: `the last observation of ${asset.via} could not read the devices`,
      };
    }
    const devices = observedDevices(o);
    const device =
      devices.find((d) => d.id === asset.deviceId) ??
      devices.find((d) => d.mac !== "" && macKey(d.mac) === macKey(asset.mac));
    return device === undefined
      ? { asset, presence: "gone" }
      : { asset, presence: "present", device };
  });
}

/** The fix a person is told for an asset that is gone from the integration. */
export function goneFix(a: NetworkAssetDef): string {
  return `stolos estate observe ${a.via} (if the device is back), or release it: stolos host release ${a.name} (nothing at the controller changes)`;
}

/** The policies of an asset, as any machine has them (spec 110-network-assets FR-005): present, online, firmware current. */
export function assetPolicies(s: AssetStatus): PolicyResult[] {
  const a = s.asset;
  if (s.presence === "unread") {
    return [
      {
        id: "network-asset-present",
        title: "The controller still reports the device",
        scf: ["AST-02", "AST-04"],
        status: "unknown",
        detail: s.why ?? "not read",
        fix: `stolos estate observe ${a.via}`,
      },
    ];
  }
  const present: PolicyResult = {
    id: "network-asset-present",
    title: "The controller still reports the device",
    scf: ["AST-02", "AST-04"],
    status: s.presence === "present" ? "pass" : "warn",
    detail:
      s.presence === "present"
        ? `reported by ${a.via}`
        : `gone from the integration: ${a.via} no longer reports it`,
    ...(s.presence === "gone" ? { fix: goneFix(a) } : {}),
  };
  const d = s.device;
  if (d === undefined) return [present];
  return [
    present,
    {
      id: "network-asset-online",
      title: "The device is online",
      scf: ["AST-04", "MON-02"],
      status: d.state === "ONLINE" ? "pass" : "fail",
      detail: d.state || "state not given",
      fix: "power or reconnect the device (or forget it at the controller if it is gone)",
    },
    {
      id: "network-asset-firmware",
      title: "No firmware update is waiting",
      scf: ["VPM-08"],
      status: d.firmwareUpdatable ? "warn" : "pass",
      detail: d.firmwareUpdatable ? `${d.firmware}: an update is waiting` : d.firmware || "current",
      fix: "update it at the controller (or turn on automatic updates there)",
    },
  ];
}
