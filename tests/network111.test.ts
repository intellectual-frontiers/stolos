/**
 * Spec 111-network-posture: the pack over data (every policy: pass, fail, warn, not observed yet, not applicable, accepted), its table
 * (SCF ids against the catalog, explain codes, the fields of the pinned document), the scoping by tags, `knownClients` and its build
 * validation, the gaps, the evidence rows and their freshness, the inventory's determinism, the change events over two observations,
 * and the standards the spec names.
 *
 * @module
 */

import { fs, path, proc } from "@intellectual-frontiers/commons/ts/runtime";
import {
  assert,
  assertEquals,
  assertStringIncludes,
  proves,
} from "@intellectual-frontiers/commons/ts/runtime/test";
import { loadScf } from "../src/archon/compliance/catalog.ts";
import { type Evidence, fleetEvidence } from "../src/archon/compliance/report.ts";
import { cadenceFor, refreshCommand, resolveCadences } from "../src/archon/compliance/freshness.ts";
import { isScfId, SCF } from "../src/archon/compliance/scf.ts";
import { driftEvent } from "../src/archon/compliance/drift.ts";
import { componentDefinition } from "../src/archon/compliance/oscal.ts";
import { complianceView } from "../src/archon/compliance/report.ts";
import { EXPLAIN } from "../src/archon/core/explain.ts";
import { networkProblems } from "../src/archon/connect/network-asset.ts";
import {
  buildInventory,
  inventoryJson,
  inventoryMarkdown,
} from "../src/archon/connect/network-inventory.ts";
import {
  CHANGE_SCF,
  changeLine,
  diffObservations,
  NETWORK_CHANGE_KINDS,
} from "../src/archon/connect/network-changes.ts";
import {
  failing,
  NETWORK_GAPS,
  NETWORK_POLICIES,
  postureCounts,
  postureWaiting,
} from "../src/archon/connect/network-posture.ts";
import { buildNetworkView } from "../src/archon/connect/network-view.ts";
import { rescopePosture } from "../src/archon/connect/network-check.ts";
import { FACTS } from "./console/serve-stolos.ts";
import { document } from "./unifi-fixtures.ts";
import {
  AP,
  asset,
  client,
  device,
  GW,
  observation,
  port,
  rule,
  run,
  SW,
  vlan,
  wifi,
} from "./network111-fixtures.ts";
import { ENGINE_ROOT } from "./sandbox.ts";

/** The character the repository text never uses (spelled out, so that this file has none). */
const EM = String.fromCharCode(0x2014);

const NOW = Date.parse("2026-11-19T12:00:00Z");
const result = (r: ReturnType<typeof run>, id: string) => {
  const x = r.results.find((y) => y.id === `network/${id}`);
  assert(x !== undefined, `no result ${id}: ${r.results.map((y) => y.id).join(", ")}`);
  return x;
};
const specText = async (name: string): Promise<string> =>
  await fs.readTextFile(path.join(ENGINE_ROOT, "specs/111-network-posture", name));

// ---------------------------------------------------------------------------------------------------- the table

/** The fields of a schema of the pinned document, through `$ref` and `allOf`. */
function schemaProps(name: string): Set<string> {
  const doc = document();
  const seen = new Set<string>();
  const out = new Set<string>();
  const walk = (s: Record<string, unknown>): void => {
    const ref = s["$ref"];
    if (typeof ref === "string") {
      const n = ref.split("/").pop() ?? "";
      if (seen.has(n)) return;
      seen.add(n);
      walk((doc.components.schemas[n] ?? {}) as Record<string, unknown>);
      return;
    }
    for (const p of (s["allOf"] as Array<Record<string, unknown>> | undefined) ?? []) walk(p);
    for (const k of Object.keys((s["properties"] as Record<string, unknown> | undefined) ?? {})) {
      out.add(k);
    }
  };
  walk({ $ref: `#/components/schemas/${name}` });
  return out;
}

/** Whether `schema.member` (`Wifi broadcast overview.securityConfiguration.type`) exists in the pinned document. */
function inDocument(field: string): boolean {
  const doc = document();
  const i = Object.keys(doc.components.schemas).find((n) => field.startsWith(`${n}.`));
  if (i === undefined) return false;
  const path = field.slice(i.length + 1).split(".");
  let at = i;
  for (const [k, seg] of path.entries()) {
    const props = schemaProps(at);
    if (!props.has(seg)) return false;
    if (k === path.length - 1) return true;
    // The member's own schema: through its $ref.
    let found: string | undefined;
    const walk = (s: Record<string, unknown>, depth = 0): void => {
      if (found !== undefined || depth > 6) return;
      const ref = s["$ref"];
      if (typeof ref === "string") {
        walk(
          (doc.components.schemas[ref.split("/").pop() ?? ""] ?? {}) as Record<string, unknown>,
          depth + 1,
        );
        return;
      }
      for (const p of (s["allOf"] as Array<Record<string, unknown>> | undefined) ?? [])
        walk(p, depth + 1);
      const m = (s["properties"] as Record<string, Record<string, unknown>> | undefined)?.[seg];
      if (m !== undefined) {
        const r = m["$ref"];
        if (typeof r === "string") found = r.split("/").pop();
      }
    };
    walk({ $ref: `#/components/schemas/${at}` });
    if (found === undefined) return false;
    at = found;
  }
  return true;
}

