// Spec 066: the Stolos Console with a fake fleet and a fake runner, for the browser test
// (tests/console/stolos-browser.cjs, CI's console-browser job) and the server tests.
// Usage: deno run -A tests/console/serve-stolos.ts <port>
import { Sessions } from "../../src/archon/console/auth.ts";
import type { ActivityEntry } from "../../src/archon/console/pages.ts";
import type { PcFacts } from "../../src/archon/console/pc.ts";
import { Launch, type StolosDeps, stolosHandler } from "../../src/archon/console/stolos-server.ts";
import { PC_GUIDES } from "../../src/archon/console/stolos-pages.ts";
import { policies } from "../../src/archon/adopt/policy.ts";
import { type DeviceDef, devicePolicies } from "../../src/archon/device/device.ts";
import { toObserved } from "../../src/archon/adopt/adopt.ts";
import { parseProbe } from "../../src/archon/adopt/probe.ts";
import { cloudflare } from "../../src/archon/connect/cloudflare.ts";
import type { Observation } from "../../src/archon/connect/connector.ts";
import { buildGraph, type Estate, estatePolicies } from "../../src/archon/estate/graph.ts";
import {
  CATALOG_FORMAT,
  SCF_SOURCE,
  type ScfCatalog,
} from "../../src/archon/compliance/catalog.ts";
import { FRAMEWORKS } from "../../src/archon/compliance/scf.ts";

const now = new Date().toISOString().replace(/\.\d+Z$/, "Z");
const mac = toObserved(
  parseProbe(
    `@probe\nversion=1\nat=${now}\n@os\nkernel=Darwin\nfamily=macos\nname=macOS\nversion=15.1\narch=arm64\nhostname=alice-mbp\nserial=C02EXAMPLE\n@hardware\ncpus=10\nmemory_mb=32768\ndisk_total_gb=926\ndisk_used_pct=41\n@security\ndisk_encryption=on\nfirewall=on\nauto_updates=on\nadmins=alice\n@software\nbrew_packages=120\nosquery=5.12.1\n@listening\nports=22 5000\n`,
  ),
);
const desk = toObserved(
  parseProbe(
    `@probe\nversion=1\nat=${now}\n@os\nkernel=Linux\nfamily=arch\nname=Arch Linux\nversion=rolling\narch=x86_64\nhostname=bob-desk\nflavor=omarchy\n@hardware\ncpus=16\nmemory_mb=65536\n@security\ndisk_encryption=off\nfirewall=off\nauto_updates=manual\nadmins=bob\n@software\nmanager=pacman\npackages=1400\npending_updates=48\n@listening\nports=22 631\n`,
  ),
);
const machines = [
  {
    name: "alice-mbp",
    ssh: { user: "alice", address: "alice-mbp.local" },
    hostKeys: [],
    adopted: "2026-11-01",
    owner: "alice",
    title: "Alice's MacBook",
  },
  {
    name: "bob-desk",
    ssh: { user: "bob", address: "10.0.30.71" },
    hostKeys: [],
    adopted: "2026-11-02",
    owner: "bob",
    accepted: [{
      policy: "firewall",
      reason: "the office router filters; this desktop serves nothing",
      by: "Alice Example",
      until: "2099-01-01",
    }],
  },
];
const cf: Observation = {
  at: now,
  provider: "cloudflare",
  account: "Example Co",
  assets: [
    { kind: "zone", id: "z1", name: "example.org", facts: { ssl: "strict", minTls: "1.0" } },
    {
      kind: "dns-record",
      id: "r1",
      name: "alpha.lab.example.org",
      where: "example.org",
      fleetMachine: "alpha",
      facts: { type: "A", content: "10.0.30.59" },
    },
    { kind: "r2-bucket", id: "backups", name: "backups", where: "ENAM" },
  ],
  posture: { zones: 1, zonesStrictTls: 1, zonesAlwaysHttps: 1, zonesMinTls12: 0, zonesDnssec: 0 },
  gaps: ["Workers: /accounts/a1/workers/scripts: 403 (the credential may not read this)"],
};
const t = Date.now();

