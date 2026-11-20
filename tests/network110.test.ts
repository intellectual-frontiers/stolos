/**
 * Spec 110-network-assets: the classes and facets of network devices, the way of joining, the record of an asset and its names, the
 * auto-adopt rules, the reconcile of an observation (present, gone, unread), clients matched by MAC, the topology and its edges in the
 * estate graph, the tag helpers, and the question to every machine skipping an asset. These run on data, in this process.
 *
 * @module
 */

import { assert, assertEquals, assertStringIncludes, proves } from "@intellectual-frontiers/test";
import { CODE_LISTS } from "../ontology/stolos/mod.ts";
import { DEVICE_CLASSES, DEVICE_FACETS, WAYS_OF_JOINING } from "../src/archon/ontology.auto.ts";
import {
  classify,
  FACETS_OF_CLASS,
  OCSF_DEVICE_TYPE,
  parseClass,
  devicesWithFacet,
} from "../src/archon/connect/network-class.ts";
import {
  assetPolicies,
  autoAdoptChoices,
  chooseDevices,
  defineNetwork,
  deviceLabel,
  networkAssetSource,
  networkProblems,
  notAdopted,
  observedDevices,
  planAdoption,
  reconcile,
  type NetworkAssetDef,
} from "../src/archon/connect/network-asset.ts";
import { entityParts } from "../src/archon/connect/integration-entities.ts";
import type {
  NetworkDevice,
  Client,
  WifiNetwork,
  Vlan,
} from "../src/archon/connect/integration-entities.ts";
import type { Observation } from "../src/archon/connect/connector.ts";
import {
  buildNetworkView,
  matchClients,
  networkFactsFor,
} from "../src/archon/connect/network-view.ts";
import { layoutTopology, topology, topologySvg } from "../src/archon/connect/network-topology.ts";
import { integrationBadge, JOINED_LABEL, wayOfJoining } from "../src/archon/adopt/joining.ts";
import { answeredLine, askAll } from "../src/archon/adopt/query.ts";
import { buildGraph, estateQuery } from "../src/archon/estate/graph.ts";
import {
  inVlan,
  ofClass,
  onSsid,
  uplinkedTo,
  withFacet,
  type TagFacts,
} from "../src/archon/model/tags.ts";

const NOW = new Date("2026-11-18T12:00:00Z");

const dev = (id: string, name: string, over: Partial<NetworkDevice> = {}): NetworkDevice => ({
  source: "unifi",
  site: "Default",
  id,
  name,
  kind: "other",
  model: "X",
  mac: `02:00:00:00:00:0${id.slice(-1)}`,
  ip: `192.0.2.${id.slice(-1)}`,
  state: "ONLINE",
  firmware: "7.0.1",
  class: "other",
  facets: [],
  ...over,
});

const GW = dev("g1", "Gateway", {
  class: "gateway",
  facets: ["routing", "switching"],
  model: "UDM-Pro",
});
const SW = dev("s2", "Office Switch", {
  class: "switch",
  facets: ["switching"],
  model: "USW-24",
  uplink: "g1",
});
const AP = dev("a3", "AP Hall", {
  class: "access-point",
  facets: ["wireless"],
  model: "U7-Pro",
  uplink: "s2",
});
const LOOSE = dev("a4", "AP Garage", { class: "access-point", facets: ["wireless"], model: "U6" });
const client = (id: string, name: string, over: Partial<Client> = {}): Client => ({
  source: "unifi",
  site: "Default",
  id,
  name,
  kind: "wired",
  ...over,
});
const wifi = (over: Partial<WifiNetwork> = {}): WifiNetwork => ({
  source: "unifi",
  site: "Default",
  id: "w1",
  name: "home",
  enabled: true,
  security: "WPA3_PERSONAL",
  frequenciesGHz: [5],
  guest: false,
  ...over,
});
const vlan = (id: string, name: string, vlanId: number, over: Partial<Vlan> = {}): Vlan => ({
  source: "unifi",
  site: "Default",
  id,
  name,
  vlanId,
  enabled: true,
  default: vlanId === 1,
  ...over,
});

