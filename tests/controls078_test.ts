// Spec 078: the custom-control SDK. Controls are TypeScript (a query plus an assertion, tagged with
// SCF controls), packs live in the fleet repository and are tested like code, the built-in
// policies run on the same SDK with identical results, and a pack's results reach Compliance.
import { assert, assertEquals, assertStringIncludes, assertThrows } from "./assert.ts";
import { join } from "../src/archon/core/path.ts";
import {
  defineControl,
  defineControlPack,
  fixtureEstate,
  runPack,
  testControl,
} from "../src/archon/controls/mod.ts";
import { loadControlPacks, runFleetPacks } from "../src/archon/controls/run.ts";
import { type AdoptedDef, toObserved } from "../src/archon/adopt/adopt.ts";
import type { ProbeOutput } from "../src/archon/adopt/probe.ts";
import { policies } from "../src/archon/adopt/policy.ts";
import {
  type DeviceDef,
  type DeviceObserved,
  devicePolicies,
} from "../src/archon/device/device.ts";
import { buildGraph, estatePolicies, estateQuery } from "../src/archon/estate/graph.ts";
import type { Snapshot } from "../src/archon/estate/snapshot.ts";
import type { Observation } from "../src/archon/connect/connector.ts";
import { complianceView, fleetEvidence } from "../src/archon/compliance/report.ts";
import {
  legacyDevicePolicies,
  legacyEstatePolicies,
  legacyPolicies,
} from "./controls078_legacy.ts";
import { FACTS } from "./console/serve-stolos.ts";
import { sandbox } from "./sandbox.ts";
// The example pack's own tests run here too, so the engine's suite proves they pass.
import "../examples/fleets/lab/controls/baseline/baseline_test.ts";

const AT = "2026-11-01T00:00:00Z";
const NOW = new Date("2026-11-03T00:00:00Z");
const EXAMPLE = "examples/fleets/lab/controls";

const obs = (provider: string, entities: Observation["entities"]): Observation => ({
  at: AT,
  provider,
  account: `${provider}.example`,
  assets: [],
  posture: {},
  gaps: [],
  ...(entities ? { entities } : {}),
});
const admin = (id: string, mfa = true) => ({
  system: "okta",
  id,
  name: `admin${id}`,
  email: `admin${id}@lab.example.net`,
  active: true,
  admin: true,
  mfa,
});
const oktaWith = (n: number) =>
  fixtureEstate({
    sources: [{
      connector: "okta",
      observation: obs("okta", {
        accounts: Array.from({ length: n }, (_, i) => admin(String(i + 1))),
      }),
    }],
  });

Deno.test("078: a wrong SCF id fails type checking, and at definition", () => {
  assertThrows(
    () =>
      defineControl({
        id: "x",
        title: "X",
        // @ts-expect-error: not an SCF control Stolos knows
        scf: ["XYZ-99"],
        subject: "estate",
        query: "SELECT 1 AS n",
        assert: () => ({ status: "pass", detail: "" }),
      }),
    Error,
    "XYZ-99 is not an SCF control",
  );
  assertThrows(
    () =>
      defineControlPack({
        id: "p",
        title: "P",
        version: "1.0.0",
        controls: [
          defineControl({
            id: "a",
            title: "A",
            scf: ["CFG-04"],
            subject: "osquery",
            query: "SELECT 1",
            assert: () => undefined,
          }),
          defineControl({
            id: "a",
            title: "A again",
            scf: ["CFG-04"],
            subject: "osquery",
            query: "SELECT 1",
            assert: () => undefined,
          }),
        ],
      }),
    Error,
    "two controls are named a",
  );
});

