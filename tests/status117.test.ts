/**
 * Spec 117-adopted-in-status: `stolos fleet status` lists every machine the fleet knows (a paired machine, an SNMP device, a network
 * asset), and a control with no evidence is shown as not observed yet, never as a failure. The parts that touch the world run for real:
 * the `stolos` command in a sandbox fleet (a copy of the example lab with a paired Windows machine, one never observed, an SNMP device
 * and a network asset with the router's observation), and the real `Ui` for the verdict and the exit code. The servers are stand-ins
 * only where the transport is: an `ssh` on the PATH that does not answer, as spec 107's test has it.
 *
 * @module
 */

import { fs, path, proc } from "@intellectual-frontiers/system";
import {
  assert,
  assertEquals,
  assertStringIncludes,
  proves,
} from "@intellectual-frontiers/commons/ts/runtime/test";
import { setLogProgram, Ui } from "../src/archon/core/ui.ts";
import { EXPLAIN, explainText } from "../src/archon/core/explain.ts";
import {
  isNotObserved,
  NO_EVIDENCE_CODE,
  notObservedWords,
} from "../src/archon/compliance/not-observed.ts";
import {
  affectedControls,
  impactMarkdown,
  judge,
  printImpact,
} from "../src/archon/compliance/impact.ts";
import type { Impact } from "../src/archon/compliance/impact.ts";
import { compareViews, driftEvent, type ControlChange } from "../src/archon/compliance/drift.ts";
import { combine, type ComplianceView } from "../src/archon/compliance/report.ts";
import {
  type AdoptedDef,
  machineSource,
  type Observed,
  observedSource,
} from "../src/archon/adopt/adopt.ts";
import { controllerDef } from "../src/archon/adopt/controller.ts";
import { notObservedItem, policies, readResult } from "../src/archon/adopt/policy.ts";
import { adoptedKind, lineText, resultText } from "../src/archon/observe/fleet-machines.ts";
import { deviceObservedSource, deviceSource, type DeviceDef } from "../src/archon/device/device.ts";
import { type NetworkAssetDef, networkAssetSource } from "../src/archon/connect/network-asset.ts";
import { observationSource, type Observation } from "../src/archon/connect/connector.ts";
import { entityParts } from "../src/archon/connect/integration-entities.ts";
import type { NetworkDevice } from "../src/archon/connect/integration-entities.ts";
import { ENGINE_ROOT, linkEngine, sandbox } from "./sandbox.ts";

setLogProgram("stolos");

const LIMIT = { timeout: 180_000 };

/** A control that went from no evidence to failing, with the evidence that changed under it. */
const change = (id: string, name: string, evidence: ControlChange["evidence"]): ControlChange => ({
  id,
  name,
  from: "no evidence",
  to: "fail",
  worse: true,
  evidence,
});

const STALE = (check: string, source: "adopted" | "cloud" = "adopted") => ({
  source,
  subject: "berlin",
  check,
  to: "fail" as const,
  stale: true,
});
const FRESH_FAIL = {
  source: "adopted" as const,
  subject: "berlin",
  check: "The firewall is on",
  to: "fail" as const,
};

function impactOf(evidence: ControlChange[]): Impact {
  return {
    fleet: "lab",
    base: "1234567890abcdef1234567890abcdef12345678",
    head: "working tree",
    changes: [],
    hosts: { added: [], removed: [] },
    evidence,
    controls: affectedControls([], evidence),
    catalog: { version: "2026.3" },
    gate: judge({ changes: [], evidence }),
    problems: [],
  };
}

/** The real Ui, writing to a list, with emoji marks. */
function ui() {
  const out: string[] = [];
  const u = new Ui({
    tty: false,
    color: false,
    emoji: true,
    write: (s) => out.push(s),
    logPath: null,
  });
  return { u, text: () => out.join("") };
}