proves(
  ["111-network-posture FR-001", "111-network-posture FR-011"],
  "111: the pack is one table of nine policies: ids, SCF controls Stolos knows, explain codes, and fields that exist in the pinned document",
  () => {
    assertEquals(NETWORK_POLICIES.length, 9);
    assertEquals(new Set(NETWORK_POLICIES.map((p) => p.id)).size, 9);
    assertEquals(new Set(NETWORK_POLICIES.map((p) => p.code)).size, 9);
    const local = [
      "observation time",
      "tags.ts dimensions",
      "adopted/<name>/network.ts tags and owner",
    ];
    for (const p of NETWORK_POLICIES) {
      assert(/^network\/[a-z-]+$/.test(p.id), p.id);
      assert(p.title.length > 10 && p.fix.length > 10, p.id);
      assert(p.scf.length >= 1 && p.scf.every(isScfId), `${p.id}: an SCF id Stolos does not know`);
      assert(/^E111-[A-Z-]+$/.test(p.code), p.code);
      const ex = EXPLAIN[p.code];
      assert(ex !== undefined && ex.fix.length > 10 && ex.what.length > 10, `explain ${p.code}`);
      assert(p.fields.length >= 1, p.id);
      for (const f of p.fields) {
        assert(local.includes(f) || inDocument(f), `${p.id}: ${f} is not in the pinned document`);
      }
    }
    // Every gap says why and what is missing, and none is a policy.
    assertEquals(NETWORK_GAPS.length, 7);
    for (const g of NETWORK_GAPS) {
      assert(g.reason.length > 30 && g.missing.length > 5, g.id);
      assert(!NETWORK_POLICIES.some((p) => p.id.endsWith(g.id)), g.id);
    }
    // The document really lacks what the gaps say it lacks.
    const doc = document();
    assert(!Object.keys(doc.paths).some((p) => /lease|port-forward|routes/.test(p)));
    assert(!schemaProps("Port overview").has("enabled"), "a port has no administrative state");
    assert(!schemaProps("Adopted device overview").has("latestFirmwareVersion"));
    const types = JSON.stringify(doc.components.schemas["Wifi security configuration overview"]);
    assert(!/WEP|WPA_/.test(types.replace(/WPA2|WPA3/g, "")), "the document has no WEP type");
  },
);

proves(
  ["111-network-posture FR-001", "111-network-posture FR-019"],
  "111: the SCF controls the pack and the change events name are SCF's, with SCF's names (and Stolos knows each)",
  async () => {
    const named = new Set<string>([
      ...NETWORK_POLICIES.flatMap((p) => p.scf),
      ...Object.values(CHANGE_SCF).flat(),
    ]);
    for (const id of named) assert(isScfId(id), `${id} is not in compliance/scf.ts`);
    const spec = await specText("spec.md");
    for (const id of [
      "AST-04",
      "AST-05.1",
      "AST-07.1",
      "AST-11",
      "CFG-02",
      "CFG-03",
      "CHG-03",
      "MON-02",
      "NET-04",
      "NET-06",
      "NET-22",
      "NET-24",
      "NET-24.1",
      "VPM-06",
      "VPM-08",
    ]) {
      assertStringIncludes(spec, id);
    }
    const catalog = await loadScf().catch(() => undefined);
    if (catalog === undefined) {
      assert(
        proc.env.get("STOLOS_REQUIRE_SCF") === undefined,
        "STOLOS_REQUIRE_SCF is set (CI) but the SCF catalog is not cached",
      );
      return;
    }
    const names: Record<string, string> = {
      "AST-05.1":
        "Technology Assets, Applications, Services and/or Data (TAASD) Criticality Ratings",
      "AST-11": "Automated Unauthorized Component Detection",
      "CFG-03": "Least Functionality",
      "NET-06": "Network Segmentation (macrosegmentation)",
      "NET-22": "Guest Networks",
      "NET-24": "Wireless Networking",
      "NET-24.1": "Wireless Networking Authentication & Encryption",
      "VPM-08": "Software & Firmware Patching",
      "VPM-06": "Vulnerability Remediation Process",
      "CHG-03": "Configuration Change Control",
      "CFG-02": "Configuration Management Program",
      "MON-02": "Continuous Monitoring",
      "AST-04": "Asset Inventories",
    };
    for (const [id, name] of Object.entries(names)) {
      assertEquals(catalog.controls[id]?.name, name, id);
    }
    assert(catalog.controls["NET-04"]?.name.startsWith("Data Flow Enforcement"), "NET-04");
    // What Stolos says an id is called is what the catalog says.
    for (const id of named) {
      const mine = SCF.find((c) => c.id === id);
      assertEquals(catalog.controls[id]?.name, mine?.name, id);
    }
  },
);

// ---------------------------------------------------------------------------------------------------- the policies

proves(
  ["111-network-posture FR-004"],
  "111: network/observed passes when recent, fails after 7 days, and is not observed yet when there is no observation",
  () => {
    assertEquals(result(run(observation()), "observed").status, "pass");
    const old = run(observation({ at: "2026-11-01T00:00:00Z" }));
    assertEquals(result(old, "observed").status, "fail");
    assertStringIncludes(result(old, "observed").detail, "2026-11-01");
    assertEquals(result(old, "observed").fix, "bun run stolos estate observe unifi");
    const none = run(undefined);
    assertEquals(result(none, "observed").status, "unknown");
    assertEquals(none.at, undefined);
  },
);

