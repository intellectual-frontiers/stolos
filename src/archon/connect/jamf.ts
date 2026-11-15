/**
 * Spec 087 (part A): Jamf Pro, read-only: every computer's name, serial
 * number, macOS version, assigned user's email, FileVault state of its boot
 * volume, and last contact, from the Jamf Pro API's computer inventory
 * (`GET /api/v4/computers-inventory`, or `/api/v3/...` on a server older
 * than Jamf Pro 11.30). Evidence for encryption at rest (SCF CRY-07) and
 * asset inventory (AST-04, MON-02).
 *
 * Credential: an API client (API Roles and Clients) whose role has only the
 * Read Computers privilege; Stolos exchanges its client id and secret for a
 * short-lived token (OAuth 2.0 client credentials at `/api/oauth/token`).
 *
 * @module
 */

import { type Connector, fresh } from "./connector.ts";
import { CHECK_IN_DAYS, devicePolicies, devicePosture, osName } from "./endpoint.ts";
import { emailKey } from "./entities.ts";
import { HARDWARE_DEVICE } from "./labels.ts";
import { clientCredentials, type Ctx, defineConnector } from "./sdk.ts";

const FIELDS = {
  server: { secret: false, hint: "your Jamf Pro server (example.jamfcloud.com)" },
  clientId: { secret: false, hint: "the API client's Client ID" },
  clientSecret: { secret: true, hint: "the API client's secret (Read Computers only)" },
};

/** The server's address, without a trailing slash. */
const base = (server: string) =>
  `https://${server.replace(/^https?:\/\//, "").replace(/\/+$/, "")}`;

const SECTIONS = ["GENERAL", "HARDWARE", "OPERATING_SYSTEM", "USER_AND_LOCATION", "DISK_ENCRYPTION"]
  .map((s) => `section=${s}`)
  .join("&");

interface Computer {
  id: string;
  general?: {
    name?: string;
    /** v4. */
    lastContact?: string;
    /** v3 and earlier. */
    lastContactTime?: string;
    remoteManagement?: { managed?: boolean };
  };
  hardware?: { serialNumber?: string; model?: string };
  operatingSystem?: { name?: string; version?: string };
  userAndLocation?: { email?: string; username?: string };
  diskEncryption?: {
    fileVault2Enabled?: boolean;
    bootPartitionEncryptionDetails?: { partitionFileVault2State?: string };
  };
}

/** Every computer, `page` and `page-size` paged (`{ totalCount, results }`). */
function inventory(ctx: Ctx<typeof FIELDS>, version: string): AsyncGenerator<Computer> {
  const at = (page: number) =>
    `${base(
      ctx.cred.server,
    )}/api/${version}/computers-inventory?${SECTIONS}&page=${page}&page-size=100&sort=id%3Aasc`;
  return ctx.cursorPages<{ totalCount?: number; results?: Computer[] }, Computer>(
    at(0),
    (b) => b.results,
    (b, url) => {
      const page = Number(new URL(url).searchParams.get("page")) + 1;
      return (b.results?.length ?? 0) === 100 && page * 100 < (b.totalCount ?? Infinity)
        ? at(page)
        : undefined;
    },
  );
}

/** v4, or v3 when the server is older than 11.30 (a 404 on the first page). */
async function* computers(ctx: Ctx<typeof FIELDS>): AsyncGenerator<Computer> {
  let any = false;
  try {
    for await (const c of inventory(ctx, "v4")) {
      any = true;
      yield c;
    }
  } catch (e) {
    if (any || !(e instanceof Error && e.message.endsWith("HTTP 404"))) throw e;
    yield* inventory(ctx, "v3");
  }
}

/** FileVault on the boot volume: ENCRYPTED is encrypted; UNKNOWN and INELIGIBLE say nothing. */
function fileVault(c: Computer): boolean | undefined {
  const state = c.diskEncryption?.bootPartitionEncryptionDetails?.partitionFileVault2State;
  if (state && state !== "UNKNOWN" && state !== "INELIGIBLE") return state === "ENCRYPTED";
  return c.diskEncryption?.fileVault2Enabled;
}

/** Jamf Pro. */
export const jamf: Connector = defineConnector({
  id: "jamf",
  title: "Jamf Pro",
  logo: "",
  serviceModels: ["SaaS"],
  markets: ["unified-endpoint-management"],
  connectHelp: [
    "Jamf Pro > Settings > System > API roles and clients > API Roles > New: stolos-read, with the one privilege Read Computers (read only)",
    "API Clients > New: stolos-read, with the stolos-read role; Enable API client; save",
    "Generate client secret (copy it now; it is shown once) and copy the Client ID",
    "Copy your Jamf Pro server's address (example.jamfcloud.com)",
  ],
  recipe: {
    open: {
      href: "https://learn.jamf.com/en-US/bundle/jamf-pro-documentation-current/page/API_Roles_and_Clients.html",
      label: "Jamf Pro: API Roles and Clients",
    },
  },
  fields: FIELDS,
  tokenEndpoints: (cred) => [`${base(cred.server)}/api/oauth/token`],
  auth: (cred, http) =>
    clientCredentials(
      http,
      `${base(cred.server)}/api/oauth/token`,
      cred.clientId,
      cred.clientSecret,
    ),
  account: (cred) => cred.server.replace(/^https?:\/\//, "").replace(/\/+$/, ""),
  resources: {
    computers: {
      label: HARDWARE_DEVICE,
      ocsf: "inventory_info",
      list: computers,
      map: (c: Computer) => {
        const name = c.general?.name;
        const owner = emailKey(c.userAndLocation?.email);
        const os = osName(c.operatingSystem?.name, c.operatingSystem?.version);
        const encrypted = fileVault(c);
        const seen = c.general?.lastContact ?? c.general?.lastContactTime;
        return {
          native_id: String(c.id),
          display_name: name || c.hardware?.serialNumber || String(c.id),
          props: {
            ...(name ? { hostname: name.toLowerCase() } : {}),
            ...(owner ? { owner } : {}),
            ...(os ? { os_name: os } : {}),
            ...(c.hardware?.serialNumber ? { serial_number: c.hardware.serialNumber } : {}),
            ...(encrypted !== undefined ? { encrypted } : {}),
            ...(seen ? { last_seen: seen } : {}),
            managed_by: "jamf",
          },
        };
      },
      asset: (c: Computer) => ({
        kind: "device",
        facts: {
          os: c.operatingSystem?.version ?? "",
          encrypted: fileVault(c) === true,
          managed: c.general?.remoteManagement?.managed === true,
        },
      }),
    },
  },
  posture: (records, _cred, seen) => devicePosture(records, seen.now),
  policies(o, now) {
    return [
      fresh(o, now, "jamf"),
      ...devicePolicies(o, "jamf", {
        encryption:
          "Jamf Pro > Computers > Configuration Profiles: scope a FileVault profile (Security & Privacy > FileVault, with a personal recovery key escrowed) to all managed computers",
        checkIn: `Jamf Pro > Computers > Search Inventory: Last Check-in more than ${CHECK_IN_DAYS} days ago; bring each back (sudo jamf policy), or remove the ones that are gone`,
      }),
    ];
  },
});
