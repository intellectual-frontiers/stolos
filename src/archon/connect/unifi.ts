/**
 * Spec 109-integrations-api FR-009 to FR-018: UniFi Network, the first `router` of the integration layer. It reads the UniFi Network
 * application's local integration API, in the version Ubiquiti publishes on its official CDN (10.3.58: its OpenAPI 3.1 document is
 * pinned in `vendor/unifi-network/`, and the types of `unifi-api.auto.ts` are generated from it), over a controller's own address with
 * the key the owner creates in the Network application (Settings, Control Plane, Integrations): `X-API-KEY`.
 *
 * - **Only what the document offers.** `unifiGet` and `unifiPaged` take a path of the document's GET operations (`UnifiGet`), so a path the
 *   document does not have, such as a DHCP leases endpoint, does not compile. What the document does not offer (`dhcp-leases`,
 *   `port-forwards`, `routes`) is `notOffered`, with its reason, and a gap in every observation.
 * - **Read-only.** GET only; the connector's transport refuses every other method.
 * - **A certificate that is verified.** Pinned by fingerprint, or by an explicit CA, or by the system's roots (`unifi-tls.ts`); never
 *   switched off. `stolos connect unifi` shows the person a certificate no public authority signed, and pins it only on a yes.
 *
 * ```mermaid
 * flowchart LR
 *   key["X-API-KEY (vault)"] --> api["https://&lt;controller&gt;/proxy/network/integration/v1"]
 *   tls["pinned SHA-256 or CA (unifi-tls.ts)"] --> api
 *   api --> sites["/sites"] --> per["each site: devices, clients, networks,<br/>firewall policies + zones, wifi broadcasts,<br/>device details (ports)"]
 *   per --> read["router capabilities: devices, clients, networks-and-vlans,<br/>ports, firewall-rules, wifi, health"]
 *   read --> obs["Observation: records, device entities, posture, gaps"]
 * ```
 *
 * @module
 */
// Spec: 109-integrations-api FR-009, FR-011, FR-012, FR-013, FR-014, FR-015, FR-016, FR-018
// Spec: 110-network-assets FR-001, FR-007, FR-012
// Spec: 111-network-posture FR-012

import { http } from "@intellectual-frontiers/commons/ts/runtime";
import type { PolicyResult } from "../adopt/policy.ts";
import { AccessDenied, check, fresh, type Observation } from "./connector.ts";
import { integrationConnector } from "./integration-connector.ts";
import type {
  Client,
  FirewallRule,
  NetworkDevice,
  Reading,
  RouterHealth,
  SwitchPort,
  Vlan,
  WifiNetwork,
} from "./integration-entities.ts";
import { defineIntegration, NotAvailable, type ReadContext } from "./integration.ts";
import { classify } from "./network-class.ts";
import type { UnifiGet } from "./unifi-api.auto.ts";
import { UNIFI_API } from "./unifi-api.auto.ts";
import {
  controllerOf,
  normalizeFingerprint,
  probeCertificate,
  showFingerprint,
  trustedFetch,
  trustOf,
} from "./unifi-tls.ts";

/** The base path of the integration API on a controller running the Network application on UniFi OS. */
export const DEFAULT_BASE_PATH = "/proxy/network/integration";

/** The most sites, and the most devices whose ports are read, one observation takes. */
const MAX_SITES = 100;
const MAX_PORT_DEVICES = 500;
/** Spec 111-network-posture FR-012: the most network and Wi-Fi broadcast details one observation reads. */
const MAX_DETAILS = 200;
const PAGE = 200;
const MAX_PAGES = 50;

/** Where the API is: the controller's origin and the base path (a setting; `/integration` for a standalone Network application). */
export function apiBase(cred: Readonly<Record<string, string>>): string {
  const u = controllerOf(cred["url"] ?? "");
  const raw = (cred["basePath"] ?? "").trim() || DEFAULT_BASE_PATH;
  const base = `/${raw.replace(/^\/+|\/+$/g, "")}`;
  return `${u.origin}${base}`;
}