proves(
  ["111-network-posture FR-005"],
  "111: devices-present warns for an asset the controller no longer reports and is unknown, never gone, when the devices could not be read; devices-online fails for an offline device",
  () => {
    const sw = asset("office-switch", "s2");
    const ok = run(observation(), { assets: [sw] });
    assertEquals(result(ok, "devices-present").status, "pass");
    const gone = run(observation({ devices: [GW, AP] }), { assets: [sw] });
    assertEquals(result(gone, "devices-present").status, "warn");
    assertStringIncludes(result(gone, "devices-present").detail, "office-switch");
    assertStringIncludes(
      result(gone, "devices-present").items[0]?.detail ?? "",
      "stolos host release office-switch",
    );
    const unread = run(observation({ devices: [], gaps: ["devices (Default): 403"] }), {
      assets: [sw],
    });
    assertEquals(result(unread, "devices-present").status, "unknown");
    assertEquals(result(unread, "devices-online").status, "unknown");
    assertEquals(result(unread, "firmware-current").status, "unknown");
    const off = run(
      observation({
        devices: [GW, { ...SW, state: "OFFLINE" }, { ...AP, state: "UPDATING" }],
      }),
    );
    const online = result(off, "devices-online");
    assertEquals(online.status, "fail");
    assertEquals(
      online.items.map((i) => i.subject),
      ["Office Switch"],
    );
    const moving = run(observation({ devices: [GW, SW, { ...AP, state: "UPDATING" }] }));
    assertEquals(result(moving, "devices-online").status, "warn");
    // No asset adopted: not a result, a not-applicable line with the reason.
    const none = run(observation());
    assert(!none.results.some((r) => r.id === "network/devices-present"));
    assertEquals(
      none.notApplicable
        .find((n) => n.id === "network/devices-present")
        ?.reason.includes("network discover"),
      true,
    );
  },
);

proves(
  ["111-network-posture FR-006"],
  "111: firmware-current warns for each device whose own update flag is set, from its own version",
  () => {
    const r = run(
      observation({ devices: [GW, { ...SW, firmwareUpdatable: true, firmware: "6.5.0" }, AP] }),
    );
    const f = result(r, "firmware-current");
    assertEquals(f.status, "warn");
    assertStringIncludes(f.detail, "1 of 3");
    assertStringIncludes(f.items[0]?.detail ?? "", "6.5.0");
    assertEquals(f.scf, ["VPM-08", "VPM-06"]);
    assertEquals(result(run(observation()), "firmware-current").status, "pass");
  },
);

proves(
  ["111-network-posture FR-007"],
  "111: wifi-no-open fails for an enabled open network that is not a guest hotspot, passes for every other type the document names, and ignores a disabled one",
  () => {
    const types = [
      "WPA2_PERSONAL",
      "WPA3_PERSONAL",
      "WPA2_WPA3_PERSONAL",
      "WPA2_ENTERPRISE",
      "WPA3_ENTERPRISE",
      "WPA2_WPA3_ENTERPRISE",
    ];
    const secure = run(
      observation({ wifi: types.map((t, i) => wifi(`w${i}`, t.toLowerCase(), { security: t })) }),
    );
    assertEquals(result(secure, "wifi-no-open").status, "pass");
    const open = run(
      observation({
        wifi: [
          wifi("w1", "cafe", { security: "OPEN" }),
          wifi("w2", "visitors", { security: "OPEN", guest: true }),
          wifi("w3", "old", { security: "OPEN", enabled: false }),
          wifi("w4", "home"),
        ],
      }),
    );
    const o = result(open, "wifi-no-open");
    assertEquals(o.status, "fail");
    assertEquals(
      o.items.map((i) => i.subject),
      ["cafe"],
    );
    assertEquals(o.scf, ["NET-24.1", "NET-24"]);
    assertEquals(failing(open.results), true);
    // The Wi-Fi networks could not be read: not observed yet, not a pass.
    const unread = run(
      observation({ gaps: ["wifi broadcasts (Default): 403 (the credential may not read this)"] }),
    );
    assertEquals(result(unread, "wifi-no-open").status, "unknown");
    // None at all: nothing applies.
    assert(run(observation()).notApplicable.some((n) => n.id === "network/wifi-no-open"));
  },
);

