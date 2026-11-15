/**
 * Spec 087 (part A): endpoint management and EDR connectors (Intune, Defender for Endpoint, Jamf
 * Pro, Kandji, CrowdStrike Falcon, SentinelOne), against recorded API responses: read-only (GET,
 * plus the token endpoint), devices become the estate's devices, a denied resource is a gap, a
 * failing policy says how to fix it, and the estate counts each device once across the probe, the
 * MDM, and the EDR.
 *
 * @module
 */

import {
  assert,
  assertEquals,
  assertStringIncludes,
  proves,
} from "@intellectual-frontiers/ifc-ts/runtime/test";
import { recordedHttp } from "../src/archon/connect/sdk.ts";
import {
  type Connector,
  MARKET_CATEGORIES,
  type Observation,
} from "../src/archon/connect/connector.ts";
import { CONNECTORS } from "../src/archon/connect/commands.ts";
import { SCF } from "../src/archon/compliance/scf.ts";
import { defender, intune } from "../src/archon/connect/microsoft-endpoint.ts";
import { jamf } from "../src/archon/connect/jamf.ts";
import { kandji } from "../src/archon/connect/kandji.ts";
import { crowdstrike } from "../src/archon/connect/crowdstrike.ts";
import { sentinelone } from "../src/archon/connect/sentinelone.ts";
import {
  buildGraph,
  estateQuery,
  fixedAssetKey,
  serialKeysByHostname,
  SOURCE_RANK,
} from "../src/archon/estate/graph.ts";
import type { Snapshot } from "../src/archon/estate/snapshot.ts";
import type { PolicyResult } from "../src/archon/adopt/policy.ts";

const NOW = new Date("2026-11-15T12:00:00Z");
type Calls = Array<{ method: string; url: string }>;
const onlyReads = (calls: Calls, token: string[] = []): boolean =>
  calls.length > 0 &&
  calls.every((c) => c.method === "GET" || (c.method === "POST" && token.includes(c.url)));
function result(o: Observation, c: Connector, id: string): PolicyResult | undefined {
  const r = c.policies(o, NOW.getTime()).find((p) => p.id === id);
  return r;
}
const DENIED = { status: 403, body: { error: { code: "Forbidden" } } };
const TOKEN = { body: { access_token: "t", token_type: "Bearer", expires_in: 3599 } };

const IDS = ["intune", "defender", "jamf", "kandji", "crowdstrike", "sentinelone"];

proves(
  ["087-wave2-connectors FR-001", "087-wave2-connectors FR-002"],
  "087a: the six are registered, read-only in their help, in analyst markets, with real SCF ids",
  () => {
    const markets = new Set(MARKET_CATEGORIES.map((m) => m.id));
    const scf = new Set(SCF.map((c) => c.id));
    for (const id of IDS) {
      const c = CONNECTORS.find((x) => x.id === id);
      assert(c, id);
      assertEquals(c.serviceModels, ["SaaS"]);
      assert(c.markets.length && c.markets.every((m) => markets.has(m)), `${id}: markets`);
      assert(c.connectHelp.join(" ").match(/read only/i), `${id}: read-only help`);
      assert(
        c.fields.some((f) => f.secret),
        `${id}: a secret field`,
      );
      const o: Observation = {
        at: NOW.toISOString(),
        provider: id,
        account: "a",
        assets: [],
        posture: {},
        gaps: [],
      };
      for (const p of c.policies(o, NOW.getTime())) {
        for (const s of p.scf) assert(scf.has(s), `${id}: ${p.id}: ${s} is an SCF id Stolos uses`);
      }
    }
    assertEquals(
      markets.has("unified-endpoint-management") && markets.has("endpoint-protection-platforms"),
      true,
    );
    // MDMs and EDRs rank after Stolos's own managed hosts and adopted machines.
    const rank = (id: string): number => SOURCE_RANK[id] ?? -1;
    for (const id of IDS) assert(rank(id) > rank("adopted"), id);
    for (const edr of ["defender", "crowdstrike", "sentinelone"]) {
      assert(rank(edr) > rank("intune"), edr);
    }
  },
);

