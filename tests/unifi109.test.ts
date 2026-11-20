/**
 * Spec 109-integrations-api: UniFi Network as the first router. The pinned official document and the types generated from it; the
 * endpoints it offers and the gaps it leaves; the connector against recorded responses shaped by the document and served by a real local
 * HTTPS server with a self-signed certificate; and how that certificate is trusted (a pinned fingerprint, an explicit CA, never switched
 * off, trust on first use).
 *
 * @module
 */

import { fs, path, proc } from "@intellectual-frontiers/system";
import { http } from "@intellectual-frontiers/net";
import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
  proves,
} from "@intellectual-frontiers/test";
import { sha256 } from "@intellectual-frontiers/crypto";
import { runtimeCommand } from "../src/archon/install/bun.ts";
import { UNIFI_API, UNIFI_OPERATIONS } from "../src/archon/connect/unifi-api.auto.ts";
import {
  DEFAULT_BASE_PATH,
  apiBase,
  unifi,
  unifiGet,
  unifiRouter,
} from "../src/archon/connect/unifi.ts";
import { readContext } from "../src/archon/connect/integration.ts";
import {
  controllerOf,
  isFingerprint,
  normalizeFingerprint,
  probeCertificate,
  showFingerprint,
  trustOf,
} from "../src/archon/connect/unifi-tls.ts";
import {
  document,
  fixture,
  makeCertificate,
  startController,
  uuid,
  type Controller,
  type Routes,
} from "./unifi-fixtures.ts";

const NOW = new Date("2026-11-17T12:00:00Z");
const KEY = "test-key-not-a-secret";
const BASE = "/proxy/network/integration";
const LIMIT = { timeout: 180_000 };

/** The vault's record for a controller, with what a test says over it. */
const credOf = (c: Controller, over: Record<string, string> = {}): Record<string, string> => ({
  url: c.url,
  key: KEY,
  ...over,
});

/** The live transport a connector is given by the command (it makes its own pinned one where the trust says so). */
const live = (): http.Transport =>
  http.liveTransport({ credentials: "allow", userAgent: "stolos" });

const SITE = uuid();
const BRANCH = uuid();
const GATEWAY = uuid();
const SWITCH = uuid();
const ACCESS_POINT = uuid();
const IOT = uuid();
const ZONE_INTERNAL = uuid();
const ZONE_IOT = uuid();

