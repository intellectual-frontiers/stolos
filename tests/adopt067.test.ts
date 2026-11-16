/**
 * Spec 067: adopted machines: the probe, its output, the observation, and the policy pack.
 *
 * @module
 */
import { fs, proc } from "@intellectual-frontiers/ifc-ts/runtime";
import {
  assert,
  assertEquals,
  assertExists,
  assertStringIncludes,
  proves,
  the,
} from "@intellectual-frontiers/ifc-ts/runtime/test";
import {
  authorizedLine,
  parseProbe,
  PROBE_SCRIPT,
  PROBE_VERSION,
} from "../src/archon/adopt/probe.ts";
import {
  type AdoptedDef,
  installScript,
  MACHINE_NAME,
  machineSource,
  type Observed,
  observedSource,
  releaseScript,
  toObserved,
} from "../src/archon/adopt/adopt.ts";
import { policies, supportedOs } from "../src/archon/adopt/policy.ts";
import { queryRefusal } from "../src/archon/state/query.ts";

const MAC_OUTPUT = `@probe
version=1
at=2026-11-01T10:00:00Z
@os
kernel=Darwin
family=macos
name=macOS
version=15.1
arch=arm64
hostname=alice-mbp
serial=C02EXAMPLE
@hardware
cpus=10
memory_mb=32768
disk_total_gb=926
disk_used_pct=41
@security
disk_encryption=on
firewall=on
auto_updates=on
admins=alice bob
@software
brew_packages=120
osquery=5.12.1
@listening
ports=22 5000 7000
`;

const machine: AdoptedDef = {
  name: "alice-mbp",
  ssh: { user: "alice", address: "alice-mbp.local" },
  hostKeys: ["alice-mbp.local ssh-ed25519 AAAAexample"],
  adopted: "2026-11-01",
};

proves(
  ["067-adopt FR-004"],
  "067: parseProbe reads sections and key=value lines (CRLF too)",
  () => {
    const p = parseProbe("junk=1\r\n@os\r\nfamily=macos\r\nname=a=b\r\n@empty\r\n");
    assertEquals(p, { os: { family: "macos", name: "a=b" }, empty: {} });
  },
);

proves(["067-adopt FR-004"], "067: toObserved turns probe output into an observation", () => {
  const o = toObserved(parseProbe(MAC_OUTPUT));
  assertEquals(o.os.family, "macos");
  assertEquals(o.os.serial, "C02EXAMPLE");
  assertEquals(o.hardware, { cpus: 10, memoryMB: 32768, diskTotalGB: 926, diskUsedPct: 41 });
  assertEquals(o.security.admins, ["alice", "bob"]);
  assertEquals(o.software.osquery, "5.12.1");
  assertEquals(o.listening, [22, 5000, 7000]);
  const empty = toObserved({});
  assertEquals(empty.os.family, "unknown");
  assertEquals(empty.security.diskEncryption, "unknown");
  assertEquals(empty.listening, []);
});

proves(["067-adopt FR-004"], "067: a well-kept Mac passes every policy", () => {
  const o = toObserved(parseProbe(MAC_OUTPUT));
  const r = policies(machine, o, Date.parse("2026-11-03T00:00:00Z"));
  assertEquals(
    r.filter((p) => p.status !== "pass").map((p) => p.id),
    [],
  );
  for (const p of r) {
    assert(p.scf.length > 0 && p.scf.every((c) => /^[A-Z]{3}-\d{2}$/.test(c)), p.id);
  }
});

proves(["067-adopt FR-004"], "067: policies fail with a fix for this OS", () => {
  const o: Observed = toObserved(parseProbe(MAC_OUTPUT));
  o.security.diskEncryption = "off";
  o.security.admins = ["a", "b", "c", "d"];
  const r = policies({ ...machine, until: "2026-10-01" }, o, Date.parse("2026-12-01T00:00:00Z"));
  const by = Object.fromEntries(r.map((p) => [p.id, p]));
  assertEquals(the(by["disk-encryption"]).status, "fail");
  assertStringIncludes(the(the(by["disk-encryption"]).fix), "FileVault");
  assertEquals(the(by["observed"]).status, "fail");
  assertEquals(the(by["few-admins"]).status, "warn");
  assertEquals(the(by["adoption-current"]).status, "fail");
  assertEquals(policies(machine, undefined)[0]?.status, "fail");
});