// Microsoft: one app registration, a token per API.
const MS_TOKEN = "https://login.microsoftonline.com/t1/oauth2/v2.0/token";
const MS_CRED = { tenant: "t1", clientId: "c", clientSecret: "s" };
const INTUNE =
  "https://graph.microsoft.com/v1.0/deviceManagement/managedDevices?$select=id,deviceName,serialNumber,operatingSystem,osVersion,userPrincipalName,emailAddress,isEncrypted,lastSyncDateTime,complianceState,managementAgent,managedDeviceOwnerType";
const INTUNE_2 = "https://graph.microsoft.com/v1.0/deviceManagement/managedDevices?$skiptoken=p2";
const intuneFixtures = {
  [MS_TOKEN]: TOKEN,
  [INTUNE]: {
    body: {
      value: [
        {
          id: "d1",
          deviceName: "ALICE-MBP",
          serialNumber: "C02ALICE",
          operatingSystem: "macOS",
          osVersion: "15.1",
          userPrincipalName: "Alice@Example.org",
          isEncrypted: true,
          lastSyncDateTime: "2026-11-14T09:00:00Z",
          complianceState: "compliant",
          managementAgent: "mdm",
        },
        {
          id: "d2",
          deviceName: "BOB-PC",
          serialNumber: "5CG1234",
          operatingSystem: "Windows",
          osVersion: "10.0.26100.2314",
          userPrincipalName: "bob@example.org",
          isEncrypted: false,
          lastSyncDateTime: "2026-10-01T09:00:00Z",
          complianceState: "noncompliant",
        },
      ],
      "@odata.nextLink": INTUNE_2,
    },
  },
  [INTUNE_2]: {
    body: {
      value: [
        {
          id: "d3",
          deviceName: "Alice's iPhone",
          serialNumber: "Unknown",
          operatingSystem: "iOS",
          osVersion: "18.1",
          emailAddress: "alice@example.org",
          isEncrypted: true,
          lastSyncDateTime: "0001-01-01T00:00:00Z",
          complianceState: "unknown",
        },
      ],
    },
  },
};

proves(
  ["087-wave2-connectors FR-001"],
  "087a: Intune: managed devices, encryption, check-in, compliance; a 403 is a gap",
  async () => {
    const calls: Calls = [];
    const o = await intune.observe(MS_CRED, recordedHttp(intuneFixtures, calls), NOW);
    assert(onlyReads(calls, [MS_TOKEN]));
    assertEquals(
      calls.filter((c) => c.method === "POST").map((c) => c.url),
      [MS_TOKEN],
    );
    assertEquals(o.account, "t1");
    assertEquals(o.gaps, []);
    const devices = o.entities?.devices ?? [];
    assertEquals(devices[0], {
      source: "intune",
      id: "d1",
      name: "ALICE-MBP",
      managed: false,
      owner: "alice@example.org",
      os: "macOS 15.1",
      serial: "C02ALICE",
      encrypted: true,
      seen: "2026-11-14T09:00:00Z",
    });
    // No serial ("Unknown") and no sync ("0001-01-01") are not facts.
    assertEquals(devices[2]?.serial, undefined);
    assertEquals(devices[2]?.seen, undefined);
    assertEquals(o.posture, {
      devices: 3,
      devicesUnencrypted: 1,
      devicesStale: 1,
      devicesNoncompliant: 1,
    });
    assertEquals(result(o, intune, "observed")?.status, "pass");
    const enc = result(o, intune, "intune-disk-encryption");
    assertEquals(
      [enc?.status, enc?.detail, enc?.scf],
      ["fail", "1 of 3 devices unencrypted", ["CRY-07"]],
    );
    assertStringIncludes(enc?.fix ?? "", "BitLocker");
    assertEquals(result(o, intune, "intune-check-in")?.status, "fail");
    assertEquals(result(o, intune, "intune-compliance")?.status, "fail");
    assertStringIncludes(result(o, intune, "intune-compliance")?.fix ?? "", "Compliance");

    const denied = await intune.observe(
      MS_CRED,
      recordedHttp({ [MS_TOKEN]: TOKEN, [INTUNE]: DENIED }),
      NOW,
    );
    assertStringIncludes(
      denied.gaps.join(";"),
      "managed devices: /v1.0/deviceManagement/managedDevices: 403",
    );
    assertEquals(denied.entities, undefined);
    assertEquals(result(denied, intune, "intune-disk-encryption")?.status, "unknown");
  },
);