/** A path of the document's GET operations: the only paths this client can name. */
type GetPath = keyof UnifiGet;

/** The paths whose answer is a page of items (`data`, `totalCount`). */
type PagedPath = {
  [P in GetPath]: UnifiGet[P]["response"] extends { data: unknown[]; totalCount: number }
    ? P
    : never;
}[GetPath];

/** What a page of a path holds. */
type ItemOf<P extends PagedPath> = UnifiGet[P]["response"] extends { data: Array<infer I> }
  ? I
  : never;

/** A path with its placeholders (`{siteId}`) filled. */
function fill(path: string, vars: Readonly<Record<string, string>>): string {
  return path.replace(/\{(\w+)\}/g, (_m, k: string) => encodeURIComponent(vars[k] ?? ""));
}

/** One answer of a documented GET operation, typed by the document. */
export function unifiGet<P extends GetPath>(
  ctx: ReadContext,
  path: P,
  vars: Readonly<Record<string, string>> = {},
): Promise<UnifiGet[P]["response"]> {
  return ctx.json<UnifiGet[P]["response"]>(`${apiBase(ctx.cred)}${fill(path, vars)}`);
}

/** Every item of a documented list, paged with `offset` and `limit` (at most {@link MAX_PAGES} pages). */
export async function unifiPaged<P extends PagedPath>(
  ctx: ReadContext,
  path: P,
  vars: Readonly<Record<string, string>> = {},
): Promise<Array<ItemOf<P>>> {
  const out: Array<ItemOf<P>> = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const at = `${apiBase(ctx.cred)}${fill(path, vars)}?offset=${out.length}&limit=${PAGE}`;
    const r = await ctx.json<{ data: Array<ItemOf<P>>; totalCount: number }>(at);
    out.push(...r.data);
    if (r.data.length === 0 || out.length >= r.totalCount) break;
  }
  return out;
}

/** A site of the controller. */
interface Site {
  id: string;
  name: string;
}

/** The sites, read once. */
const sitesOf = (ctx: ReadContext): Promise<Site[]> =>
  ctx.memo("unifi:sites", async () =>
    (await unifiPaged(ctx, "/v1/sites"))
      .slice(0, MAX_SITES)
      .map((s) => ({ id: s.id, name: s.name })),
  );

/** One list for each site, a site the key may not read a gap and the rest kept. */
async function perSite<T>(
  ctx: ReadContext,
  what: string,
  read: (site: Site) => Promise<T[]>,
): Promise<T[]> {
  const out: T[] = [];
  for (const site of await sitesOf(ctx)) {
    out.push(...(await ctx.orGap(`${what} (${site.name})`, [] as T[], () => read(site))));
  }
  return out;
}

/** What a device does, from its features (a gateway before a switch before an access point). */
function kindOf(features: readonly string[]): NetworkDevice["kind"] {
  if (features.includes("gateway")) return "gateway";
  if (features.includes("switching")) return "switch";
  if (features.includes("accessPoint")) return "access-point";
  return "other";
}

/** One device's details (its ports, its uplink), read once for an observation: a denied or absent read is a gap and `undefined`. */
const detailOf = (
  ctx: ReadContext,
  site: Site,
  d: { id: string; name: string },
): Promise<UnifiGet["/v1/sites/{siteId}/devices/{deviceId}"]["response"] | undefined> =>
  ctx.memo(`unifi:detail:${d.id}`, () =>
    ctx.orGap(`${d.name} details`, undefined, () =>
      unifiGet(ctx, "/v1/sites/{siteId}/devices/{deviceId}", { siteId: site.id, deviceId: d.id }),
    ),
  );

/**
 * The adopted devices of every site, read once (the ports and the health read from them). Spec 110-network-assets FR-001, FR-007: each
 * has its class and facets (from the document's `features`, then the model) and, from its details, its uplink: the device it connects
 * through. A device that is not a gateway and has no uplink in the answer is a reported gap (no edge is made for it).
 */