/** The routes of a controller with two sites: the first fully readable, the second one that refuses its clients. */
function routes(): Routes {
  const owner = (origin: string) => ({ origin });
  const device = (id: string, over: Record<string, unknown>) =>
    fixture("Adopted device overview", {
      id,
      supported: true,
      firmwareUpdatable: false,
      firmwareVersion: "7.0.1",
      ...over,
    });
  const wired = fixture("Wired client overview", {
    type: "WIRED",
    name: "alpha",
    ipAddress: "10.0.0.10",
    macAddress: "02:00:00:00:00:10",
    uplinkDeviceId: SWITCH,
    access: { type: "DEFAULT" },
    connectedAt: "2026-11-17T08:00:00Z",
  });
  const guest = fixture("Wireless client overview", {
    type: "WIRELESS",
    name: "visitor phone",
    ipAddress: "10.0.20.31",
    macAddress: "02:00:00:00:00:31",
    uplinkDeviceId: ACCESS_POINT,
    access: { type: "GUEST", authorized: true },
  });
  const vpn = fixture("VPN client (connection) overview", {
    type: "VPN",
    name: "remote laptop",
    ipAddress: "10.0.99.2",
    access: { type: "DEFAULT" },
  });
  const port = (idx: number, state: string, poe?: string) =>
    fixture("Port overview", {
      idx,
      state,
      connector: "RJ45",
      maxSpeedMbps: 2500,
      ...(state === "UP" ? { speedMbps: 1000 } : {}),
      ...(poe ? { poe: fixture("Port PoE overview", { state: poe, enabled: true }) } : {}),
    });
  const detail = (id: string, name: string, ports: unknown[]) =>
    fixture("Adopted device details", {
      id,
      name,
      configurationId: "7596498d2f367dc2",
      interfaces: { ports },
    });
  const empty = { body: { data: [] } };
  return {
    "/v1/info": { body: fixture("Application info", { applicationVersion: "10.3.58" }) },
    "/v1/sites": {
      body: {
        data: [
          fixture("Site overview", { id: SITE, name: "Default", internalReference: "default" }),
          fixture("Site overview", { id: BRANCH, name: "Branch", internalReference: "branch" }),
        ],
      },
    },
    [`/v1/sites/${SITE}/devices`]: {
      body: {
        data: [
          device(GATEWAY, {
            name: "gateway",
            model: "UDM-Pro",
            macAddress: "02:00:00:00:00:01",
            ipAddress: "192.0.2.1",
            state: "ONLINE",
            features: ["gateway", "switching"],
            interfaces: ["ports"],
          }),
          device(SWITCH, {
            name: "switch-office",
            model: "USW-24",
            macAddress: "02:00:00:00:00:02",
            ipAddress: "192.0.2.2",
            state: "ONLINE",
            features: ["switching"],
            interfaces: ["ports"],
            firmwareUpdatable: true,
          }),
          device(ACCESS_POINT, {
            name: "ap-hall",
            model: "U7-Pro",
            macAddress: "02:00:00:00:00:03",
            ipAddress: "192.0.2.3",
            state: "OFFLINE",
            features: ["accessPoint"],
            interfaces: ["radios"],
          }),
        ],
      },
    },
    [`/v1/sites/${SITE}/devices/${GATEWAY}`]: {
      body: detail(GATEWAY, "gateway", [port(1, "UP", "UP"), port(2, "DOWN")]),
    },
    [`/v1/sites/${SITE}/devices/${SWITCH}`]: {
      body: detail(SWITCH, "switch-office", [port(1, "UP")]),
    },
    [`/v1/sites/${SITE}/clients`]: { body: { data: [wired, guest, vpn] } },
    [`/v1/sites/${SITE}/networks`]: {
      body: {
        data: [
          fixture("Gateway managed network overview", {
            management: "GATEWAY",
            name: "Default",
            vlanId: 1,
            default: true,
            enabled: true,
            zoneId: ZONE_INTERNAL,
            metadata: owner("SYSTEM_DEFINED"),
          }),
          fixture("Gateway managed network overview", {
            id: IOT,
            management: "GATEWAY",
            name: "IoT",
            vlanId: 20,
            default: false,
            enabled: true,
            zoneId: ZONE_IOT,
            metadata: owner("USER_DEFINED"),
          }),
          fixture("Unmanaged network overview", {
            management: "UNMANAGED",
            name: "Spare",
            vlanId: 30,
            default: false,
            enabled: false,
            metadata: owner("USER_DEFINED"),
          }),
        ],
      },
    },
    [`/v1/sites/${SITE}/firewall/zones`]: {
      body: {
        data: [
          fixture("Firewall zone", {
            id: ZONE_INTERNAL,
            name: "Internal",
            metadata: owner("SYSTEM_DEFINED"),
          }),
          fixture("Firewall zone", {
            id: ZONE_IOT,
            name: "IoT zone",
            metadata: owner("USER_DEFINED"),
          }),
        ],
      },
    },
    [`/v1/sites/${SITE}/firewall/policies`]: {
      body: {
        data: [
          fixture("Firewall policy", {
            name: "Block IoT to internal",
            enabled: true,
            index: 10,
            action: { type: "BLOCK" },
            source: { zoneId: ZONE_IOT },
            destination: { zoneId: ZONE_INTERNAL },
            loggingEnabled: true,
            ipProtocolScope: { ipVersion: "IPV4" },
            metadata: owner("USER_DEFINED"),
          }),
        ],
      },
    },
    [`/v1/sites/${SITE}/wifi/broadcasts`]: {
      body: {
        data: [
          fixture("IntegrationStandardWifiBroadcastOverviewDto", {
            type: "STANDARD",
            name: "home",
            enabled: true,
            securityConfiguration: { type: "WPA3_PERSONAL" },
            broadcastingFrequenciesGHz: [2.4, 5],
            metadata: owner("USER_DEFINED"),
          }),
          fixture("IntegrationStandardWifiBroadcastOverviewDto", {
            type: "STANDARD",
            name: "lobby",
            enabled: true,
            securityConfiguration: { type: "OPEN" },
            broadcastingFrequenciesGHz: [5],
            metadata: owner("USER_DEFINED"),
          }),
        ],
      },
    },
    // The second site: the key may not read its clients (a gap), and it has nothing else.
    [`/v1/sites/${BRANCH}/devices`]: empty,
    [`/v1/sites/${BRANCH}/clients`]: { status: 403, body: { message: "forbidden" } },
    [`/v1/sites/${BRANCH}/networks`]: empty,
    [`/v1/sites/${BRANCH}/firewall/zones`]: empty,
    [`/v1/sites/${BRANCH}/firewall/policies`]: empty,
    [`/v1/sites/${BRANCH}/wifi/broadcasts`]: empty,
  };
}

