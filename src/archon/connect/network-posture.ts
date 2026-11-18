/**
 * Spec 111-network-posture: the network as an asset class has posture policies. One **pack** of nine policies runs over the last
 * observation of the routers' controllers (the official UniFi Network 10.3.58 API, read-only, spec 109), the fleet's network assets
 * (spec 110), its tags (spec 108) and its `network.ts`, and says for each: pass, fail, warn, **not observed yet** (spec 117), or accepted
 * (spec 078), with the items it is about, the SCF controls it gives evidence for, an explain code and the fix.
 *
 * What the data cannot support is not a policy: {@link NETWORK_GAPS} lists it with its reason and the field the document lacks. A policy
 * that does not apply (no guest Wi-Fi network, no adopted asset) is listed as not applicable and gives no evidence.
 *
 * ```mermaid
 * flowchart LR
 *   o["observations (estate/&lt;router&gt;.ts)"] --> v["buildNetworkView (110)"]
 *   a["assets, tags, network.ts"] --> p
 *   v --> p["evaluateNetworkPosture: nine policies"]
 *   p --> r["results: pass, fail, warn, unknown, accepted"]
 *   p --> n["not applicable, with the reason"]
 *   g["NETWORK_GAPS: what the API does not give"] -.-> r
 *   r --> use["network check, fleet status, compliance evidence, the console"]
 * ```
 *
 * @example
 * ```ts
 * import { evaluateNetworkPosture } from "./network-posture.ts";
 * import { buildNetworkView } from "./network-view.ts";
 * const view = buildNetworkView({ observations: [], assets: [], machines: [] });
 * const run = evaluateNetworkPosture({ observations: [], assets: [], view, now: 0 });
 * run.results[0]?.status; // "unknown": the router has not been observed yet
 * ```
 *
 * @module
 */
// Spec: 111-network-posture FR-001, FR-002, FR-003, FR-004, FR-005, FR-006, FR-007, FR-008, FR-009, FR-010, FR-011

import type { Acceptance } from "../adopt/adopt.ts";
import { notObservedItem, type PolicyResult } from "../adopt/policy.ts";
import type { ScfId } from "../compliance/scf.ts";
import { acceptRisks } from "../controls/core.ts";
import type { Observation } from "./connector.ts";
import {
  goneFix,
  macKey,
  type NetworkAssetDef,
  type NetworkConfig,
  type ObservedClient,
  type ObservedDevice,
  type ObservedPort,
  type ObservedSsid,
  type ObservedVlan,
  devicesUnread,
  observedPorts,
  readingUnread,
} from "./network-asset.ts";
import type { NetworkView } from "./network-view.ts";

/** One policy of the pack: what it is, what it gives evidence for, and the fields of the pinned document it rests on. */
export interface NetworkPolicyDef {
  /** `network/<word>`: the id a result carries and `controls/accepted.ts` names. */
  id: string;
  /** What it requires, for people. */
  title: string;
  /** The SCF controls it gives evidence for. */
  scf: readonly ScfId[];
  /** The explain code a failing or warning result carries (`stolos explain <code>`). */
  code: string;
  /** The fields of the official API's document (10.3.58) it rests on, as `schema.field`. */
  fields: readonly string[];
  /** How to make it pass. */
  fix: string;
}