const devicesOf = (ctx: ReadContext): Promise<NetworkDevice[]> =>
  ctx.memo("unifi:devices", () =>
    perSite(ctx, "devices", async (site) => {
      const overview = await unifiPaged(ctx, "/v1/sites/{siteId}/devices", { siteId: site.id });
      const out: NetworkDevice[] = [];
      for (const d of overview.slice(0, MAX_PORT_DEVICES)) {
        const c = classify({ model: d.model, features: d.features });
        const detail = await detailOf(ctx, site, d);
        const uplink = detail?.uplink?.deviceId;
        if (detail !== undefined && uplink === undefined && c.class !== "gateway") {
          ctx.gap(`uplink (${d.name}): the API gave no uplink for this device, so it has no edge`);
        }
        out.push({
          source: "unifi",
          site: site.name,
          id: d.id,
          name: d.name,
          kind: kindOf(d.features),
          model: d.model,
          mac: d.macAddress,
          ip: d.ipAddress,
          state: d.state,
          firmware: d.firmwareVersion ?? "",
          firmwareUpdatable: d.firmwareUpdatable,
          supported: d.supported,
          hasPorts: d.interfaces.includes("ports"),
          class: c.class,
          facets: c.facets,
          ...(uplink === undefined ? {} : { uplink }),
        });
      }
      return out;
    }),
  );

const OFFLINE = new Set(["OFFLINE", "CONNECTION_INTERRUPTED", "ISOLATED"]);