/** A path the controller was asked for, as the document's template. */
function templateOf(target: string): string | undefined {
  const p = target.split("?")[0] ?? "";
  if (!p.startsWith(BASE)) return undefined;
  const rest = p.slice(BASE.length);
  return UNIFI_OPERATIONS.filter((o) => o.method === "GET").find((o) =>
    new RegExp(`^${o.path.replace(/\{\w+\}/g, "[^/]+")}$`).test(rest),
  )?.path;
}

// ------------------------------------------------------------------------------ the pinned document and the generator

proves(
  ["109-integrations-api FR-009", "109-integrations-api FR-010"],
  "109: the pinned document is the one named (version, source, SHA-256, origin), and the generated types say so",
  async () => {
    const dir = new URL("../vendor/unifi-network/10.3.58/", import.meta.url);
    const bytes = fs.readFileSync(new URL("integration.json", dir));
    assertEquals(String(await sha256(bytes)), String(UNIFI_API.sha256));
    assertEquals(
      UNIFI_API.sha256,
      "c6824fe526b0a0030153b52e117348ab651af3fc6540d8c9de73e4fab57ca0d7",
    );
    assertEquals(UNIFI_API.source, "https://apidoc-cdn.ui.com/network/v10.3.58/integration.json");
    assertEquals(UNIFI_API.version, "10.3.58");
    assertEquals(UNIFI_API.openapi, "3.1.0");
    const readme = new TextDecoder().decode(fs.readFileSync(new URL("README.md", dir)));
    assertStringIncludes(readme, UNIFI_API.sha256);
    assertStringIncludes(readme, UNIFI_API.source);
    assertStringIncludes(readme, "Ubiquiti");
    const doc = document() as unknown as { info: { version: string }; openapi: string };
    assertEquals(doc.info.version, UNIFI_API.version);
    assertEquals(doc.openapi, "3.1.0");
    // The generated module says where it comes from and that it is never edited by hand (Article 26).
    const generated = new TextDecoder().decode(
      fs.readFileSync(new URL("../src/archon/connect/unifi-api.auto.ts", import.meta.url)),
    );
    assertStringIncludes(generated, "GENERATED by `bun run unifi-api`");
    assertStringIncludes(generated, UNIFI_API.sha256);
    assertStringIncludes(generated, "Never edit by hand");
  },
);

proves(
  ["109-integrations-api FR-010"],
  "109: the generated module is what the generator writes from the pinned document, and the generator refuses another document",
  async () => {
    const r = await proc.output(
      [
        ...runtimeCommand(),
        path.fromFileUrl(new URL("../tools/unifi-api-gen.ts", import.meta.url)),
        "--check",
      ],
      { stdin: "null", signal: AbortSignal.timeout(150_000) },
    );
    assert(r.code === 0, new TextDecoder().decode(r.stderr));
    // The operations the generated module lists are the document's, all of them.
    const doc = document();
    const ops = Object.entries(doc.paths).flatMap(([p, m]) =>
      Object.keys(m).map((x) => `${x.toUpperCase()} ${p}`),
    );
    assertEquals(UNIFI_OPERATIONS.map((o) => `${o.method} ${o.path}`).sort(), ops.sort());
    assertEquals(UNIFI_OPERATIONS.length, 73);
  },
  LIMIT,
);

// ------------------------------------------------------------------------------ what the document offers

proves(
  ["109-integrations-api FR-013", "109-integrations-api FR-014"],
  "109: what the document does not offer is a reported gap with its reason, and no path of the document offers it",
  () => {
    assertEquals(Object.keys(unifiRouter.notOffered).sort(), [
      "dhcp-leases",
      "port-forwards",
      "routes",
    ]);
    assertEquals(unifiRouter.offers.slice().sort(), [
      "clients",
      "devices",
      "firewall-rules",
      "health",
      "networks-and-vlans",
      "ports",
      "wifi",
    ]);
    for (const reason of Object.values(unifiRouter.notOffered)) {
      assertStringIncludes(reason, "10.3.58");
    }
    // Checked against the pinned document itself: nothing in it is about leases, forwards or routes.
    for (const o of UNIFI_OPERATIONS) {
      assert(!/lease|forward|route|nat\b/i.test(o.path), `${o.path} is about what is not offered`);
    }
    // The paths the client takes are the document's: a path that is not does not compile.
    const ctx = readContext({ cred: {}, http: live(), now: NOW, headers: {}, gaps: [] });
    const never = (): unknown =>
      // @ts-expect-error the document has no operation for DHCP leases, so the client cannot name one
      unifiGet(ctx, "/v1/sites/{siteId}/dhcp/leases");
    assertEquals(typeof never, "function");
    const never2 = (): unknown =>
      // @ts-expect-error nor for port forwards or routes
      unifiGet(ctx, "/v1/sites/{siteId}/port-forwards");
    assertEquals(typeof never2, "function");
  },
);

