/**
 * Spec 110-network-assets: the UniFi connector against a real local HTTPS server with recorded responses shaped by the pinned document
 * (classes, uplinks, the Wi-Fi advertisement, the gaps, GET only), and the commands for real in a sandbox fleet with a signing key:
 * discover, adopt (one signed commit), tags on an asset, refresh and departure, auto-adopt by a rule, release, and a question to every
 * machine.
 *
 * @module
 */

import { fs, path } from "@intellectual-frontiers/system";
import { http } from "@intellectual-frontiers/net";
import {
  assert,
  assertEquals,
  assertStringIncludes,
  proves,
} from "@intellectual-frontiers/commons/ts/runtime/test";
import { unifi } from "../src/archon/connect/unifi.ts";
import { observedDevices, observedSsids } from "../src/archon/connect/network-asset.ts";
import { fixture, makeCertificate, startController, uuid, type Routes } from "./unifi-fixtures.ts";
import { fleet as sandboxFleet } from "./lab-fleet.ts";

const NOW = new Date("2026-11-18T12:00:00Z");
const LIMIT = { timeout: 180_000 };
const SITE = uuid();
const GW = uuid();
const SW = uuid();
const AP = uuid();
const IOT = uuid();
const PHONE = uuid();

function routes(over: { devices?: unknown[] } = {}): Routes {
  const device = (id: string, o: Record<string, unknown>) =>
    fixture("Adopted device overview", {
      id,
      supported: true,
      firmwareUpdatable: false,
      firmwareVersion: "7.0.1",
      ...o,
    });
  const detail = (id: string, name: string, uplink?: string) =>
    fixture("Adopted device details", {
      id,
      name,
      configurationId: "7596498d2f367dc2",
      interfaces: {},
      ...(uplink ? { uplink: { deviceId: uplink } } : {}),
    });
  const owner = { origin: "USER_DEFINED" };
  return {
    "/v1/info": { body: fixture("Application info", { applicationVersion: "10.3.58" }) },
    "/v1/sites": {
      body: {
        data: [
          fixture("Site overview", { id: SITE, name: "Default", internalReference: "default" }),
        ],
      },
    },
    [`/v1/sites/${SITE}/devices`]: {
      body: {
        data: over.devices ?? [
          device(GW, {
            name: "Gateway",
            model: "UDM-Pro",
            macAddress: "02:00:00:00:00:01",
            ipAddress: "192.0.2.1",
            state: "ONLINE",
            features: ["gateway", "switching"],
            interfaces: [],
          }),
          device(SW, {
            name: "Office Switch",
            model: "USW-24",
            macAddress: "02:00:00:00:00:02",
            ipAddress: "192.0.2.2",
            state: "ONLINE",
            features: ["switching"],
            interfaces: [],
          }),
          device(AP, {
            name: "AP Hall",
            model: "U7-Pro",
            macAddress: "02:00:00:00:00:03",
            ipAddress: "192.0.2.3",
            state: "ONLINE",
            features: ["accessPoint"],
            interfaces: [],
          }),
          device(PHONE, {
            name: "Mystery",
            model: "ZZ-9",
            macAddress: "02:00:00:00:00:04",
            ipAddress: "192.0.2.4",
            state: "ONLINE",
            features: [],
            interfaces: [],
          }),
        ],
      },
    },
    [`/v1/sites/${SITE}/devices/${GW}`]: { body: detail(GW, "Gateway") },
    [`/v1/sites/${SITE}/devices/${SW}`]: { body: detail(SW, "Office Switch", GW) },
    [`/v1/sites/${SITE}/devices/${AP}`]: { body: detail(AP, "AP Hall", SW) },
    // The device nobody could classify has no uplink in its details: a gap, no edge.
    [`/v1/sites/${SITE}/devices/${PHONE}`]: { body: detail(PHONE, "Mystery") },
    [`/v1/sites/${SITE}/clients`]: {
      body: {
        data: [
          fixture("Wired client overview", {
            type: "WIRED",
            name: "alpha",
            ipAddress: "10.0.0.10",
            macAddress: "02:00:00:00:10:10",
            uplinkDeviceId: SW,
            access: { type: "DEFAULT" },
          }),
        ],
      },
    },
    [`/v1/sites/${SITE}/networks`]: {
      body: {
        data: [
          fixture("Gateway managed network overview", {
            id: IOT,
            management: "GATEWAY",
            name: "IoT",
            vlanId: 20,
            default: false,
            enabled: true,
            zoneId: uuid(),
            metadata: owner,
          }),
        ],
      },
    },
    [`/v1/sites/${SITE}/firewall/zones`]: { body: { data: [] } },
    [`/v1/sites/${SITE}/firewall/policies`]: { body: { data: [] } },
    [`/v1/sites/${SITE}/wifi/broadcasts`]: {
      body: {
        data: [
          fixture("IntegrationStandardWifiBroadcastOverviewDto", {
            type: "STANDARD",
            name: "iot-wifi",
            enabled: true,
            securityConfiguration: { type: "WPA3_PERSONAL" },
            broadcastingFrequenciesGHz: [2.4],
            broadcastingDeviceFilter: { type: "DEVICES", deviceIds: [AP] },
            network: { type: "SPECIFIC", networkId: IOT },
            metadata: owner,
          }),
        ],
      },
    },
  };
}