proves(
  [
    "117-adopted-in-status FR-006",
    "117-adopted-in-status FR-007",
    "117-adopted-in-status FR-008",
    "117-adopted-in-status FR-010",
  ],
  "117: a control with no evidence is a waiting item with one fix and a code, counted as not set up yet, exit 0; a control with evidence that fails stays a warning",
  () => {
    const noEvidence = [
      change("BCD-24", "Data Backups", []),
      change("CRY-07", "Encrypting Data At Rest", [STALE("The disk is encrypted")]),
    ];
    const { u, text } = ui();
    printImpact(impactOf(noEvidence), u.phase("Compliance impact"));
    assertEquals(u.finish(), 0, text());
    const t = text();
    assertStringIncludes(t, "⏳");
    assertStringIncludes(t, "BCD-24 Data Backups: not observed yet");
    assertStringIncludes(t, "CRY-07 Encrypting Data At Rest: not observed recently");
    assertStringIncludes(t, `[${NO_EVIDENCE_CODE}]`);
    // The one fix line: what to run, and for the disk the probe's fact.
    assertStringIncludes(t, "bun run stolos host observe berlin");
    assertStringIncludes(t, "needs the probe's disk_encryption fact (BitLocker on Windows");
    assertStringIncludes(t, "2 waiting");
    assert(!t.includes("no evidence -> fail"), t);
    assert(!t.includes("(observed)"), t);
    assert(!t.includes("⚠️") && !t.includes("E105-WARNING"), "no warning");
    assert(!/[1-9]\d* warning/.test(t), "not counted as a warning");

    // Evidence that failed within its service level is a failure as before (a warning here, the gate being off).
    const real = change("END-07", "Software Firewall", [FRESH_FAIL]);
    assertEquals(isNotObserved(real), false);
    const b = ui();
    printImpact(impactOf([real]), b.u.phase("Compliance impact"));
    assertEquals(b.u.finish(), 0);
    assertStringIncludes(b.text(), "END-07 Software Firewall (observed): no evidence -> fail");
    assertStringIncludes(b.text(), "E105-WARNING");
    // A mixed run: the real one is still warned about, the other waits.
    const c = ui();
    printImpact(impactOf([real, noEvidence[0] as ControlChange]), c.u.phase("Compliance impact"));
    c.u.finish();
    assertStringIncludes(c.text(), "1 warning");
    assertStringIncludes(c.text(), "1 waiting");

    // What to run, by source.
    assertEquals(
      notObservedWords(change("CFG-04", "x", [{ ...STALE("c"), source: "managed" }])).fix,
      "bun run stolos fleet status",
    );
    // The explanation exists and says it in plain words.
    const e = EXPLAIN[NO_EVIDENCE_CODE];
    assert(e !== undefined && e.what.includes("Nothing failed"));
    assertStringIncludes(explainText(NO_EVIDENCE_CODE), "Not observed yet");
  },
);

proves(
  ["117-adopted-in-status FR-006", "117-adopted-in-status FR-009"],
  "117: the pull request comment and the mailed drift say it too, and nothing of the evidence, the statuses or the score changes",
  () => {
    const c = change("BCD-24", "Data Backups", []);
    const before = structuredClone(c);
    const md = impactMarkdown(impactOf([c]));
    assertStringIncludes(md, "observed: not observed yet");
    assert(!md.includes("no evidence -> fail"), md);
    const ev = driftEvent({
      fleet: "lab",
      since: { rev: "abcdef1234567890", at: "2026-11-17T10:00:00Z" },
      now: { at: "2026-11-18T10:00:00Z" },
      changes: [c],
    });
    assertStringIncludes(ev.what, "BCD-24 Data Backups: not observed yet");
    assert(!ev.what.includes("(worse)"), ev.what);
    assertEquals(ev.level, "info");
    // The data is what it was: the change still reads no evidence -> fail, worse, and the score semantics of spec 068 FR-002 stand.
    assertEquals(c, before);
    assertEquals(combine([]), "no evidence");
    assertEquals(combine(["no evidence"]), "no evidence");
    assertEquals(combine(["fail", "no evidence"]), "fail");
    const view = (status: "no evidence" | "fail"): ComplianceView =>
      ({
        controls: [{ control: { id: "BCD-24", name: "Data Backups" }, status, evidence: [] }],
      }) as unknown as ComplianceView;
    const [w] = compareViews(view("no evidence"), view("fail"));
    assertEquals([w?.from, w?.to, w?.worse], ["no evidence", "fail", true]);
  },
);