// ------------------------------------------------------------------------------ the connector, against a real HTTPS server

proves(
  [
    "109-integrations-api FR-003",
    "109-integrations-api FR-004",
    "109-integrations-api FR-005",
    "109-integrations-api FR-011",
    "109-integrations-api FR-013",
    "109-integrations-api FR-014",
    "109-integrations-api FR-015",
    "109-integrations-api FR-017",
  ],
  "109: UniFi against recorded responses shaped by the document: every offered capability, paging, a denied call, the gaps, GET only, the key",
  async () => {
    const cert = await makeCertificate();
    const c = await startController(cert, routes());
    try {
      const o = await unifi.observe(credOf(c, { fingerprint: cert.fingerprint }), live(), NOW);
      assertEquals(o.provider, "unifi");
      assertEquals(o.account, c.url.replace("https://", ""));
      assertEquals(o.at, "2026-11-17T12:00:00Z");
      const count = (kind: string): number => o.assets.filter((a) => a.kind === kind).length;
      assertEquals(count("network-device"), 3);
      assertEquals(count("client"), 3);
      assertEquals(count("vlan"), 3);
      assertEquals(count("switch-port"), 3);
      assertEquals(count("firewall-rule"), 1);
      assertEquals(count("wifi-network"), 2);
      // The records carry labels named from OCSF and D3FEND, and the OCSF class of the estate graph.
      const labels = (l: string) => (o.records ?? []).filter((r) => r.label === l);
      assertEquals(labels("computer_network_node").length, 3);
      assertEquals(labels("network_endpoint").length, 3);
      assertEquals(labels("local_area_network").length, 3);
      assertEquals(labels("network_interface").length, 3);
      assertEquals(labels("firewall_rule").length, 1);
      assertEquals(labels("network").length, 2);
      for (const r of o.records ?? []) assert([5001, 5023].includes(r.ocsf_class_uid), r.label);
      const iot = labels("local_area_network").find((r) => r.display_name === "IoT");
      assertEquals(iot?.props["vlan_id"], 20);
      const rule = labels("firewall_rule")[0];
      assertEquals(rule?.props["rule_action"], "block");
      assertEquals(rule?.props["source_zone"], "IoT zone");
      assertEquals(rule?.props["destination_zone"], "Internal");
      assertEquals(rule?.props["origin"], "user");
      const wired = labels("network_endpoint").find((r) => r.display_name === "alpha");
      assertEquals(wired?.props["mac"], "02:00:00:00:00:10");
      assertEquals(wired?.props["uplink"], SWITCH);
      assertEquals(
        labels("network_endpoint").find((r) => r.display_name === "visitor phone")?.props["guest"],
        true,
      );
      // Adopted devices are device entities with the source unifi: fixed assets beside the fleet's machines.
      assertEquals(o.entities?.devices?.map((d) => `${d.source}:${d.name}:${d.managed}`).sort(), [
        "unifi:ap-hall:false",
        "unifi:gateway:false",
        "unifi:switch-office:false",
      ]);
      // The posture the policies read.
      assertEquals(o.posture["devices"], 3);
      assertEquals(o.posture["devicesOffline"], 1);
      assertEquals(o.posture["devicesFirmwareUpdatable"], 1);
      assertEquals(o.posture["clients"], 3);
      assertEquals(o.posture["clientsGuest"], 1);
      assertEquals(o.posture["vlansNonDefault"], 1);
      assertEquals(o.posture["ports"], 3);
      assertEquals(o.posture["portsDown"], 1);
      assertEquals(o.posture["wifiNetworks"], 2);
      assertEquals(o.posture["wifiOpen"], 1);
      assertEquals(o.posture["firewallPolicies"], 1);
      assertEquals(o.posture["appVersion"], "10.3.58");
      assertEquals(o.posture["apiVersion"], "10.3.58");
      assertEquals(o.posture["tlsTrust"], "pinned");
      assertEquals(o.posture["tlsFingerprint"], cert.fingerprint.toUpperCase());
      // The gaps: what the document does not offer (with the reason), and the site whose clients the key may not read.
      const gaps = o.gaps.join("\n");
      assertStringIncludes(
        gaps,
        "dhcp-leases: the document (10.3.58) describes the DHCP server settings",
      );
      assertStringIncludes(gaps, "port-forwards: the document (10.3.58) has no operation");
      assertStringIncludes(gaps, "routes: the document (10.3.58) has no operation");
      assertStringIncludes(gaps, "clients (Branch)");
      assertStringIncludes(gaps, "403");
      // Only GET, only the key the vault holds, and only paths the document has.
      assert(c.seen.length > 15, `${c.seen.length} requests`);
      for (const r of c.seen) {
        assertEquals(r.method, "GET", r.target);
        assertEquals(r.key, KEY, r.target);
        assert(
          templateOf(r.target) !== undefined,
          `${r.target} is not an operation of the document`,
        );
      }
      // Paging: the server answers two at a time, and the client asked again from where it was (3 clients, 3 devices).
      assert(
        c.seen.some((r) => r.target.includes(`/sites/${SITE}/clients?offset=2&limit=200`)),
        "the second page of clients was asked for",
      );
      // The key is nowhere in what was observed.
      assert(!JSON.stringify(o).includes(KEY));
    } finally {
      await c.stop();
    }
  },
  LIMIT,
);