/** The fake fleet's facts. */
export const FACTS: PcFacts = {
  fleet: {
    id: "lab",
    title: "lab",
    repo: "example/fleet",
    domain: "lab.example.org",
    engine: "v0.0.0",
  },
  machines: [
    {
      name: "alpha",
      kind: "server",
      os: "Ubuntu",
      where: "10.0.30.59",
      seen: now,
      score: { pass: 141, total: 142 },
      failing: ["apt:ipv4-only"],
      console: "https://alpha.lab.example.org/",
      applied: { commit: "f6e5d4c", subject: "lab: approve", at: now },
      sync: {
        at: now,
        blocked: "a1b2c3d4e5 is not signed by a fleet signer (archon explain E047-UNSIGNED)",
      },
      upToDate: false,
    },
    {
      name: "beta",
      kind: "server",
      os: "Ubuntu",
      seen: now,
      score: { pass: 142, total: 142 },
      failing: [],
      console: "https://beta.lab.example.org/",
    },
    { name: "wsl-alice", kind: "workstation", os: "Ubuntu", failing: [] },
    ...machines.map((m, i) => {
      const o = [mac, desk][i];
      const rs = policies(m, o, t);
      return {
        name: m.name,
        kind: "adopted" as const,
        os: `${o.os.name} ${o.os.version}`,
        where: m.ssh.address,
        owner: m.owner,
        seen: o.at,
        score: { pass: rs.filter((r) => r.status === "pass").length, total: rs.length },
        failing: rs.filter((r) => r.status === "fail").map((r) => r.title),
      };
    }),
    { name: "scratch", kind: "cloud", where: "Hetzner Cloud, fsn1-dc14", seen: now, failing: [] },
    {
      name: "front-printer",
      kind: "device",
      os: "LaserJet Example",
      where: "10.0.30.40",
      owner: "office",
      serial: "VNB0000000",
      seen: now,
      score: { pass: 4, total: 4 },
      failing: [],
    },
    {
      name: "front-desk",
      kind: "discovered",
      os: "Windows 11 Pro 26100",
      where: "10.0.30.77",
      seen: now,
      failing: [],
    },
  ],
  adopted: machines.map((m, i) => ({
    machine: m,
    observed: [mac, desk][i],
    results: policies(m, [mac, desk][i], t),
  })),
  devices: [{
    device: {
      name: "front-printer",
      kind: "printer",
      address: "10.0.30.40",
      owner: "office",
      location: "front desk",
      snmp: { user: "stolos", auth: "sha256" },
      added: now,
    },
    observed: {
      at: now,
      description: "Example LaserJet, firmware 2026.1",
      sysName: "front-printer",
      objectId: "1.3.6.1.4.1.11.2.3.9.1",
      contact: "office",
      location: "front desk",
      uptimeDays: 12,
      interfaces: 1,
      serial: "VNB0000000",
      model: "LaserJet Example",
    },
    results: [],
  }].map((d) => ({
    ...d,
    device: d.device as DeviceDef,
    results: devicePolicies(d.device as DeviceDef, d.observed),
  })),
  clouds: [
    {
      id: "cloudflare",
      title: "Cloudflare",
      logo: "cloudflare",
      connected: true,
      observed: cf,
      results: cloudflare.policies(cf, t),
    },
    { id: "microsoft", title: "Microsoft 365 and Azure", logo: "", connected: false, results: [] },
    { id: "aws", title: "Amazon Web Services", logo: "", connected: true, results: [] },
    { id: "hetzner", title: "Hetzner Cloud", logo: "hetzner", connected: false, results: [] },
  ],
  signers: [
    {
      name: "alice-daily",
      role: "daily",
      added: "2026-10-01",
      key: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIexampledailykeyexampledailykey",
    },
    {
      name: "alice-recovery",
      role: "recovery",
      added: "2026-10-01",
      key: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIexamplerecoverykeyexamplerec",
    },
  ],
  git: {
    dirty: [" M fleets/lab/hosts/alpha.ts"],
    unapproved: ["a1b2c3d4e5 lab: add beta (alice)"],
    log: [
      { sha: "a1b2c3d4e5", subject: "lab: add beta", author: "alice", at: now, approved: false },
      { sha: "f6e5d4c3b2", subject: "lab: approve", author: "alice", at: now, approved: true },
    ],
  },
};