const DEFENDER = "https://api.security.microsoft.com/api/machines?$top=10000";
const defenderFixtures = {
  [MS_TOKEN]: TOKEN,
  [DEFENDER]: {
    body: {
      value: [
        {
          id: "m1",
          computerDnsName: "alice-mbp.example.org",
          osPlatform: "macOS",
          version: "15.1",
          lastSeen: "2026-11-15T08:00:00Z",
          healthStatus: "Active",
          onboardingStatus: "Onboarded",
        },
        {
          id: "m2",
          computerDnsName: "bob-pc.example.org",
          osPlatform: "Windows11",
          lastSeen: "2026-10-20T08:00:00Z",
          healthStatus: "Inactive",
          onboardingStatus: "Onboarded",
        },
        {
          id: "m3",
          computerDnsName: "printer-3",
          osPlatform: "Linux",
          lastSeen: "2026-11-15T07:00:00Z",
          healthStatus: "Active",
          onboardingStatus: "CanBeOnboarded",
        },
      ],
    },
  },
};

proves(
  ["087-wave2-connectors FR-001"],
  "087a: Defender for Endpoint: machines, sensor health, onboarding; a 403 is a gap, a 404 is none",
  async () => {
    const calls: Calls = [];
    const o = await defender.observe(MS_CRED, recordedHttp(defenderFixtures, calls), NOW);
    assert(onlyReads(calls, [MS_TOKEN]));
    assertEquals(o.posture, {
      notOnboarded: 1,
      devices: 3,
      devicesStale: 1,
      sensorsUnhealthy: 1,
    });
    assertEquals(o.entities?.devices?.[0]?.name, "alice-mbp.example.org");
    assertEquals(o.entities?.devices?.[0]?.serial, undefined);
    const sensor = result(o, defender, "defender-sensor");
    assertEquals([sensor?.status, sensor?.scf], ["fail", ["END-04", "MON-02"]]);
    assertStringIncludes(sensor?.fix ?? "", "Onboarding");
    assertEquals(result(o, defender, "defender-onboarded")?.status, "warn");
    assertEquals(result(o, defender, "defender-check-in")?.status, "fail");

    const none = await defender.observe(
      MS_CRED,
      recordedHttp({ [MS_TOKEN]: TOKEN, [DEFENDER]: { status: 404, body: {} } }),
      NOW,
    );
    assertEquals([none.gaps, none.posture], [[], { notOnboarded: 0, devices: 0 }]);
    const denied = await defender.observe(
      MS_CRED,
      recordedHttp({ [MS_TOKEN]: TOKEN, [DEFENDER]: DENIED }),
      NOW,
    );
    assertStringIncludes(denied.gaps.join(";"), "machines: /api/machines: 403");
    assertEquals(result(denied, defender, "defender-sensor")?.status, "unknown");
  },
);

const JAMF = "https://example.jamfcloud.com";
const JAMF_TOKEN = `${JAMF}/api/oauth/token`;
const jamfPage = (v: string) =>
  `${JAMF}/api/${v}/computers-inventory?section=GENERAL&section=HARDWARE&section=OPERATING_SYSTEM&section=USER_AND_LOCATION&section=DISK_ENCRYPTION&page=0&page-size=100&sort=id%3Aasc`;