/** UniFi Network 10.3.58 as a router: what the official document offers, and why it does not offer the rest. */
export const unifiRouter = defineIntegration({
  id: "unifi",
  title: "UniFi Network",
  kind: "router",
  read: {
    devices: (ctx) => devicesOf(ctx),
    clients: (ctx) =>
      perSite(ctx, "clients", async (site) =>
        (await unifiPaged(ctx, "/v1/sites/{siteId}/clients", { siteId: site.id })).map(
          (c): Client => {
            const kind = (
              { WIRED: "wired", WIRELESS: "wireless", VPN: "vpn", TELEPORT: "teleport" } as const
            )[c.type];
            return {
              source: "unifi",
              site: site.name,
              id: c.id,
              name: c.name,
              kind,
              ...(c.type === "WIRED" || c.type === "WIRELESS"
                ? { mac: c.macAddress, uplink: c.uplinkDeviceId }
                : {}),
              ...(c.ipAddress !== undefined ? { ip: c.ipAddress } : {}),
              guest: c.access.type === "GUEST",
              ...(c.connectedAt !== undefined ? { connectedAt: c.connectedAt } : {}),
            };
          },
        ),
      ),
    "networks-and-vlans": (ctx) =>
      perSite(ctx, "networks", async (site) => {
        const networks = await unifiPaged(ctx, "/v1/sites/{siteId}/networks", { siteId: site.id });
        const out: Vlan[] = [];
        for (const [i, n] of networks.entries()) {
          // Spec 111-network-posture FR-012: the network's details say whether it is isolated from the others (a gateway or switch managed
          // network has the flag; an unmanaged one has none). A read that fails is a gap and the flag is left out, never guessed.
          const detail =
            i < MAX_DETAILS
              ? await ctx.orGap(`isolation of network ${n.name}`, undefined, () =>
                  unifiGet(ctx, "/v1/sites/{siteId}/networks/{networkId}", {
                    siteId: site.id,
                    networkId: n.id,
                  }),
                )
              : undefined;
          const isolated =
            detail !== undefined && "isolationEnabled" in detail
              ? detail.isolationEnabled
              : undefined;
          out.push({
            source: "unifi",
            site: site.name,
            id: n.id,
            name: n.name,
            vlanId: n.vlanId,
            enabled: n.enabled,
            default: n.default,
            management: n.management.toLowerCase(),
            ...(n.management === "GATEWAY" && n.zoneId !== undefined ? { zone: n.zoneId } : {}),
            ...(isolated === undefined ? {} : { isolated }),
          });
        }
        return out;
      }),
    ports: async (ctx) => {
      const out: SwitchPort[] = [];
      const withPorts = (await devicesOf(ctx)).filter((d) => d.hasPorts).slice(0, MAX_PORT_DEVICES);
      const sites = await sitesOf(ctx);
      for (const d of withPorts) {
        const site = sites.find((s) => s.name === d.site);
        if (site === undefined) continue;
        const detail = await detailOf(ctx, site, d);
        for (const p of detail?.interfaces.ports ?? []) {
          out.push({
            source: "unifi",
            site: site.name,
            device: d.id,
            deviceName: d.name,
            index: p.idx,
            state: p.state,
            ...(p.speedMbps !== undefined ? { speedMbps: p.speedMbps } : {}),
            maxSpeedMbps: p.maxSpeedMbps,
            connector: p.connector,
            ...(p.poe !== undefined ? { poeState: p.poe.state, poeEnabled: p.poe.enabled } : {}),
          });
        }
      }
      return out;
    },
    "firewall-rules": (ctx) =>
      perSite(ctx, "firewall policies", async (site) => {
        const zones = new Map(
          (
            await ctx.orGap("firewall zones", [], () =>
              unifiPaged(ctx, "/v1/sites/{siteId}/firewall/zones", { siteId: site.id }),
            )
          ).map((z) => [z.id, z.name]),
        );
        const origin = {
          USER_DEFINED: "user",
          SYSTEM_DEFINED: "system",
          DERIVED: "derived",
        } as const;
        return (
          await unifiPaged(ctx, "/v1/sites/{siteId}/firewall/policies", { siteId: site.id })
        ).map((p): FirewallRule => ({
          source: "unifi",
          site: site.name,
          id: p.id,
          name: p.name,
          enabled: p.enabled,
          action: ({ ALLOW: "allow", BLOCK: "block", REJECT: "reject" } as const)[p.action.type],
          sourceZone: zones.get(p.source.zoneId) ?? p.source.zoneId,
          destinationZone: zones.get(p.destination.zoneId) ?? p.destination.zoneId,
          index: p.index,
          logging: p.loggingEnabled,
          origin: origin[p.metadata.origin] ?? "unknown",
        }));
      }),
    wifi: (ctx) =>
      perSite(ctx, "wifi broadcasts", async (site) => {
        const broadcasts = await unifiPaged(ctx, "/v1/sites/{siteId}/wifi/broadcasts", {
          siteId: site.id,
        });
        // A broadcast may name its access points by tag (spec 110-network-assets FR-007): the tags are read once, when one does.
        const byTag = broadcasts.some((b) => b.broadcastingDeviceFilter?.type === "DEVICE_TAGS")
          ? new Map(
              (
                await ctx.orGap("device tags", [], () =>
                  unifiPaged(ctx, "/v1/sites/{siteId}/device-tags", { siteId: site.id }),
                )
              ).map((t) => [t.id, t.deviceIds]),
            )
          : new Map<string, string[]>();
        // Spec 111-network-posture FR-012: each broadcast's details say whether its clients are isolated from each other.
        const isolation = new Map<string, boolean>();
        for (const b of broadcasts.slice(0, MAX_DETAILS)) {
          const d = await ctx.orGap(`client isolation of Wi-Fi network ${b.name}`, undefined, () =>
            unifiGet(ctx, "/v1/sites/{siteId}/wifi/broadcasts/{wifiBroadcastId}", {
              siteId: site.id,
              wifiBroadcastId: b.id,
            }),
          );
          if (d !== undefined) isolation.set(b.id, d.clientIsolationEnabled);
        }
        return broadcasts.map((b): WifiNetwork => {
          const f = b.broadcastingDeviceFilter;
          const broadcastBy =
            f === undefined
              ? undefined
              : f.type === "DEVICES"
                ? [...f.deviceIds]
                : [...new Set(f.deviceTagIds.flatMap((t) => byTag.get(t) ?? []))];
          const n = b.network;
          return {
            source: "unifi",
            site: site.name,
            id: b.id,
            name: b.name,
            enabled: b.enabled,
            security: b.securityConfiguration.type,
            frequenciesGHz: b.type === "STANDARD" ? b.broadcastingFrequenciesGHz : [],
            guest: b.type === "STANDARD" && b.hotspotConfiguration !== undefined,
            ...(broadcastBy === undefined ? {} : { broadcastBy }),
            ...(n === undefined ? {} : { network: n.type === "NATIVE" ? "native" : n.networkId }),
            ...(isolation.has(b.id) ? { clientIsolation: isolation.get(b.id) === true } : {}),
          };
        });
      }),
    health: async (ctx): Promise<RouterHealth[]> => {
      const version = (await unifiGet(ctx, "/v1/info")).applicationVersion;
      const devices = await devicesOf(ctx);
      return (await sitesOf(ctx)).map((site) => {
        const mine = devices.filter((d) => d.site === site.name);
        return {
          source: "unifi",
          site: site.name,
          version,
          devices: mine.length,
          devicesOnline: mine.filter((d) => d.state === "ONLINE").length,
          devicesOffline: mine.filter((d) => OFFLINE.has(d.state)).length,
          devicesUpdatable: mine.filter((d) => d.firmwareUpdatable === true).length,
        };
      });
    },
  },
  notOffered: {
    "dhcp-leases": `the document (${UNIFI_API.version}) describes the DHCP server settings of a network, and offers no operation that lists leases`,
    "port-forwards": `the document (${UNIFI_API.version}) has no operation for port forwards`,
    routes: `the document (${UNIFI_API.version}) has no operation for routes`,
  },
});