proves(
  ["111-network-posture FR-008"],
  "111: guest-isolated fails for a guest Wi-Fi network on a network the details say is not isolated, passes when it is, and is not observed yet where the flag was not read",
  () => {
    const guest = (over: object = {}) =>
      wifi("w1", "visitors", { guest: true, security: "WPA2_PERSONAL", network: "n1", ...over });
    const v = (isolated?: boolean) =>
      vlan("n1", "Guests", { vlanId: 30, ...(isolated === undefined ? {} : { isolated }) });
    const bad = run(observation({ wifi: [guest({ clientIsolation: true })], vlans: [v(false)] }));
    const b = result(bad, "guest-isolated");
    assertEquals(b.status, "fail");
    assertStringIncludes(b.items[0]?.detail ?? "", "not isolated");
    assertStringIncludes(b.items[0]?.detail ?? "", "its clients are isolated from each other");
    assertEquals(
      result(run(observation({ wifi: [guest()], vlans: [v(true)] })), "guest-isolated").status,
      "pass",
    );
    // The default network carries it (`native`).
    const native = run(
      observation({
        wifi: [guest({ network: "native" })],
        vlans: [vlan("n0", "Default", { default: true, isolated: false })],
      }),
    );
    assertEquals(result(native, "guest-isolated").status, "fail");
    // The details were not read: an earlier observation, or a denied read.
    const unknown = run(observation({ wifi: [guest()], vlans: [v()] }));
    assertEquals(result(unknown, "guest-isolated").status, "unknown");
    const unreadNetworks = run(
      observation({
        wifi: [guest()],
        gaps: ["networks (Default): 403 (the credential may not read this)"],
      }),
    );
    assertEquals(result(unreadNetworks, "guest-isolated").status, "unknown");
    // No guest Wi-Fi network (or a disabled one): not applicable.
    const none = run(observation({ wifi: [guest({ enabled: false })], vlans: [v(false)] }));
    assert(none.notApplicable.some((n) => n.id === "network/guest-isolated"));
    assertEquals(result(bad, "guest-isolated").scf, ["NET-22", "NET-06"]);
  },
);

proves(
  ["111-network-posture FR-009", "111-network-posture FR-021"],
  "111: unknown-clients is informational without an allowlist and fails with knownClients; a matched machine, a listed MAC and a VPN session never count; the allowlist is validated at build",
  () => {
    const clients = [
      client(10, "front-desk-pc"),
      client(11, "stranger", { kind: "wireless" }),
      client(12, "tv"),
      client(13, "vpn-session", { kind: "vpn", mac: undefined, uplink: undefined }),
    ];
    const machines = [{ name: "front-desk", macs: ["02:00:00:00:10:0a"] }];
    const info = run(observation({ clients }), { machines });
    const i = result(info, "unknown-clients");
    assertEquals(i.status, "warn");
    assertEquals(
      i.items.map((x) => x.subject),
      ["stranger", "tv"],
    );
    assertStringIncludes(i.detail, "informational");
    assertEquals(failing(info.results), false, "informational is never a failure");
    const declared = run(observation({ clients }), {
      machines,
      config: {
        autoAdopt: [],
        knownClients: [{ mac: "02:00:00:00:10:0C", name: "tv", reason: "the lobby TV" }],
      },
    });
    const d = result(declared, "unknown-clients");
    assertEquals(d.status, "fail");
    assertEquals(
      d.items.map((x) => x.subject),
      ["stranger"],
    );
    // An allowlist that names everyone: pass.
    const all = run(observation({ clients }), {
      machines,
      config: {
        autoAdopt: [],
        knownClients: [{ mac: "02:00:00:00:10:0b" }, { mac: "02:00:00:00:10:0c" }],
      },
    });
    assertEquals(result(all, "unknown-clients").status, "pass");
    // The list is validated: a MAC, a duplicate, a stray field, a dimension that does not exist.
    const problems = networkProblems(
      {
        autoAdopt: [],
        knownClients: [
          { mac: "02:00:00:00:10:0c" },
          {
            mac: "02-00-00-00-10-0c" as `${string}:${string}:${string}:${string}:${string}:${string}`,
          },
          { mac: "02:00:00:00:10:0C" },
          { mac: "02:00:00:00:10:0d", surprise: 1 } as unknown as {
            mac: `${string}:${string}:${string}:${string}:${string}:${string}`;
          },
        ],
        requiredTags: ["owner", "nope"],
      },
      [],
      ["owner", "criticality"],
    );
    const says = problems.map((p) => `${p.where}: ${p.message}`).join("\n");
    assertStringIncludes(says, "knownClients[1]: 02-00-00-00-10-0c is not a MAC address");
    assertStringIncludes(says, "knownClients[2]: 02:00:00:00:10:0C is listed twice");
    assertStringIncludes(says, "knownClients[3]: surprise is not a field of a known client");
    assertStringIncludes(says, "requiredTags[1]: nope is not a dimension of tags.ts");
    assertEquals(
      networkProblems({ autoAdopt: [], knownClients: [{ mac: "02:00:00:00:10:0c" }] }),
      [],
    );
  },
);

