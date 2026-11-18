/**
 * Spec 111-network-posture FR-016: the network inventory (NIST SP 800-53 Rev 5 CM-8, system component inventory): every network device
 * the integration reports or the fleet adopted (class, model, firmware, address, state, tags, how it joined, when it was observed), the
 * Wi-Fi networks and the networks, and the gaps, as Markdown or JSON. It is **deterministic**: it holds no time of its own (the time of a
 * device is its observation's) and a stable order, so the same observation and records give the same bytes, and a commit of the file is
 * a record of the inventory.
 *
 * @example
 * ```ts
 * import { buildInventory, inventoryMarkdown } from "./network-inventory.ts";
 * import { buildNetworkView } from "./network-view.ts";
 * const view = buildNetworkView({ observations: [], assets: [], machines: [] });
 * inventoryMarkdown(buildInventory({ view, assets: [] })).includes("Network inventory"); // true
 * ```
 *
 * @module
 */
// Spec: 111-network-posture FR-011, FR-016

import type { NetworkAssetDef } from "./network-asset.ts";
import { CLASS_LABEL } from "./network-class.ts";
import { NETWORK_GAPS } from "./network-posture.ts";
import { NOT_GIVEN, type NetworkView } from "./network-view.ts";

/** How a device is in the fleet. */
export type InventoryJoined = "adopted" | "auto-adopted" | "discovered, not adopted";

/** One device of the inventory. */
export interface InventoryDevice {
  /** Its name (the fleet's, for an adopted one; the controller's otherwise). */
  name: string;
  /** The connector it was read through. */
  via: string;
  /** Its class (`stolos:DeviceClass`), as the label people read. */
  class: string;
  /** Its model. */
  model: string;
  /** Its firmware version. */
  firmware: string;
  /** A firmware update is waiting. */
  updateWaiting: boolean;
  /** Its address. */
  address: string;
  /** Its MAC address. */
  mac: string;
  /** Its state at the controller (`not read`: the controller was not read). */
  state: string;
  /** The name of the device it connects through. */
  uplink: string;
  /** The tags it holds. */
  tags: string[];
  /** How it joined the fleet. */
  joined: InventoryJoined;
  /** Where it is against the integration: present, gone from it, unread, or not adopted. */
  presence: string;
  /** When it was last observed (the observation's time). */
  observed: string;
}

