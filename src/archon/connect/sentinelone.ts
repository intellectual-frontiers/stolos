/**
 * Spec 087 (part A): SentinelOne Singularity Endpoint, read-only: every
 * agent's computer name, serial number, operating system, last activity,
 * disk encryption, whether its agent is fully working, and whether it has
 * an unresolved threat (`GET /web/api/v2.1/agents`, cursor paged).
 * Evidence for anti-malware (SCF END-04), continuous monitoring (MON-02),
 * encryption at rest (CRY-07), and asset inventory (AST-04).
 *
 * Credential: the API token of a service user with the Viewer role
 * (read only), at the account or site scope.
 *
 * @module
 */

import { check, type Connector, fresh } from "./connector.ts";
import { devicePolicies, devicePosture, osName } from "./endpoint.ts";
import { HARDWARE_DEVICE } from "./labels.ts";
import { type Ctx, defineConnector } from "./sdk.ts";

const FIELDS = {
  console: { secret: false, hint: "your management console (example.sentinelone.net)" },
  token: { secret: true, hint: "the API token of a service user with the Viewer role" },
};

/** The console's address, without a trailing slash. */
const base = (console: string) =>
  `https://${console.replace(/^https?:\/\//, "").replace(/\/+$/, "")}`;

interface Agent {
  id: string;
  computerName?: string;
  serialNumber?: string;
  osName?: string;
  osRevision?: string;
  lastActiveDate?: string;
  isActive?: boolean;
  isDecommissioned?: boolean;
  /** Disk encryption is on. */
  encryptedApplications?: boolean;
  /** "na" when the agent is fully working; otherwise disabled in part or in full. */
  operationalState?: string;
  infected?: boolean;
  activeThreats?: number;
  agentVersion?: string;
  isUpToDate?: boolean;
}

/**
 * Every agent, 1,000 at a time (`cursor` from `pagination.nextCursor`),
 * counting those with an unresolved threat (`devicesInfected`).
 */
async function* agents(ctx: Ctx<typeof FIELDS>): AsyncGenerator<Agent> {
  const at = (cursor?: string) =>
    `${base(ctx.cred.console)}/web/api/v2.1/agents?limit=1000&isDecommissioned=false${
      cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""
    }`;
  let infected = 0;
  for await (
    const a of ctx.cursorPages<
      { data?: Agent[]; pagination?: { nextCursor?: string | null } },
      Agent
    >(
      at(),
      (b) => b.data,
      (b) => (b.pagination?.nextCursor ? at(b.pagination.nextCursor) : undefined),
    )
  ) {
    if (a.infected || (a.activeThreats ?? 0) > 0) infected++;
    yield a;
  }
  ctx.fact("devicesInfected", infected);
}

const working = (a: Agent) => (a.operationalState ?? "na") === "na";

/** SentinelOne. */
export const sentinelone: Connector = defineConnector({
  id: "sentinelone",
  title: "SentinelOne",
  logo: "",
  serviceModels: ["SaaS"],
  markets: ["endpoint-protection-platforms"],
  connectHelp: [
    "SentinelOne console > Policy & Settings > User Management > Service Users > Create New Service User: stolos-read",
    "Scope: your account (or site); Role: Viewer (read only); choose an expiration date",
    "Copy the API token it shows (it is shown once), and your console's address (example.sentinelone.net)",
  ],
  recipe: {},
  fields: FIELDS,
  auth: (cred) =>
    Promise.resolve({ Authorization: `ApiToken ${cred.token}`, Accept: "application/json" }),
  account: (cred) => cred.console.replace(/^https?:\/\//, "").replace(/\/+$/, ""),
  resources: {
    agents: {
      label: HARDWARE_DEVICE,
      ocsf: "inventory_info",
      list: agents,
      map: (a: Agent) => ({
        native_id: a.id,
        display_name: a.computerName || a.serialNumber || a.id,
        props: {
          ...(a.computerName ? { hostname: a.computerName.toLowerCase().split(".")[0] } : {}),
          ...(osName(a.osName, a.osRevision) ? { os_name: osName(a.osName, a.osRevision) } : {}),
          ...(a.serialNumber ? { serial_number: a.serialNumber } : {}),
          ...(typeof a.encryptedApplications === "boolean"
            ? { encrypted: a.encryptedApplications }
            : {}),
          ...(a.lastActiveDate ? { last_seen: a.lastActiveDate } : {}),
          managed_by: "sentinelone",
          sensor_healthy: working(a),
        },
      }),
      asset: (a: Agent) => ({
        kind: "device",
        facts: {
          os: a.osName ?? "",
          agent: a.agentVersion ?? "",
          working: working(a),
          threats: a.activeThreats ?? (a.infected ? 1 : 0),
        },
      }),
    },
  },
  posture(records, _cred, seen) {
    return devicePosture(records, seen.now);
  },
  policies(o, now) {
    return [
      fresh(o, now, "sentinelone"),
      ...devicePolicies(o, "sentinelone", {
        encryption:
          "turn on BitLocker or FileVault on each device SentinelOne reports unencrypted (from the MDM that manages it)",
        checkIn:
          "SentinelOne console > Sentinels > Endpoints: filter Last Active; bring each stale endpoint back online, or decommission the ones that are gone",
        sensor:
          "SentinelOne console > Sentinels > Endpoints: filter Operational State (disabled); re-enable the agent, or reboot or upgrade it as its Pending Actions say",
      }),
      check(o, {
        id: "sentinelone-threats",
        title: "No device has an unresolved threat",
        scf: ["END-04"],
        fact: "devicesInfected",
        want: (v) => v === 0,
        show: (v) => `${v} of ${o.posture.devices} devices with an active threat`,
        fix:
          "SentinelOne console > Incidents: resolve each active threat (mitigate, then mark resolved)",
      }),
    ];
  },
});