/** An observation as the connector writes it, from typed entities (the same mapping the connector uses). */
function observation(o: {
  devices?: NetworkDevice[];
  clients?: Client[];
  wifi?: WifiNetwork[];
  vlans?: Vlan[];
  gaps?: string[];
}): Observation {
  const parts = [
    entityParts({ kind: "router", capability: "devices", items: o.devices ?? [] }),
    entityParts({ kind: "router", capability: "clients", items: o.clients ?? [] }),
    entityParts({ kind: "router", capability: "wifi", items: o.wifi ?? [] }),
    entityParts({ kind: "router", capability: "networks-and-vlans", items: o.vlans ?? [] }),
  ];
  return {
    at: "2026-11-18T12:00:00Z",
    provider: "unifi",
    account: "192.0.2.1",
    assets: [],
    posture: {},
    gaps: o.gaps ?? [],
    records: parts.flatMap((p) => p.records),
  };
}

const OBS = observation({
  devices: [GW, SW, AP, LOOSE],
  clients: [
    client("c1", "Alpha Laptop", { mac: "02:00:00:00:10:10", ip: "10.0.0.10", uplink: "s2" }),
    client("c2", "Phone", {
      kind: "wireless",
      mac: "02:00:00:00:10:11",
      ip: "10.0.0.11",
      uplink: "a3",
      guest: true,
    }),
    client("c3", "vpn", { kind: "vpn", ip: "10.0.99.2" }),
  ],
  wifi: [
    wifi({ broadcastBy: ["a3"], network: "n20" }),
    wifi({ id: "w2", name: "all-aps", network: "native" }),
  ],
  vlans: [vlan("n1", "Default", 1), vlan("n20", "IoT", 20)],
  gaps: ["uplink (AP Garage): the API gave no uplink for this device, so it has no edge"],
});

const asset = (over: Partial<NetworkAssetDef> = {}): NetworkAssetDef => ({
  name: "office-switch",
  via: "unifi",
  account: "192.0.2.1",
  deviceId: "s2",
  mac: "02:00:00:00:00:02",
  class: "switch",
  model: "USW-24",
  adopted: "2026-11-18T12:00:00Z",
  joined: "integration",
  ...over,
});

proves(
  ["110-network-assets FR-001"],
  "110: a device has a class and facets from the ontology's code lists, classified from the API's features, then the model, never guessed",
  () => {
    assertEquals(DEVICE_CLASSES.length, 8);
    assertEquals(Object.keys(CODE_LISTS.DeviceClass.list), [...DEVICE_CLASSES]);
    assertEquals(Object.keys(CODE_LISTS.DeviceFacet.list), [...DEVICE_FACETS]);
    assertEquals(
      classify({ model: "UDM-Pro", features: ["gateway", "switching"] }).class,
      "gateway",
    );
    assertEquals(classify({ model: "UDM-Pro", features: ["gateway", "switching"] }).facets, [
      "routing",
      "switching",
    ]);
    assertEquals(classify({ model: "USW", features: ["switching"] }).class, "switch");
    assertEquals(classify({ model: "U7", features: ["accessPoint"] }).facets, ["wireless"]);
    assertEquals(classify({ model: "UNVR-Pro", features: [] }), {
      class: "recorder",
      facets: ["surveillance"],
      basis: "model",
    });
    assertEquals(classify({ model: "UVC-G4", features: [] }).class, "camera");
    assertEquals(classify({ model: "UA-Hub", features: [] }).class, "door-controller");
    assertEquals(classify({ model: "UP-Phone", features: [] }).class, "phone");
    assertEquals(classify({ model: "Mystery 9", features: [] }), {
      class: "other",
      facets: [],
      basis: "unknown",
    });
    // Every class has facets and an OCSF device type; any vendor's devices are asked for by facet.
    for (const c of DEVICE_CLASSES) {
      assert(FACETS_OF_CLASS[c] !== undefined && OCSF_DEVICE_TYPE[c].id > 0, c);
    }
    assertEquals(OCSF_DEVICE_TYPE.switch.caption, "Switch");
    assertEquals(
      devicesWithFacet(observedDevices(OBS), "switching").map((d) => d.id),
      ["g1", "s2"],
    );
    assertEquals(parseClass("AccessPoint"), "access-point");
    assertEquals(parseClass("Access point"), "access-point");
    assertEquals(parseClass("toaster"), undefined);
  },
);

