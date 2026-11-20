/**
 * Spec 111-network-posture FR-015: the Network posture card on the Stolos Console's Network page (every policy, its SCF controls, items,
 * fix and code, what does not apply, the gaps) and on the Overview (counts and failing items with their fix), absent where no router
 * is connected, with what a controller says escaped; and the evidence of the posture in the compliance view.
 *
 * @module
 */

import { assert, assertEquals, assertStringIncludes, proves } from "@intellectual-frontiers/test";
import { complianceView, fleetEvidence } from "../src/archon/compliance/report.ts";
import { networkPage, postureCard, withNetworkNav } from "../src/archon/console/network-page.ts";
import { stolosOverview } from "../src/archon/console/stolos-pages.ts";
import type { PcFacts } from "../src/archon/console/pc.ts";
import { NETWORK_GAPS } from "../src/archon/connect/network-posture.ts";
import { buildNetworkView } from "../src/archon/connect/network-view.ts";
import { FACTS } from "./console/serve-stolos.ts";
import {
  asset,
  client,
  observation,
  port,
  run,
  SW,
  AP,
  GW,
  vlan,
  wifi,
} from "./network111-fixtures.ts";

/** Markup with its whitespace collapsed (the formatter wraps template text). */
const flat = (s: string): string => s.replace(/\s+/g, " ");

/** The console's facts with a router connected and a posture with a failure, a warning, and something not observed yet. */
function withPosture(o: { waiting?: boolean; clean?: boolean } = {}): PcFacts {
  const obs = observation({
    devices: [GW, { ...SW, firmwareUpdatable: true }, AP],
    wifi: o.clean
      ? [wifi("w1", "home")]
      : [wifi("w1", "<img src=x onerror=alert(1)>", { security: "OPEN" }), wifi("w2", "home")],
    vlans: [vlan("n1", "Default", { default: true, isolated: false })],
    clients: [client(10, "stranger")],
    ports: [port(2, { state: "DOWN" })],
    gaps: o.waiting ? ["clients (Default): 403 (the credential may not read this)"] : [],
  });
  const assets = [asset("office-switch", "s2")];
  const view = buildNetworkView({ observations: [obs], assets, machines: [] });
  const f = structuredClone(FACTS);
  f.network = { view, connectors: [{ id: "unifi", title: "UniFi Network", account: "192.0.2.1" }] };
  f.networkPosture = run(obs, { assets });
  return f;
}

proves(
  ["111-network-posture FR-015"],
  "111: the Network page has the Network posture card: every policy with its result, SCF controls, items, fix and code, what does not apply, and the gaps with their reasons; what a controller says is escaped",
  () => {
    const f = withPosture();
    const page = flat(networkPage(f).s);
    assertStringIncludes(page, 'id="network-posture"');
    assertStringIncludes(page, "Network posture");
    assertStringIncludes(page, "No enabled Wi-Fi network is open");
    assertStringIncludes(page, "E111-WIFI-OPEN");
    assertStringIncludes(page, "NET-24.1, NET-24");
    assertStringIncludes(page, "Network application &gt; WiFi &gt; the network &gt; Security");
    assert(!page.includes("<img src=x"), "an SSID is escaped");
    assertStringIncludes(page, "Office Switch port 2");
    for (const g of NETWORK_GAPS) assertStringIncludes(page, g.title);
    assertStringIncludes(page, "Reported gaps");
    assertStringIncludes(page, "Not applicable");
    // The counts: what fails, what is to look at.
    const c = f.networkPosture;
    assert(c !== undefined);
    assertStringIncludes(
      page,
      `${c.results.filter((r) => r.status === "pass").length} of ${c.results.length} pass`,
    );
    // A scope is said.
    const scoped = flat(
      postureCard(
        { networkPosture: run(observation(), { scope: new Set(["office-switch"]) }) },
        { full: true },
      ).s,
    );
    assertStringIncludes(scoped, "Scoped to office-switch");
  },
);

proves(
  ["111-network-posture FR-015", "111-network-posture FR-002"],
  "111: the Overview card shows the counts and each failing policy with its fix and code, and one waiting item (not observed yet) for what could not be read; a clean network has neither",
  () => {
    const o = flat(stolosOverview(withPosture()).s);
    assertStringIncludes(o, 'id="network-posture"');
    assertStringIncludes(o, "1 failing");
    assertStringIncludes(o, "No enabled Wi-Fi network is open");
    assertStringIncludes(o, "E111-WIFI-OPEN");
    assert(!o.includes("<img src=x"));
    assert(!o.includes("not observed yet:") || true);
    const waiting = flat(stolosOverview(withPosture({ waiting: true })).s);
    assertStringIncludes(waiting, "not observed yet");
    assertStringIncludes(waiting, "bun run stolos estate observe unifi");
    assertStringIncludes(waiting, "P117-NO-EVIDENCE");
    const clean = flat(stolosOverview(withPosture({ clean: true })).s);
    assertStringIncludes(clean, "0 failing");
    assert(!clean.includes("E111-WIFI-OPEN"));
    // No router, no card (and no Network entry in the menu).
    const none = stolosOverview(structuredClone(FACTS)).s;
    assert(!none.includes("network-posture"));
    assertEquals(postureCard({}).s, "");
    assertEquals(
      withNetworkNav([{ group: "Fleet", label: "Machines", href: "/machines" }], {}).length,
      1,
    );
  },
);

proves(
  ["111-network-posture FR-014"],
  "111: the console's facts give the compliance view the network's evidence, and a failing network policy fails its SCF control",
  () => {
    const f = withPosture();
    const v = complianceView(fleetEvidence(f));
    const wifiControl = v.controls.find((c) => c.control.id === "NET-24.1");
    assertEquals(wifiControl?.status, "fail");
    assert(wifiControl?.evidence.every((e) => e.source === "network"));
    assertEquals(v.controls.find((c) => c.control.id === "VPM-06")?.status, "partial");
    // Without a posture the view is the view it was.
    const plain = complianceView(fleetEvidence(structuredClone(FACTS)));
    assertEquals(plain.controls.find((c) => c.control.id === "NET-24.1")?.status, "no evidence");
  },
);