proves(
  ["111-network-posture FR-010"],
  "111: assets-classified warns for the fleet's own owner and criticality, fails for dimensions network.ts names, applies only where the fleet defines them; unused-poe warns for a port with its link down and PoE on",
  () => {
    const sw = asset("office-switch", "s2");
    const ap = asset("ap-hall", "a3", { class: "access-point", owner: "alice" });
    const tags = (
      held: Record<string, string[]>,
      dimensions = ["env", "owner", "criticality"],
    ) => ({
      dimensions,
      held: new Map(Object.entries(held)),
    });
    const warn = run(observation(), {
      assets: [sw, ap],
      tags: tags({ "office-switch": ["env:lab"], "ap-hall": ["criticality:low"] }),
    });
    const w = result(warn, "assets-classified");
    assertEquals(w.status, "warn");
    // ap-hall has an owner field and a criticality tag; the switch has neither.
    assertEquals(
      w.items.map((i) => i.subject),
      ["office-switch"],
    );
    assertStringIncludes(w.items[0]?.detail ?? "", "owner:*, criticality:*");
    const strict = run(observation(), {
      assets: [sw],
      tags: tags({ "office-switch": ["env:lab"] }),
      config: { autoAdopt: [], requiredTags: ["owner"] },
    });
    assertEquals(result(strict, "assets-classified").status, "fail");
    const good = run(observation(), {
      assets: [sw],
      tags: tags({ "office-switch": ["owner:alice", "criticality:high"] }),
    });
    assertEquals(result(good, "assets-classified").status, "pass");
    const noDims = run(observation(), { assets: [sw], tags: tags({}, ["env"]) });
    assert(noDims.notApplicable.some((n) => n.id === "network/assets-classified"));
    assert(!noDims.results.some((r) => r.id === "network/assets-classified"));
    // Ports.
    const ports = [
      port(1),
      port(2, { state: "DOWN", poeEnabled: true }),
      port(3, { state: "DOWN", poeEnabled: false, poeState: "DOWN" }),
    ];
    const poe = run(observation({ ports }));
    const p = result(poe, "unused-poe");
    assertEquals(p.status, "warn");
    assertEquals(
      p.items.map((i) => i.subject),
      ["Office Switch port 2"],
    );
    assertEquals(
      result(
        run(observation({ ports: [port(1), port(3, { state: "DOWN", poeEnabled: false })] })),
        "unused-poe",
      ).status,
      "pass",
    );
    // An observation written before the PoE setting was read is not observed yet.
    const old = run(observation({ ports: [port(2, { state: "DOWN", poeEnabled: undefined })] }));
    assertEquals(result(old, "unused-poe").status, "unknown");
    // A gateway's port without PoE, or no port at all: nothing applies.
    assert(
      run(
        observation({ ports: [port(1, { poeState: undefined, poeEnabled: undefined })] }),
      ).notApplicable.some((n) => n.id === "network/unused-poe"),
    );
  },
);

proves(
  ["111-network-posture FR-002"],
  "111: nothing observed is one waiting item with the observe command, in spec 117's words, never a failure",
  () => {
    const none = run(undefined);
    assertEquals(failing(none.results), false);
    assert(none.results.every((r) => r.status === "unknown" || r.id.startsWith("network/assets")));
    const w = postureWaiting(none);
    assert(w !== undefined);
    assertStringIncludes(w.message, "not observed yet");
    assertEquals(w.fix, "bun run stolos estate observe unifi");
    assertEquals(w.code, "P117-NO-EVIDENCE");
    const c = postureCounts(none.results);
    assertEquals(c.fail, 0);
    // Fully observed: nothing to wait for.
    assertEquals(postureWaiting(run(observation())), undefined);
  },
);

proves(
  ["111-network-posture FR-003"],
  "111: an accepted risk (network/<word>) makes a failure accepted until its date, then it fails again and says so; a pass is never changed",
  () => {
    const open = observation({ wifi: [wifi("w1", "cafe", { security: "OPEN" })] });
    const until = (d: string) => [
      { policy: "network/wifi-no-open", reason: "the cafe's guest board", by: "alice", until: d },
    ];
    const live = run(open, { accepted: until("2027-01-31") });
    const a = result(live, "wifi-no-open");
    assertEquals(a.status, "accepted");
    assertStringIncludes(a.detail, "accepted by alice until 2027-01-31: the cafe's guest board");
    assertEquals(failing(live.results), false);
    const ended = run(open, { accepted: until("2026-11-01") });
    assertEquals(result(ended, "wifi-no-open").status, "fail");
    assertStringIncludes(
      result(ended, "wifi-no-open").detail,
      "the accepted risk ended 2026-11-01",
    );
    const secure = observation({ wifi: [wifi("w1", "home")] });
    const pass = run(secure, { accepted: until("2027-01-31") });
    assertEquals(result(pass, "wifi-no-open"), result(run(secure, {}), "wifi-no-open"));
    assertEquals(result(pass, "wifi-no-open").status, "pass");
  },
);

proves(
  ["111-network-posture FR-013"],
  "111: a choice of network assets scopes the pack to their devices, the Wi-Fi they broadcast, their ports and the clients connected through them",
  () => {
    const sw = asset("office-switch", "s2");
    const ap = asset("ap-hall", "a3", { class: "access-point" });
    const obs = observation({
      devices: [GW, { ...SW, firmwareUpdatable: true }, { ...AP, state: "OFFLINE" }],
      wifi: [wifi("w1", "cafe", { security: "OPEN", broadcastBy: ["a3"] })],
      clients: [
        client(10, "on-switch", { uplink: "s2" }),
        client(11, "on-ap", { uplink: "a3", kind: "wireless" }),
      ],
      ports: [port(2, { state: "DOWN" })],
    });
    const all = run(obs, { assets: [sw, ap] });
    assertEquals(result(all, "devices-online").status, "fail");
    assertEquals(result(all, "wifi-no-open").status, "fail");
    const onlySwitch = run(obs, { assets: [sw, ap], scope: new Set(["office-switch"]) });
    assertEquals(result(onlySwitch, "devices-online").status, "pass");
    assertEquals(result(onlySwitch, "firmware-current").status, "warn");
    assert(
      onlySwitch.notApplicable.some((n) => n.id === "network/wifi-no-open"),
      "the open Wi-Fi is the AP's",
    );
    assertEquals(
      result(onlySwitch, "unknown-clients").items.map((i) => i.subject),
      ["on-switch"],
    );
    assertEquals(result(onlySwitch, "unused-poe").status, "warn");
    assertEquals(onlySwitch.scope, ["office-switch"]);
    const onlyAp = run(obs, { assets: [sw, ap], scope: new Set(["ap-hall"]) });
    assertEquals(result(onlyAp, "devices-online").status, "fail");
    assertEquals(result(onlyAp, "wifi-no-open").status, "fail");
    assert(onlyAp.notApplicable.some((n) => n.id === "network/unused-poe"));
    // The same data scoped again (compliance --tag): the observation's freshness is not scoped.
    const again = rescopePosture(all, new Set(["office-switch", "alpha"]));
    assertEquals(again.scope, ["office-switch"]);
    assertEquals(result(again, "observed").status, "pass");
  },
);