const JAMF_CRED = { server: "https://example.jamfcloud.com/", clientId: "c", clientSecret: "s" };
const jamfComputers = (contact: "lastContact" | "lastContactTime") => ({
  totalCount: 2,
  results: [
    {
      id: "1",
      general: {
        name: "alice-mbp",
        [contact]: "2026-11-14T10:00:00Z",
        remoteManagement: { managed: true },
      },
      hardware: { serialNumber: "C02ALICE" },
      operatingSystem: { name: "macOS", version: "15.1" },
      userAndLocation: { email: "Alice@Example.org" },
      diskEncryption: {
        fileVault2Enabled: true,
        bootPartitionEncryptionDetails: { partitionFileVault2State: "ENCRYPTED" },
      },
    },
    {
      id: "2",
      general: { name: "carol-mba", [contact]: "2026-09-01T10:00:00Z" },
      hardware: { serialNumber: "C02CAROL" },
      operatingSystem: { name: "macOS", version: "14.7" },
      userAndLocation: { email: "carol@example.org" },
      diskEncryption: {
        bootPartitionEncryptionDetails: { partitionFileVault2State: "UNENCRYPTED" },
      },
    },
  ],
});

proves(
  ["087-wave2-connectors FR-001"],
  "087a: Jamf Pro: computers, FileVault, last contact (v4, or v3 on an older server); a 403 is a gap",
  async () => {
    const calls: Calls = [];
    const o = await jamf.observe(
      JAMF_CRED,
      recordedHttp(
        { [JAMF_TOKEN]: TOKEN, [jamfPage("v4")]: { body: jamfComputers("lastContact") } },
        calls,
      ),
      NOW,
    );
    assert(onlyReads(calls, [JAMF_TOKEN]));
    assertEquals(o.account, "example.jamfcloud.com");
    assertEquals(o.entities?.devices?.[0], {
      source: "jamf",
      id: "1",
      name: "alice-mbp",
      managed: false,
      owner: "alice@example.org",
      os: "macOS 15.1",
      serial: "C02ALICE",
      encrypted: true,
      seen: "2026-11-14T10:00:00Z",
    });
    assertEquals(o.posture, { devices: 2, devicesUnencrypted: 1, devicesStale: 1 });
    const enc = result(o, jamf, "jamf-disk-encryption");
    assertEquals(enc?.status, "fail");
    assertStringIncludes(enc?.fix ?? "", "FileVault");
    assertStringIncludes(result(o, jamf, "jamf-check-in")?.fix ?? "", "14 days");

    const older = await jamf.observe(
      JAMF_CRED,
      recordedHttp({
        [JAMF_TOKEN]: TOKEN,
        [jamfPage("v4")]: { status: 404, body: { httpStatus: 404 } },
        [jamfPage("v3")]: { body: jamfComputers("lastContactTime") },
      }),
      NOW,
    );
    assertEquals(
      older.entities?.devices?.map((d) => d.seen),
      ["2026-11-14T10:00:00Z", "2026-09-01T10:00:00Z"],
    );
    const denied = await jamf.observe(
      JAMF_CRED,
      recordedHttp({ [JAMF_TOKEN]: TOKEN, [jamfPage("v4")]: DENIED }),
      NOW,
    );
    assertStringIncludes(denied.gaps.join(";"), "computers: /api/v4/computers-inventory: 403");
  },
);

const KANDJI = "https://example.api.kandji.io/api/v1/devices";
const KANDJI_LIST = `${KANDJI}?limit=300&offset=0`;
const KANDJI_CRED = { api: "example.api.kandji.io", token: "t" };
const kandjiDevices = {
  body: [
    {
      device_id: "k1",
      device_name: "alice-mbp",
      serial_number: "C02ALICE",
      platform: "Mac",
      os_version: "15.1",
      last_check_in: "2026-11-15T06:00:00Z",
      user: { email: "alice@example.org", name: "Alice Example" },
    },
    {
      device_id: "k2",
      device_name: "Bob's iPad",
      serial_number: "DMPBOB",
      platform: "iPad",
      os_version: "18.1",
      last_check_in: "2026-11-05T06:00:00Z",
      user: "",
    },
  ],
};