/** An observation a Windows machine's probe could have made: BitLocker unknown, the firewall off. */
const observed = (over: Partial<Observed["security"]> = {}, flavor?: string): Observed => ({
  at: new Date(Date.now() - 3_600_000).toISOString(),
  probe: "3",
  os: {
    family: flavor ? "arch" : "windows",
    name: flavor ? "Omarchy" : "Windows 11 Pro",
    version: flavor ? "rolling" : "26100",
    kernel: "",
    arch: "x86_64",
    hostname: "x",
    ...(flavor ? { flavor } : {}),
  },
  hardware: {},
  security: {
    diskEncryption: "unknown",
    firewall: "off",
    autoUpdates: "on",
    admins: ["alice"],
    ...over,
  },
  software: {},
  listening: [],
});

const machine = (name: string, over: Partial<AdoptedDef> = {}): AdoptedDef => ({
  name,
  ssh: { user: "alice", address: "192.0.2.50" },
  hostKeys: [],
  adopted: "2026-11-18T09:00:00.000Z",
  joined: "paired",
  ...over,
});

proves(
  ["117-adopted-in-status FR-002", "117-adopted-in-status FR-004"],
  "117: a machine's line says its kind, how it joined, operating system, last observation, policy result and tags; what was not observed is one waiting item, a failure a warning",
  () => {
    const berlin = machine("berlin");
    const o = observed();
    const rs = policies(berlin, o);
    assertEquals(adoptedKind(o), "workstation");
    assertEquals(adoptedKind(observed({}, "omarchy")), "workstation");
    assertEquals(
      adoptedKind({ ...o, os: { ...o.os, family: "ubuntu", name: "Ubuntu" } }),
      "server",
    );
    assertEquals(adoptedKind(undefined), "machine");
    // disk encryption unknown, firewall off: one failing, one not observed, the rest pass.
    assertEquals(
      rs.filter((r) => readResult(r) === "fail").map((r) => r.id),
      ["firewall"],
    );
    const w = notObservedItem(rs, "bun run stolos host observe berlin");
    assertEquals(w?.code, NO_EVIDENCE_CODE);
    assertStringIncludes(w?.message ?? "", "The disk is encrypted");
    assertStringIncludes(w?.message ?? "", ": not observed yet");
    assertStringIncludes(w?.fix ?? "", "BitLocker on Windows");
    assertStringIncludes(w?.fix ?? "", "bun run stolos host observe berlin");
    const passing = rs.filter((r) => r.status === "pass").length;
    const waiting = rs.filter((r) => readResult(r) === "not-observed").length;
    assertEquals(
      resultText(rs),
      `${passing} passing, 1 failing, ${rs.filter((r) => r.status === "warn").length} warning, ${waiting} not observed yet`.replace(
        ", 0 warning",
        "",
      ),
    );
    // A machine never observed: one result, which is waiting, not failing.
    const never = policies(berlin, undefined);
    assertEquals(readResult(never[0] as (typeof never)[number]), "not-observed");
    assertEquals(notObservedItem(never, "x")?.message, "not observed yet");
    assertEquals(resultText(never), "0 passing, 1 not observed yet");
    // Nothing waiting: no item.
    assertEquals(
      notObservedItem(policies(berlin, observed({ diskEncryption: "on", firewall: "on" })), "x"),
      undefined,
    );
    const line = lineText(
      {
        name: "berlin",
        kind: "workstation",
        joined: "paired",
        os: "Windows 11 Pro 26100",
        observedAt: "2026-11-18T09:12:00.000Z",
        results: rs,
        observe: "x",
      },
      "tags env:lab · custom: pilot",
    );
    assertStringIncludes(
      line,
      "workstation · paired · Windows 11 Pro 26100 · observed 2026-11-18 09:12 · ",
    );
    assertStringIncludes(line, "1 failing, ");
    assertStringIncludes(line, "not observed yet · tags env:lab · custom: pilot");
    const asset = lineText(
      {
        name: "office-switch",
        kind: "network asset (switch)",
        joined: "integration",
        os: "USW-24",
        results: [],
        observe: "x",
        via: { connector: "unifi", account: "192.0.2.1", state: "ONLINE" },
      },
      "",
    );
    assertStringIncludes(
      asset,
      "network asset (switch) · adopted via an integration (read, never probed) · via unifi, account 192.0.2.1, ONLINE · USW-24 · not observed yet · no policies",
    );
  },
);