proves(
  ["109-integrations-api FR-016"],
  "109: UniFi's posture policies each have a fix and an SCF control, and fail or warn where the network is not as they want",
  async () => {
    const cert = await makeCertificate();
    const c = await startController(cert, routes());
    try {
      const o = await unifi.observe(credOf(c, { fingerprint: cert.fingerprint }), live(), NOW);
      const results = unifi.policies(o, NOW.getTime());
      const by = Object.fromEntries(results.map((r) => [r.id, r]));
      assertEquals(results.map((r) => r.id).sort(), [
        "observed",
        "unifi-devices-online",
        "unifi-firmware-current",
        "unifi-tls-verified",
        "unifi-vlan-segmentation",
        "unifi-wifi-no-open",
      ]);
      assertEquals(by["observed"]?.status, "pass");
      assertEquals(by["unifi-devices-online"]?.status, "fail");
      assertStringIncludes(by["unifi-devices-online"]?.detail ?? "", "1 of 3");
      assertEquals(by["unifi-firmware-current"]?.status, "warn");
      assertEquals(by["unifi-wifi-no-open"]?.status, "fail");
      assertEquals(by["unifi-vlan-segmentation"]?.status, "pass");
      assertEquals(by["unifi-tls-verified"]?.status, "pass");
      assertStringIncludes(by["unifi-tls-verified"]?.detail ?? "", "pinned");
      for (const r of results) {
        assert((r.fix ?? "").length > 10, `${r.id}: a fix`);
        assert(r.scf.length > 0, `${r.id}: an SCF control`);
      }
      // A policy over what was not read is unknown, never a pass.
      const blind = unifi.policies({ ...o, posture: { apiVersion: "10.3.58" } }, NOW.getTime());
      assertEquals(blind.find((r) => r.id === "unifi-wifi-no-open")?.status, "unknown");
      assertEquals(blind.find((r) => r.id === "unifi-tls-verified")?.status, "unknown");
    } finally {
      await c.stop();
    }
  },
  LIMIT,
);