proves(
  ["110-network-assets FR-002"],
  "110: the way of joining has `integration`, with the badge naming the integration, and the auto variant",
  () => {
    assert(WAYS_OF_JOINING.includes("integration"));
    assertEquals(CODE_LISTS.WayOfJoining.list.integration !== undefined, true);
    assertEquals(wayOfJoining({ kind: "device", joined: "integration" }), "integration");
    assertEquals(wayOfJoining({ kind: "device" }), "integrated");
    assertEquals(JOINED_LABEL.integration, "Via integration");
    assertEquals(integrationBadge({ title: "UniFi Network" }), "Adopted via UniFi");
    assertEquals(
      integrationBadge({ title: "UniFi Network", auto: true }),
      "Auto-adopted via UniFi",
    );
  },
);

proves(
  ["110-network-assets FR-003"],
  "110: a record is a typed source, a name is the device's name as a DNS label, a taken name is refused plainly, and a device is chosen by name, MAC or id",
  () => {
    assertEquals(deviceLabel("Office Switch 1", "USW-24"), "office-switch-1");
    assertEquals(deviceLabel("3rd floor AP", "U6"), "d-3rd-floor-ap");
    assertEquals(deviceLabel("   ", "USW-24"), "usw-24");
    const devices = observedDevices(OBS);
    assertEquals(devices.length, 4);
    assertEquals(devices.find((d) => d.id === "s2")?.class, "switch");
    assertEquals(devices.find((d) => d.id === "a3")?.uplink, "s2");
    const plan = planAdoption(
      devices.filter((d) => d.id !== "a4"),
      new Set(["gateway"]),
      { now: NOW },
    );
    assertEquals(
      plan.records.map((r) => r.name),
      ["office-switch", "ap-hall"],
    );
    assertEquals(plan.refused.length, 1);
    assertStringIncludes(
      plan.refused[0]?.why ?? "",
      "gateway is already a machine, a host or an asset",
    );
    const r = plan.records[0] as NetworkAssetDef;
    assertEquals(
      [r.via, r.deviceId, r.mac, r.class, r.joined],
      ["unifi", "s2", "02:00:00:00:00:02", "switch", "integration"],
    );
    assertEquals(r.auto, undefined);
    assertEquals(r.serial, undefined);
    // Two devices that make one name: the second is refused, nothing is renamed to make room.
    const twin = planAdoption(
      [
        dev("a5", "AP Hall", { class: "access-point" }),
        dev("a6", "ap hall", { class: "access-point" }),
      ].map((d) => observedDevices(observation({ devices: [d] }))[0] as never),
      new Set(),
    );
    assertEquals(twin.records.length, 1);
    assertEquals(twin.refused.length, 1);
    // By name, by MAC, by id; a stranger is missing.
    const found = chooseDevices(devices, ["office switch", "02:00:00:00:00:03", "g1", "nope"]);
    assertEquals(
      found.chosen.map((d) => d.id),
      ["s2", "a3", "g1"],
    );
    assertEquals(found.missing, ["nope"]);
    assertEquals(
      notAdopted(devices, [asset()]).map((d) => d.id),
      ["g1", "a3", "a4"],
    );
    const src = networkAssetSource(asset({ tags: ["env:lab"] }));
    assertStringIncludes(src, "export const asset: NetworkAssetDef<TagId>");
    assertStringIncludes(src, `import type { TagId } from "../../tags.ts"`);
    assertStringIncludes(src, `joined: "integration"`);
    assert(!networkAssetSource(asset()).includes("TagId"));
  },
);

