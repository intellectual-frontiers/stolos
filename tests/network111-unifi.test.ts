/**
 * Spec 111-network-posture: the UniFi connector against a real local HTTPS server (the new GET reads of the pinned document and their
 * gaps, GET only), and the commands for real in a sandbox fleet with a Git repository and a signing key: `network check` (its report,
 * exit codes, JSON, quiet, scoping by tags, accepted risks, `knownClients`), `network inventory` (deterministic, a file), `network
 * changes` and `compliance drift` over real commits, and the evidence in `stolos compliance`.
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
import {
  observedDevices,
  observedPorts,
  observedSsids,
  observedVlans,
} from "../src/archon/connect/network-asset.ts";
import { fixture, makeCertificate, startController, uuid, type Routes } from "./unifi-fixtures.ts";
import { fleet as sandboxFleet } from "./lab-fleet.ts";

const NOW = new Date("2026-11-18T12:00:00Z");
const LIMIT = { timeout: 180_000 };
const SITE = uuid();
const GW = uuid();
const SW = uuid();
const AP = uuid();
const NET_DEFAULT = uuid();
const NET_GUEST = uuid();
const W_CAFE = uuid();
const W_VISITORS = uuid();
const Z_INT = uuid();
const Z_EXT = uuid();
const R_BLOCK = uuid();

/** What the controller says; a test changes the table between observations. */
function routes(): Routes {
  const device = (id: string, o: Record<string, unknown>) =>
    fixture("Adopted device overview", {
      id,
      supported: true,
      firmwareUpdatable: false,
      firmwareVersion: "7.0.1",
      ...o,
    });
  const detail = (id: string, name: string, uplink?: string, ports: unknown[] = []) =>
    fixture("Adopted device details", {
      id,
      name,
      configurationId: "7596498d2f367dc2",
      interfaces: { ports },
      ...(uplink ? { uplink: { deviceId: uplink } } : {}),
    });
  const port = (idx: number, state: string, poeEnabled: boolean) =>
    fixture("Port overview", {
      idx,
      state,
      connector: "RJ45",
      maxSpeedMbps: 1000,
      poe: { enabled: poeEnabled, standard: "802.3af", state: poeEnabled ? "UP" : "DOWN", type: 1 },
    });
  const owner = { origin: "USER_DEFINED" };
  const network = (id: string, name: string, vlanId: number, isDefault: boolean) =>
    fixture("Gateway managed network overview", {
      id,
      management: "GATEWAY",
      name,
      vlanId,
      default: isDefault,
      enabled: true,
      zoneId: Z_INT,
      metadata: owner,
    });
  const networkDetails = (id: string, name: string, vlanId: number, isolated: boolean) =>
    fixture("Gateway managed network details", {
      id,
      management: "GATEWAY",
      name,
      vlanId,
      enabled: true,
      zoneId: Z_INT,
      isolationEnabled: isolated,
      metadata: owner,
    });
  const broadcast = (id: string, name: string, security: string, o: Record<string, unknown> = {}) =>
    fixture("IntegrationStandardWifiBroadcastOverviewDto", {
      id,
      type: "STANDARD",
      name,
      enabled: true,
      securityConfiguration: { type: security },
      broadcastingFrequenciesGHz: [5],
      broadcastingDeviceFilter: { type: "DEVICES", deviceIds: [AP] },
      metadata: owner,
      ...o,
    });
  const broadcastDetails = (id: string, name: string, security: string, isolated: boolean) =>
    fixture("IntegrationStandardWifiBroadcastDetailDto", {
      id,
      type: "STANDARD",
      name,
      enabled: true,
      securityConfiguration: { type: security },
      clientIsolationEnabled: isolated,
      metadata: owner,
    });
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
        data: [
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
            interfaces: ["ports"],
            firmwareUpdatable: true,
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
        ],
      },
    },
    [`/v1/sites/${SITE}/devices/${GW}`]: { body: detail(GW, "Gateway") },
    [`/v1/sites/${SITE}/devices/${SW}`]: {
      body: detail(SW, "Office Switch", GW, [port(1, "UP", true), port(2, "DOWN", true)]),
    },
    [`/v1/sites/${SITE}/devices/${AP}`]: { body: detail(AP, "AP Hall", SW) },
    [`/v1/sites/${SITE}/clients`]: {
      body: {
        data: [
          fixture("Wired client overview", {
            type: "WIRED",
            name: "front-desk-pc",
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
        data: [network(NET_DEFAULT, "Default", 1, true), network(NET_GUEST, "Guests", 30, false)],
      },
    },
    [`/v1/sites/${SITE}/networks/${NET_DEFAULT}`]: {
      body: networkDetails(NET_DEFAULT, "Default", 1, false),
    },
    [`/v1/sites/${SITE}/networks/${NET_GUEST}`]: {
      body: networkDetails(NET_GUEST, "Guests", 30, false),
    },
    [`/v1/sites/${SITE}/firewall/zones`]: {
      body: {
        data: [
          fixture("Firewall zone", { id: Z_INT, name: "Internal" }),
          fixture("Firewall zone", { id: Z_EXT, name: "External" }),
        ],
      },
    },
    [`/v1/sites/${SITE}/firewall/policies`]: {
      body: {
        data: [
          fixture("Firewall policy", {
            id: R_BLOCK,
            name: "block guests to internal",
            enabled: true,
            index: 1,
            action: { type: "BLOCK" },
            source: { zoneId: Z_EXT },
            destination: { zoneId: Z_INT },
            loggingEnabled: false,
            metadata: owner,
          }),
        ],
      },
    },
    [`/v1/sites/${SITE}/wifi/broadcasts`]: {
      body: {
        data: [
          broadcast(W_CAFE, "cafe", "OPEN"),
          broadcast(W_VISITORS, "visitors", "WPA2_PERSONAL", {
            hotspotConfiguration: { type: "CAPTIVE_PORTAL" },
            network: { type: "SPECIFIC", networkId: NET_GUEST },
          }),
        ],
      },
    },
    [`/v1/sites/${SITE}/wifi/broadcasts/${W_CAFE}`]: {
      body: broadcastDetails(W_CAFE, "cafe", "OPEN", false),
    },
    [`/v1/sites/${SITE}/wifi/broadcasts/${W_VISITORS}`]: {
      body: broadcastDetails(W_VISITORS, "visitors", "WPA2_PERSONAL", true),
    },
  };
}

proves(
  ["111-network-posture FR-012"],
  "111: the connector reads a network's isolation, a Wi-Fi broadcast's client isolation and a port's PoE setting from the pinned document (GET only), and a read that fails is a gap with the field left out",
  async () => {
    const cert = await makeCertificate();
    const table = routes();
    // A denied read, and a read the controller does not have: gaps, never errors, never guesses.
    table[`/v1/sites/${SITE}/networks/${NET_GUEST}`] = { status: 403 };
    delete table[`/v1/sites/${SITE}/wifi/broadcasts/${W_CAFE}`];
    const c = await startController(cert, table);
    try {
      const o = await unifi.observe(
        { url: c.url, key: "test-key-not-a-secret", fingerprint: cert.fingerprint },
        http.liveTransport({ credentials: "allow", userAgent: "stolos" }),
        NOW,
      );
      const vlans = observedVlans(o);
      assertEquals(
        vlans.map((v) => [v.name, v.isolated]),
        [
          ["Default", false],
          ["Guests", undefined],
        ],
      );
      const ssids = observedSsids(o);
      assertEquals(
        ssids.map((s) => [s.name, s.clientIsolation, s.guest]),
        [
          ["cafe", undefined, false],
          ["visitors", true, true],
        ],
      );
      assertEquals(
        observedPorts(o).map((p) => [p.index, p.state, p.poeEnabled]),
        [
          [1, "UP", true],
          [2, "DOWN", true],
        ],
      );
      assert(
        o.gaps.some((g) => g.startsWith("isolation of network Guests")),
        o.gaps.join("\n"),
      );
      assert(
        o.gaps.some((g) => g.startsWith("client isolation of Wi-Fi network cafe")),
        o.gaps.join("\n"),
      );
      // The device list is still read: the gaps are about the details only.
      assertEquals(observedDevices(o).length, 3);
      // Only what the document has: every request is a GET of a path of the pinned document.
      assert(c.seen.every((r) => r.method === "GET"));
      assert(
        c.seen.some((r) => r.target.includes(`/networks/${NET_DEFAULT}`)) &&
          c.seen.some((r) => r.target.includes(`/wifi/broadcasts/${W_VISITORS}`)),
        "the details were read",
      );
    } finally {
      await c.stop();
    }
  },
  LIMIT,
);

const parse = (out: string): Record<string, unknown> =>
  JSON.parse(out.slice(out.indexOf("{"), out.lastIndexOf("}") + 1)) as Record<string, unknown>;

proves(
  [
    "111-network-posture FR-013",
    "111-network-posture FR-003",
    "111-network-posture FR-009",
    "111-network-posture FR-014",
    "111-network-posture FR-015",
    "111-network-posture FR-016",
    "111-network-posture FR-018",
    "111-network-posture FR-019",
    "111-network-posture FR-021",
  ],
  "111: in a sandbox fleet, network check reports and exits by its results (JSON, quiet, scoped by tags, accepted risks, knownClients), the inventory is deterministic, the changes and the drift come from real commits, and the evidence is in stolos compliance",
  async () => {
    const cert = await makeCertificate();
    const table = routes();
    const ctl = await startController(cert, table);
    const lab = await sandboxFleet();
    try {
      const { stolos, sh, repo, sb } = lab;
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
      // Not observed yet: one waiting item, never a failure, exit 0.
      let r = await stolos(["network", "check", "--verbose"]);
      assertEquals(r.code, 0, r.out);
      assertStringIncludes(r.out, "not observed yet");
      r = await stolos(["network", "check", "--json"]);
      assertEquals(r.code, 0, r.out);
      const waiting = parse(r.out) as {
        waiting: { fix: string; code: string };
        counts: Record<string, number>;
      };
      assertEquals(waiting.waiting.fix, "bun run stolos estate observe unifi");
      assertEquals(waiting.waiting.code, "P117-NO-EVIDENCE");
      assertEquals(waiting.counts["fail"], 0);
      // Observe and commit: the baseline of the history.
      r = await stolos(["estate", "observe", "unifi"]);
      assertEquals(r.code, 0, r.out);
      r = await stolos(["apply", "-m", "lab: observe the router"]);
      assertEquals(r.code, 0, r.out);
      const base = await sh(repo, "git", "rev-parse", "HEAD");
      // The check: a report that exits 1 for what fails, asking the controller nothing.
      const seen = ctl.seen.length;
      r = await stolos(["network", "check", "--verbose"]);
      assertEquals(r.code, 1, r.out);
      assertEquals(ctl.seen.length, seen, "the check reads Git and this PC, not the controller");
      for (const w of [
        "E111-WIFI-OPEN",
        "E111-GUEST-ISOLATION",
        "cafe",
        "visitors",
        "NET-24.1",
        "NET-22",
        "VPM-08",
        "Office Switch port 2",
        "informational",
        "management interface",
        "WEP",
        "Disabled ports",
      ]) {
        assertStringIncludes(r.out, w);
      }
      r = await stolos(["network", "check", "--json"]);
      assertEquals(r.code, 1, r.out);
      const j = parse(r.out) as {
        counts: Record<string, number>;
        policies: Array<{
          id: string;
          status: string;
          scf: string[];
          code: string;
          fix?: string;
          items: unknown[];
        }>;
        gaps: unknown[];
        observed: string;
      };
      const by = (id: string) => j.policies.find((p) => p.id === `network/${id}`);
      assertEquals(by("wifi-no-open")?.status, "fail");
      assertEquals(by("guest-isolated")?.status, "fail");
      assertEquals(by("firmware-current")?.status, "warn");
      assertEquals(by("unknown-clients")?.status, "warn");
      assertEquals(by("unused-poe")?.status, "warn");
      assertEquals(by("devices-online")?.status, "pass");
      assertEquals(by("wifi-no-open")?.code, "E111-WIFI-OPEN");
      assert((by("wifi-no-open")?.fix ?? "").length > 10);
      assertEquals(j.gaps.length, 7);
      assert(j.counts["fail"] === 2 && j.counts["unknown"] === 0, JSON.stringify(j.counts));
      // Quiet: the closing line only.
      const quiet = await stolos(["network", "check", "--quiet"]);
      assertEquals(quiet.code, 1);
      assert(
        quiet.out.length < r.out.length && !quiet.out.includes("management interface"),
        quiet.out,
      );
      // Accept the two failures (controls/accepted.ts): until the date they are accepted, the check exits 0.
      await fs.mkdir(path.join(repo, "fleets/lab/controls"), { recursive: true });
      await fs.writeTextFile(
        path.join(repo, "fleets/lab/controls/accepted.ts"),
        `export const accepted = [
  { policy: "network/wifi-no-open", reason: "the cafe board is open by design", by: "alice", until: "2099-01-31" },
  { policy: "network/guest-isolated", reason: "guests share the default network until the move", by: "alice", until: "2099-01-31" },
];\n`,
      );
      r = await stolos(["network", "check"]);
      assertEquals(r.code, 0, r.out);
      assertStringIncludes(r.out, "accepted by alice until 2099-01-31");
      // The evidence of stolos compliance: one row for each result, with its SCF controls.
      r = await stolos(["compliance", "--json"]);
      assertStringIncludes(r.out, `"source": "network"`);
      await fs.remove(path.join(repo, "fleets/lab/controls/accepted.ts"));
      // knownClients: an empty list makes the unknown client a failure; listing it makes it a pass; a bad MAC is a problem of build.
      const net = (list: string) =>
        `import { defineNetwork } from "@intellectual-frontiers/stolos/archon/connect/network-asset";\n\nexport const network = defineNetwork({ autoAdopt: [], knownClients: ${list} });\n`;
      await fs.writeTextFile(path.join(repo, "fleets/lab/network.ts"), net("[]"));
      r = await stolos(["network", "check", "--json"]);
      assertEquals(parse(r.out)["policies"] instanceof Array, true);
      assertEquals(
        (parse(r.out) as { policies: Array<{ id: string; status: string }> }).policies.find(
          (p) => p.id === "network/unknown-clients",
        )?.status,
        "fail",
      );
      await fs.writeTextFile(
        path.join(repo, "fleets/lab/network.ts"),
        net(`[{ mac: "02:00:00:00:10:10", name: "front desk", reason: "the reception PC" }]`),
      );
      r = await stolos(["build"]);
      assertEquals(r.code, 0, r.out);
      r = await stolos(["network", "check", "--json"]);
      assertEquals(
        (parse(r.out) as { policies: Array<{ id: string; status: string }> }).policies.find(
          (p) => p.id === "network/unknown-clients",
        )?.status,
        "pass",
      );
      await fs.writeTextFile(path.join(repo, "fleets/lab/network.ts"), net(`[{ mac: "nope" }]`));
      r = await stolos(["build"]);
      assertEquals(r.code, 1, r.out);
      assertStringIncludes(r.out, "nope is not a MAC address");
      await fs.remove(path.join(repo, "fleets/lab/network.ts"));
      // Scoped by tags: adopt the switch, tag it, and check only it (and what is connected through it).
      r = await stolos(["network", "adopt", "--all", "--class", "switch"]);
      assertEquals(r.code, 0, r.out);
      r = await stolos(["tag", "add", "office-switch", "criticality:high"]);
      assertEquals(r.code, 0, r.out);
      r = await stolos(["network", "check", "--tag", "criticality:high", "--json"]);
      const scoped = parse(r.out) as {
        scope: string[];
        policies: Array<{ id: string; status: string }>;
        notApplicable: Array<{ id: string }>;
      };
      assertEquals(scoped.scope, ["office-switch"]);
      assertEquals(
        scoped.policies.find((p) => p.id === "network/firmware-current")?.status,
        "warn",
      );
      assert(
        scoped.notApplicable.some((n) => n.id === "network/wifi-no-open"),
        "the open Wi-Fi is the AP's",
      );
      assertEquals(r.code, 0, r.out);
      r = await stolos(["network", "check", "--tag", "env:prod"]);
      assertEquals(r.code, 1, r.out);
      assertStringIncludes(r.out, "no network asset has");
      // The asset has criticality but no owner: the fleet defines both dimensions, so it is to look at.
      r = await stolos(["network", "check", "--json"]);
      const all = parse(r.out) as {
        policies: Array<{ id: string; status: string; detail: string }>;
      };
      assertEquals(all.policies.find((p) => p.id === "network/assets-classified")?.status, "warn");
      assertStringIncludes(
        all.policies.find((p) => p.id === "network/assets-classified")?.detail ?? "",
        "owner:*",
      );
      // Fleet status: the Network group carries the posture.
      r = await stolos(["fleet", "status"]);
      assertStringIncludes(r.out, "posture:");
      assertStringIncludes(r.out, "E111-WIFI-OPEN");
      // The inventory: deterministic, a file, JSON.
      const out1 = path.join(repo, "out/inv-1.md");
      const out2 = path.join(repo, "out/inv-2.md");
      r = await stolos(["network", "inventory", "--out", out1]);
      assertEquals(r.code, 0, r.out);
      r = await stolos(["network", "inventory", "--out", out2]);
      assertEquals(await fs.readTextFile(out2), await fs.readTextFile(out1));
      const md = await fs.readTextFile(out1);
      for (const w of [
        "# Network inventory",
        "office-switch",
        "Gateway",
        "AP Hall",
        "criticality:high",
        "USW-24",
        "7.0.1",
        "02:00:00:00:00:02",
        "cafe",
        "OPEN",
        "Guests",
        "VLAN",
        "adopted",
        "discovered, not adopted",
      ]) {
        assertStringIncludes(md, w);
      }
      r = await stolos(["network", "inventory", "--format", "json"]);
      const inv = parse(r.out) as { devices: Array<{ name: string; joined: string }> };
      assertEquals(
        inv.devices.map((d) => d.name),
        ["AP Hall", "Gateway", "office-switch"].sort(),
      );
      assertEquals(inv.devices.find((d) => d.name === "office-switch")?.joined, "adopted");
      r = await stolos(["network", "inventory", "--format", "xml"]);
      assertEquals(r.code, 1);
      // Commit what the fleet has now, then change the network at the controller and observe again.
      r = await stolos(["apply", "-m", "lab: adopt the switch"]);
      assertEquals(r.code, 0, r.out);
      const second = await sh(repo, "git", "rev-parse", "HEAD");
      // No change yet: no event.
      r = await stolos(["network", "changes", "--since", base]);
      assertEquals(r.code, 0, r.out);
      assertStringIncludes(r.out, "no change since");
      const wifiBody = table[`/v1/sites/${SITE}/wifi/broadcasts`]?.body as {
        data: Array<{ id: string; securityConfiguration: { type: string } }>;
      };
      table[`/v1/sites/${SITE}/wifi/broadcasts`] = {
        body: {
          data: [
            ...wifiBody.data
              .filter((w) => w.id === W_CAFE)
              .map((w) => ({ ...w, securityConfiguration: { type: "WPA3_PERSONAL" } })),
          ],
        },
      };
      const devs = table[`/v1/sites/${SITE}/devices`]?.body as {
        data: Array<Record<string, unknown>>;
      };
      table[`/v1/sites/${SITE}/devices`] = {
        body: {
          data: devs.data.map((d) =>
            d["id"] === SW
              ? { ...d, firmwareVersion: "7.0.2", firmwareUpdatable: false, name: "Core Switch" }
              : d,
          ),
        },
      };
      const pol = table[`/v1/sites/${SITE}/firewall/policies`]?.body as {
        data: Array<Record<string, unknown>>;
      };
      table[`/v1/sites/${SITE}/firewall/policies`] = {
        body: { data: pol.data.map((p) => ({ ...p, enabled: false })) },
      };
      r = await stolos(["estate", "observe", "unifi"]);
      assertEquals(r.code, 0, r.out);
      // Not committed yet: the events say so.
      r = await stolos(["network", "changes", "--since", base, "--json"]);
      const pending = parse(r.out) as {
        changes: Array<{ kind: string; commit: string; uncommitted?: boolean }>;
      };
      assert(
        pending.changes.length >= 3 && pending.changes.every((c) => c.uncommitted === true),
        r.out,
      );
      r = await stolos(["apply", "-m", "lab: the network changed"]);
      assertEquals(r.code, 0, r.out);
      const third = await sh(repo, "git", "rev-parse", "HEAD");
      r = await stolos(["network", "changes", "--since", second, "--json"]);
      assertEquals(r.code, 0, r.out);
      const h = parse(r.out) as {
        changes: Array<{
          kind: string;
          subject: string;
          detail: string;
          commit: string;
          at: string;
          scf: string[];
          uncommitted?: boolean;
        }>;
      };
      const kinds = h.changes.map((c) => `${c.kind}: ${c.subject}`).sort();
      assertEquals(kinds, [
        "device-renamed: Core Switch",
        "firewall-rule-changed: block guests to internal",
        "firmware-changed: Core Switch",
        "wifi-removed: visitors",
        "wifi-security-changed: cafe",
      ]);
      assert(
        h.changes.every((c) => c.commit === third && !c.uncommitted && c.scf.length === 2),
        r.out,
      );
      assertEquals(
        h.changes.find((c) => c.kind === "wifi-security-changed")?.detail,
        "security OPEN to WPA3_PERSONAL",
      );
      // From the baseline the same changes are listed (the commit between them changed nothing of the network).
      r = await stolos(["network", "changes", "--since", base]);
      assertStringIncludes(r.out, "wifi-security-changed: cafe: security OPEN to WPA3_PERSONAL");
      assertStringIncludes(r.out, "CHG-03");
      assertStringIncludes(r.out, "5 change(s) since");
      // The compliance drift lists them as events, and the posture is better: the open Wi-Fi is gone.
      r = await stolos(["compliance", "drift", "--since", second, "--json"]);
      assertEquals(r.code, 0, r.out);
      const drift = parse(r.out) as { network?: Array<{ kind: string }> };
      assertEquals(drift.network?.length, 5);
      r = await stolos(["compliance", "drift", "--since", second]);
      assertStringIncludes(r.out, "network change");
      assertStringIncludes(r.out, "wifi-security-changed: cafe");
      r = await stolos(["network", "check", "--json"]);
      assertEquals(
        (parse(r.out) as { policies: Array<{ id: string; status: string }> }).policies.find(
          (p) => p.id === "network/wifi-no-open",
        )?.status,
        "pass",
      );
      // Everything the controller was asked was a GET.
      assert(ctl.seen.every((x) => x.method === "GET"));
    } finally {
      await ctl.stop();
      await fs.remove(lab.sb.home, { recursive: true }).catch(() => {});
    }
  },
  LIMIT,
);