/** A boot.log with one finished install and one under way. */
export const BOOT_LOG = [
  "2026-11-15T10:00:01Z 10.0.30.59 TFTP bootx64.efi",
  "2026-11-15T10:00:03Z 10.0.30.59 alpha: armed, starting its install",
  "2026-11-15T10:00:09Z 10.0.30.59 TFTP linux",
  "2026-11-15T10:01:40Z 10.0.30.59 alpha: installer image (whole)",
  "2026-11-15T10:02:10Z 10.0.30.59 alpha: install config sent (network on aa:bb:cc:00:00:01)",
  "2026-11-15T10:04:00Z 10.0.30.59 alpha: installer: copying Ubuntu to the disk",
  "2026-11-15T10:08:00Z 10.0.30.59 alpha: install finished; disarmed",
  "2026-11-15T10:09:00Z 10.0.30.59 alpha: First boot: installing Deno, cloning the repository",
  "2026-11-15T10:10:30Z 10.0.30.59 alpha: [ok] Verify: 142 passed",
  "2026-11-15T10:10:31Z 10.0.30.59 alpha: Ready: 142/142 checks · ssh alpha",
  "2026-11-15T11:00:01Z 10.0.30.60 TFTP grubx64.efi",
  "2026-11-15T11:00:03Z 10.0.30.60 beta: claimed by beta",
  "2026-11-15T11:01:50Z 10.0.30.60 beta: installer image (whole)",
].join("\n") + "\n";

/** A fake runner: lines, and fleet query answers as JSON. */
export const fakeRunner: StolosDeps["runner"] = async (argv, each) => {
  if (argv[0] === "fleet" && argv[1] === "query") {
    if (/shadow/.test(argv[2])) {
      each("   [FAIL] refused: the table shadow is never served (secrets or reaching out)");
      return 1;
    }
    each(JSON.stringify([
      { machine: "alpha", kind: "managed", rows: [{ name: "Ubuntu", version: "26.04" }] },
      { machine: "alice-mbp", kind: "adopted", rows: [{ name: "macOS", version: "15.1" }] },
      { machine: "bob-desk", kind: "adopted", error: "osquery is not installed here" },
    ]));
    return 1;
  }
  for (let i = 0; i < 20; i++) {
    each(
      i === 5 ? "   [warn] The firewall is on: firewall: off [END-07, NET-02]" : `[ok] step ${i}`,
    );
    await new Promise((r) => setTimeout(r, 15));
  }
  each(`[ok] ${argv.join(" ")} done`);
  return 0;
};

const estateObs = (provider: string, account: string, entities: Observation["entities"]) => ({
  connector: provider,
  observation: {
    at: "2026-11-01T00:00:00Z",
    provider,
    account,
    assets: [],
    posture: {},
    gaps: [],
    entities,
  } as Observation,
});

/** The fake fleet's estate (spec 090): people, accounts, a repository, machines, and findings. */
export function fakeEstate(): Estate {
  const e = buildGraph({
    fleet: "lab",
    sources: [
      estateObs("bamboohr", "example", {
        people: [
          { email: "alice@example.org", name: "Alice", status: "active", type: "employee" },
          { email: "bob@example.org", name: "Bob", status: "terminated", end: "2026-10-31" },
        ],
      }),
      estateObs("okta", "example.okta.com", {
        accounts: [
          {
            system: "okta",
            id: "1",
            name: "alice",
            email: "alice@example.org",
            active: true,
            admin: true,
            mfa: false,
          },
          {
            system: "okta",
            id: "2",
            name: "bob",
            email: "bob@example.org",
            active: true,
            admin: false,
            mfa: true,
          },
        ],
      }),
      estateObs("github", "example", {
        accounts: [{ system: "github", id: "3", name: "ci-bot", active: true, service: true }],
        repositories: [{ system: "github", name: "example/app", private: true, protected: false }],
      }),
    ],
    machines: [
      { source: "stolos", id: "alpha", name: "alpha", managed: true, os: "Ubuntu" },
      {
        source: "adopted",
        id: "alice-mbp",
        name: "alice-mbp",
        owner: "alice@example.org",
        managed: false,
        serial: "C02EXAMPLE",
        encrypted: true,
      },
      { source: "adopted", id: "bob-desk", name: "bob-desk", managed: false, encrypted: false },
    ],
    links: {},
  }, { now: new Date("2026-11-15T12:00:00Z") });
  estatePolicies(e, new Date("2026-11-15T12:00:00Z"));
  return e;
}

