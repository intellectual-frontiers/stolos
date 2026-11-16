/**
 * Spec 087 (part A): Kandji (now Iru Endpoint Management), read-only:
 * every device's name, serial number, OS version, assigned user's email,
 * and last MDM check-in (`GET /api/v1/devices`), and each Mac's FileVault
 * state (`GET /api/v1/devices/{id}/details`). Evidence for encryption at
 * rest (SCF CRY-07) and asset inventory (AST-04, MON-02).
 *
 * Credential: an API token whose permissions are only Device list and
 * Device details (Settings > Access > API Token).
 *
 * @module
 */

import { http } from "@intellectual-frontiers/commons/ts/runtime";
import { type Connector, fresh } from "./connector.ts";
import { devicePolicies, devicePosture, osName } from "./endpoint.ts";
import { emailKey } from "./entities.ts";
import { HARDWARE_DEVICE } from "./labels.ts";
import { type Ctx, defineConnector } from "./sdk.ts";

const FIELDS = {
  api: { secret: false, hint: "your API URL (example.api.kandji.io, or example.api.eu.kandji.io)" },
  token: { secret: true, hint: "an API token with Device list and Device details only" },
};

/** The API's address, without a trailing slash. */
const base = (api: string) => `https://${api.replace(/^https?:\/\//, "").replace(/\/+$/, "")}`;

/** Kandji's largest page. */
const LIMIT = 300;

interface Device {
  device_id: string;
  device_name?: string;
  serial_number?: string;
  platform?: string;
  os_version?: string;
  last_check_in?: string;
  user?: { email?: string; name?: string } | string | null;
  mdm_enabled?: boolean;
  /** Added here, from the device's details (undefined: not a Mac, or not readable). */
  filevault?: boolean;
}

/** Every device (`limit` and `offset`), with each Mac's FileVault state from its details. */
async function* devices(ctx: Ctx<typeof FIELDS>): AsyncGenerator<Device> {
  const at = (offset: number) =>
    `${base(ctx.cred.api)}/api/v1/devices?limit=${LIMIT}&offset=${offset}`;
  const list = ctx.cursorPages<Device[], Device>(
    at(0),
    (b) => b,
    (b, url) =>
      b.length === LIMIT ? at(Number(new URL(url).searchParams.get("offset")) + LIMIT) : undefined,
  );
  // One denial of the details is enough to know: the rest are not asked for.
  let details = true;
  for await (const d of list) {
    if (details && d.platform === "Mac") {
      const x = await ctx.orGap(
        "device details",
        undefined as { filevault?: { filevault_enabled?: boolean } } | undefined,
        () =>
          ctx.json(
            `${base(ctx.cred.api)}/api/v1/devices/${encodeURIComponent(d.device_id)}/details`,
          ),
      );
      if (!x) details = false;
      const fv = x?.filevault?.filevault_enabled;
      yield typeof fv === "boolean" ? { ...d, filevault: fv } : d;
      continue;
    }
    yield d;
  }
}

/** Kandji. */
export const kandji: Connector = defineConnector({
  id: "kandji",
  title: "Kandji",
  logo: "",
  serviceModels: ["SaaS"],
  markets: ["unified-endpoint-management"],
  connectHelp: [
    "Kandji (Iru) > Settings > Access > API Token > Add Token: stolos-read",
    "Copy the token now (it is shown once), then Manage API Permissions: turn on only Devices > Device list and Device details (read only)",
    "Copy your API URL from the same page (example.api.kandji.io)",
  ],
  recipe: {
    open: { href: "https://api-docs.iru.com", label: "Kandji (Iru) API documentation" },
  },
  fields: FIELDS,
  auth: (cred) => Promise.resolve(http.bearer(cred.token)),
  account: (cred) => cred.api.replace(/^https?:\/\//, "").replace(/\/+$/, ""),
  resources: {
    devices: {
      label: HARDWARE_DEVICE,
      ocsf: "inventory_info",
      list: devices,
      map: (d: Device) => {
        const owner = typeof d.user === "object" && d.user ? emailKey(d.user.email) : undefined;
        const os = osName(d.platform === "Mac" ? "macOS" : d.platform, d.os_version);
        return {
          native_id: d.device_id,
          display_name: d.device_name || d.serial_number || d.device_id,
          props: {
            ...(d.device_name ? { hostname: d.device_name.toLowerCase() } : {}),
            ...(owner ? { owner } : {}),
            ...(os ? { os_name: os } : {}),
            ...(d.serial_number ? { serial_number: d.serial_number } : {}),
            ...(d.filevault !== undefined ? { encrypted: d.filevault } : {}),
            ...(d.last_check_in ? { last_seen: d.last_check_in } : {}),
            managed_by: "kandji",
          },
        };
      },
      asset: (d: Device) => ({
        kind: "device",
        facts: {
          platform: d.platform ?? "",
          os: d.os_version ?? "",
          ...(d.filevault !== undefined ? { encrypted: d.filevault } : {}),
        },
      }),
    },
  },
  posture: (records, _cred, seen) => devicePosture(records, seen.now),
  policies(o, now) {
    return [
      fresh(o, now, "kandji"),
      ...devicePolicies(o, "kandji", {
        encryption:
          "Kandji > Library > Add new > FileVault: add it to every Blueprint with Macs (it escrows the recovery key)",
        checkIn:
          "Kandji > Devices: sort by Last Check-in; bring each stale device back online, or remove the ones that are gone",
      }),
    ];
  },
});
