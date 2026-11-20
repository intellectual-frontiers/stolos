/**
 * Spec 069: integrate: the one-liners, the check-in code, and the scripts themselves.
 *
 * @module
 */

import {
  assert,
  assertEquals,
  assertStringIncludes,
  assertThrows,
  proves,
} from "@intellectual-frontiers/commons/ts/runtime/test";
import { sha256 } from "@intellectual-frontiers/crypto";
import { toBase64 } from "@intellectual-frontiers/formats";
import { fs, proc } from "@intellectual-frontiers/system";
import { tcp } from "@intellectual-frontiers/net";
import { nameFor, parseCheckIn } from "../src/archon/adopt/checkin.ts";
import { fromCheckIn, integrateLines } from "../src/archon/adopt/integrate.ts";
import { PROBE_SCRIPT, PROBE_SCRIPT_WINDOWS, PROBE_VERSION } from "../src/archon/adopt/probe.ts";

const KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIexampleexampleexampleexampleexample00";
const code = (text: string): string => "stolos1:" + toBase64(new TextEncoder().encode(text));
const SAMPLE = `@checkin
v=1
fleet=lab
kinds=adopt osquery
user=alice
port=2222
hostname=Alices-MacBook-Pro.local
addresses=192.168.1.20 not-an-ip
macs=AA:BB:CC:00:00:02 junk
@hostkeys
1=${KEY}
2=ssh-ed25519 not base64 !!
@probe
version=2
at=2026-11-15T10:00:00Z
@os
family=macos
name=macOS
version=15.1
serial=C02EXAMPLE
@security
disk_encryption=on
`;

proves(
  ["069-integrate FR-003"],
  "069: a check-in code is read, and only well-formed facts are kept",
  () => {
    const c = parseCheckIn(code(SAMPLE) + "\n");
    assertEquals(c.fleet, "lab");
    assertEquals(c.kinds, ["adopt", "osquery"]);
    assertEquals([c.user, c.port], ["alice", 2222]);
    assertEquals(c.addresses, ["192.168.1.20"]);
    assertEquals(c.macs, ["aa:bb:cc:00:00:02"]);
    assertEquals(c.hostKeys, [KEY]);
    assertEquals(c.observed?.os.serial, "C02EXAMPLE");
    assertEquals(nameFor(c.hostname), "alices-macbook-pro");
    assertEquals(fromCheckIn(c, "alice-mbp").os, "macOS 15.1");
  },
);

proves(["069-integrate FR-003"], "069: what is not a check-in code says so plainly", () => {
  assertThrows(() => parseCheckIn("hello"), undefined, "starts with stolos1:");
  assertThrows(() => parseCheckIn("stolos1:%%%"), undefined, "cut short");
  assertThrows(() => parseCheckIn(code("@checkin\nv=9\n")), undefined, "not a check-in code");
  assertThrows(
    () => parseCheckIn(code("@checkin\nv=1\nhostname=\n")),
    undefined,
    "no usable hostname",
  );
});

proves(
  ["069-integrate FR-004", "098-pair FR-009"],
  "069: the one-liners carry the fleet, the key, the engine, and the probe's checksum",
  async () => {
    const l = await integrateLines({
      as: ["adopt", "osquery"],
      fleet: "lab",
      key: KEY + " comment",
      tag: "stolos-v1.2.3",
    });
    assertStringIncludes(
      l.posix,
      "https://raw.githubusercontent.com/intellectual-frontiers/stolos/stolos-v1.2.3/bin/integrate.sh | sh -s --",
    );
    assertStringIncludes(
      l.posix,
      `--adopt --osquery --fleet lab --key '${KEY}' --engine stolos-v1.2.3 --probe-sha256 `,
    );
    assert(!l.posix.includes("comment"), "the key's comment is not passed");
    assertStringIncludes(l.windows ?? "", "integrate.windows.ps1");
    const ws = await integrateLines({
      as: ["workstation"],
      fleet: "lab",
      repo: "example/fleet",
      tag: "stolos-v1.2.3",
    });
    assertEquals(ws.windows, undefined, "a Windows workstation is WSL: no PowerShell line");
    assertStringIncludes(ws.posix, "--repo example/fleet");
  },
);