/** The pack, in the order its results are shown. */
export const NETWORK_POLICIES: readonly NetworkPolicyDef[] = [
  {
    id: "network/observed",
    title: "The network was observed in the last 7 days",
    scf: ["AST-04", "MON-02"],
    code: "E111-STALE",
    fields: ["observation time"],
    fix: "bun run stolos estate observe unifi",
  },
  {
    id: "network/devices-present",
    title: "Every adopted network asset is still reported by the controller",
    scf: ["AST-04"],
    code: "E111-GONE",
    fields: ["Adopted device overview.id", "Adopted device overview.macAddress"],
    fix: "bun run stolos estate observe unifi (if the device is back), or release the asset: bun run stolos host release <name> (nothing at the controller changes)",
  },
  {
    id: "network/devices-online",
    title: "Every network device is online",
    scf: ["AST-04", "MON-02"],
    code: "E111-OFFLINE",
    fields: ["Adopted device overview.state"],
    fix: "power or reconnect the device (Network application > UniFi Devices), or forget it at the controller if it is gone",
  },
  {
    id: "network/firmware-current",
    title: "No network device has a firmware update waiting",
    scf: ["VPM-08", "VPM-06"],
    code: "E111-FIRMWARE",
    fields: [
      "Adopted device overview.firmwareUpdatable",
      "Adopted device overview.firmwareVersion",
    ],
    fix: "Network application > UniFi Devices > the device > Update (or turn on automatic updates in Settings > Control Plane > Updates)",
  },
  {
    id: "network/wifi-no-open",
    title: "No enabled Wi-Fi network is open (without authentication or encryption)",
    scf: ["NET-24.1", "NET-24"],
    code: "E111-WIFI-OPEN",
    fields: [
      "Wifi broadcast overview.securityConfiguration.type",
      "Wifi broadcast overview.enabled",
      "IntegrationStandardWifiBroadcastOverviewDto.hotspotConfiguration",
    ],
    fix: "Network application > WiFi > the network > Security: WPA3 (or WPA2/WPA3) personal or enterprise; a guest network is a hotspot with a portal",
  },
  {
    id: "network/guest-isolated",
    title: "Every enabled guest Wi-Fi network is on a network isolated from the others",
    scf: ["NET-22", "NET-06"],
    code: "E111-GUEST-ISOLATION",
    fields: [
      "IntegrationStandardWifiBroadcastOverviewDto.hotspotConfiguration",
      "Wifi broadcast overview.network",
      "Gateway managed network details.isolationEnabled",
      "Switch managed network details.isolationEnabled",
      "Wifi broadcast details.clientIsolationEnabled",
    ],
    fix: "Network application > Settings > Networks > the guest network: turn on Isolate Network (and Client Device Isolation on the WiFi network)",
  },
  {
    id: "network/unknown-clients",
    title: "Every client on the network is a machine of the fleet or a known client",
    scf: ["AST-11", "AST-04"],
    code: "E111-UNKNOWN-CLIENT",
    fields: [
      "Client overview.type",
      "Wired client overview.macAddress",
      "Wired client overview.uplinkDeviceId",
    ],
    fix: "bun run stolos pair adopts a machine of the fleet; or list the client in fleets/<fleet>/network.ts: knownClients: [{ mac, name, reason }]",
  },
  {
    id: "network/assets-classified",
    title: "Every network asset has the owner and criticality the fleet requires",
    scf: ["AST-07.1", "AST-05.1"],
    code: "E111-UNOWNED",
    fields: ["tags.ts dimensions", "adopted/<name>/network.ts tags and owner"],
    fix: "bun run stolos tag add <asset> owner:<value> criticality:<value> (the values tags.ts defines)",
  },
  {
    id: "network/unused-poe",
    title: "A port with nothing connected does not supply power over Ethernet",
    scf: ["CFG-03"],
    code: "E111-POE-UNUSED",
    fields: ["Port overview.state", "Port PoE overview.enabled"],
    fix: "Network application > UniFi Devices > the switch > Ports > the port: set PoE off",
  },
];

/** What the pinned API cannot support, and so is reported, never checked: the policy it would be, why not, and the field that is missing. */
export interface NetworkGap {
  /** A word for it. */
  id: string;
  /** The policy it would be. */
  title: string;
  /** Why the official API (10.3.58) cannot support it. */
  reason: string;
  /** The field the document lacks. */
  missing: string;
}