/** A small SCF catalog (the real one is downloaded): enough for the OSCAL documents. */
export const FAKE_CATALOG: ScfCatalog = {
  format: CATALOG_FORMAT,
  version: SCF_SOURCE.version,
  controls: Object.fromEntries(
    ["CRY-07", "CHG-03", "IAC-06", "IAC-15", "END-04"].map((id) => [id, {
      domain: "Example",
      name: id,
      description: `${id}, for the tests.`,
      maps: Object.fromEntries(
        FRAMEWORKS.map((f) => [f.id, f.id === "nist80053" ? ["AC-2"] : []]),
      ) as ScfCatalog["controls"][string]["maps"],
    }]),
  ),
};

/** The console with fakes; `launch` and the evidence directory are exposed for tests. */
export async function fakeConsole(
  port: number,
): Promise<{ handler: ReturnType<typeof stolosHandler>; launch: Launch; evidenceDir: string }> {
  const log: ActivityEntry[] = [];
  const launch = new Launch();
  const state = await Deno.makeTempDir();
  const evidenceDir = `${state}/evidence`;
  await Deno.mkdir(evidenceDir);
  await Deno.writeTextFile(`${state}/secret.txt`, "not for the API\n");
  await Deno.writeFile(
    `${evidenceDir}/lab-evidence-2026-01-01-to-2026-06-30.zip`,
    new Uint8Array([0x50, 0x4b, 0x05, 0x06, ...new Array(18).fill(0)]),
  );
  await Deno.writeTextFile(`${evidenceDir}/notes.txt`, "not a bundle\n");
  const estate = fakeEstate();
  const handler = stolosHandler({
    port,
    person: { user: "alice", name: "Alice Example", github: "alice-example" },
    launch,
    sessions: new Sessions(),
    facts: () => Promise.resolve(structuredClone(FACTS)),
    runner: fakeRunner,
    activity: {
      add: (e) => (log.push(e), Promise.resolve()),
      recent: (n) => Promise.resolve(log.slice(-n).reverse()),
    },
    guides: PC_GUIDES,
    guideDoc: (n) =>
      Promise.resolve(n === "daily-use" ? "<h1>Daily use</h1><p>Example.</p>" : undefined),
    integrate: async (_name, as) => {
      const { integrateLines } = await import("../../src/archon/adopt/integrate.ts");
      return await integrateLines({
        as: as as never,
        fleet: "lab",
        ...(as.includes("adopt")
          ? { key: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIexampleexampleexampleexample0000" }
          : {}),
        tag: "v0.0.0",
      });
    },
    bootLog: () => Promise.resolve(BOOT_LOG),
    cacheDir: await Deno.makeTempDir(),
    estate: () => Promise.resolve(estate),
    evidenceDir,
    catalog: () => Promise.resolve(FAKE_CATALOG),
  });
  return { handler, launch, evidenceDir };
}

if (import.meta.main) {
  const port = Number(Deno.args[0] ?? 8098);
  const { handler, launch } = await fakeConsole(port);
  // Test only: a fresh launch link (the real console prints it in the terminal).
  Deno.serve(
    { port, hostname: "127.0.0.1", onListen: () => console.log("listening") },
    (req) =>
      new URL(req.url).pathname === "/__test/launch"
        ? new Response(launch.issue())
        : new URL(req.url).pathname === "/healthz"
        ? new Response("ok\n")
        : handler(req),
  );
}