proves(
  ["110-network-assets FR-001", "110-network-assets FR-007", "110-network-assets FR-012"],
  "110: UniFi's devices are classified from the document's features, uplinks come from the device details, a device with none is a reported gap, the Wi-Fi advertisement names its access points, and only GET is sent",
  async () => {
    const cert = await makeCertificate();
    const c = await startController(cert, routes());
    try {
      const o = await unifi.observe(
        { url: c.url, key: "test-key-not-a-secret", fingerprint: cert.fingerprint },
        http.liveTransport({ credentials: "allow", userAgent: "stolos" }),
        NOW,
      );
      const d = observedDevices(o);
      assertEquals(
        d.map((x) => [x.name, x.class]),
        [
          ["Gateway", "gateway"],
          ["Office Switch", "switch"],
          ["AP Hall", "access-point"],
          ["Mystery", "other"],
        ],
      );
      assertEquals(d[0]?.facets, ["routing", "switching"]);
      assertEquals(d.find((x) => x.name === "AP Hall")?.uplink, SW);
      assertEquals(d.find((x) => x.name === "Office Switch")?.uplink, GW);
      assertEquals(d.find((x) => x.name === "Gateway")?.uplink, undefined);
      assertEquals(d.find((x) => x.name === "Mystery")?.uplink, undefined);
      assert(
        o.gaps.some((g) => g.startsWith("uplink (Mystery)")),
        o.gaps.join("\n"),
      );
      assert(
        !o.gaps.some((g) => g.startsWith("uplink (Gateway)")),
        "a gateway has no uplink by nature",
      );
      const s = observedSsids(o)[0];
      assertEquals([s?.name, s?.broadcastBy, s?.network], ["iot-wifi", [AP], IOT]);
      // The gaps of spec 109 are kept.
      for (const g of ["dhcp-leases", "port-forwards", "routes"])
        assert(
          o.gaps.some((x) => x.startsWith(g)),
          g,
        );
      assert(c.seen.length > 0 && c.seen.every((r) => r.method === "GET"));
    } finally {
      await c.stop();
    }
  },
  LIMIT,
);