/** The gaps (spec 111-network-posture FR-011): reported with every check and every inventory. */
export const NETWORK_GAPS: readonly NetworkGap[] = [
  {
    id: "management-from-guest",
    title: "The management interface is not reachable from guest networks",
    reason:
      "the document lists firewall policies by zone and filter, has no operation that evaluates what a network can reach and does not say which address is a management interface; saying so would be a guess",
    missing: "reachability between networks; the management address of a device",
  },
  {
    id: "legacy-wifi-security",
    title: "No Wi-Fi network uses WEP or another legacy security",
    reason:
      "the document's security types are OPEN, WPA2_PERSONAL, WPA3_PERSONAL, WPA2_WPA3_PERSONAL and the three enterprise types: WEP cannot be configured or reported, so only OPEN is weak",
    missing: "a security type for WEP or WPA (v1)",
  },
  {
    id: "disabled-ports",
    title: "Disabled ports are on the list the fleet expects",
    reason:
      "a port's state is UP, DOWN or UNKNOWN (the link), with no administrative state, so a disabled port cannot be told from one with nothing connected",
    missing: "Port overview.enabled (an administrative state)",
  },
  {
    id: "firmware-age",
    title: "No firmware is more than N days behind",
    reason:
      "the document gives a device its version and a Boolean `firmwareUpdatable`, with no latest version, release date or vulnerability for a firmware, so how far behind it is cannot be said",
    missing: "the latest firmware version and its release date",
  },
  {
    id: "firewall-effect",
    title: "A firewall rule does not allow what it should not",
    reason:
      "a rule's action, zones and order are read (they are the change events of `network changes`), but the effect of its filters (addresses, ports, applications, schedules) is not evaluated",
    missing: "an evaluation of a firewall policy's effect",
  },
  {
    id: "dhcp-port-forwards-routes",
    title: "DHCP leases, port forwards and routes are as expected",
    reason: "the document has no operation for any of them (spec 110 FR-012)",
    missing: "an operation listing leases, port forwards or routes",
  },
  {
    id: "client-placement",
    title: "A client is on the network and Wi-Fi network it should be",
    reason:
      "the document gives a client its MAC, address, the device it connects through and whether it is a guest, and no port, VLAN or Wi-Fi network",
    missing: "a client's port, VLAN and Wi-Fi network",
  },
];

/** What a result is about. */
export interface NetworkItem {
  /** A device, a Wi-Fi network, a client, a port or an asset. */
  subject: string;
  /** What is found of it. */
  detail: string;
}

/** One policy's result for the network (a {@link PolicyResult} with its items and its code). */
export interface NetworkPolicyResult extends PolicyResult {
  /** The explain code (`stolos explain <code>`); a pass carries it too, so the table of codes is the table of policies. */
  code: string;
  /** What the result is about (the failing, warning or unknown ones; none for a pass). */
  items: NetworkItem[];
  /** The fields of the document it rests on. */
  fields: string[];
}

/** A policy that does not apply, and why. */
export interface NotApplicable {
  /** The policy's id. */
  id: string;
  /** Its title. */
  title: string;
  /** Why nothing applies. */
  reason: string;
}

/** What the pack is given: data only, so that every place that draws a result computes the same. */
export interface PostureInput {
  /** The observations of the routers' connectors. */
  observations: readonly Observation[];
  /** The fleet's network assets. */
  assets: readonly NetworkAssetDef[];
  /** The view over them (spec 110). */
  view: NetworkView;
  /** The fleet's `network.ts`, when it has one. */
  config?: NetworkConfig | undefined;
  /** The fleet's tag dimensions and the tags each asset holds (spec 108); absent where `tags.ts` does not load. */
  tags?:
    { dimensions: readonly string[]; held: ReadonlyMap<string, readonly string[]> } | undefined;
  /** Accepted risks (`controls/accepted.ts`), by `network/<word>`. */
  accepted?: readonly Acceptance[] | undefined;
  /** Only the network assets of this name (and what is connected through them): the choice of `--tag` and `--select`. */
  scope?: ReadonlySet<string> | undefined;
  /** Now (epoch milliseconds). */
  now: number;
}

/** What the pack found. */
export interface PostureRun {
  /** The evidence's subject: `network (<account>)`. */
  subject: string;
  /** The connector the first observation came through (its cadence, its refresh command). */
  connector: string;
  /** When the newest observation was made (ISO), absent when none was. */
  at?: string;
  /** The results, in the order of {@link NETWORK_POLICIES}. */
  results: NetworkPolicyResult[];
  /** The policies that do not apply, each with its reason. */
  notApplicable: NotApplicable[];
  /** What the API cannot support ({@link NETWORK_GAPS}). */
  gaps: readonly NetworkGap[];
  /** What the observations could not read (reported gaps). */
  unread: string[];
  /** The names of the assets the run was scoped to, when it was. */
  scope?: string[];
  /** The input the run was made from, so that the same data can be scoped again (not enumerable: never written out). */
  input: PostureInput;
}

/** How many of each result. */
export interface PostureCounts {
  /** Passing. */
  pass: number;
  /** Failing. */
  fail: number;
  /** Warning (worth doing, or informational). */
  warn: number;
  /** Not observed yet. */
  unknown: number;
  /** Accepted risks. */
  accepted: number;
}