proves(
  ["110-network-assets FR-004"],
  "110: auto-adopt rules are typed, validated, choose by class (and connector and model), skip what is adopted or was released, and mark the records auto",
  () => {
    const devices = observedDevices(OBS);
    const cfg = defineNetwork({
      autoAdopt: [{ class: "switch" }, { class: "access-point", model: "U7" }],
    });
    assertEquals(
      autoAdoptChoices(cfg, devices, [], []).map((d) => d.id),
      ["s2", "a3"],
    );
    assertEquals(
      autoAdoptChoices(cfg, devices, [asset()], []).map((d) => d.id),
      ["a3"],
    );
    assertEquals(
      autoAdoptChoices(
        cfg,
        devices,
        [],
        [{ via: "unifi", deviceId: "a3", name: "ap-hall", at: "2026-11-18T00:00:00Z" }],
      ).map((d) => d.id),
      ["s2"],
    );
    assertEquals(autoAdoptChoices(undefined, devices, [], []), []);
    assertEquals(
      planAdoption(autoAdoptChoices(cfg, devices, [], []), new Set(), { auto: true }).records.every(
        (r) => r.auto === true,
      ),
      true,
    );
    assertEquals(networkProblems(cfg, ["unifi"]), []);
    // @ts-expect-error a class that is not the ontology's is a type error
    defineNetwork({ autoAdopt: [{ class: "toaster" }] });
    const bad = networkProblems(
      { autoAdopt: [{ class: "toaster" as never }, { class: "switch", via: "nowhere" }] },
      ["unifi"],
    );
    assertEquals(bad.length, 2);
    assertStringIncludes(bad[0]?.message ?? "", "not a device class");
    assertStringIncludes(bad[1]?.message ?? "", "not a connector");
  },
);

proves(
  ["110-network-assets FR-005"],
  "110: an asset the controller stops reporting is gone (a warning with its fix), never deleted; a controller that could not be read says unread",
  () => {
    const a = asset();
    const present = reconcile([a], [OBS])[0];
    assertEquals(present?.presence, "present");
    assertEquals(
      assetPolicies(present as never).map((r) => r.status),
      ["pass", "pass", "pass"],
    );
    // Re-adopted at the controller under a new id: still the same device, by MAC.
    assertEquals(reconcile([asset({ deviceId: "old" })], [OBS])[0]?.presence, "present");
    const without = observation({ devices: [GW] });
    const gone = reconcile([a], [without])[0];
    assertEquals(gone?.presence, "gone");
    const results = assetPolicies(gone as never);
    assertEquals(results[0]?.status, "warn");
    assertStringIncludes(results[0]?.detail ?? "", "gone from the integration");
    assertStringIncludes(results[0]?.fix ?? "", "stolos host release office-switch");
    assertStringIncludes(results[0]?.fix ?? "", "nothing at the controller changes");
    // A devices read that failed is not an absence; neither is a connector never observed.
    const unread = reconcile([a], [observation({ gaps: ["devices (Default): 403"] })])[0];
    assertEquals(unread?.presence, "unread");
    assertEquals(reconcile([a], [])[0]?.presence, "unread");
    assertEquals(assetPolicies(unread as never)[0]?.status, "unknown");
    // Facts follow the observation: offline, and a firmware update waiting.
    const off = observation({ devices: [{ ...SW, state: "OFFLINE", firmwareUpdatable: true }] });
    const rs = assetPolicies(reconcile([a], [off])[0] as never);
    assertEquals(
      rs.map((r) => r.status),
      ["pass", "fail", "warn"],
    );
  },
);

proves(
  ["110-network-assets FR-006"],
  "110: clients are observed and matched to machines by MAC (the address as a said fallback); the rest are unmanaged",
  () => {
    const view = buildNetworkView({
      observations: [OBS],
      assets: [],
      machines: [
        { name: "alpha", macs: ["02-00-00-00-10-10"] },
        { name: "beta", address: "10.0.0.11" },
        { name: "gamma", macs: ["02:00:00:00:99:99"] },
      ],
    });
    const alpha = view.matches.get("alpha");
    assertEquals(
      [alpha?.by, alpha?.uplinkName, alpha?.client.ip],
      ["mac", "Office Switch", "10.0.0.10"],
    );
    assertEquals(view.matches.get("beta")?.by, "address");
    assertEquals(view.matches.has("gamma"), false);
    assertEquals(
      view.unmanaged.map((c) => c.name),
      ["vpn"],
    );
    const m = matchClients([], [{ name: "x", macs: ["02:00:00:00:00:01"] }]);
    assertEquals(m.matches.size, 0);
  },
);