/** The facts the readings give the policies. */
function facts(
  readings: Reading[],
  cred: Readonly<Record<string, string>>,
): Observation["posture"] {
  const f: Observation["posture"] = { apiVersion: UNIFI_API.version };
  try {
    const t = trustOf(cred);
    f["tlsTrust"] = t.mode;
    if (t.mode === "pinned") f["tlsFingerprint"] = showFingerprint(t.sha256);
  } catch {
    // A credential whose trust cannot be read is one whose observation already failed.
  }
  for (const r of readings) {
    if (r.kind !== "router") continue;
    switch (r.capability) {
      case "devices":
        f["devices"] = r.items.length;
        f["devicesOnline"] = r.items.filter((d) => d.state === "ONLINE").length;
        f["devicesOffline"] = r.items.filter((d) => OFFLINE.has(d.state)).length;
        f["devicesFirmwareUpdatable"] = r.items.filter((d) => d.firmwareUpdatable === true).length;
        break;
      case "clients":
        f["clients"] = r.items.length;
        f["clientsGuest"] = r.items.filter((c) => c.guest === true).length;
        break;
      case "networks-and-vlans":
        f["vlansEnabled"] = r.items.filter((v) => v.enabled).length;
        f["vlansNonDefault"] = r.items.filter((v) => v.enabled && !v.default).length;
        break;
      case "ports":
        f["ports"] = r.items.length;
        f["portsDown"] = r.items.filter((p) => p.state === "DOWN").length;
        break;
      case "firewall-rules":
        f["firewallPolicies"] = r.items.length;
        f["firewallPoliciesEnabled"] = r.items.filter((p) => p.enabled).length;
        break;
      case "wifi":
        f["wifiNetworks"] = r.items.length;
        f["wifiOpen"] = r.items.filter(
          (w) => w.enabled && !w.guest && w.security === "OPEN",
        ).length;
        break;
      case "health": {
        const v = r.items.find((h) => h.version !== undefined)?.version;
        if (v !== undefined) f["appVersion"] = v;
        break;
      }
      case "dhcp-leases":
      case "port-forwards":
      case "routes":
        break;
    }
  }
  return f;
}