proves(
  ["087-wave2-connectors FR-001"],
  "087a: Kandji: devices, each Mac's FileVault from its details; a 403 on details or the list is a gap",
  async () => {
    const calls: Calls = [];
    const o = await kandji.observe(
      KANDJI_CRED,
      recordedHttp(
        {
          [KANDJI_LIST]: kandjiDevices,
          [`${KANDJI}/k1/details`]: { body: { filevault: { filevault_enabled: false } } },
        },
        calls,
      ),
      NOW,
    );
    assert(onlyReads(calls));
    // Details only for a Mac: an iPad encrypts by itself.
    assertEquals(
      calls.map((c) => c.url),
      [KANDJI_LIST, `${KANDJI}/k1/details`],
    );
    assertEquals(
      o.entities?.devices?.map((d) => [d.name, d.owner, d.os, d.encrypted]),
      [
        ["alice-mbp", "alice@example.org", "macOS 15.1", false],
        ["Bob's iPad", undefined, "iPad 18.1", undefined],
      ],
    );
    assertEquals(o.posture, { devices: 2, devicesUnencrypted: 1, devicesStale: 0 });
    const enc = result(o, kandji, "kandji-disk-encryption");
    assertEquals(enc?.status, "fail");
    assertStringIncludes(enc?.fix ?? "", "Blueprint");
    assertEquals(result(o, kandji, "kandji-check-in")?.status, "pass");

    const noDetails = await kandji.observe(
      KANDJI_CRED,
      recordedHttp({ [KANDJI_LIST]: kandjiDevices, [`${KANDJI}/k1/details`]: DENIED }),
      NOW,
    );
    assertStringIncludes(
      noDetails.gaps.join(";"),
      "device details: /api/v1/devices/k1/details: 403",
    );
    assertEquals(noDetails.posture["devices"], 2);
    assertEquals(result(noDetails, kandji, "kandji-disk-encryption")?.status, "unknown");
    const denied = await kandji.observe(KANDJI_CRED, recordedHttp({ [KANDJI_LIST]: DENIED }), NOW);
    assertStringIncludes(denied.gaps.join(";"), "devices: /api/v1/devices: 403");
  },
);

const CS = "https://api.crowdstrike.com";
const CS_TOKEN = `${CS}/oauth2/token`;
const csPage = (offset?: string) =>
  `${CS}/devices/combined/devices/v1?limit=1000&sort=device_id.asc&fields=${encodeURIComponent(
    "device_id,hostname,serial_number,os_version,platform_name,last_seen,status,reduced_functionality_mode,agent_version",
  )}${offset ? `&offset=${offset}` : ""}`;
const CS_CRED = { cloud: "api.crowdstrike.com", clientId: "c", clientSecret: "s" };
const csFixtures = {
  [CS_TOKEN]: TOKEN,
  [csPage()]: {
    body: {
      resources: [
        {
          device_id: "h1",
          hostname: "ALICE-MBP",
          serial_number: "C02ALICE",
          os_version: "macOS 15.1",
          platform_name: "Mac",
          last_seen: "2026-11-15T09:00:00Z",
          status: "normal",
          reduced_functionality_mode: "no",
          agent_version: "7.20.18902.0",
        },
      ],
      meta: { pagination: { total: 2, next: "n2" } },
    },
  },
  [csPage("n2")]: {
    body: {
      resources: [
        {
          device_id: "h2",
          hostname: "bob-pc",
          serial_number: "5CG1234",
          os_version: "Windows 11",
          platform_name: "Windows",
          last_seen: "2026-10-01T09:00:00Z",
          status: "normal",
          reduced_functionality_mode: "yes",
        },
      ],
      meta: { pagination: { total: 2 } },
    },
  },
};

proves(
  ["087-wave2-connectors FR-001"],
  "087a: CrowdStrike Falcon: hosts across pages, sensor health; a 403 is a gap",
  async () => {
    const calls: Calls = [];
    const o = await crowdstrike.observe(CS_CRED, recordedHttp(csFixtures, calls), NOW);
    assert(onlyReads(calls, [CS_TOKEN]));
    assertEquals(o.account, "api.crowdstrike.com");
    assertEquals(
      o.entities?.devices?.map((d) => [d.id, d.serial, d.os]),
      [
        ["h1", "C02ALICE", "macOS 15.1"],
        ["h2", "5CG1234", "Windows 11"],
      ],
    );
    assertEquals(o.posture, { devices: 2, devicesStale: 1, sensorsUnhealthy: 1 });
    const sensor = result(o, crowdstrike, "crowdstrike-sensor");
    assertEquals(sensor?.status, "fail");
    assertStringIncludes(sensor?.fix ?? "", "Reduced functionality mode");
    // Falcon reports no disk encryption: no policy pretends it does.
    assertEquals(result(o, crowdstrike, "crowdstrike-disk-encryption"), undefined);

    const denied = await crowdstrike.observe(
      CS_CRED,
      recordedHttp({ [CS_TOKEN]: TOKEN, [csPage()]: DENIED }),
      NOW,
    );
    assertStringIncludes(denied.gaps.join(";"), "hosts: /devices/combined/devices/v1: 403");
  },
);