// ------------------------------------------------------------------------------ the real command

const DEV = (id: string, name: string, over: Partial<NetworkDevice> = {}): NetworkDevice => ({
  source: "unifi",
  site: "Default",
  id,
  name,
  kind: "other",
  model: "USW-24",
  mac: "02:00:00:00:00:02",
  ip: "192.0.2.12",
  state: "ONLINE",
  firmware: "7.0.1",
  class: "switch",
  facets: ["switching"],
  ...over,
});

const ROUTER: Observation = {
  at: "2026-11-18T12:00:00Z",
  provider: "unifi",
  account: "192.0.2.1",
  assets: [],
  posture: {},
  gaps: [],
  records: entityParts({
    kind: "router",
    capability: "devices",
    items: [DEV("s2", "Office Switch")],
  }).records,
};

/** The example lab in a sandbox, with this PC as controller, a paired machine, one never observed, an SNMP device and a network asset. */
async function lab() {
  const sb = await sandbox("stolos-status117-");
  const repo = path.join(sb.home, "fleet");
  await fs.mkdir(path.join(repo, "fleets"), { recursive: true });
  await proc.output([
    "cp",
    "-r",
    path.join(ENGINE_ROOT, "examples/fleets/lab"),
    `${repo}/fleets/lab`,
  ]);
  await linkEngine(repo);
  const bin = path.join(sb.home, "bin");
  await fs.mkdir(bin, { recursive: true });
  await fs.writeTextFile(
    path.join(bin, "ssh"),
    `#!/bin/sh\necho "ssh: connect to host: No route to host" >&2; exit 255\n`,
    { mode: 0o755 },
  );
  const fleetDir = path.join(repo, "fleets", "lab");
  const put = async (rel: string, text: string) => {
    await fs.mkdir(path.dirname(path.join(fleetDir, rel)), { recursive: true });
    await fs.writeTextFile(path.join(fleetDir, rel), text);
  };
  const me = await controllerDef();
  await put(`adopted/${me.name}/machine.ts`, machineSource(me));
  // berlin: paired, Windows, observed an hour ago (firewall off, BitLocker unknown), a custom tag.
  await put(
    "adopted/berlin/machine.ts",
    machineSource(machine("berlin", { customTags: ["pilot"] })),
  );
  await put("adopted/berlin/observed.ts", observedSource(observed()));
  // intrepid: paired, never observed.
  await put(
    "adopted/intrepid/machine.ts",
    machineSource(machine("intrepid", { ssh: { user: "alice", address: "192.0.2.51" } })),
  );
  // An SNMP device, observed.
  const dev: DeviceDef = {
    name: "printer-1",
    kind: "printer",
    address: "192.0.2.60",
    snmp: { user: "stolos", auth: "sha256" },
    added: "2026-11-18T09:00:00.000Z",
  };
  await put("devices/printer-1/device.ts", deviceSource(dev));
  await put(
    "devices/printer-1/observed.ts",
    deviceObservedSource({
      at: new Date(Date.now() - 3_600_000).toISOString(),
      description: "A printer",
      sysName: "printer-1",
      objectId: "1.3.6.1.4.1.0",
      contact: "",
      location: "",
      uptimeDays: 3,
      model: "LJ-100",
    }),
  );
  // A network asset adopted through the integration, and the router's observation.
  const asset: NetworkAssetDef = {
    name: "office-switch",
    via: "unifi",
    account: "192.0.2.1",
    deviceId: "s2",
    mac: "02:00:00:00:00:02",
    class: "switch",
    model: "USW-24",
    adopted: "2026-11-18T12:00:00Z",
    joined: "integration",
  };
  await put("adopted/office-switch/network.ts", networkAssetSource(asset));
  await put("estate/unifi.ts", observationSource(ROUTER));
  const env = { ARCHON_REPO: repo, ARCHON_FLEET: "lab", PATH: `${bin}:${proc.env.get("PATH")}` };
  return {
    sb,
    me: me.name,
    env,
    stolos: (...args: string[]) => sb.run("src/stolos/main.ts", args, "", env),
  };
}