proves(
  ["110-network-assets FR-007", "110-network-assets FR-012"],
  "110: the graph has uplink, connected-to, advertises and member-of edges from what the API gave, and none where it gave nothing (the gap is reported)",
  () => {
    const view = buildNetworkView({ observations: [OBS], assets: [], machines: [] });
    const verbs = (v: string) => view.edges.filter((e) => e.verb === v);
    assertEquals(
      verbs("uplinked_to").map((e) => [e.from, e.to]),
      [
        ["s2", "g1"],
        ["a3", "s2"],
      ],
    );
    assertEquals(
      verbs("connected_to").map((e) => [e.from, e.to]),
      [
        ["c1", "s2"],
        ["c2", "a3"],
      ],
    );
    assertEquals(
      verbs("advertises")
        .map((e) => [e.from, e.to])
        .sort(),
      [
        ["a3", "w1"],
        ["a3", "w2"],
        ["a4", "w2"],
      ],
    );
    assertEquals(
      verbs("member_of").map((e) => [e.from, e.to]),
      [
        ["w1", "n20"],
        ["w2", "native"],
      ],
    );
    assert(
      view.edges.every((e) => e.from !== "a4" || e.verb === "advertises"),
      "no uplink edge for AP Garage",
    );
    assertStringIncludes(view.gaps.join(), "AP Garage");
    assert(view.gaps.length === 1);
    // The same edges in the estate graph.
    const e = buildGraph(
      {
        fleet: "lab",
        sources: [{ connector: "unifi", observation: OBS }],
        machines: [],
        links: {},
      },
      { now: NOW },
    );
    const rows = estateQuery(
      e,
      "select src_uid, verb, dst_uid from edge order by verb, src_uid, dst_uid",
    );
    const t = "unifi:192.0.2.1:";
    assert(
      rows.some(
        (r) =>
          r["verb"] === "uplinked_to" && r["src_uid"] === `${t}s2` && r["dst_uid"] === `${t}g1`,
      ),
    );
    assert(
      rows.some(
        (r) =>
          r["verb"] === "connected_to" && r["src_uid"] === `${t}c2` && r["dst_uid"] === `${t}a3`,
      ),
    );
    assert(
      rows.some(
        (r) => r["verb"] === "advertises" && r["src_uid"] === `${t}a4` && r["dst_uid"] === `${t}w2`,
      ),
    );
    assert(
      rows.some(
        (r) => r["verb"] === "member_of" && r["src_uid"] === `${t}w2` && r["dst_uid"] === `${t}n1`,
      ),
    );
    assertEquals(
      rows.filter((r) => r["verb"] === "uplinked_to" && r["src_uid"] === `${t}a4`).length,
      0,
    );
    assertEquals(
      rows.filter((r) => r["src_uid"] === `${t}c1` && r["verb"] !== "connected_to").length,
      0,
      "a client has no port, VLAN or Wi-Fi edge",
    );
  },
);

