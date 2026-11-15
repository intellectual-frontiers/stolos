/**
 * Spec 069: SNMPv3 (read-only, authPriv): published test vectors, and a real snmpd when one is installed.
 *
 * @module
 */

import {
  assert,
  assertEquals,
  assertStringIncludes,
  proves,
} from "@intellectual-frontiers/ifc-ts/runtime/test";
import { fs, proc } from "@intellectual-frontiers/ifc-ts/runtime";
import {
  aesCfb,
  decodeOid,
  encodeOid,
  localizedKey,
  SnmpSession,
} from "../src/archon/device/snmp.ts";
import { type DeviceDef, devicePolicies, observeDevice } from "../src/archon/device/device.ts";

const hex = (b: Uint8Array): string => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
const unhex = (h: string): Uint8Array =>
  Uint8Array.from((h.match(/../g) ?? []).map((x) => parseInt(x, 16)));

proves(["069-integrate FR-005"], "069 SNMP: OIDs encode and decode (large arcs too)", () => {
  for (const o of [
    "1.3.6.1.2.1.1.1.0",
    "1.3.6.1.4.1.8072.3.2.10",
    "1.3.6.1.6.3.15.1.1.4.0",
    "2.999.3",
  ]) {
    const b = encodeOid(o);
    assertEquals(decodeOid(b.slice(2)), o);
  }
});

proves(["069-integrate FR-005"], "069 SNMP: key localization matches RFC 3414 A.3.2 (SHA)", () => {
  const k = localizedKey("maplesyrup", unhex("000000000000000000000002"), "sha");
  assertEquals(hex(k), "6695febc9288e36282235fc7151f128497b38f3f");
});

proves(
  ["069-integrate FR-005"],
  "069 SNMP: AES-128-CFB matches NIST SP 800-38A F.3.13, and round-trips odd lengths",
  () => {
    const key = unhex("2b7e151628aed2a6abf7158809cf4f3c");
    const iv = unhex("000102030405060708090a0b0c0d0e0f");
    const ct = aesCfb(
      key,
      iv,
      unhex("6bc1bee22e409f96e93d7e117393172aae2d8a571e03ac9c9eb76fac45af8e51"),
      false,
    );
    assertEquals(hex(ct), "3b3fd92eb72dad20333449f8e83cfb4ac8a64537a0b3a93fcde3cdad9f1ce58b");
    const msg = new TextEncoder().encode("a scoped PDU of 37 bytes, not 16 x n");
    assertEquals(aesCfb(key, iv, aesCfb(key, iv, msg, false), true), msg);
  },
);

proves(["069-integrate FR-005"], "069 SNMP: device policies", () => {
  const d: DeviceDef = {
    name: "p",
    kind: "printer",
    address: "x",
    snmp: { user: "s", auth: "sha256" },
    added: "2026-01-01",
  };
  const now = Date.parse("2026-11-15T00:00:00Z");
  const o = {
    at: "2026-11-14T00:00:00Z",
    description: "",
    sysName: "",
    objectId: "",
    contact: "",
    location: "",
    uptimeDays: 500,
  };
  const by = Object.fromEntries(devicePolicies(d, o, now).map((r) => [r.id, r.status]));
  assertEquals(by, { observed: "pass", snmpv3: "pass", owner: "warn", restarted: "warn" });
  assertEquals(devicePolicies(d, undefined)[0]?.status, "fail");
});

const snmpd = proc.which("snmpd") ?? proc.which("snmpd", "/usr/sbin:/sbin") ?? "";

proves(
  ["069-integrate FR-005"],
  "069 SNMP: a real snmpd: SHA-256 and SHA-1 with AES, a walk, and plain refusals",
  async () => {
    const dir = await fs.makeTempDir();
    const port = 20000 + Math.floor(Math.random() * 20000);
    await fs.writeTextFile(
      `${dir}/snmpd.conf`,
      `agentAddress udp:127.0.0.1:${port}
createUser ro256 SHA-256 "auth-pass-123" AES "priv-pass-456"
createUser ro1 SHA "auth-pass-123" AES "priv-pass-456"
rouser ro256 priv
rouser ro1 priv
sysLocation Rack 2
sysContact ops@example.org
`,
    );
    const p = proc.spawn([snmpd, "-f", "-C", "-c", `${dir}/snmpd.conf`, "-Lf", `${dir}/log`], {
      env: { SNMP_PERSISTENT_DIR: dir },
      stdin: "null",
      stdout: "null",
      stderr: "null",
    });
    try {
      await proc.sleep(1500);
      for (const [user, auth] of [
        ["ro256", "sha256"],
        ["ro1", "sha"],
      ] as const) {
        const cred = { user, auth, authKey: "auth-pass-123", privKey: "priv-pass-456" };
        const d: DeviceDef = {
          name: "lab",
          kind: "switch",
          address: "127.0.0.1",
          port,
          snmp: { user, auth },
          added: "x",
        };
        const o = await observeDevice(d, cred);
        assertEquals([o.location, o.contact], ["Rack 2", "ops@example.org"]);
        assert((o.interfaces ?? 0) >= 1, "interfaces");
        const s = new SnmpSession("127.0.0.1", cred, { port });
        assert((await s.walk("1.3.6.1.2.1.2.2.1.2", 50)).length >= 1, "a walk");
      }
      const wrong = await new SnmpSession(
        "127.0.0.1",
        {
          user: "ro256",
          auth: "sha256",
          authKey: "wrong-passw",
          privKey: "priv-pass-456",
        },
        { port },
      )
        .get(["1.3.6.1.2.1.1.5.0"])
        .then(
          () => "",
          (e: unknown) => String(e),
        );
      assertStringIncludes(wrong, "wrong authentication passphrase");
      const nobody = await new SnmpSession(
        "127.0.0.1",
        {
          user: "nobody",
          auth: "sha256",
          authKey: "auth-pass-123",
          privKey: "priv-pass-456",
        },
        { port },
      )
        .get(["1.3.6.1.2.1.1.5.0"])
        .then(
          () => "",
          (e: unknown) => String(e),
        );
      assertStringIncludes(nobody, "does not know this SNMPv3 user");
    } finally {
      p.kill();
      await p.status;
      await fs.remove(dir, { recursive: true });
    }
  },
  { skip: snmpd === "" && "snmpd is not installed" },
);