proves(["067-adopt FR-003"], "067: supported operating systems (a starter table)", () => {
  const o = (family: string, version: string) =>
    ({ os: { family, version } }) as unknown as Observed;
  assertEquals(supportedOs(o("macos", "15.1")), true);
  assertEquals(supportedOs(o("macos", "12.7")), false);
  assertEquals(supportedOs(o("ubuntu", "24.04")), true);
  assertEquals(supportedOs(o("ubuntu", "20.04")), false);
  assertEquals(supportedOs(o("arch", "rolling")), true);
  assertEquals(supportedOs(o("plan9", "4")), undefined);
});

proves(["067-adopt FR-002"], "067: the probe key may run the probe only", () => {
  const line = authorizedLine("ssh-ed25519 AAAAC3Nzexample stolos@pc\n", "lab");
  assertEquals(
    line,
    'command="$HOME/.local/bin/stolos-probe",restrict ssh-ed25519 AAAAC3Nzexample stolos-probe@lab',
  );
  const install = installScript("ssh-ed25519 AAAAC3Nzexample", "lab");
  assertStringIncludes(install, line);
  assertStringIncludes(install, "grep -v 'stolos-probe@lab$'");
  assertStringIncludes(install, PROBE_SCRIPT);
  assertStringIncludes(releaseScript("lab"), 'rm -f "$HOME/.local/bin/stolos-probe"');
});

proves(
  ["067-adopt FR-001", "067-adopt FR-004"],
  "067: machine names, and machine.ts and observed.ts are TypeScript",
  () => {
    assert(MACHINE_NAME.test("alice-mbp"));
    assert(!MACHINE_NAME.test("../etc"));
    assert(!MACHINE_NAME.test("Alice"));
    assertStringIncludes(machineSource(machine), "export const machine: AdoptedDef = {");
    assertStringIncludes(observedSource(toObserved(parseProbe(MAC_OUTPUT))), "GENERATED");
  },
);

async function runProbe(
  request: string,
  path?: string,
): Promise<{ code: number; out: string; err: string }> {
  const dir = await fs.makeTempDir();
  const file = `${dir}/stolos-probe`;
  await fs.writeTextFile(file, PROBE_SCRIPT);
  const env: Record<string, string> = { SSH_ORIGINAL_COMMAND: request, HOME: dir };
  if (path) env["PATH"] = `${path}:${proc.env.get("PATH")}`;
  const r = await proc.run(["sh", file], { env });
  await fs.remove(dir, { recursive: true });
  return { code: r.code, out: r.stdout, err: r.stderr };
}

proves(
  ["067-adopt FR-002", "067-adopt FR-003"],
  "067: the probe answers facts here and refuses anything else",
  async () => {
    const facts = await runProbe("facts");
    assertEquals(facts.code, 0, facts.err);
    const o = toObserved(parseProbe(facts.out));
    assertEquals(o.probe, PROBE_VERSION);
    assert(o.os.family !== "unknown");
    assertEquals((await runProbe("version")).out.trim(), PROBE_VERSION);
    for (const evil of ["id", "facts; id", "facts && id", "$(id)"]) {
      const r = await runProbe(evil);
      assertEquals(r.code, 2, evil);
      assertEquals(r.out, "", evil);
    }
  },
  // Windows machines run the PowerShell probe (tests/integrate/windows-check.ps1 in CI).
  {
    skip: proc.build.os === "windows" && "the POSIX probe is Linux's and macOS's",
    timeout: 120_000,
  },
);