proves(
  [
    "110-network-assets FR-002",
    "110-network-assets FR-003",
    "110-network-assets FR-004",
    "110-network-assets FR-005",
    "110-network-assets FR-009",
    "110-network-assets FR-011",
  ],
  "110: discover, adopt (one signed commit), tags on an asset, a rule's auto-adoption, a device gone from UniFi (a warning, kept), release, and the question to every machine, in a sandbox fleet",
  async () => {
    const cert = await makeCertificate();
    const table = routes();
    const ctl = await startController(cert, table);
    const lab = await sandboxFleet();
    try {
      const { stolos, sh, repo, origin, sb } = lab;
      const subject = async () => await sh(origin, "git", "log", "-1", "--format=%s", "main");
      // The credential in the vault, pinned to the controller's own certificate.
      const credDir = path.join(
        sb.home,
        "config",
        "stolos",
        "secrets",
        "lab",
        "connectors",
        "unifi",
      );
      await fs.mkdir(credDir, { recursive: true });
      await fs.writeTextFile(
        path.join(credDir, "credential.json"),
        JSON.stringify({
          url: ctl.url,
          key: "test-key-not-a-secret",
          fingerprint: cert.fingerprint,
        }),
      );
      // Before it is observed: discover says what to do.
      let r = await stolos(["network", "discover"]);
      assertEquals(r.code, 1, r.out);
      assertStringIncludes(r.out, "has not been observed yet");
      r = await stolos(["estate", "observe", "unifi"]);
      assertEquals(r.code, 0, r.out);
      r = await stolos(["apply", "-m", "lab: observe the router"]);
      assertEquals(r.code, 0, r.out);
      // discover: every device, with class, model, firmware, address, state; no request to the controller is needed.
      const seenBefore = ctl.seen.length;
      r = await stolos(["network", "discover", "--json"]);
      assertEquals(r.code, 0, r.out);
      assertEquals(ctl.seen.length, seenBefore, "discover reads the observation only");
      const found = JSON.parse(
        r.out.slice(r.out.search(/^\[$/m), r.out.lastIndexOf("\n]") + 2),
      ) as Array<{
        name: string;
        class: string;
        model: string;
        firmware: string;
        address: string;
        state: string;
      }>;
      assertEquals(
        found.map((x) => x.class),
        ["gateway", "switch", "access-point", "other"],
      );
      assertEquals(found[1], {
        ...found[1],
        model: "USW-24",
        firmware: "7.0.1",
        address: "192.0.2.2",
        state: "ONLINE",
      });
      r = await stolos(["network", "discover", "--class", "toaster"]);
      assertEquals(r.code, 1);
      assertStringIncludes(r.out, "not a device class");
      // adopt: refusals first, nothing written; then one signed commit.
      const clean = await sh(repo, "git", "status", "--porcelain");
      r = await stolos(["network", "adopt", "nope"]);
      assertEquals(r.code, 1, r.out);
      assertStringIncludes(r.out, "does not report a device");
      r = await stolos(["network", "adopt", "--class", "switch"]);
      assertEquals(r.code, 1, r.out);
      assertEquals(await sh(repo, "git", "status", "--porcelain"), clean, "nothing written");
      r = await stolos(["network", "adopt", "--all", "--class", "switch"]);
      assertEquals(r.code, 0, r.out);
      assertEquals(await subject(), "110-network-assets: adopt office-switch");
      const rec = await sh(
        origin,
        "git",
        "show",
        "main:fleets/lab/adopted/office-switch/network.ts",
      );
      for (const w of [
        `via: "unifi"`,
        `deviceId: "${SW}"`,
        `mac: "02:00:00:00:00:02"`,
        `class: "switch"`,
        `joined: "integration"`,
      ]) {
        assertStringIncludes(rec, w);
      }
      assert(
        !rec.includes("ssh") && !rec.includes("serial"),
        "no SSH, and no serial the API did not give",
      );
      assertEquals(await sh(repo, "git", "status", "--porcelain"), "", "everything was sent");
      // The same device again is refused; the machine takes tags like any machine.
      r = await stolos(["network", "adopt", "Office Switch"]);
      assertEquals(r.code, 1, r.out);
      assertStringIncludes(r.out, "already adopted");
      r = await stolos(["tag", "add", "office-switch", "env:lab", "netonly"]);
      assertEquals(r.code, 0, r.out);
      assertStringIncludes(
        await sh(origin, "git", "show", "main:fleets/lab/adopted/office-switch/network.ts"),
        `"env:lab"`,
      );
      r = await stolos(["tag", "list", "office-switch", "--json"]);
      assertEquals(r.code, 0, r.out);
      assertStringIncludes(r.out, `"env:lab"`);
      // A name a machine already has is refused with what to do (alpha is a managed host).
      table[`/v1/sites/${SITE}/devices`] = {
        body: {
          data: [
            ...(table[`/v1/sites/${SITE}/devices`]?.body as { data: unknown[] }).data,
            fixture("Adopted device overview", {
              id: uuid(),
              name: "Alpha",
              model: "USW-8",
              macAddress: "02:00:00:00:00:09",
              ipAddress: "192.0.2.9",
              state: "ONLINE",
              features: ["switching"],
              interfaces: [],
              supported: true,
              firmwareUpdatable: false,
            }),
          ],
        },
      };
      r = await stolos(["estate", "observe", "unifi"]);
      assertEquals(r.code, 0, r.out);
      r = await stolos(["network", "adopt", "Alpha", "--no-apply"]);
      assertEquals(r.code, 1, r.out);
      assertStringIncludes(r.out, "alpha is already a machine, a host or an asset");
      r = await stolos(["apply", "-m", "lab: observe again"]);
      assertEquals(r.code, 0, r.out);
      // auto-adopt: a typed rule in network.ts; estate observe writes the record, apply sends it (never silent).
      await fs.writeTextFile(
        path.join(repo, "fleets/lab/network.ts"),
        `import { defineNetwork } from "@intellectual-frontiers/stolos/archon/connect/network-asset";\n\nexport const network = defineNetwork({ autoAdopt: [{ class: "access-point" }] });\n`,
      );
      r = await stolos(["build"]);
      assertEquals(r.code, 0, r.out);
      r = await stolos(["estate", "observe", "unifi", "--verbose"]);
      assertEquals(r.code, 0, r.out);
      assertStringIncludes(r.out, "adopted by your rules");
      assertStringIncludes(r.out, "ap-hall");
      assertStringIncludes(
        await fs.readTextFile(path.join(repo, "fleets/lab/adopted/ap-hall/network.ts")),
        "auto: true",
      );
      assertStringIncludes(await sh(repo, "git", "status", "--porcelain"), "adopted/ap-hall/");
      r = await stolos(["apply", "-m", "110-network-assets: auto-adopt ap-hall"]);
      assertEquals(r.code, 0, r.out);
      // A bad rule is a problem of stolos build.
      await fs.writeTextFile(
        path.join(repo, "fleets/lab/network.ts"),
        `export const network = { autoAdopt: [{ class: "toaster" }] };\n`,
      );
      r = await stolos(["build"]);
      assertEquals(r.code, 1, r.out);
      assertStringIncludes(r.out, "toaster is not a device class");
      await sh(repo, "git", "checkout", "--", "fleets/lab/network.ts");
      // refresh and departure: the controller stops reporting the switch: a warning with its fix, the record stays.
      table[`/v1/sites/${SITE}/devices`] = {
        body: {
          data: (
            table[`/v1/sites/${SITE}/devices`]?.body as { data: Array<{ id: string }> }
          ).data.filter((d) => d.id !== SW),
        },
      };
      r = await stolos(["estate", "observe", "unifi", "--verbose"]);
      assertEquals(r.code, 0, r.out);
      assertStringIncludes(r.out, "office-switch is gone from the integration");
      assertStringIncludes(r.out, "stolos host release office-switch");
      assert(
        await fs.exists(path.join(repo, "fleets/lab/adopted/office-switch/network.ts")),
        "never deleted automatically",
      );
      r = await stolos(["network", "status"]);
      assertStringIncludes(r.out, "gone from the integration");
      r = await stolos(["fleet", "status"]);
      assertStringIncludes(r.out, "gone from the integration");
      // Ask every machine: the asset is skipped with its reason, never an error.
      r = await stolos(["fleet", "query", "select 1 as one", "--tag", "netonly", "--json"]);
      assertStringIncludes(r.out, "no osquery on this device");
      assertStringIncludes(r.out, `"state": "skipped"`);
      assert(!r.out.includes("failed"), r.out);
      // release: on a person's explicit request only; the record goes, the controller is not touched, a rule does not take it again.
      const writes = ctl.seen.filter((x) => x.method !== "GET").length;
      r = await stolos(["host", "release", "ap-hall"]);
      assertEquals(r.code, 0, r.out);
      assertStringIncludes(r.out, "nothing at the controller changed");
      assert(!(await fs.exists(path.join(repo, "fleets/lab/adopted/ap-hall"))));
      assertStringIncludes(
        await fs.readTextFile(path.join(repo, "fleets/lab/network-released.ts")),
        AP,
      );
      assertEquals(ctl.seen.filter((x) => x.method !== "GET").length, writes);
    } finally {
      await ctl.stop();
      await fs.remove(lab.sb.home, { recursive: true }).catch(() => {});
    }
  },
  LIMIT,
);
