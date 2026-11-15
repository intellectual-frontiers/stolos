/**
 * Spec 087 (part A): Microsoft's endpoint connectors, read-only, each with
 * one Entra ID app registration's client credentials (a client secret):
 *
 * - **Microsoft Intune**, through Microsoft Graph
 *   (`GET /v1.0/deviceManagement/managedDevices`, application permission
 *   `DeviceManagementManagedDevices.Read.All`): every managed device's
 *   name, serial number, operating system, primary user, BitLocker or
 *   FileVault, last sync, and compliance state.
 * - **Microsoft Defender for Endpoint**, through its own API
 *   (`GET https://api.security.microsoft.com/api/machines`, application
 *   permission `Machine.Read.All` of WindowsDefenderATP): every machine's
 *   name, operating system, last seen, onboarding, and sensor health.
 *   Defender reports no serial number, so its machines join the estate by
 *   hostname.
 *
 * The same app registration may hold both permissions; each connector asks
 * for a token for its own API only.
 *
 * @module
 */

import { check, type Connector, fresh } from "./connector.ts";
import { devicePolicies, devicePosture, osName } from "./endpoint.ts";
import { emailKey } from "./entities.ts";
import { HARDWARE_DEVICE } from "./labels.ts";
import { clientCredentials, type Ctx, defineConnector, type FieldDef } from "./sdk.ts";

const GRAPH = "https://graph.microsoft.com/v1.0";
const DEFENDER = "https://api.security.microsoft.com/api";
/** Defender for Endpoint's token audience (its API still names it securitycenter). */
const DEFENDER_SCOPE = "https://api.securitycenter.microsoft.com/.default";

const tokenUrl = (tenant: string) =>
  `https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/token`;

const FIELDS = {
  tenant: { secret: false, hint: "Directory (tenant) ID" },
  clientId: { secret: false, hint: "Application (client) ID" },
  clientSecret: { secret: true, hint: "the client secret's Value" },
};

/** Every item of a Microsoft list that pages with `@odata.nextLink`. */
function odataPages<T>(ctx: Ctx<Record<string, FieldDef>>, url: string): AsyncGenerator<T> {
  return ctx.cursorPages<{ value?: T[]; "@odata.nextLink"?: string }, T>(
    url,
    (b) => b.value,
    (b) => b["@odata.nextLink"],
  );
}

const registration = (permission: string, api: string) => [
  "entra.microsoft.com > App registrations > New registration: stolos-read (single tenant), or reuse the one Microsoft 365 uses",
  `API permissions > Add a permission > ${api} > Application permissions: ${permission} (read only) > Grant admin consent`,
  "Certificates & secrets > New client secret (copy its Value)",
  "Overview: copy the Directory (tenant) ID and Application (client) ID",
];

const APP_REGISTRATIONS = {
  href: "https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade",
  label: "Open Entra app registrations",
};

interface ManagedDevice {
  id: string;
  deviceName?: string;
  serialNumber?: string;
  operatingSystem?: string;
  osVersion?: string;
  userPrincipalName?: string;
  emailAddress?: string;
  isEncrypted?: boolean;
  lastSyncDateTime?: string;
  complianceState?: string;
  managementAgent?: string;
  managedDeviceOwnerType?: string;
}

/** Intune reports "0001-01-01T00:00:00Z" for a device that never synced. */
const when = (t?: string) => (t && !t.startsWith("0001-") ? t : undefined);

/** Microsoft Intune. */
export const intune: Connector = defineConnector({
  id: "intune",
  title: "Microsoft Intune",
  logo: "",
  serviceModels: ["SaaS"],
  markets: ["unified-endpoint-management"],
  connectHelp: registration("DeviceManagementManagedDevices.Read.All", "Microsoft Graph"),
  recipe: { open: APP_REGISTRATIONS },
  fields: FIELDS,
  tokenEndpoints: (cred) => [tokenUrl(cred.tenant)],
  auth: (cred, http) =>
    clientCredentials(
      http,
      tokenUrl(cred.tenant),
      cred.clientId,
      cred.clientSecret,
      "https://graph.microsoft.com/.default",
    ),
  account: (cred) => cred.tenant,
  resources: {
    "managed devices": {
      label: HARDWARE_DEVICE,
      ocsf: "inventory_info",
      list: (ctx) =>
        odataPages<ManagedDevice>(
          ctx,
          `${GRAPH}/deviceManagement/managedDevices?$select=id,deviceName,serialNumber,operatingSystem,osVersion,userPrincipalName,emailAddress,isEncrypted,lastSyncDateTime,complianceState,managementAgent,managedDeviceOwnerType`,
        ),
      map: (d: ManagedDevice) => {
        const owner = emailKey(d.userPrincipalName) ?? emailKey(d.emailAddress);
        const seen = when(d.lastSyncDateTime);
        const compliance = d.complianceState ?? "unknown";
        return {
          native_id: d.id,
          display_name: d.deviceName || d.serialNumber || d.id,
          props: {
            ...(d.deviceName ? { hostname: d.deviceName.toLowerCase() } : {}),
            ...(owner ? { owner } : {}),
            ...(osName(d.operatingSystem, d.osVersion)
              ? { os_name: osName(d.operatingSystem, d.osVersion) }
              : {}),
            // Intune reports "Unknown" or empty for a serial it does not know.
            ...(d.serialNumber && !/^(unknown|0+)$/i.test(d.serialNumber)
              ? { serial_number: d.serialNumber }
              : {}),
            ...(typeof d.isEncrypted === "boolean" ? { encrypted: d.isEncrypted } : {}),
            ...(seen ? { last_seen: seen } : {}),
            managed_by: "intune",
            ...(compliance === "compliant" || compliance === "noncompliant"
              ? { compliant: compliance === "compliant" }
              : {}),
          },
        };
      },
      asset: (d: ManagedDevice) => ({
        kind: "device",
        facts: {
          os: d.operatingSystem ?? "",
          encrypted: d.isEncrypted === true,
          compliance: d.complianceState ?? "unknown",
        },
      }),
    },
  },
  posture: (records, _cred, seen) => devicePosture(records, seen.now),
  policies(o, now) {
    return [
      fresh(o, now, "intune"),
      ...devicePolicies(o, "intune", {
        encryption:
          "Intune admin center > Endpoint security > Disk encryption: assign a BitLocker (Windows) and a FileVault (macOS) policy to every device, and require encryption in the compliance policy",
        checkIn:
          "Intune admin center > Devices > All devices: sort by Last check-in; sync each stale device, or retire the ones that are gone",
        compliance:
          "Intune admin center > Devices > Compliance: open each noncompliant device and fix what its policy reports (OS version, encryption, firewall, antivirus)",
      }),
    ];
  },
});