proves(
  ["109-integrations-api FR-005", "109-integrations-api FR-011"],
  "109: a key the controller refuses, a controller with no API at the base path and a base path setting fail the observation in words, and a missing page is a gap",
  async () => {
    const cert = await makeCertificate();
    // The key is refused (401): the observation fails and says what to do, and nothing else is read.
    const refused = await startController(cert, { "/v1/info": { status: 401, body: {} } });
    try {
      const err = await assertRejects(
        () => unifi.observe(credOf(refused, { fingerprint: cert.fingerprint }), live(), NOW),
        Error,
      );
      assertStringIncludes(err.message, "the controller refused the key");
      assertEquals(refused.seen.length, 1);
    } finally {
      await refused.stop();
    }
    // A standalone Network application: its API is at /integration, a setting of the connector.
    const standalone = await startController(
      cert,
      {
        "/v1/info": { body: { applicationVersion: "10.3.58" } },
        "/v1/sites": { body: { data: [fixture("Site overview", { id: SITE, name: "Default" })] } },
        [`/v1/sites/${SITE}/devices`]: { body: { data: [] } },
        // The version has no wifi endpoint (404): a gap, and the rest is read.
        [`/v1/sites/${SITE}/clients`]: { body: { data: [] } },
        [`/v1/sites/${SITE}/networks`]: { body: { data: [] } },
        [`/v1/sites/${SITE}/firewall/zones`]: { body: { data: [] } },
        [`/v1/sites/${SITE}/firewall/policies`]: { body: { data: [] } },
      },
      "/integration",
    );
    try {
      const cred = credOf(standalone, { fingerprint: cert.fingerprint });
      // The default base path finds nothing there.
      const wrong = await assertRejects(() => unifi.observe(cred, live(), NOW), Error);
      assertStringIncludes(wrong.message, "has no integration API at");
      assertStringIncludes(wrong.message, `${standalone.url}${DEFAULT_BASE_PATH}`);
      const o = await unifi.observe({ ...cred, basePath: "integration" }, live(), NOW);
      assertEquals(o.posture["devices"], 0);
      assertStringIncludes(o.gaps.join("\n"), "wifi broadcasts (Default)");
      assertStringIncludes(o.gaps.join("\n"), "404");
      assertEquals(apiBase({ url: "192.0.2.1" }), `https://192.0.2.1${DEFAULT_BASE_PATH}`);
      assertEquals(
        apiBase({ url: "https://unifi.example.net:8443/", basePath: "/integration/" }),
        "https://unifi.example.net:8443/integration",
      );
    } finally {
      await standalone.stop();
    }
  },
  LIMIT,
);

// ------------------------------------------------------------------------------ the certificate

proves(
  ["109-integrations-api FR-012"],
  "109: a certificate is trusted only by its pinned fingerprint or an explicit CA, a different one is refused before any request, and verification is never switched off",
  async () => {
    const cert = await makeCertificate();
    const other = await makeCertificate("other.example.net");
    const c = await startController(cert, routes());
    try {
      // A system trust (nothing pinned, no CA): a self-signed controller is refused, before a byte of the request is written.
      const unpinned = await assertRejects(() => unifi.observe(credOf(c), live(), NOW), Error);
      assertStringIncludes(unpinned.message, "stolos connect unifi");
      assertEquals(c.seen.length, 0, "the key never reached an untrusted server");
      // A different certificate than the pinned one: refused, naming both fingerprints, and nothing sent.
      const wrong = await assertRejects(
        () => unifi.observe(credOf(c, { fingerprint: other.fingerprint }), live(), NOW),
        Error,
      );
      assertStringIncludes(wrong.message, "is not the pinned one");
      assertStringIncludes(wrong.message, showFingerprint(other.fingerprint));
      assertStringIncludes(wrong.message, showFingerprint(cert.fingerprint));
      assertStringIncludes(wrong.message, "stolos connect");
      assertEquals(c.seen.length, 0, "nor to a server with another certificate");
      // The fingerprint may be written with or without colons, in any case.
      const pinned = normalizeFingerprint(cert.fingerprint).toUpperCase();
      const o = await unifi.observe(credOf(c, { fingerprint: pinned }), live(), NOW);
      assertEquals(o.posture["tlsTrust"], "pinned");
      assert(c.seen.length > 0);
      // An explicit CA set (here the certificate itself, which has the host's address in its names): Node's full verification.
      c.seen.length = 0;
      const withCa = await unifi.observe(credOf(c, { ca: cert.cert }), live(), NOW);
      assertEquals(withCa.posture["tlsTrust"], "ca");
      assert(c.seen.length > 0);
      // A CA that did not sign it: refused, nothing sent.
      c.seen.length = 0;
      await assertRejects(() => unifi.observe(credOf(c, { ca: other.cert }), live(), NOW), Error);
      assertEquals(c.seen.length, 0);
      // Pinning did not switch verification off anywhere else: an ordinary request to the same server still fails.
      await assertRejects(() => fetch(`${c.url}/proxy/network/integration/v1/info`), Error);
      assertEquals(c.seen.length, 0);
      // The settings are checked in words.
      assertEquals(trustOf({}).mode, "system");
      assertEquals(trustOf({ fingerprint: cert.fingerprint }).mode, "pinned");
      assertEquals(trustOf({ ca: cert.cert }).mode, "ca");
      let bad = "";
      try {
        trustOf({ fingerprint: "not a fingerprint" });
      } catch (e) {
        bad = e instanceof Error ? e.message : "";
      }
      assertStringIncludes(bad, "SHA-256");
      assert(
        isFingerprint(cert.fingerprint) && !isFingerprint("abc") && !isFingerprint("zz".repeat(32)),
      );
      assertEquals(controllerOf("192.0.2.1").origin, "https://192.0.2.1");
      let plain = "";
      try {
        controllerOf("http://192.0.2.1");
      } catch (e) {
        plain = e instanceof Error ? e.message : "";
      }
      assertStringIncludes(plain, "https only");
    } finally {
      await c.stop();
    }
  },
  LIMIT,
);