proves(
  ["110-network-assets FR-008"],
  "110: the topology is laid out by a typed function (the gateway on top, then below, clients under their device) and drawn as escaped SVG",
  () => {
    const view = buildNetworkView({ observations: [OBS], assets: [asset()], machines: [] });
    const t = topology(view, { maxClients: 1 });
    assertEquals(
      t.roots.map((n) => n.label),
      ["Gateway"],
    );
    assertEquals(
      t.orphans.map((n) => n.label),
      ["AP Garage"],
    );
    assertStringIncludes(t.notes.join(), "drawn apart");
    const l = layoutTopology(t);
    const at = (k: string) => l.nodes.find((n) => n.key === k);
    assert((at("g1")?.y ?? 9) < (at("s2")?.y ?? 0) && (at("s2")?.y ?? 9) < (at("a3")?.y ?? 0));
    assert(
      (at("a4")?.y ?? 0) > (at("a3")?.y ?? 99),
      "the device without an uplink is below the trees",
    );
    const sw = at("s2");
    assertEquals(sw?.label, "office-switch", "an adopted device shows the fleet's name");
    // Nothing overlaps within a row.
    const rows = new Map<number, typeof l.nodes>();
    for (const n of l.nodes) rows.set(n.y, [...(rows.get(n.y) ?? []), n]);
    for (const row of rows.values()) {
      const sorted = [...row].sort((a, b) => a.x - b.x);
      for (let i = 1; i < sorted.length; i++) {
        assert(
          (sorted[i]?.x ?? 0) - (sorted[i - 1]?.x ?? 0) >=
            ((sorted[i]?.w ?? 0) + (sorted[i - 1]?.w ?? 0)) / 2,
          "no overlap",
        );
      }
    }
    const evil = buildNetworkView({
      observations: [
        observation({ devices: [dev("g1", `<script>alert(1)</script>`, { class: "gateway" })] }),
      ],
      assets: [],
      machines: [],
    });
    const svg = topologySvg(layoutTopology(topology(evil)));
    assert(!svg.includes("<script>"), "labels are escaped");
    assertStringIncludes(svg, "&#60;script&#62;");
    assertStringIncludes(topologySvg(l), "<svg");
  },
);

proves(
  ["110-network-assets FR-010"],
  "110: tag rules have typed helpers over network facts: ofClass, withFacet, inVlan, onSsid, uplinkedTo",
  () => {
    const view = buildNetworkView({
      observations: [OBS],
      assets: [
        asset(),
        asset({ name: "ap-hall", deviceId: "a3", mac: "02:00:00:00:00:03", class: "access-point" }),
      ],
      machines: [{ name: "alpha", macs: ["02:00:00:00:10:10"] }],
    });
    const facts = networkFactsFor(view);
    const f = (name: string, kind: TagFacts["kind"] = "device"): TagFacts => ({
      name,
      kind,
      net: facts.get(name) as never,
    });
    const sw = f("office-switch");
    const ap = f("ap-hall");
    assert(ofClass("switch", "gateway")(sw) && !ofClass("switch")(ap));
    assert(withFacet("wireless")(ap) && !withFacet("wireless")(sw));
    assert(uplinkedTo("office switch")(ap) && !uplinkedTo("Gateway")(ap));
    assert(onSsid("home")(ap) && onSsid("all-aps")(ap) && !onSsid("home")(sw));
    assert(inVlan("IoT")(ap) && inVlan("n20")(ap) && inVlan("default")(ap) && !inVlan("IoT")(sw));
    // A machine the client matches has its uplink, and nothing else.
    const alpha = f("alpha", "adopted");
    assert(
      uplinkedTo("Office Switch")(alpha) && !ofClass("switch")(alpha) && !inVlan("IoT")(alpha),
    );
    assert(!ofClass("switch")({ name: "x", kind: "server" }));
  },
);

proves(
  ["110-network-assets FR-011"],
  "110: asking every machine skips a network asset with its reason, sends it nothing, and counts it in no failure",
  async () => {
    let asked = 0;
    const answers = await askAll(
      [
        { machine: "alpha", kind: "managed", ask: () => Promise.resolve([{ v: 1 }]) },
        {
          machine: "office-switch",
          kind: "network",
          skip: "no osquery on this device",
          ask: () => {
            asked++;
            return Promise.resolve([]);
          },
        },
      ],
      { timeoutMs: 2000 },
    );
    assertEquals(asked, 0);
    const s = answers.find((a) => a.machine === "office-switch");
    assertEquals([s?.state, s?.error], ["skipped", "no osquery on this device"]);
    assertEquals(answeredLine(answers), "1 of 1 answered (1 skipped: no osquery on this device)");
    assertEquals(CODE_LISTS.AnswerState.list.skipped !== undefined, true);
  },
);