proves(
  ["067-adopt FR-002", "067-adopt FR-005"],
  "067: the probe runs one SELECT through osqueryi, nothing else",
  async () => {
    const bin = await fs.makeTempDir();
    await fs.writeTextFile(
      `${bin}/osqueryi`,
      '#!/bin/sh\n[ "$1" = --version ] && echo "osqueryi version 5.12.1" && exit 0\necho "RAN: $2"\n',
    );
    await fs.chmod(`${bin}/osqueryi`, 0o755);
    const q = (sql: string) => runProbe(`osquery ${btoa(sql)}`, bin);
    assertEquals((await q("select 1;")).out.trim(), "RAN: select 1");
    assertEquals((await q("with a as (select 1) select * from a")).code, 0);
    assertEquals((await q("select 1; select 2")).code, 2);
    assertEquals((await q("delete from users")).code, 2);
    assertEquals((await runProbe("osquery !!notbase64!!", bin)).code, 2);
    await fs.remove(bin, { recursive: true });
  },
  { timeout: 120_000 },
);

proves(["067-adopt FR-005"], "067: fleet query refuses what the servers refuse", () => {
  assertEquals(queryRefusal("select name from os_version"), undefined);
  assert(queryRefusal("select * from shadow"));
  assert(queryRefusal("select 1; select 2"));
  assert(queryRefusal("drop table users"));
});

proves(
  ["067-adopt FR-012"],
  "067: discover reads Linux, macOS, and Windows neighbor tables; knows the fleet's",
  async () => {
    const { parseNeighbors, unknownMachines } = await import("../src/archon/adopt/discover.ts");
    const linux =
      "192.168.1.1 dev eth0 lladdr aa:bb:cc:00:00:01 REACHABLE\n192.168.1.9 dev eth0  FAILED\n";
    const mac =
      "? (192.168.1.20) at aa:bb:cc:0:0:2 on en0 ifscope [ethernet]\n? (192.168.1.21) at aa:bb:cc:00:00:02 on en0\n? (192.168.1.255) at ff:ff:ff:ff:ff:ff on en0\n";
    const win =
      "  192.168.1.30          aa-bb-cc-00-00-03     dynamic\n  224.0.0.22            01-00-5e-00-00-16     static\n";
    assertEquals(parseNeighbors(linux), [{ address: "192.168.1.1", mac: "aa:bb:cc:00:00:01" }]);
    assertEquals(parseNeighbors(mac), [
      { address: "192.168.1.20", mac: "aa:bb:cc:00:00:02" },
      { address: "192.168.1.21", mac: "aa:bb:cc:00:00:02" },
    ]);
    assertEquals(parseNeighbors(win), [{ address: "192.168.1.30", mac: "aa:bb:cc:00:00:03" }]);
    const seen = [
      { source: "lan", address: "192.168.1.1", id: "aa:bb:cc:00:00:01" },
      { source: "lan", address: "192.168.1.30", id: "AA:BB:CC:00:00:03" },
      { source: "hetzner", address: "198.51.100.2", id: "2", name: "scratch" },
      { source: "hetzner", address: "198.51.100.1", id: "1", name: "server1" },
    ];
    const left = unknownMachines(seen, {
      macs: ["aa:bb:cc:00:00:03"],
      addresses: ["192.168.1.1"],
      names: ["server1"],
    });
    assertEquals(
      left.map((d) => d.id),
      ["2"],
    );
  },
);

proves(
  ["067-adopt FR-013"],
  "067: an accepted risk shows as accepted until its date, then fails again",
  async () => {
    const { accept } = await import("../src/archon/adopt/policy.ts");
    const m = {
      ...machine,
      accepted: [
        {
          policy: "disk-encryption",
          reason: "no customer data here",
          by: "Alice",
          until: "2026-12-31",
        },
      ],
    };
    const fail = {
      id: "disk-encryption",
      title: "The disk is encrypted",
      scf: ["CRY-07"],
      status: "fail" as const,
      detail: "off",
    };
    const before = accept(m, [fail], Date.parse("2026-11-20T00:00:00Z"))[0];
    assertExists(before);
    assertEquals(before.status, "accepted");
    assertStringIncludes(
      before.detail,
      "accepted by Alice until 2026-12-31: no customer data here",
    );
    assertEquals(accept(m, [fail], Date.parse("2027-01-02T00:00:00Z"))[0]?.status, "fail");
    assertEquals(accept(m, [{ ...fail, status: "pass" }])[0]?.status, "pass");
  },
);