const S1 = "https://example.sentinelone.net/web/api/v2.1/agents?limit=1000&isDecommissioned=false";
const S1_CRED = { console: "example.sentinelone.net", token: "t" };

proves(
  ["087-wave2-connectors FR-001"],
  "087a: SentinelOne: agents across pages, encryption, agent state, threats; a 403 is a gap",
  async () => {
    const calls: Calls = [];
    const o = await sentinelone.observe(
      S1_CRED,
      recordedHttp(
        {
          [S1]: {
            body: {
              data: [
                {
                  id: "a1",
                  computerName: "alice-mbp",
                  serialNumber: "C02ALICE",
                  osName: "macOS",
                  osRevision: "15.1",
                  lastActiveDate: "2026-11-15T10:00:00Z",
                  encryptedApplications: true,
                  operationalState: "na",
                  infected: false,
                  activeThreats: 0,
                },
              ],
              pagination: { nextCursor: "c2", totalItems: 2 },
            },
          },
          [`${S1}&cursor=c2`]: {
            body: {
              data: [
                {
                  id: "a2",
                  computerName: "bob-pc",
                  serialNumber: "5CG1234",
                  osName: "Windows 11 Pro",
                  lastActiveDate: "2026-11-14T10:00:00Z",
                  encryptedApplications: false,
                  operationalState: "disabled_error",
                  infected: true,
                  activeThreats: 1,
                },
              ],
              pagination: { nextCursor: null, totalItems: 2 },
            },
          },
        },
        calls,
      ),
      NOW,
    );
    assert(onlyReads(calls));
    assertEquals(o.posture, {
      devicesInfected: 1,
      devices: 2,
      devicesUnencrypted: 1,
      devicesStale: 0,
      sensorsUnhealthy: 1,
    });
    const threats = result(o, sentinelone, "sentinelone-threats");
    assertEquals([threats?.status, threats?.scf], ["fail", ["END-04"]]);
    assertStringIncludes(threats?.fix ?? "", "Incidents");
    assertEquals(result(o, sentinelone, "sentinelone-sensor")?.status, "fail");
    assertEquals(result(o, sentinelone, "sentinelone-disk-encryption")?.status, "fail");

    const denied = await sentinelone.observe(S1_CRED, recordedHttp({ [S1]: DENIED }), NOW);
    assertStringIncludes(denied.gaps.join(";"), "agents: /web/api/v2.1/agents: 403");
    assertEquals(result(denied, sentinelone, "sentinelone-threats")?.status, "unknown");
  },
);