interface Machine {
  id: string;
  computerDnsName?: string;
  osPlatform?: string;
  version?: string;
  osVersion?: string;
  lastSeen?: string;
  healthStatus?: string;
  onboardingStatus?: string;
  aadDeviceId?: string;
}

/** A machine is onboarded unless Defender says it is not (discovered devices are "CanBeOnboarded"). */
const onboarded = (m: Machine) => (m.onboardingStatus ?? "Onboarded") === "Onboarded";

/**
 * Defender's machines (a 404 means none was seen in the retention period),
 * counting the discovered ones that have no sensor (`notOnboarded`).
 */
async function* machines(ctx: Ctx<typeof FIELDS>): AsyncGenerator<Machine> {
  let notOnboarded = 0;
  try {
    for await (const m of odataPages<Machine>(ctx, `${DEFENDER}/machines?$top=10000`)) {
      if (!onboarded(m)) notOnboarded++;
      yield m;
    }
  } catch (e) {
    if (!(e instanceof Error && e.message.endsWith("HTTP 404"))) throw e;
  }
  ctx.fact("notOnboarded", notOnboarded);
}

/** Microsoft Defender for Endpoint. */
export const defender: Connector = defineConnector({
  id: "defender",
  title: "Microsoft Defender for Endpoint",
  logo: "",
  serviceModels: ["SaaS"],
  markets: ["endpoint-protection-platforms"],
  connectHelp: registration(
    "Machine.Read.All",
    "APIs my organization uses > WindowsDefenderATP",
  ),
  recipe: { open: APP_REGISTRATIONS },
  fields: FIELDS,
  tokenEndpoints: (cred) => [tokenUrl(cred.tenant)],
  auth: (cred, http) =>
    clientCredentials(
      http,
      tokenUrl(cred.tenant),
      cred.clientId,
      cred.clientSecret,
      DEFENDER_SCOPE,
    ),
  account: (cred) => cred.tenant,
  resources: {
    machines: {
      label: HARDWARE_DEVICE,
      ocsf: "inventory_info",
      list: machines,
      map: (m: Machine) => ({
        native_id: m.id,
        display_name: m.computerDnsName || m.id,
        props: {
          ...(m.computerDnsName ? { hostname: m.computerDnsName.toLowerCase().split(".")[0] } : {}),
          ...(osName(m.osPlatform, m.version ?? m.osVersion)
            ? { os_name: osName(m.osPlatform, m.version ?? m.osVersion) }
            : {}),
          ...(m.lastSeen ? { last_seen: m.lastSeen } : {}),
          managed_by: "defender",
          // Active: the sensor reports. Inactive, NoSensorData, ImpairedCommunication: it does not, or
          // not fully. A discovered device that is not onboarded has no sensor (defender-onboarded).
          ...(onboarded(m) ? { sensor_healthy: m.healthStatus === "Active" } : {}),
        },
      }),
      asset: (m: Machine) => ({
        kind: "device",
        facts: {
          os: m.osPlatform ?? "",
          health: m.healthStatus ?? "Unknown",
          onboarding: m.onboardingStatus ?? "Onboarded",
        },
      }),
    },
  },
  posture: (records, _cred, seen) => devicePosture(records, seen.now),
  policies(o, now) {
    return [
      fresh(o, now, "defender"),
      ...devicePolicies(o, "defender", {
        checkIn:
          "Microsoft Defender portal > Assets > Devices: filter by Last device update; bring each stale device back online, or offboard the ones that are gone",
        sensor:
          "Microsoft Defender portal > Assets > Devices: filter Health state (Inactive, Misconfigured) and Onboarding status (Can be onboarded); onboard each device (Settings > Endpoints > Onboarding) and repair impaired sensors",
      }),
      check(o, {
        id: "defender-onboarded",
        title: "Every device Defender discovered is onboarded",
        scf: ["END-04", "AST-04"],
        fact: "notOnboarded",
        want: (v) => v === 0,
        show: (v) => `${v} discovered devices without the sensor`,
        fix:
          "Microsoft Defender portal > Assets > Devices > Onboarding status: Can be onboarded; onboard each (Settings > Endpoints > Onboarding), or exclude devices that are not yours",
        warnOnly: true,
      }),
    ];
  },
});