proves(
  ["109-integrations-api FR-012", "109-integrations-api FR-018"],
  "109: trust on first use: the certificate is shown to the person, pinned only on a yes, and the probe sends no request",
  async () => {
    const cert = await makeCertificate();
    const c = await startController(cert, routes());
    try {
      const said: string[] = [];
      const ask = (answer: string | undefined) => {
        const asked: string[] = [];
        return {
          asked,
          io: {
            say: (line: string) => said.push(line),
            ask: (q: string) => {
              asked.push(q);
              return Promise.resolve(answer);
            },
          },
        };
      };
      const probe = await probeCertificate("127.0.0.1", Number(new URL(c.url).port));
      assertEquals(probe.trusted, false);
      assertEquals(probe.sha256, normalizeFingerprint(cert.fingerprint));
      assertEquals(probe.subject, "unifi.example.net");
      assertEquals(c.seen.length, 0, "the probe reads the certificate and sends nothing");

      // Yes: the credential comes back with the fingerprint, which is what the observation then pins and writes to the fleet record.
      const yes = ask("yes");
      const kept = await unifi.trust?.(credOf(c), yes.io);
      assert(kept?.ok === true);
      assertEquals(kept.cred["fingerprint"], normalizeFingerprint(cert.fingerprint));
      assertEquals(kept.cred["key"], KEY);
      assertEquals(yes.asked.length, 1);
      const shown = said.join("\n");
      assertStringIncludes(shown, showFingerprint(cert.fingerprint));
      assertStringIncludes(shown, "unifi.example.net");
      assertStringIncludes(shown, "no public authority signed");
      assertEquals(c.seen.length, 0, "nothing was requested while the person decided");
      // With it, the observation works and records what was pinned.
      const o = await unifi.observe(kept.cred, live(), NOW);
      assertEquals(o.posture["tlsFingerprint"], showFingerprint(cert.fingerprint));

      // No (or no answer): nothing is kept.
      for (const answer of ["no", "", undefined]) {
        const r = await unifi.trust?.(credOf(c), ask(answer).io);
        assert(r?.ok === false, String(answer));
        assertStringIncludes(r.why, "nothing was kept");
      }
      // Already pinned, or a CA given: it is the person's decision already, so nothing is asked.
      const pinned = ask("no");
      assert(
        (await unifi.trust?.(credOf(c, { fingerprint: cert.fingerprint }), pinned.io))?.ok === true,
      );
      assert((await unifi.trust?.(credOf(c, { ca: cert.cert }), pinned.io))?.ok === true);
      assertEquals(pinned.asked.length, 0);
      // A controller that cannot be reached, and an address that is not https: said in words.
      const dead = await unifi.trust?.({ url: "127.0.0.1:1", key: KEY }, ask("yes").io);
      assert(dead?.ok === false);
      assertStringIncludes(dead.why, "could not reach");
      const plain = await unifi.trust?.({ url: "http://192.0.2.1", key: KEY }, ask("yes").io);
      assert(plain?.ok === false);
    } finally {
      await c.stop();
    }
  },
  LIMIT,
);