proves(
  ["067-adopt FR-006"],
  "067: host release removes the probe and its key line over your own SSH, then the model and the probe key",
  async () => {
    const { sandbox, linkEngine } = await import("./sandbox.ts");
    const { path } = await import("@intellectual-frontiers/ifc-ts/runtime");
    const sb = await sandbox("stolos-release-");
    try {
      const repo = path.join(sb.home, "fleet");
      await fs.mkdir(path.join(repo, "fleets"), { recursive: true });
      await fs.copy("examples/fleets/lab", path.join(repo, "fleets", "lab"));
      await linkEngine(repo);
      const dir = path.join(repo, "fleets", "lab", "adopted", "alice-mbp");
      await fs.mkdir(dir, { recursive: true });
      await fs.writeTextFile(path.join(dir, "machine.ts"), machineSource(machine));
      // The probe key, in this PC's vault.
      const keys = path.join(sb.home, "config", "stolos", "secrets", "lab", "adopted", "alice-mbp");
      await fs.mkdir(keys, { recursive: true });
      await fs.writeTextFile(path.join(keys, "probe_key"), "PRIVATE\n");
      await fs.writeTextFile(path.join(keys, "probe_key.pub"), "ssh-ed25519 AAAAC3Nzprobe pc\n");
      // The machine, as adopt left it: the probe, and its key's line beside the owner's own key.
      const there = path.join(sb.home, "alice-mbp");
      await fs.mkdir(path.join(there, ".ssh"), { recursive: true });
      await fs.writeTextFile(
        path.join(there, ".ssh", "authorized_keys"),
        "ssh-ed25519 AAAAC3Nzowner alice@laptop\n",
      );
      const install = await proc.run(["sh", "-s"], {
        input: installScript("ssh-ed25519 AAAAC3Nzprobe", "lab"),
        env: { HOME: there, PATH: proc.env.get("PATH") ?? "/usr/bin:/bin" },
        clearEnv: true,
      });
      assertEquals(install.code, 0, install.stderr);
      const probe = path.join(there, ".local", "bin", "stolos-probe");
      assert(await fs.exists(probe), "the probe is installed");
      assertStringIncludes(
        await fs.readTextFile(path.join(there, ".ssh", "authorized_keys")),
        "stolos-probe@lab",
      );
      // "Your own SSH": a stand-in ssh that runs what it is given on the machine above.
      const bin = path.join(sb.home, "bin");
      await fs.mkdir(bin);
      await fs.writeTextFile(path.join(bin, "ssh"), `#!/bin/sh\nHOME="${there}" exec sh -s\n`);
      await fs.chmod(path.join(bin, "ssh"), 0o755);
      const r = await sb.run("src/stolos/main.ts", ["host", "release", "alice-mbp"], "", {
        ARCHON_REPO: repo,
        ARCHON_FLEET: "lab",
        PATH: `${bin}:${sb.env["PATH"] ?? ""}`,
      });
      assertEquals(r.code, 0, r.out);
      assertStringIncludes(r.out, "stolos-probe removed");
      assertStringIncludes(r.out, "alice-mbp released: its model and probe key are gone");
      assert(!(await fs.exists(probe)), "the probe is gone");
      assertEquals(
        await fs.readTextFile(path.join(there, ".ssh", "authorized_keys")),
        "ssh-ed25519 AAAAC3Nzowner alice@laptop\n",
        "only the probe's line went",
      );
      assert(!(await fs.exists(dir)), "the model is gone");
      assert(!(await fs.exists(path.join(keys, "probe_key"))), "the probe key is gone");
      assert(!(await fs.exists(path.join(keys, "probe_key.pub"))));
    } finally {
      await fs.remove(sb.home, { recursive: true });
    }
  },
  { skip: proc.build.os === "windows" && "the stand-in ssh is a shell script" },
);