// ---------------------------------------------------------------------------------------------------- evidence

proves(
  ["111-network-posture FR-014"],
  "111: each result is one piece of evidence with the source network, its SCF controls, the connector and the time the router was observed; a fleet with no router has none, and the account's cadence applies",
  () => {
    const posture = run(observation({ wifi: [wifi("w1", "cafe", { security: "OPEN" })] }), {
      assets: [asset("office-switch", "s2")],
    });
    const without = fleetEvidence(FACTS, NOW);
    assert(!without.some((e) => e.source === "network"), "no router, no network evidence");
    const ev = fleetEvidence({ ...FACTS, networkPosture: posture }, NOW).filter(
      (e) => e.source === "network",
    );
    assertEquals(ev.length, posture.results.length);
    const open = ev.find((e) => e.check === NETWORK_POLICIES[4]?.title);
    assertEquals(open?.status, "fail");
    assertEquals(open?.scf, ["NET-24.1", "NET-24"]);
    assertEquals(open?.connector, "unifi");
    assertEquals(open?.observedAt, "2026-11-18T12:00:00.000Z");
    assertEquals(open?.subject, "network (192.0.2.1)");
    // The freshness of the account applies, and the command that observes it again is named.
    const cadences = resolveCadences({ connectors: [] });
    assert(cadenceFor(open as Evidence, cadences) !== undefined, "held to the cloud cadence");
    assertEquals(refreshCommand(open as Evidence), "bun run stolos estate observe unifi");
    // Every other piece of the fleet's evidence is what it was.
    const rest = fleetEvidence({ ...FACTS, networkPosture: posture }, NOW).filter(
      (e) => e.source !== "network",
    );
    assertEquals(JSON.stringify(rest), JSON.stringify(without));
    // A control with network evidence has it; the others are not changed.
    const v = complianceView(fleetEvidence({ ...FACTS, networkPosture: posture }, NOW));
    assertEquals(v.controls.find((c) => c.control.id === "NET-24.1")?.status, "fail");
    assertEquals(v.controls.find((c) => c.control.id === "NET-22")?.status, "no evidence");
  },
);

// ---------------------------------------------------------------------------------------------------- inventory

proves(
  ["111-network-posture FR-016"],
  "111: the inventory is deterministic (the same data, the same bytes, whatever the order of the records), holds the observation's time and no time of its own, and lists a gone asset from its record",
  () => {
    const sw = asset("office-switch", "s2");
    const auto = asset("ap-hall", "a3", { class: "access-point", auto: true });
    const gone = asset("old-switch", "s9", { mac: "02:00:00:00:00:09" });
    const obs = observation({
      devices: [
        GW,
        { ...SW, firmwareUpdatable: true },
        AP,
        device("n7", "Mystery", { model: "ZZ-9" }),
      ],
      wifi: [wifi("w2", "zeta"), wifi("w1", "alpha", { security: "OPEN" })],
      vlans: [
        vlan("n2", "IoT", { vlanId: 20, isolated: true }),
        vlan("n1", "Default", { vlanId: 1, default: true }),
      ],
    });
    const view = (o: typeof obs) =>
      buildNetworkView({ observations: [o], assets: [sw, auto, gone], machines: [] });
    const tags = new Map([["office-switch", ["owner:alice", "env:lab"]]]);
    const make = (o: typeof obs) =>
      buildInventory({ view: view(o), assets: [sw, auto, gone], tags });
    const a = inventoryMarkdown(make(obs));
    const shuffled = { ...obs, records: [...(obs.records ?? [])].reverse() };
    assertEquals(inventoryMarkdown(make(shuffled)), a);
    assertEquals(inventoryJson(make(shuffled)), inventoryJson(make(obs)));
    assertStringIncludes(a, "# Network inventory");
    assertStringIncludes(a, "CM-8");
    // Sorted by name (code-unit order, the same everywhere), with the fleet's name for an adopted device and the controller's for the rest.
    const inv = make(obs);
    assertEquals(
      inv.devices.map((d) => d.name),
      ["Gateway", "Mystery", "ap-hall", "office-switch", "old-switch"],
    );
    const row = (n: string) => inv.devices.find((d) => d.name === n);
    assertEquals(row("office-switch")?.joined, "adopted");
    assertEquals(row("office-switch")?.updateWaiting, true);
    assertEquals(row("office-switch")?.tags, ["env:lab", "owner:alice"]);
    assertEquals(row("office-switch")?.uplink, "Gateway");
    assertEquals(row("ap-hall")?.joined, "auto-adopted");
    assertEquals(row("Mystery")?.joined, "discovered, not adopted");
    assertEquals(row("old-switch")?.presence, "gone from the integration");
    assertEquals(row("old-switch")?.model, "USW-24");
    assertEquals(row("Gateway")?.observed, "2026-11-18T12:00:00Z");
    // No time of its own: nothing in it is newer than the observation.
    assert(!/2026-11-19|2027/.test(a), "no generation time");
    assertEquals(
      inv.wifi.map((w) => w.name),
      ["alpha", "zeta"],
    );
    assertEquals(
      inv.networks.map((n) => [n.name, n.isolated]),
      [
        ["Default", "not read"],
        ["IoT", "yes"],
      ],
    );
    // The gaps are reported with their reasons, never left out.
    for (const g of NETWORK_GAPS) assertStringIncludes(a, g.title);
    assertEquals((JSON.parse(inventoryJson(inv)) as { devices: unknown[] }).devices.length, 5);
  },
);