/** The connection the key is for, and a refusal in words a person can act on. */
async function required(ctx: ReadContext): Promise<void> {
  try {
    await unifiGet(ctx, "/v1/info");
  } catch (e) {
    if (e instanceof NotAvailable) {
      throw new Error(
        `the controller has no integration API at ${apiBase(ctx.cred)} (check the base path, and that the Network application is 9.0 or newer)`,
        { cause: e },
      );
    }
    if (e instanceof AccessDenied) {
      throw new Error(
        "the controller refused the key: create one in the Network application (Settings, Control Plane, Integrations) and run stolos connect unifi",
        { cause: e },
      );
    }
    const why = e instanceof Error ? e.message : String(e);
    if (
      !why.includes("is not the pinned one") &&
      /self[- ]signed|certificate|CERT_|SSL|TLS/i.test(why)
    ) {
      throw new Error(
        `${why}; the controller's certificate is not trusted: run stolos connect unifi to pin it, or give a CA file`,
        { cause: e },
      );
    }
    throw e;
  }
}

/** UniFi Network, connected: `stolos connect unifi`. */
export const unifi = integrationConnector({
  id: "unifi",
  title: "UniFi Network",
  logo: "ubiquiti",
  serviceModels: [],
  selfHosted: true,
  markets: ["enterprise-wired-wireless-lan"],
  connectHelp: [
    "In the UniFi Network application (9.0 or newer), signed in as its owner: Settings > Control Plane > Integrations > Create API Key; name it stolos and copy the key (UniFi shows it once)",
    "UniFi does not scope an API key (the integration API defines no scopes), so it has the rights of the owner's role: Stolos reads only, sending GET requests and nothing else (its transport refuses every other method), and keeps the key in this PC's vault, never in Git; delete the key in the Network application to revoke it",
    "Give the controller's address (192.0.2.1 or unifi.example.net, with :port if it is not 443). The API is read from /proxy/network/integration on UniFi OS (the default base path); a standalone Network application serves it from /integration",
    "A controller's own certificate is not signed by a public authority: the first time, Stolos shows its SHA-256 fingerprint and subject and pins that exact certificate only if you say yes (compare it with what your browser shows for the controller); or give a CA file (PEM) or the fingerprint here. A different certificate later fails until you pin it again",
  ],
  recipe: {},
  fields: [
    {
      name: "url",
      secret: false,
      hint: "the controller's address (192.0.2.1 or https://unifi.example.net)",
    },
    { name: "key", secret: true, hint: "the API key (Settings > Control Plane > Integrations)" },
    {
      name: "basePath",
      secret: false,
      optional: true,
      hint: `the base path of the integration API (empty: ${DEFAULT_BASE_PATH}; /integration for a standalone Network application)`,
    },
    {
      name: "ca",
      secret: false,
      file: true,
      optional: true,
      hint: "the path of a PEM file with the CA certificate that signed the controller's (empty: pin its certificate, or use the public roots)",
    },
    {
      name: "fingerprint",
      secret: false,
      optional: true,
      hint: "the SHA-256 fingerprint of the controller's certificate (empty: it is shown to you to approve)",
    },
  ],
  integrations: [unifiRouter],
  headers: (cred) => ({ "X-API-KEY": cred["key"] ?? "" }),
  transport(cred, t) {
    const trust = trustOf(cred);
    // A recorded transport is a test's; a pinned or CA trust is made here; the system's roots are the runtime's own `fetch`.
    if (t.kind === "recorded" || trust.mode === "system") return t;
    return http.liveTransport({
      fetch: trustedFetch(trust),
      credentials: "allow",
      userAgent: "stolos",
      timeoutSeconds: 30,
    });
  },
  required,
  account: (cred) => controllerOf(cred["url"] ?? "").host,
  posture: (readings, cred) => facts(readings, cred),
  async trust(cred, io) {
    let u: URL;
    try {
      u = controllerOf(cred["url"] ?? "");
      const t = trustOf(cred);
      // A fingerprint or a CA is already the person's decision.
      if (t.mode !== "system") return { ok: true, cred };
    } catch (e) {
      return { ok: false, why: e instanceof Error ? e.message : String(e) };
    }
    const port = u.port === "" ? 443 : Number(u.port);
    let info;
    try {
      info = await probeCertificate(u.hostname.replace(/^\[|\]$/g, ""), port);
    } catch (e) {
      return {
        ok: false,
        why: `could not reach ${u.host}: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
    if (info.trusted) return { ok: true, cred };
    io.say(`${u.host} presents a certificate that no public authority signed:`);
    io.say(`  subject:   ${info.subject}`);
    io.say(`  issuer:    ${info.issuer}`);
    io.say(`  expires:   ${info.validTo}`);
    io.say(`  SHA-256:   ${showFingerprint(info.sha256)}`);
    io.say(
      "Compare the fingerprint with what your browser shows for the controller. Trusting pins this exact certificate (like an SSH host key); a different one fails until you pin it again.",
    );
    const answer = ((await io.ask("Trust this certificate? (yes/no)")) ?? "").trim().toLowerCase();
    if (answer !== "yes" && answer !== "y") {
      return { ok: false, why: "the certificate was not trusted: nothing was kept" };
    }
    return { ok: true, cred: { ...cred, fingerprint: normalizeFingerprint(info.sha256) } };
  },
  policies(o: Observation, now: number): PolicyResult[] {
    return [
      fresh(o, now, "unifi"),
      check(o, {
        id: "unifi-devices-online",
        title: "Every adopted UniFi device is online",
        scf: ["AST-04", "MON-02"],
        fact: "devicesOffline",
        want: (v) => v === 0,
        show: (v) => `${v} of ${o.posture["devices"] ?? "?"} device(s) offline`,
        fix: "Network application > UniFi Devices: power or reconnect the device, or forget it if it is gone",
      }),
      check(o, {
        id: "unifi-firmware-current",
        title: "No UniFi device has a firmware update waiting",
        scf: ["VPM-08"],
        fact: "devicesFirmwareUpdatable",
        want: (v) => v === 0,
        show: (v) => `${v} of ${o.posture["devices"] ?? "?"} device(s) can be updated`,
        fix: "Network application > UniFi Devices > the device > Update (or turn on automatic updates in Settings > Control Plane > Updates)",
        warnOnly: true,
      }),
      check(o, {
        id: "unifi-wifi-no-open",
        title: "No enabled Wi-Fi network is open (without a password)",
        scf: ["NET-24"],
        fact: "wifiOpen",
        want: (v) => v === 0,
        show: (v) => `${v} open network(s)`,
        fix: "Network application > WiFi > the network > Security: WPA3 (or WPA2/WPA3) personal or enterprise; a guest network should be a hotspot with a portal",
      }),
      check(o, {
        id: "unifi-vlan-segmentation",
        title: "The network has more than the default network (VLANs)",
        scf: ["NET-10"],
        fact: "vlansNonDefault",
        want: (v) => typeof v === "number" && v >= 1,
        show: (v) => `${v} network(s) besides the default`,
        fix: "Network application > Settings > Networks > New Virtual Network: separate IoT, guests and servers from the default network",
        warnOnly: true,
      }),
      check(o, {
        id: "unifi-tls-verified",
        title: "The controller's certificate was verified (pinned, by a CA, or public)",
        scf: ["CRY-05", "CRY-09"],
        fact: "tlsTrust",
        want: (v) => v === "pinned" || v === "ca" || v === "system",
        show: (v) =>
          v === "pinned" ? `pinned (${o.posture["tlsFingerprint"] ?? "?"})` : String(v),
        fix: "bun run stolos connect unifi (pins the controller's certificate, or give a CA file)",
      }),
    ];
  },
});
