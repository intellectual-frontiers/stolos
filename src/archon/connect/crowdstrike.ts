/**
 * Spec 087 (part A): CrowdStrike Falcon, read-only: every host with a
 * Falcon sensor, its hostname, serial number, operating system, last seen,
 * and whether the sensor runs in reduced functionality mode
 * (`GET /devices/combined/devices/v1`). Evidence for anti-malware (SCF
 * END-04), continuous monitoring (MON-02), and asset inventory (AST-04).
 * Falcon does not report disk encryption or the device's owner here; the
 * estate graph takes those from an MDM or Stolos's probe for the same
 * device.
 *
 * Credential: an API client with the one scope Hosts: Read; Stolos
 * exchanges its id and secret for a short-lived token (OAuth 2.0 client
 * credentials at `/oauth2/token`).
 *
 * @module
 */
// Spec: 087-wave2-connectors

import { type Connector, fresh } from "./connector.ts";
import { devicePolicies, devicePosture } from "./endpoint.ts";
import { HARDWARE_DEVICE } from "./labels.ts";
import { clientCredentials, type Ctx, defineConnector } from "./sdk.ts";

const FIELDS = {
  cloud: {
    secret: false,
    hint: "your API address: api.crowdstrike.com (US-1), api.us-2.crowdstrike.com, api.eu-1.crowdstrike.com, or api.laggar.gcw.crowdstrike.com",
  },
  clientId: { secret: false, hint: "the API client's Client ID" },
  clientSecret: { secret: true, hint: "the API client's Secret (Hosts: Read only)" },
};

/** The API's address. */
const base = (cloud: string) =>
  `https://${(cloud || "api.crowdstrike.com").replace(/^https?:\/\//, "").replace(/\/+$/, "")}`;

const HOST_FIELDS = [
  "device_id",
  "hostname",
  "serial_number",
  "os_version",
  "platform_name",
  "last_seen",
  "status",
  "reduced_functionality_mode",
  "agent_version",
].join(",");

interface Host {
  device_id: string;
  hostname?: string;
  serial_number?: string;
  os_version?: string;
  platform_name?: string;
  last_seen?: string;
  status?: string;
  reduced_functionality_mode?: string;
  agent_version?: string;
}

interface Page {
  resources?: Host[];
  meta?: { pagination?: { next?: string; total?: number } };
}

/** Every host, 1,000 at a time (the next page's `offset` is the last page's `next`). */
function hosts(ctx: Ctx<typeof FIELDS>): AsyncGenerator<Host> {
  const at = (offset?: string) =>
    `${base(ctx.cred.cloud)}/devices/combined/devices/v1?limit=1000&sort=device_id.asc&fields=${encodeURIComponent(
      HOST_FIELDS,
    )}${offset ? `&offset=${encodeURIComponent(offset)}` : ""}`;
  return ctx.cursorPages<Page, Host>(
    at(),
    (b) => b.resources,
    (b) =>
      b.meta?.pagination?.next && b.resources?.length ? at(b.meta.pagination.next) : undefined,
  );
}

/** CrowdStrike Falcon. */
export const crowdstrike: Connector = defineConnector({
  id: "crowdstrike",
  title: "CrowdStrike Falcon",
  logo: "",
  serviceModels: ["SaaS"],
  markets: ["endpoint-protection-platforms"],
  connectHelp: [
    "Falcon console > Support and resources > API clients and keys > Create API client: stolos-read",
    "Scopes: tick only Hosts > Read (read only); Create",
    "Copy the Client ID and Secret (the secret is shown once), and the Base URL shown with them (api.crowdstrike.com, or your cloud's)",
  ],
  recipe: {
    open: {
      href: "https://falcon.crowdstrike.com/api-clients-and-keys/clients",
      label: "Falcon: API clients and keys",
    },
  },
  fields: FIELDS,
  tokenEndpoints: (cred) => [`${base(cred.cloud)}/oauth2/token`],
  auth: (cred, http) =>
    clientCredentials(http, `${base(cred.cloud)}/oauth2/token`, cred.clientId, cred.clientSecret),
  account: (cred) => new URL(base(cred.cloud)).host,
  resources: {
    hosts: {
      label: HARDWARE_DEVICE,
      ocsf: "inventory_info",
      list: hosts,
      map: (h: Host) => ({
        native_id: h.device_id,
        display_name: h.hostname || h.serial_number || h.device_id,
        props: {
          ...(h.hostname ? { hostname: h.hostname.toLowerCase().split(".")[0] } : {}),
          ...(h.os_version || h.platform_name ? { os_name: h.os_version || h.platform_name } : {}),
          ...(h.serial_number ? { serial_number: h.serial_number } : {}),
          ...(h.last_seen ? { last_seen: h.last_seen } : {}),
          managed_by: "crowdstrike",
          // Reduced functionality mode: the sensor runs but cannot fully protect (an unsupported kernel, say).
          sensor_healthy: h.reduced_functionality_mode !== "yes",
        },
      }),
      asset: (h: Host) => ({
        kind: "device",
        facts: {
          platform: h.platform_name ?? "",
          sensor: h.agent_version ?? "",
          status: h.status ?? "",
          rfm: h.reduced_functionality_mode === "yes",
        },
      }),
    },
  },
  posture: (records, _cred, seen) => devicePosture(records, seen.now),
  policies(o, now) {
    return [
      fresh(o, now, "crowdstrike"),
      ...devicePolicies(o, "crowdstrike", {
        checkIn:
          "Falcon console > Host setup and management > Host management: filter Last seen; bring each stale host back online, or hide the ones that are gone",
        sensor:
          "Falcon console > Host management: filter Reduced functionality mode = Yes; update each host's sensor (Sensor update policies) or move it to a supported OS or kernel",
      }),
    ];
  },
});