/** The inventory. */
export interface Inventory {
  /** The routers' connectors that were observed, each with the controller's address and when. */
  connectors: Array<{ id: string; account: string; observed: string }>;
  /** Every device. */
  devices: InventoryDevice[];
  /** The Wi-Fi networks. */
  wifi: Array<{ name: string; security: string; guest: boolean; enabled: boolean; via: string }>;
  /** The networks. */
  networks: Array<{
    name: string;
    vlanId: number;
    enabled: boolean;
    default: boolean;
    isolated: string;
    via: string;
  }>;
  /** What the observations could not read, and what the API does not give. */
  gaps: string[];
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The inventory of a view: `tags` are the tags each asset holds, by its name. */
export function buildInventory(i: {
  view: NetworkView;
  assets: readonly NetworkAssetDef[];
  tags?: ReadonlyMap<string, readonly string[]>;
}): Inventory {
  const at = new Map(i.view.connectors.map((c) => [c.id, c.at]));
  const tagsOf = (name: string | undefined): string[] =>
    name === undefined ? [] : [...(i.tags?.get(name) ?? [])].sort(cmp);
  const devices: InventoryDevice[] = [];
  const present = new Set<string>();
  for (const r of i.view.devices) {
    const a = r.asset === undefined ? undefined : i.assets.find((x) => x.name === r.asset);
    if (a !== undefined) present.add(a.name);
    devices.push({
      name: a?.name ?? r.device.name,
      via: r.device.via,
      class: CLASS_LABEL[r.device.class],
      model: r.device.model,
      firmware: r.device.firmware,
      updateWaiting: r.device.firmwareUpdatable,
      address: r.device.ip,
      mac: r.device.mac,
      state: r.device.state || "not given",
      uplink: r.uplinkName ?? "",
      tags: tagsOf(a?.name),
      joined: a === undefined ? "discovered, not adopted" : a.auto ? "auto-adopted" : "adopted",
      presence: a === undefined ? "not adopted" : "present",
      observed: at.get(r.device.via) ?? "",
    });
  }
  // An adopted asset the controller no longer reports (or could not be asked about) is still in the inventory, from its record.
  for (const s of i.view.assets) {
    if (present.has(s.asset.name)) continue;
    const a = s.asset;
    devices.push({
      name: a.name,
      via: a.via,
      class: CLASS_LABEL[a.class],
      model: a.model,
      firmware: "",
      updateWaiting: false,
      address: "",
      mac: a.mac,
      state: "not read",
      uplink: "",
      tags: tagsOf(a.name),
      joined: a.auto ? "auto-adopted" : "adopted",
      presence: s.presence === "gone" ? "gone from the integration" : "unread",
      observed: at.get(a.via) ?? "",
    });
  }
  devices.sort((a, b) => cmp(a.name, b.name) || cmp(a.mac, b.mac));
  return {
    connectors: i.view.connectors
      .map((c) => ({ id: c.id, account: c.account, observed: c.at }))
      .sort((a, b) => cmp(a.id, b.id)),
    devices,
    wifi: i.view.ssids
      .map((s) => ({
        name: s.name,
        security: s.security || "not read",
        guest: s.guest,
        enabled: s.enabled,
        via: s.via,
      }))
      .sort((a, b) => cmp(a.name, b.name) || cmp(a.via, b.via)),
    networks: i.view.vlans
      .map((v) => ({
        name: v.name,
        vlanId: v.vlanId,
        enabled: v.enabled,
        default: v.default,
        isolated: v.isolated === undefined ? "not read" : v.isolated ? "yes" : "no",
        via: v.via,
      }))
      .sort((a, b) => a.vlanId - b.vlanId || cmp(a.name, b.name)),
    gaps: [
      ...[...new Set(i.view.gaps)].sort(cmp),
      ...NOT_GIVEN.filter((g) => g.startsWith("a device's serial")),
      ...NETWORK_GAPS.map((g) => `${g.title}: ${g.reason}`),
    ],
  };
}

const cell = (v: string | number | boolean): string =>
  String(v === true ? "yes" : v === false ? "no" : v)
    .replace(/\|/g, "\\|")
    .replace(/\r?\n/g, " ");

function table(head: string[], rows: Array<Array<string | number | boolean>>): string[] {
  if (!rows.length) return ["None.", ""];
  return [
    `| ${head.join(" | ")} |`,
    `| ${head.map(() => "---").join(" | ")} |`,
    ...rows.map((r) => `| ${r.map(cell).join(" | ")} |`),
    "",
  ];
}

/** The inventory as Markdown. */
export function inventoryMarkdown(inv: Inventory): string {
  const lines: string[] = [
    "# Network inventory",
    "",
    "System component inventory of the network (NIST SP 800-53 Rev 5 CM-8), from the controllers' last observations and the fleet's records. Read-only; Stolos changes nothing at a controller.",
    "",
    "## Sources",
    "",
    ...table(
      ["Connector", "Controller", "Observed"],
      inv.connectors.map((c) => [c.id, c.account, c.observed]),
    ),
    `## Devices (${inv.devices.length})`,
    "",
    ...table(
      [
        "Name",
        "Class",
        "Model",
        "Firmware",
        "Update waiting",
        "Address",
        "MAC",
        "State",
        "Uplink",
        "Tags",
        "How it joined",
        "Against the integration",
        "Observed",
      ],
      inv.devices.map((d) => [
        d.name,
        d.class,
        d.model,
        d.firmware,
        d.updateWaiting,
        d.address,
        d.mac,
        d.state,
        d.uplink,
        d.tags.join(", "),
        d.joined,
        d.presence,
        d.observed,
      ]),
    ),
    `## Wi-Fi networks (${inv.wifi.length})`,
    "",
    ...table(
      ["Name", "Security", "Guest", "Enabled", "Connector"],
      inv.wifi.map((w) => [w.name, w.security, w.guest, w.enabled, w.via]),
    ),
    `## Networks (${inv.networks.length})`,
    "",
    ...table(
      ["Name", "VLAN", "Enabled", "Default", "Isolated", "Connector"],
      inv.networks.map((n) => [n.name, n.vlanId, n.enabled, n.default, n.isolated, n.via]),
    ),
    "## Gaps",
    "",
    ...inv.gaps.map((g) => `- ${g}`),
    "",
  ];
  return lines.join("\n");
}

/** The inventory as JSON (two spaces, a final newline). */
export function inventoryJson(inv: Inventory): string {
  return `${JSON.stringify(inv, null, 2)}\n`;
}