proves(
  ["109-integrations-api FR-006", "109-integrations-api FR-018"],
  "109: UniFi is a connector of the family: connected like any (fields, a secret, read-only help), and no page of its own",
  async () => {
    const { CONNECTORS } = await import("../src/archon/connect/commands.ts");
    const c = CONNECTORS.find((x) => x.id === "unifi");
    assert(c !== undefined);
    assertEquals(c.title, "UniFi Network");
    assertEquals(
      c.fields.map((f) => [f.name, f.secret, f.optional === true]),
      [
        ["url", false, false],
        ["key", true, false],
        ["basePath", false, true],
        ["ca", false, true],
        ["fingerprint", false, true],
      ],
    );
    assert(c.fields.find((f) => f.name === "ca")?.file === true, "the CA is a file");
    assertEquals(c.selfHosted, true);
    assertEquals(c.serviceModels, []);
    assert(/read/i.test(c.connectHelp.join(" ")));
    assertStringIncludes(c.connectHelp.join(" "), "Settings > Control Plane > Integrations");
    assertStringIncludes(c.connectHelp.join(" "), "does not scope an API key");
    assert(typeof c.trust === "function");
    // The commands that exist are the ones that show it: no new command for the router.
    const { COMMANDS } = await import("../src/archon/commands/registry.ts");
    for (const n of ["connect", "disconnect", "estate observe", "estate check", "estate assets"]) {
      assert(
        COMMANDS.some((x) => x.name === n),
        n,
      );
    }
    assert(!COMMANDS.some((x) => /unifi|router/i.test(x.name)), "no command of its own");
  },
);

proves(
  ["109-integrations-api FR-012", "109-integrations-api FR-018"],
  "109: stolos estate observe | check | assets unifi, run for real: the pin is in the fleet record (never the key), and disconnect removes the credential",
  async () => {
    const { sandbox, linkEngine } = await import("./sandbox.ts");
    const cert = await makeCertificate();
    const c = await startController(cert, routes());
    const sb = await sandbox("stolos-unifi-");
    try {
      const repo = path.join(sb.home, "fleet");
      await fs.mkdir(path.join(repo, "fleets"), { recursive: true });
      await fs.copy("examples/fleets/lab", path.join(repo, "fleets", "lab"));
      await linkEngine(repo);
      const env = { ARCHON_REPO: repo, ARCHON_FLEET: "lab" };
      const stolos = (args: string[], stdin = "") => sb.run("src/stolos/main.ts", args, stdin, env);
      const dir = path.join(sb.home, "config", "stolos", "secrets", "lab", "connectors", "unifi");
      // Not connected: it says how.
      let r = await stolos(["estate", "observe", "unifi"]);
      assertStringIncludes(r.out, "not connected (bun run stolos connect unifi)");
      // What `connect` keeps in the vault once the person has said yes: the key, the address, and the pinned fingerprint.
      await fs.mkdir(dir, { recursive: true });
      await fs.writeTextFile(
        path.join(dir, "credential.json"),
        JSON.stringify({
          url: c.url,
          key: KEY,
          fingerprint: normalizeFingerprint(cert.fingerprint),
        }) + "\n",
      );
      r = await stolos(["estate", "observe", "unifi"]);
      assertEquals(r.code, 0, r.out);
      const file = await fs.readTextFile(path.join(repo, "fleets", "lab", "estate", "unifi.ts"));
      assertStringIncludes(file, showFingerprint(cert.fingerprint));
      assertStringIncludes(file, 'provider: "unifi"');
      assertStringIncludes(file, "GENERATED by `stolos estate observe`");
      assert(!file.includes(KEY), "the key is not in the fleet record");
      assert(c.seen.every((x) => x.method === "GET" && x.key === KEY));
      r = await stolos(["estate", "assets", "unifi", "--json"]);
      const rows = JSON.parse(
        r.out.slice(r.out.indexOf("["), r.out.lastIndexOf("]") + 1),
      ) as Array<{
        provider: string;
        kind: string;
      }>;
      assert(
        rows.some((a) => a.provider === "unifi" && a.kind === "network-device"),
        r.out,
      );
      assert(rows.some((a) => a.kind === "client"));
      r = await stolos(["estate", "check", "unifi", "--json"]);
      const checked = JSON.parse(r.out.slice(r.out.indexOf("{"), r.out.lastIndexOf("}") + 1)) as {
        accounts: Array<{ provider: string; results: Array<{ id: string; status: string }> }>;
      };
      const u = checked.accounts.find((a) => a.provider === "unifi");
      assertEquals(u?.results.find((p) => p.id === "unifi-wifi-no-open")?.status, "fail");
      assertEquals(r.code, 1, "a failing policy fails the check");
      r = await stolos(["disconnect", "unifi"]);
      assertEquals(r.code, 0, r.out);
      assert(!(await fs.exists(path.join(dir, "credential.json"))));
      assert(await fs.exists(path.join(repo, "fleets", "lab", "estate", "unifi.ts")));
    } finally {
      await c.stop();
      await fs.remove(sb.home, { recursive: true });
    }
  },
  LIMIT,
);