proves(
  ["087-wave2-connectors FR-002", "090-estate-graph FR-004"],
  "087a: one laptop seen by the probe, Intune, and Falcon is one fixed asset, three observed_as edges",
  async () => {
    const fromIntune = await intune.observe(MS_CRED, recordedHttp(intuneFixtures), NOW);
    const fromFalcon = await crowdstrike.observe(CS_CRED, recordedHttp(csFixtures), NOW);
    const snap = (sources: Array<[string, Observation]>): Snapshot => ({
      fleet: "lab",
      sources: sources.map(([connector, observation]) => ({ connector, observation })),
      machines: [
        {
          source: "adopted",
          id: "alice-mbp",
          name: "alice-mbp.local",
          owner: "alice@example.org",
          managed: false,
          serial: "c02alice",
          os: "macOS 15.1 (24B83)",
        },
      ],
      links: {},
    });
    // Falcon first in the snapshot: the order of sources does not decide whose word wins.
    const e = buildGraph(
      snap([
        ["crowdstrike", fromFalcon],
        ["intune", fromIntune],
      ]),
      { now: NOW },
    );
    const laptop = "serial:C02ALICE";
    assertEquals(
      estateQuery(e, `select count(*) as n from fixed_asset where fixed_asset_uid = '${laptop}'`),
      [{ n: 1 }],
    );
    assertEquals(
      estateQuery(
        e,
        `select dst_uid, source, basis from edge where verb = 'observed_as' and src_uid = '${laptop}' order by dst_uid`,
      ),
      [
        { dst_uid: "adopted:alice-mbp", source: "adopted", basis: "serial" },
        { dst_uid: "crowdstrike:h1", source: "crowdstrike", basis: "serial" },
        { dst_uid: "intune:d1", source: "intune", basis: "serial" },
      ],
    );
    // Each property from the source that ranks first and knows it: the probe, then the MDM.
    assertEquals(
      estateQuery(
        e,
        `select property, source from node_property_provenance where node_uid = '${laptop}' order by property`,
      ),
      [
        { property: "encrypted", source: "intune" },
        { property: "hostname", source: "adopted" },
        { property: "os_name", source: "adopted" },
        { property: "serial_number", source: "adopted" },
      ],
    );
    assertEquals(
      estateQuery(
        e,
        `select hostname, os_name, encrypted, fixed_asset_type, last_seen from fixed_asset where fixed_asset_uid = '${laptop}'`,
      ),
      [
        {
          hostname: "alice-mbp",
          os_name: "macOS 15.1 (24B83)",
          encrypted: 1,
          fixed_asset_type: "workstation",
          last_seen: "2026-11-15T12:00:00Z",
        },
      ],
    );
    // Bob's PC: Intune and Falcon, by serial; the iPhone (no serial) by its name: three in all.
    assertEquals(estateQuery(e, "select count(*) as n from fixed_asset"), [{ n: 3 }]);

    // Defender reports no serial number: its machine joins the laptop by hostname.
    const fromDefender = await defender.observe(MS_CRED, recordedHttp(defenderFixtures), NOW);
    const all = buildGraph(
      snap([
        ["intune", fromIntune],
        ["crowdstrike", fromFalcon],
        ["defender", fromDefender],
      ]),
      { now: NOW },
    );
    assertEquals(
      estateQuery(
        all,
        `select dst_uid, basis from edge where verb = 'observed_as' and src_uid = '${laptop}' and source = 'defender'`,
      ),
      [{ dst_uid: "defender:m1", basis: "hostname" }],
    );
    assertEquals(
      estateQuery(all, "select fixed_asset_uid from fixed_asset order by fixed_asset_uid"),
      [
        { fixed_asset_uid: "hostname:alice's iphone" },
        { fixed_asset_uid: "hostname:printer-3" },
        { fixed_asset_uid: "serial:5CG1234" },
        { fixed_asset_uid: "serial:C02ALICE" },
      ],
    );
  },
);

proves(
  ["087-wave2-connectors FR-002"],
  "087a: a device with only a hostname joins a serial only when one machine has that name",
  () => {
    const dev = (source: string, id: string, name: string, serial?: string) => ({
      source,
      id,
      name,
      managed: false,
      ...(serial ? { serial } : {}),
    });
    const byHost = serialKeysByHostname([
      dev("intune", "1", "alice-mbp", "C02ALICE"),
      dev("jamf", "2", "MacBook-Pro", "C02ONE"),
      dev("jamf", "3", "macbook-pro.local", "C02TWO"),
    ]);
    assertEquals(
      fixedAssetKey(dev("defender", "m", "alice-mbp.example.org"), {}, byHost),
      "serial:C02ALICE",
    );
    // Two machines share the default name: neither is guessed.
    assertEquals(
      fixedAssetKey(dev("defender", "n", "macbook-pro"), {}, byHost),
      "hostname:macbook-pro",
    );
    // links.ts still decides first.
    assertEquals(
      fixedAssetKey(
        dev("defender", "n", "macbook-pro"),
        { "device:defender:n": "serial:C02TWO" },
        byHost,
      ),
      "serial:C02TWO",
    );
  },
);