proves(["069-integrate FR-002"], "069: both probes report the same version", () => {
  assertEquals(PROBE_VERSION, "3");
  assertStringIncludes(PROBE_SCRIPT_WINDOWS, `$version = '${PROBE_VERSION}'`);
  assertStringIncludes(PROBE_SCRIPT, `version) echo ${PROBE_VERSION} ;;`);
});

async function sh(
  args: string[],
  env: Record<string, string>,
): Promise<{ code: number; out: string }> {
  const r = await proc.run(["sh", "bin/integrate.sh", ...args], { env, clearEnv: true });
  return { code: r.code, out: r.stdout + r.stderr };
}

/** The first line of a script's output that is a check-in code. */
const checkInLine = (out: string): string =>
  out.split("\n").find((l) => l.startsWith("stolos1:")) ?? "";

proves(
  ["069-integrate FR-001", "069-integrate FR-003"],
  "069: integrate.sh: discover changes nothing and prints a code; adopt installs and undoes",
  async () => {
    const home = await fs.makeTempDir();
    const env = {
      HOME: home,
      STOLOS_RAW: proc.cwd(),
      PATH: proc.env.get("PATH") ?? "/usr/bin:/bin",
    };
    const d = await sh([], env);
    assertEquals(d.code, 0, d.out);
    assertStringIncludes(d.out, "Nothing on this machine will change");
    assertEquals(parseCheckIn(checkInLine(d.out)).kinds, ["discover"]);
    assertEquals(fs.readDirSync(home).length, 0, "discover wrote nothing");
    const dry = await sh(["--adopt", "--fleet", "lab", "--key", KEY, "--dry-run"], env);
    assertStringIncludes(dry.out, "nothing was changed");
    assertEquals(fs.readDirSync(home).length, 0, "a dry run wrote nothing");
    const { PROBE_SCRIPT } = await import("../src/archon/adopt/probe.ts");
    const sum = await sha256(PROBE_SCRIPT);
    // Something listens on --ssh-port (this test), so the script sees SSH on and only writes in the account.
    const l = await tcp.listen({ hostname: "127.0.0.1", port: 0 });
    const port = String(l.addr.port);
    const bad = await sh(
      [
        "--adopt",
        "--fleet",
        "lab",
        "--key",
        KEY,
        "--probe-sha256",
        "0".repeat(64),
        "--yes",
        "--ssh-port",
        port,
      ],
      env,
    );
    assert(bad.code !== 0 && bad.out.includes("checksum differs"), bad.out);
    const ok = await sh(
      [
        "--adopt",
        "--fleet",
        "lab",
        "--key",
        KEY,
        "--probe-sha256",
        sum,
        "--ssh-port",
        port,
        "--yes",
      ],
      env,
    );
    l.close();
    assertEquals(ok.code, 0, ok.out);
    assertStringIncludes(
      await fs.readTextFile(`${home}/.ssh/authorized_keys`),
      `restrict ${KEY} stolos-probe@lab`,
    );
    assertEquals(await fs.readTextFile(`${home}/.local/bin/stolos-probe`), PROBE_SCRIPT);
    const code2 = parseCheckIn(checkInLine(ok.out));
    assertEquals([code2.kinds, code2.port], [["adopt"], Number(port)]);
    const u = await sh(["--undo", "--fleet", "lab", "--yes"], env);
    assertEquals(u.code, 0, u.out);
    assert(!(await fs.readTextFile(`${home}/.ssh/authorized_keys`)).includes("stolos-probe@lab"));
    assert(!(await fs.exists(`${home}/.local/bin/stolos-probe`)), "the probe is removed");
    await fs.remove(home, { recursive: true });
  },
  {
    // Windows runs integrate.windows.ps1 (tests/integrate/windows-check.ps1 in CI).
    skip: proc.build.os === "windows" && "integrate.sh is for Linux and macOS",
  },
);