Deno.test("078: a pack loads from the fleet's controls folder; a broken one is a problem", async () => {
  const { packs, problems } = await loadControlPacks(EXAMPLE);
  assertEquals(problems, []);
  assertEquals(packs.map((p) => p.pack.id), ["baseline"]);
  assertEquals(packs[0].pack.controls.map((c) => c.id), ["few-admins", "no-telnet"]);
  const dir = await Deno.makeTempDir({ prefix: "stolos-controls-" });
  try {
    await Deno.mkdir(join(dir, "broken"));
    await Deno.writeTextFile(join(dir, "broken", "pack.ts"), "export const nothing = 1;\n");
    const r = await loadControlPacks(dir);
    assertEquals(r.packs, []);
    assertStringIncludes(r.problems[0], "exports no pack");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("078: a pack runs over a fixture estate and osquery answers: fails and passes as asserted", async () => {
  const { packs } = await loadControlPacks(EXAMPLE);
  const pack = packs[0].pack;
  const answers = [
    { machine: "alpha", rows: [{ port: 23, address: "0.0.0.0" }] },
    { machine: "beta", rows: [] },
    { machine: "gamma", error: "osquery is not installed" },
  ];
  const run = await runPack(pack, { estate: oktaWith(5), osquery: () => answers, now: NOW });
  assertEquals(run.pack, { id: "baseline", title: "Lab baseline", version: "1.0.0" });
  assertEquals(
    run.results.map((r) => [r.id, r.subject, r.status]),
    [
      ["baseline/few-admins", "across systems", "warn"],
      ["baseline/no-telnet", "alpha", "fail"],
      ["baseline/no-telnet", "beta", "pass"],
      ["baseline/no-telnet", "gamma", "unknown"],
    ],
  );
  assertEquals(run.results[0].detail, "5 administrators in okta");
  assertEquals(run.results[1].fix, "turn the telnet service off, and use SSH");
  const fine = await runPack(pack, { estate: oktaWith(2), osquery: () => [], now: NOW });
  assertEquals(fine.results[0].status, "pass");
  // No machine has answered: unknown, saying how to ask them.
  assertEquals(fine.results[1].status, "unknown");
  assertStringIncludes(fine.results[1].detail, "controls run");
  // Without an estate graph, an estate control cannot tell.
  assertEquals((await runPack(pack, { osquery: () => [], now: NOW })).results[0].status, "unknown");
});

Deno.test("078: accepted risks apply to a pack's results, until their date", async () => {
  const { packs } = await loadControlPacks(EXAMPLE);
  const answers = [{ machine: "alpha", rows: [{ port: 23, address: "0.0.0.0" }] }];
  const accepted = [{
    policy: "baseline/no-telnet",
    reason: "the lab's terminal server",
    by: "alice",
    until: "2026-12-31",
  }];
  const r = await runPack(packs[0].pack, { osquery: () => answers, accepted, now: NOW });
  const telnet = r.results.find((x) => x.id === "baseline/no-telnet")!;
  assertEquals(telnet.status, "accepted");
  assertStringIncludes(telnet.detail, "accepted by alice until 2026-12-31");
  const later = await runPack(packs[0].pack, {
    osquery: () => answers,
    accepted,
    now: new Date("2027-01-02T00:00:00Z"),
  });
  const after = later.results.find((x) => x.id === "baseline/no-telnet")!;
  assertEquals(after.status, "fail");
  assertStringIncludes(after.detail, "the accepted risk ended 2026-12-31");
  // An adopted machine's own accepted list (machine.ts) applies to its results too.
  const machine: AdoptedDef = {
    name: "alpha",
    ssh: { user: "alice", address: "alpha.lab.example.net" },
    hostKeys: [],
    adopted: "2026-11-01",
    accepted: [{ ...accepted[0], until: "2027-06-30" }],
  };
  const own = await runPack(packs[0].pack, {
    osquery: () => answers,
    adopted: [{ machine }],
    now: NOW,
  });
  assertEquals(own.results.find((x) => x.subject === "alpha")!.status, "accepted");
});

Deno.test("078: observation controls run per device and per account; testControl matches", async () => {
  const device: DeviceDef = {
    name: "front-printer",
    kind: "printer",
    address: "10.0.30.40",
    snmp: { user: "stolos", auth: "sha256" },
    added: AT,
  };
  const observed: DeviceObserved = {
    at: AT,
    description: "Printer",
    sysName: "front-printer",
    objectId: "1.3.6.1",
    contact: "",
    location: "",
    uptimeDays: 3,
  };
  const located = defineControl({
    id: "located",
    title: "Every printer has a location",
    scf: ["AST-07.1"],
    subject: "observation",
    of: "device",
    assert: ({ device: d, observed: o }) =>
      d.kind !== "printer" ? undefined : {
        status: d.location || o.location ? "pass" : "fail",
        detail: d.location || o.location || "no location",
      },
    fix: ({ device: d }) => `set location in devices/${d.name}/device.ts`,
  });
  const mfa = defineControl({
    id: "mfa-known",
    title: "The identity provider says who has MFA",
    scf: ["IAC-37"],
    subject: "observation",
    of: "connector",
    assert: ({ observed: o }) => ({
      status: (o.entities?.accounts ?? []).every((a) => a.mfa !== undefined) ? "pass" : "warn",
      detail: `${o.entities?.accounts?.length ?? 0} account(s)`,
    }),
  });
  const pack = defineControlPack({
    id: "obs",
    title: "Obs",
    version: "0.1.0",
    controls: [located, mfa],
  });
  const r = await runPack(pack, {
    devices: [{ device, observed }],
    connectors: [{ connector: "okta", observed: obs("okta", { accounts: [admin("1")] }) }],
    now: NOW,
  });
  assertEquals(r.results.map((x) => [x.id, x.subject, x.status]), [
    ["obs/located", "front-printer", "fail"],
    ["obs/mfa-known", "okta (okta.example)", "pass"],
  ]);
  assertEquals(r.results[0].fix, "set location in devices/front-printer/device.ts");
  const [t] = testControl(located, { input: { device, observed, now: NOW.getTime() } });
  const { subject: _s, control: _c, ...shown } = r.results[0];
  assertEquals(t, { ...shown, id: "located" });
});

// --- The built-ins on the SDK give the results they gave before (tests/controls078_legacy.ts). ---

/** A small deterministic generator, so the cases are many and the same on every run. */
function* lcg(seed: number) {
  let s = seed;
  while (true) {
    s = (s * 1103515245 + 12345) % 2147483648;
    yield s;
  }
}

Deno.test("078: the adopted-machine pack on the SDK gives identical results (400 machines)", () => {
  const rnd = lcg(78);
  const pick = <T>(xs: readonly T[]): T => xs[rnd.next().value! % xs.length];
  const now = Date.parse("2026-11-15T00:00:00Z");
  for (let i = 0; i < 400; i++) {
    const family = pick([
      "macos",
      "windows",
      "ubuntu",
      "arch linux",
      "debian",
      "fedora",
      "freebsd",
    ]);
    const p: ProbeOutput = {
      probe: { at: pick(["2026-11-14T00:00:00Z", "2026-10-01T00:00:00Z"]), version: "1" },
      os: {
        family,
        name: pick(["", "Some OS"]),
        version: pick(["15", "13", "26100", "19045", "24.04", "20.04", "12", "40", "rolling", ""]),
      },
      security: {
        disk_encryption: pick(["on", "off", "unknown", ""]),
        firewall: pick(["on", "off", ""]),
        auto_updates: pick(["on", "manual", "off", ""]),
        ...(pick([true, false]) ? { ssh_password_auth: pick(["yes", "no"]) } : {}),
        ...(pick([true, false]) ? { antivirus: pick(["on", "off", "?"]) } : {}),
        admins: pick(["", "alice", "a b c", "a b c d e"]),
      },
      software: {
        ...(pick([true, false]) ? { pending_updates: pick(["0", "20", "21", "300"]) } : {}),
        ...(pick([true, false]) ? { osquery: "5.12.1" } : {}),
      },
    };
    const m: AdoptedDef = {
      name: `m${i}`,
      ssh: { user: "alice", address: "a" },
      hostKeys: [],
      adopted: "2026-01-01",
      ...(pick([true, false]) ? { until: pick(["2026-01-31", "2027-12-31"]) } : {}),
      ...(pick([true, false])
        ? {
          accepted: [{
            policy: pick(["disk-encryption", "firewall", "supported-os", "observed"]),
            reason: "r",
            by: "alice",
            until: pick(["2026-01-01", "2027-01-01"]),
          }],
        }
        : {}),
    };
    const o = pick([true, true, true, false]) ? toObserved(p) : undefined;
    const want = legacyPolicies(m, o, now);
    const got = policies(m, o, now);
    assertEquals(JSON.stringify(got), JSON.stringify(want), `machine ${i}`);
  }
});

Deno.test("078: the device policies on the SDK give identical results", () => {
  const rnd = lcg(69);
  const pick = <T>(xs: readonly T[]): T => xs[rnd.next().value! % xs.length];
  const now = Date.parse("2026-11-15T00:00:00Z");
  for (let i = 0; i < 200; i++) {
    const d: DeviceDef = {
      name: `d${i}`,
      kind: pick(["printer", "router", "ups"]),
      address: "10.0.30.40",
      snmp: { user: "stolos", auth: pick(["sha", "sha256"]) },
      added: AT,
      ...(pick([true, false]) ? { owner: "alice" } : {}),
      ...(pick([true, false]) ? { location: "Room 1" } : {}),
    };
    const o: DeviceObserved | undefined = pick([true, true, false])
      ? {
        at: pick(["2026-11-14T00:00:00Z", "2026-09-01T00:00:00Z"]),
        description: "x",
        sysName: "x",
        objectId: "1.3",
        contact: pick(["", "ops"]),
        location: pick(["", "rack 2"]),
        uptimeDays: pick([1, 400, 401]),
        ...(pick([true, false]) ? { firmware: "1.2.3" } : {}),
      }
      : undefined;
    assertEquals(
      JSON.stringify(devicePolicies(d, o, now)),
      JSON.stringify(legacyDevicePolicies(d, o, now)),
      `device ${i}`,
    );
  }
});

/** Estates with every cross-system policy passing, failing, and not applying. */
function estates(): Array<[string, Snapshot]> {
  const snap = (sources: Array<[string, Observation]>, machines: Snapshot["machines"] = []) => ({
    fleet: "lab",
    sources: sources.map(([connector, observation]) => ({ connector, observation })),
    machines,
    links: { "github:alice": "alice@lab.example.net" },
  });
  const hr = obs("bamboohr", {
    people: [
      { email: "alice@lab.example.net", name: "Alice", status: "active" },
      { email: "bob@lab.example.net", name: "Bob", status: "terminated", end: "2026-10-31" },
      { email: "carol@lab.example.net", name: "Carol", status: "active" },
    ],
  });
  const okta = obs("okta", {
    accounts: [
      { ...admin("1", false), email: "alice@lab.example.net", name: "alice" },
      { ...admin("2"), email: "bob@lab.example.net", name: "bob", admin: false },
      { ...admin("3"), email: "dave@lab.example.net", name: "dave" },
    ],
  });
  const many = obs("google", {
    accounts: Array.from({ length: 15 }, (_, i) => ({
      system: "google",
      id: `g${i}`,
      name: `user${i}`,
      email: `user${i}@lab.example.net`,
      active: true,
      admin: true,
      mfa: false,
    })),
  });
  const github = obs("github", {
    accounts: [{ system: "github", id: "9", name: "alice", active: true }],
    repositories: [
      { system: "github", name: "lab/site", private: true, protected: false },
      { system: "github", name: "lab/infra", private: true, protected: true },
      { system: "github", name: "lab/public", private: false, protected: false },
    ],
  });
  const machines = [
    {
      source: "adopted",
      id: "alice-laptop",
      name: "alice-laptop",
      owner: "alice@lab.example.net",
      encrypted: false,
      managed: true,
    },
    { source: "stolos", id: "alpha", name: "alpha", serial: "S1", encrypted: true, managed: true },
  ];
  return [
    ["empty", snap([])],
    ["hr only", snap([["bamboohr", hr]])],
    ["identity only", snap([["okta", okta]])],
    ["everything", snap([["bamboohr", hr], ["okta", okta], ["github", github]], machines)],
    ["more than twelve", snap([["google", many]])],
    [
      "all good",
      snap(
        [
          [
            "bamboohr",
            obs("bamboohr", { people: [{ email: "admin1@lab.example.net", status: "active" }] }),
          ],
          ["okta", obs("okta", { accounts: [admin("1")] })],
          [
            "github",
            obs("github", {
              repositories: [{
                system: "github",
                name: "lab/infra",
                private: true,
                protected: true,
              }],
            }),
          ],
        ],
        [{ ...machines[1], owner: "admin1@lab.example.net" }],
      ),
    ],
  ];
}

Deno.test("078: the estate graph's cross-system policies on the SDK give identical results and findings", () => {
  for (const [name, s] of estates()) {
    const before = buildGraph(s, { now: NOW });
    const after = buildGraph(s, { now: NOW });
    const want = legacyEstatePolicies(before, NOW);
    const got = estatePolicies(after, NOW);
    assertEquals(JSON.stringify(got), JSON.stringify(want), name);
    const findings = "SELECT * FROM finding ORDER BY finding_uid";
    assertEquals(estateQuery(after, findings), estateQuery(before, findings), `${name}: findings`);
  }
  // The fixtures reach every policy, and both verdicts of each.
  const seen = new Set(
    estates().flatMap(([, s]) =>
      estatePolicies(buildGraph(s, { now: NOW }), NOW).map((r) => `${r.id}:${r.status}`)
    ),
  );
  for (
    const id of [
      "leavers",
      "orphans",
      "devices-for-people",
      "admins-mfa",
      "devices-encrypted",
      "repos-protected",
    ]
  ) {
    assert([...seen].some((x) => x.startsWith(`${id}:`) && !x.endsWith(":pass")), `${id} fails`);
    assert(seen.has(`${id}:pass`), `${id} passes`);
  }
});

// --- Compliance ---

Deno.test("078: a pack's results are Compliance evidence, from a control pack", async () => {
  const { runs } = await runFleetPacks({
    dir: EXAMPLE,
    estate: oktaWith(4),
    now: NOW,
  });
  const view = complianceView(fleetEvidence({ ...FACTS, controls: runs }));
  const iac30 = view.controls.find((c) => c.control.id === "IAC-30")!;
  const e = iac30.evidence.find((x) => x.source === "control pack")!;
  assertEquals(e.check, "Lab baseline: No system has more than three active administrators");
  assertEquals(e.subject, "across systems");
  assertEquals(e.status, "warn");
});

Deno.test("078: a pack in a temporary fleet repository shows up in stolos compliance and controls", async () => {
  const sb = await sandbox("stolos-controls-");
  try {
    const repo = join(sb.home, "fleet");
    await Deno.mkdir(join(repo, "fleets"), { recursive: true });
    const git = await new Deno.Command("git", { args: ["init", "-q", repo], stdin: "null" })
      .output();
    assert(git.success);
    await new Deno.Command("cp", {
      args: ["-r", "examples/fleets/lab", join(repo, "fleets", "lab")],
    })
      .output();
    const pack = join(repo, "fleets", "lab", "controls", "acme");
    await Deno.mkdir(pack, { recursive: true });
    await Deno.writeTextFile(
      join(pack, "pack.ts"),
      `import { defineControl, defineControlPack } from "@stolos/archon/controls/mod.ts";

export const pack = defineControlPack({
  id: "acme",
  title: "Acme rules",
  version: "1.0.0",
  controls: [
    defineControl({
      id: "zones-signed",
      title: "The fleet's zones are signed",
      scf: ["NET-13"],
      subject: "estate",
      query: "SELECT count(*) AS n FROM tenant",
      assert: (rows) => ({ status: "fail", detail: \`\${rows[0].n} tenant(s), none signed\` }),
      fix: "sign the zones (DNSSEC)",
    }),
  ],
});
`,
    );
    const env = { ARCHON_REPO: repo, ARCHON_FLEET: "lab" };
    const list = await sb.run("src/stolos/main.ts", ["controls", "list", "--json"], "", env);
    assertEquals(list.code, 0, list.out);
    assertStringIncludes(list.out, '"id": "acme"');
    assertStringIncludes(list.out, '"id": "baseline"');
    const r = await sb.run("src/stolos/main.ts", ["compliance", "--json"], "", env);
    const view = JSON.parse(r.out.slice(r.out.indexOf("{"), r.out.lastIndexOf("}") + 1));
    const net13 = view.controls.find((c: { control: { id: string } }) => c.control.id === "NET-13");
    const e = net13.evidence.find((x: { source: string }) => x.source === "control pack");
    assert(e, r.out);
    assertEquals(e.check, "Acme rules: The fleet's zones are signed");
    assertEquals(e.status, "fail");
    assertEquals(net13.status, "fail");
    // The packs' tests run in the fleet repository (its deno.json maps @stolos/ to the engine).
    await Deno.writeTextFile(
      join(repo, "deno.json"),
      JSON.stringify({ imports: { "@stolos/": new URL("../src/", import.meta.url).href } }),
    );
    const t = await sb.run("src/stolos/main.ts", ["controls", "test"], "", env);
    assertEquals(t.code, 0, t.out);
    assertStringIncludes(t.out, "baseline: telnet fails where it listens");
  } finally {
    await Deno.remove(sb.home, { recursive: true }).catch(() => {});
  }
});