/** The counts of a run. */
export function postureCounts(rs: readonly PolicyResult[]): PostureCounts {
  const n = (s: PolicyResult["status"]): number => rs.filter((r) => r.status === s).length;
  return {
    pass: n("pass"),
    fail: n("fail"),
    warn: n("warn"),
    unknown: n("unknown"),
    accepted: n("accepted"),
  };
}

/** The most items a result's detail names; the rest are counted. */
const NAMED = 5;
/** The most items a result keeps (the console and the JSON list them; a very large network is cut and says so). */
const KEPT = 50;
/** An observation older than this many days is stale (as an adopted machine's). */
const STALE_DAYS = 7;
const DAY = 86_400_000;

/** The devices whose state is a loss of service. */
const OFFLINE_STATES = new Set(["OFFLINE", "CONNECTION_INTERRUPTED", "ISOLATED"]);

const policyOf = (id: string): NetworkPolicyDef => {
  const p = NETWORK_POLICIES.find((x) => x.id === id);
  if (p === undefined) throw new Error(`no network policy ${id}`);
  return p;
};

/** `a, b, c and 2 more`. */
function named(names: readonly string[]): string {
  const shown = names.slice(0, NAMED).join(", ");
  return names.length > NAMED ? `${shown} and ${names.length - NAMED} more` : shown;
}

/** A result of the pack. */
function result(
  id: string,
  status: PolicyResult["status"],
  detail: string,
  items: readonly NetworkItem[] = [],
  fix?: string,
): NetworkPolicyResult {
  const p = policyOf(id);
  const f = status === "pass" ? undefined : (fix ?? p.fix);
  return {
    id: p.id,
    title: p.title,
    scf: [...p.scf],
    status,
    detail,
    ...(f === undefined ? {} : { fix: f }),
    code: p.code,
    items: items.slice(0, KEPT),
    fields: [...p.fields],
  };
}

/** The observation command a waiting policy names. */
const observeCommand = (via: string): string => `bun run stolos estate observe ${via}`;

/**
 * Run the pack. Pure: the same input gives the same results, whether it is made from the working tree, from a commit of the
 * repository (compliance drift) or from a test.
 */