// ---------------------------------------------------------------------------------------------------- change events

proves(
  ["111-network-posture FR-018"],
  "111: the change events between two observations: a device added, gone, renamed, with new firmware; a Wi-Fi network added, removed, with another security; a network added, removed, changed; a firewall rule added, removed, changed",
  () => {
    const before = observation({
      devices: [GW, SW, AP],
      wifi: [
        wifi("w1", "home"),
        wifi("w2", "old"),
        wifi("w3", "cafe", { security: "WPA2_PERSONAL" }),
      ],
      vlans: [
        vlan("n1", "Default", { vlanId: 1, default: true }),
        vlan("n2", "IoT", { vlanId: 20 }),
        vlan("n3", "Lab", { vlanId: 40 }),
      ],
      rules: [
        rule("r1", "allow dns", { action: "allow" }),
        rule("r2", "block all"),
        rule("r3", "old rule"),
      ],
    });
    const after = observation({
      devices: [
        { ...GW, firmware: "7.1.0" },
        { ...SW, name: "Core Switch" },
        device("n7", "New Camera Hub", { model: "UVC", class: "camera" }),
      ],
      wifi: [
        wifi("w1", "home"),
        wifi("w3", "cafe", { security: "OPEN" }),
        wifi("w4", "guest", { guest: true }),
      ],
      vlans: [
        vlan("n1", "Default", { vlanId: 1, default: true }),
        vlan("n2", "IoT", { vlanId: 21, enabled: false }),
        vlan("n4", "Cameras", { vlanId: 50 }),
      ],
      rules: [
        rule("r1", "allow dns", { action: "block" }),
        rule("r2", "block all", { enabled: false }),
        rule("r4", "allow ntp", { action: "allow" }),
      ],
    });
    const d = diffObservations(before, after);
    const kinds = (k: string) => d.filter((x) => x.kind === k).map((x) => x.subject);
    assertEquals(kinds("device-added"), ["New Camera Hub"]);
    assertEquals(kinds("device-gone"), ["AP Hall"]);
    assertEquals(kinds("device-renamed"), ["Core Switch"]);
    assertEquals(d.find((x) => x.kind === "device-renamed")?.before, "Office Switch");
    assertEquals(kinds("firmware-changed"), ["Gateway"]);
    assertEquals(d.find((x) => x.kind === "firmware-changed")?.detail, "firmware 7.0.1 to 7.1.0");
    assertEquals(kinds("wifi-added"), ["guest"]);
    assertEquals(kinds("wifi-removed"), ["old"]);
    assertEquals(kinds("wifi-security-changed"), ["cafe"]);
    assertEquals(
      d.find((x) => x.kind === "wifi-security-changed")?.detail,
      "security WPA2_PERSONAL to OPEN",
    );
    assertEquals(kinds("network-added"), ["Cameras"]);
    assertEquals(kinds("network-removed"), ["Lab"]);
    assertEquals(kinds("network-changed"), ["IoT"]);
    assertEquals(d.find((x) => x.kind === "network-changed")?.detail, "VLAN 20 to 21, disabled");
    assertEquals(kinds("firewall-rule-added"), ["allow ntp"]);
    assertEquals(kinds("firewall-rule-removed"), ["old rule"]);
    assertEquals(kinds("firewall-rule-changed").sort(), ["allow dns", "block all"]);
    // Nothing changed: nothing recorded; a changed state or address alone is not a configuration change.
    assertEquals(diffObservations(before, before), []);
    assertEquals(
      diffObservations(
        before,
        observation({
          ...{ devices: [{ ...GW, state: "OFFLINE", ip: "192.0.2.77" }, SW, AP] },
          wifi: [
            wifi("w1", "home"),
            wifi("w2", "old"),
            wifi("w3", "cafe", { security: "WPA2_PERSONAL" }),
          ],
          vlans: [
            vlan("n1", "Default", { vlanId: 1, default: true }),
            vlan("n2", "IoT", { vlanId: 20 }),
            vlan("n3", "Lab", { vlanId: 40 }),
          ],
          rules: [
            rule("r1", "allow dns", { action: "allow" }),
            rule("r2", "block all"),
            rule("r3", "old rule"),
          ],
        }),
      ),
      [],
    );
    // Every kind has SCF controls (CM-3 and CM-6), and the list of kinds is the list the table covers.
    for (const k of NETWORK_CHANGE_KINDS)
      assert(CHANGE_SCF[k].every(isScfId) && CHANGE_SCF[k].length === 2, k);
    assertEquals(new Set(d.map((x) => x.kind)).size, NETWORK_CHANGE_KINDS.length);
  },
);