proves(
  [
    "117-adopted-in-status FR-001",
    "117-adopted-in-status FR-002",
    "117-adopted-in-status FR-003",
    "117-adopted-in-status FR-004",
    "117-adopted-in-status FR-005",
    "117-adopted-in-status FR-006",
    "117-adopted-in-status FR-007",
  ],
  "117: fleet status in a sandbox fleet lists the controller, the servers, then the paired machines, the SNMP device and the network asset, one line each, waiting items not warnings; host check agrees",
  async () => {
    const l = await lab();
    try {
      const st = await l.stolos("fleet", "status");
      const t = st.out;
      // The order: the controller, the servers, then the others.
      const at = (s: string) => t.indexOf(s);
      assert(at(l.me) >= 0 && at("alpha") > at(l.me), t);
      for (const [a, b] of [
        ["beta", "berlin"],
        ["berlin", "intrepid"],
        ["intrepid", "printer-1"],
        ["printer-1", "office-switch"],
      ] as const) {
        assert(at(a) >= 0 && at(b) > at(a), `${a} before ${b}: ${t}`);
      }
      assertStringIncludes(t, "workstation · paired");
      assertStringIncludes(t, "Windows 11 Pro 26100");
      assertStringIncludes(t, "custom: pilot");
      assertStringIncludes(t, "1 failing, 1 warning, 1 not observed yet");
      assertStringIncludes(t, "device (printer) · integrated");
      assertStringIncludes(t, "LJ-100");
      assertStringIncludes(t, "network asset (switch) · adopted via an integration");
      assertStringIncludes(t, "via unifi, account 192.0.2.1, ONLINE");
      // Never observed: a waiting item with its command and code, not a failure.
      assertStringIncludes(t, "not observed yet");
      assertStringIncludes(t, "bun run stolos host observe intrepid");
      assertStringIncludes(t, "[P117-NO-EVIDENCE]");
      // The disk's reason, and the firewall failing as a warning.
      assertStringIncludes(t, "needs the probe's disk_encryption fact");
      assertStringIncludes(t, "The firewall is on: firewall: off");
      assert(!t.includes("Observed by Stolos: never observed"), t);
      // host check agrees, and exits 0 for a machine that only waits (berlin's firewall does fail: 1).
      const hc = await l.stolos("host", "check", "intrepid");
      assertEquals(hc.code, 0, hc.out);
      assertStringIncludes(hc.out, "not observed yet");
      assert(!hc.out.includes("never observed"), hc.out);
      const hb = await l.stolos("host", "check", "berlin");
      assertEquals(hb.code, 1, hb.out);
      assertStringIncludes(hb.out, "The disk is encrypted");
      assertStringIncludes(hb.out, ": not observed yet");
      // The Stolos Console lists what a machine fails: a machine never observed fails nothing, a failing firewall is listed.
      const facts = await l.sb.run("tests/status117-facts.ts", [], "", l.env);
      assertEquals(facts.code, 0, facts.out);
      const machines = JSON.parse(facts.out.slice(facts.out.indexOf("["))) as Array<{
        name: string;
        failing: string[];
      }>;
      assertEquals(machines.find((m) => m.name === "intrepid")?.failing, []);
      assertEquals(machines.find((m) => m.name === "berlin")?.failing, ["The firewall is on"]);
      // --json keeps printing nothing on the screen.
      const j = await l.stolos("--json", "fleet", "status");
      assert(!j.out.includes("berlin"), j.out);
      // discover keeps working.
      const d = await l.stolos("discover");
      assertStringIncludes(d.out, "this PC is in the fleet already");
    } finally {
      await fs.remove(l.sb.home, { recursive: true });
    }
  },
  { ...LIMIT, skip: proc.build.os === "windows" && "the stand-in ssh is a shell script" },
);