export function evaluateNetworkPosture(i: PostureInput): PostureRun {
  const obs = i.observations;
  const via = obs[0]?.provider ?? "unifi";
  const times = obs.map((o) => Date.parse(o.at)).filter((t) => Number.isFinite(t));
  const at = times.length ? new Date(Math.max(...times)).toISOString() : undefined;
  const notApplicable: NotApplicable[] = [];
  const na = (id: string, reason: string): void => {
    notApplicable.push({ id, title: policyOf(id).title, reason });
  };
  const waiting = (id: string, why: string): NetworkPolicyResult =>
    result(id, "unknown", why, [], observeCommand(via));

  const scope = i.scope;
  const scoped = (name: string | undefined): boolean =>
    scope === undefined || (name !== undefined && scope.has(name));
  const devices: ObservedDevice[] = i.view.devices
    .filter((r) => scope === undefined || (r.asset !== undefined && scoped(r.asset)))
    .map((r) => r.device);
  const deviceIds = new Set(devices.map((d) => d.id));
  const advertised = new Set(
    i.view.edges.filter((e) => e.verb === "advertises" && deviceIds.has(e.from)).map((e) => e.to),
  );
  const ssids: ObservedSsid[] = i.view.ssids.filter(
    (s) => scope === undefined || advertised.has(s.id),
  );
  const clients = i.view.clients.filter(
    (c) => scope === undefined || (c.client.uplink !== undefined && deviceIds.has(c.client.uplink)),
  );
  const ports: ObservedPort[] = obs
    .flatMap(observedPorts)
    .filter((p) => scope === undefined || deviceIds.has(p.device));
  const assets = i.assets.filter((a) => scoped(a.name));
  const unreadBy = (what: Parameters<typeof readingUnread>[1]): boolean =>
    obs.length > 0 && obs.every((o) => readingUnread(o, what));
  const anyUnread = (what: Parameters<typeof readingUnread>[1]): boolean =>
    obs.some((o) => readingUnread(o, what));
  const never = obs.length === 0;
  const neverWords = "the router has not been observed yet";
  const results: NetworkPolicyResult[] = [];

  // network/observed
  {
    if (never) results.push(waiting("network/observed", neverWords));
    else {
      const old = obs.filter((o) => (i.now - Date.parse(o.at)) / DAY > STALE_DAYS);
      results.push(
        old.length
          ? result(
              "network/observed",
              "fail",
              `last observed ${named(old.map((o) => `${o.provider} ${o.at.slice(0, 10)}`))}`,
              old.map((o) => ({ subject: o.provider, detail: `observed ${o.at.slice(0, 10)}` })),
              observeCommand(old[0]?.provider ?? via),
            )
          : result("network/observed", "pass", `last observed ${at?.slice(0, 10) ?? ""}`),
      );
    }
  }

  // network/devices-present
  {
    const id = "network/devices-present";
    const st = i.view.assets.filter((a) => scoped(a.asset.name));
    if (never) results.push(waiting(id, neverWords));
    else if (!st.length)
      na(id, "no network asset is adopted yet (bun run stolos network discover)");
    else {
      const gone = st.filter((a) => a.presence === "gone");
      const unread = st.filter((a) => a.presence === "unread");
      if (gone.length) {
        results.push(
          result(
            id,
            "warn",
            `${gone.length} of ${st.length} asset(s) gone from the integration: ${named(gone.map((g) => g.asset.name))}`,
            gone.map((g) => ({ subject: g.asset.name, detail: goneFix(g.asset) })),
          ),
        );
      } else if (unread.length) {
        results.push(
          waiting(id, `${named(unread.map((u) => u.asset.name))}: ${unread[0]?.why ?? "not read"}`),
        );
      } else {
        results.push(result(id, "pass", `${st.length} asset(s), all reported by the controller`));
      }
    }
  }

  // network/devices-online
  {
    const id = "network/devices-online";
    if (never) results.push(waiting(id, neverWords));
    else if (obs.every(devicesUnread)) results.push(waiting(id, "the devices could not be read"));
    else if (!devices.length) na(id, "the controller reports no device");
    else {
      const off = devices.filter((d) => OFFLINE_STATES.has(d.state));
      const moving = devices.filter((d) => d.state !== "ONLINE" && !OFFLINE_STATES.has(d.state));
      const item = (d: ObservedDevice): NetworkItem => ({
        subject: d.name,
        detail: d.state === "" ? "state not given" : d.state.toLowerCase(),
      });
      if (off.length) {
        results.push(
          result(
            id,
            "fail",
            `${off.length} of ${devices.length} device(s) offline: ${named(off.map((d) => d.name))}`,
            off.map(item),
          ),
        );
      } else if (moving.length) {
        results.push(
          result(
            id,
            "warn",
            `${moving.length} of ${devices.length} device(s) not settled: ${named(moving.map((d) => `${d.name} (${d.state.toLowerCase()})`))}`,
            moving.map(item),
          ),
        );
      } else results.push(result(id, "pass", `${devices.length} device(s) online`));
    }
  }

  // network/firmware-current
  {
    const id = "network/firmware-current";
    if (never) results.push(waiting(id, neverWords));
    else if (obs.every(devicesUnread)) results.push(waiting(id, "the devices could not be read"));
    else if (!devices.length) na(id, "the controller reports no device");
    else {
      const old = devices.filter((d) => d.firmwareUpdatable);
      results.push(
        old.length
          ? result(
              id,
              "warn",
              `${old.length} of ${devices.length} device(s) can be updated: ${named(old.map((d) => `${d.name} (${d.firmware || "version not given"})`))}`,
              old.map((d) => ({
                subject: d.name,
                detail: `${d.firmware || "version not given"}: an update is waiting`,
              })),
            )
          : result(id, "pass", `${devices.length} device(s), none has an update waiting`),
      );
    }
  }

  // network/wifi-no-open
  {
    const id = "network/wifi-no-open";
    if (never) results.push(waiting(id, neverWords));
    else if (unreadBy("wifi")) results.push(waiting(id, "the Wi-Fi networks could not be read"));
    else if (!ssids.length) na(id, "the controller reports no Wi-Fi network");
    else {
      const open = ssids.filter((s) => s.enabled && !s.guest && s.security === "OPEN");
      const blank = ssids.filter((s) => s.enabled && s.security === "");
      if (open.length) {
        results.push(
          result(
            id,
            "fail",
            `${open.length} open Wi-Fi network(s): ${named(open.map((s) => s.name))}`,
            open.map((s) => ({
              subject: s.name,
              detail: "OPEN: no authentication, no encryption",
            })),
          ),
        );
      } else if (blank.length) {
        results.push(waiting(id, `${named(blank.map((s) => s.name))}: the security was not read`));
      } else {
        const on = ssids.filter((s) => s.enabled).length;
        results.push(
          result(id, "pass", `${on} enabled Wi-Fi network(s), none open (guest hotspots excepted)`),
        );
      }
    }
  }

  // network/guest-isolated
  {
    const id = "network/guest-isolated";
    const guests = ssids.filter((s) => s.enabled && s.guest);
    if (never) results.push(waiting(id, neverWords));
    else if (unreadBy("wifi")) results.push(waiting(id, "the Wi-Fi networks could not be read"));
    else if (!guests.length) na(id, "no enabled guest Wi-Fi network (a hotspot)");
    else if (unreadBy("networks")) results.push(waiting(id, "the networks could not be read"));
    else {
      const bad: NetworkItem[] = [];
      const unknown: NetworkItem[] = [];
      let good = 0;
      for (const g of guests) {
        const own =
          g.clientIsolation === undefined
            ? ""
            : g.clientIsolation
              ? "; its clients are isolated from each other"
              : "; its clients are not isolated from each other";
        const v = vlanOf(i.view.vlans, g);
        if (g.network === undefined) {
          unknown.push({ subject: g.name, detail: "the broadcast names no network" });
        } else if (v === undefined) {
          unknown.push({ subject: g.name, detail: `the network ${g.network} was not read` });
        } else if (v.isolated === undefined) {
          unknown.push({
            subject: g.name,
            detail: `the details of network ${v.name} were not read (observe again)`,
          });
        } else if (!v.isolated) {
          bad.push({
            subject: g.name,
            detail: `on network ${v.name}, which is not isolated from the other networks${own}`,
          });
        } else good += 1;
      }
      if (bad.length) {
        results.push(
          result(
            id,
            "fail",
            `${bad.length} of ${guests.length} guest Wi-Fi network(s) not isolated: ${named(bad.map((b) => b.subject))}`,
            bad,
          ),
        );
      } else if (unknown.length) {
        results.push(waiting(id, `${named(unknown.map((u) => `${u.subject}: ${u.detail}`))}`));
      } else {
        results.push(
          result(id, "pass", `${good} guest Wi-Fi network(s), each on an isolated network`),
        );
      }
    }
  }

  // network/unknown-clients
  {
    const id = "network/unknown-clients";
    const declared = i.config?.knownClients;
    const allowed = new Set((declared ?? []).map((k) => macKey(k.mac)));
    if (never) results.push(waiting(id, neverWords));
    else if (unreadBy("clients")) results.push(waiting(id, "the clients could not be read"));
    else {
      const onNetwork = clients.filter((c) => c.client.mac !== undefined && isOnPremises(c.client));
      if (!onNetwork.length) na(id, "the controller reports no wired or wireless client");
      else {
        const unknown = onNetwork.filter(
          (c) => c.match === undefined && !allowed.has(macKey(c.client.mac ?? "")),
        );
        const items = unknown.map((c) => ({
          subject: c.client.name,
          detail: `${c.client.mac ?? ""}${c.client.ip === undefined ? "" : ` at ${c.client.ip}`}${c.uplinkName === undefined ? "" : ` through ${c.uplinkName}`}${c.client.guest ? " (guest)" : ""}`,
        }));
        const words = `${unknown.length} of ${onNetwork.length} client(s) match no machine of the fleet${declared === undefined ? "" : " and are not known clients"}: ${named(unknown.map((c) => c.client.name))}`;
        if (!unknown.length) {
          results.push(
            result(
              id,
              "pass",
              `${onNetwork.length} client(s), each a machine of the fleet${declared === undefined ? "" : " or a known client"}`,
            ),
          );
        } else if (declared === undefined) {
          results.push(
            result(
              id,
              "warn",
              `${words} (informational: declare knownClients in network.ts to make it a failure)`,
              items,
            ),
          );
        } else results.push(result(id, "fail", words, items));
      }
    }
  }

  // network/assets-classified
  {
    const id = "network/assets-classified";
    const defined = i.tags?.dimensions ?? [];
    const explicit = i.config?.requiredTags;
    const need = (explicit ?? ["owner", "criticality"]).filter((d) => defined.includes(d));
    if (!assets.length) na(id, "no network asset is adopted yet (bun run stolos network discover)");
    else if (i.tags === undefined) na(id, "the fleet's tags.ts did not load");
    else if (!need.length) {
      na(
        id,
        "the fleet defines no owner or criticality dimension in tags.ts, and network.ts requires none",
      );
    } else {
      const bad: NetworkItem[] = [];
      for (const a of assets) {
        const held = i.tags.held.get(a.name) ?? [];
        const missing = need.filter(
          (d) => !held.some((t) => t.startsWith(`${d}:`)) && !(d === "owner" && a.owner),
        );
        if (missing.length) {
          bad.push({
            subject: a.name,
            detail: `no ${missing.map((d) => `${d}:*`).join(", ")} tag`,
          });
        }
      }
      results.push(
        bad.length
          ? result(
              id,
              explicit === undefined ? "warn" : "fail",
              `${bad.length} of ${assets.length} asset(s) lack ${need.map((d) => `${d}:*`).join(" or ")}: ${named(bad.map((b) => b.subject))}`,
              bad,
            )
          : result(
              id,
              "pass",
              `${assets.length} asset(s), each with ${need.map((d) => `${d}:*`).join(" and ")}`,
            ),
      );
    }
  }

  // network/unused-poe
  {
    const id = "network/unused-poe";
    if (never) results.push(waiting(id, neverWords));
    else if (unreadBy("ports") && !ports.length) {
      results.push(waiting(id, "the ports could not be read"));
    } else {
      const withPoe = ports.filter((p) => p.poeState !== undefined);
      if (!withPoe.length) na(id, "no port with power over Ethernet was read");
      else if (withPoe.some((p) => p.poeEnabled === undefined)) {
        results.push(
          waiting(
            id,
            "an earlier observation did not read the PoE setting of its ports (observe again)",
          ),
        );
      } else {
        const idle = withPoe.filter((p) => p.state === "DOWN" && p.poeEnabled === true);
        const label = (p: ObservedPort): string => `${p.deviceName} port ${p.index}`;
        results.push(
          idle.length
            ? result(
                id,
                "warn",
                `${idle.length} port(s) supply power with nothing connected: ${named(idle.map(label))}`,
                idle.map((p) => ({ subject: label(p), detail: "link down, PoE enabled" })),
              )
            : result(
                id,
                "pass",
                `${withPoe.length} port(s) with PoE, none enabled without a link${anyUnread("ports") ? " (some ports could not be read)" : ""}`,
              ),
        );
      }
    }
  }

  const accepted = acceptRisks(i.accepted ?? [], results, i.now);
  const run: PostureRun = {
    subject: `network (${[...new Set(obs.map((o) => o.account))].join(", ") || "not observed"})`,
    connector: via,
    ...(at === undefined ? {} : { at }),
    results: accepted,
    notApplicable,
    gaps: NETWORK_GAPS,
    unread: [...new Set(obs.flatMap((o) => o.gaps))],
    ...(scope === undefined ? {} : { scope: [...scope].sort() }),
    input: i,
  };
  // The input is for scoping the same data again; it is not part of what is written out (JSON, exports), which is the results.
  Object.defineProperty(run, "input", { value: i, enumerable: false });
  return run;
}

/** A client that is a device on the premises: wired or wireless (a VPN or Teleport client is a remote session). */
function isOnPremises(c: ObservedClient): boolean {
  return c.kind === "wired" || c.kind === "wireless";
}

/** The network a Wi-Fi network carries: the default network for `native`, else the one with the id. */
function vlanOf(vlans: readonly ObservedVlan[], s: ObservedSsid): ObservedVlan | undefined {
  if (s.network === undefined) return undefined;
  return s.network === "native"
    ? vlans.find((v) => v.via === s.via && v.default)
    : vlans.find((v) => v.via === s.via && v.id === s.network);
}

/** The one waiting item (spec 117-adopted-in-status) of what was not observed yet, or undefined. */
export function postureWaiting(
  run: Pick<PostureRun, "results" | "connector">,
): { message: string; fix: string; code: string } | undefined {
  return notObservedItem(run.results, observeCommand(run.connector));
}

/** The results that fail (exit 1), by the pack's own words. */
export const failing = (rs: readonly PolicyResult[]): boolean =>
  rs.some((r) => r.status === "fail");