proves(
  ["111-network-posture FR-019"],
  "111: the drift's message names a network change by kind and subject only, never what a value was",
  () => {
    const e = driftEvent({
      fleet: "lab",
      since: { rev: "abcdef1234567890", at: "2026-11-10T00:00:00Z" },
      now: { at: "2026-11-18T00:00:00Z" },
      changes: [],
      network: [
        {
          kind: "wifi-security-changed",
          subject: "cafe",
          before: "WPA2_PERSONAL",
          after: "OPEN",
          detail: "security WPA2_PERSONAL to OPEN",
          scf: ["NET-24.1", "CFG-02"],
          connector: "unifi",
          commit: "0123456789abcdef",
          at: "2026-11-12T00:00:00Z",
        },
      ],
    });
    assertStringIncludes(e.what, "Network changes (1):");
    assertStringIncludes(
      e.what,
      changeLine({ kind: "wifi-security-changed", subject: "cafe", connector: "unifi" }),
    );
    assert(!e.what.includes("WPA2_PERSONAL") && !e.what.includes("OPEN"), e.what);
    assertStringIncludes(e.event, "1 network change(s)");
  },
);

// ---------------------------------------------------------------------------------------------------- OSCAL

proves(
  ["111-network-posture FR-017"],
  "111: the OSCAL component definition has a hardware component for each network asset and one for the network's posture; the system security plan's inventory items carry its class, model, firmware and MAC",
  async () => {
    const posture = run(observation(), { assets: [asset("office-switch", "s2")] });
    const f = { ...FACTS, networkPosture: posture };
    const machines = [
      ...f.machines,
      {
        name: "office-switch",
        kind: "device",
        where: "192.0.2.2",
        network: {
          class: "switch",
          model: "USW-24",
          mac: "02:00:00:00:00:02",
          via: "unifi",
          firmware: "7.0.1",
          state: "ONLINE",
          presence: "present",
        },
      },
    ];
    const input = {
      view: complianceView(fleetEvidence(f, NOW)),
      fleet: f.fleet,
      machines,
      version: "0.0.0",
      now: new Date("2026-11-18T12:00:00Z"),
    };
    const doc = (await componentDefinition(input)) as {
      "component-definition": {
        components: Array<{
          title: string;
          type: string;
          props?: Array<{ name: string; value: string }>;
        }>;
      };
    };
    const components = doc["component-definition"].components;
    const hw = components.find((c) => c.title === "office-switch");
    assertEquals(hw?.type, "hardware");
    const prop = (n: string) => hw?.props?.find((p) => p.name === n)?.value;
    assertEquals(prop("device-class"), "switch");
    assertEquals(prop("model"), "USW-24");
    assertEquals(prop("firmware-version"), "7.0.1");
    assertEquals(prop("mac-address"), "02:00:00:00:00:02");
    assertEquals(prop("ip-address"), "192.0.2.2");
    assert(
      components.some((c) => c.title.startsWith("The network (posture")),
      "the posture component",
    );
    // The same input gives the same document.
    assertEquals(JSON.stringify(await componentDefinition(input)), JSON.stringify(doc));
  },
);

// ---------------------------------------------------------------------------------------------------- the spec

proves(
  ["111-network-posture FR-021"],
  "111: the spec and its plan name their standards and use RFC 2119 words, the spec adds no ontology term, and the repository text has no em dash",
  async () => {
    for (const f of ["spec.md", "plan.md"]) {
      const text = await specText(f);
      assertStringIncludes(text, "Standards considered");
      for (const w of ["RFC 2119", "RFC 8174", "CM-6", "CM-8", "SC-7", "AC-18", "SI-2"]) {
        assertStringIncludes(text, w);
      }
      assertStringIncludes(text, "SCF");
      assert(!text.includes(EM), `${f} has an em dash`);
    }
    const spec = await specText("spec.md");
    for (const line of spec.split("\n").filter((l) => /^- \*\*FR-\d{3}\*\*/.test(l))) {
      const id = /FR-\d{3}/.exec(line)?.[0] ?? "";
      const block = spec.slice(spec.indexOf(line)).split(/\n(?=- \*\*FR-|\n#)/)[0] ?? "";
      assert(/\b(MUST|MUST NOT|SHOULD|SHOULD NOT|MAY)\b/.test(block), `${id} has no RFC 2119 word`);
    }
    for (const f of [
      "src/archon/connect/network-posture.ts",
      "src/archon/connect/network-changes.ts",
      "src/archon/connect/network-inventory.ts",
      "src/archon/connect/network-check.ts",
      "tests/network111.test.ts",
    ]) {
      assert(
        !(await fs.readTextFile(path.join(ENGINE_ROOT, f))).includes(EM),
        `${f} has an em dash`,
      );
    }
    // The audit is unchanged: no new unaligned term.
    const audit = await fs.readTextFile(path.join(ENGINE_ROOT, "ontology/stolos/audit.ts"));
    assert(!audit.includes("111-network-posture"), "no term of spec 111");
  },
);
