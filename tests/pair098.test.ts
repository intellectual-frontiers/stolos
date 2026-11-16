/**
 * Spec 098: pairing with a short code: the code, the signatures, the session, and the real
 * integrate.sh paired end to end against the PC's server.
 *
 * @module
 */

import {
  assert,
  assertEquals,
  assertMatch,
  assertStringIncludes,
  proves,
} from "@intellectual-frontiers/commons/ts/runtime/test";
import { fs, proc, tcp } from "@intellectual-frontiers/commons/ts/runtime";
import {
  CODE_ALPHABET,
  CODE_TTL_MS,
  mac,
  MAX_TRIES,
  newCode,
  normalizeCode,
  PairSession,
  posixScript,
  sha256Hex,
  windowsLoader,
} from "../src/archon/adopt/pair.ts";
import { parseCheckIn } from "../src/archon/adopt/checkin.ts";
import { PROBE_SCRIPT, PROBE_SCRIPT_WINDOWS } from "../src/archon/adopt/probe.ts";
import { toBase64 } from "@intellectual-frontiers/commons/ts/kernel";
import { servePair } from "./integrate/pair-server.ts";

const KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIexampleexampleexampleexampleexample00";
const CODE = "WDJB-MJHT";
const URL0 = "http://10.0.0.5:7457";

proves(["098-pair FR-002"], "098: a code is 8 characters without look-alikes, two groups", () => {
  for (let i = 0; i < 200; i++) {
    const c = newCode();
    assertMatch(c, /^[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$/);
  }
  assert(!/[01OIL]/.test(CODE_ALPHABET), "no look-alikes");
  // The sampler drops bytes at or past the largest multiple of the alphabet: every character
  // is equally likely. A source of only those bytes, then one usable one, still makes a code.
  let n = 0;
  const c = newCode((k) => {
    n++;
    return new Uint8Array(k).fill(n < 3 ? 255 : 0);
  });
  assertEquals(c, "AAAA-AAAA");
  assertEquals(normalizeCode(" wdjb mjht "), "WDJBMJHT");
  assertEquals(normalizeCode("wdjb-mjht"), normalizeCode(CODE));
});

proves(
  ["098-pair FR-004"],
  "098: the signature is HMAC-SHA256 under the normalized code, as openssl computes it",
  async () => {
    const m = await mac("wdjb-mjht", "nonce=00\n");
    assertEquals(m, await mac(CODE, "nonce=00\n"));
    const r = await proc.run(["openssl", "dgst", "-sha256", "-hmac", "WDJBMJHT"], {
      input: "nonce=00\n",
    });
    assertEquals(r.stdout.trim().replace(/^.*= */, ""), m);
  },
  { skip: proc.build.os === "windows" && "openssl is a Linux and macOS tool here" },
);

const session = (o: { now?: () => number; name?: string } = {}) => {
  const seen: string[] = [];
  const s = new PairSession({
    fleet: "lab",
    engine: "v1.2.3",
    url: URL0,
    code: CODE,
    ...(o.now ? { now: o.now } : {}),
    nameFor: (h) =>
      Promise.resolve(
        h === "alpha"
          ? { refuse: "alpha is a managed server in this fleet" }
          : { name: o.name ?? h, key: KEY },
      ),
    approve: (text) => {
      seen.push(text);
      return Promise.resolve({ ok: true, message: "adopted" });
    },
  });
  return { s, seen };
};

const post = async (s: PairSession, where: string, body: string, code = CODE) =>
  await (
    await s.handle(
      new Request(`${URL0}${where}`, {
        method: "POST",
        body,
        headers: { "x-stolos-mac": await mac(code, body) },
      }),
    )
  ).text();

proves(
  ["098-pair FR-003", "098-pair FR-008"],
  "098: the PC serves this engine's scripts with the pairing filled in",
  async () => {
    const { s } = session();
    const sh = await (await s.handle(new Request(`${URL0}/`))).text();
    assertStringIncludes(
      sh,
      `set -- --adopt --pair '${URL0}' --fleet 'lab' --engine 'v1.2.3' "$@"`,
    );
    assertStringIncludes(sh, "--pair <url>");
    assertEquals(sh, posixScript({ url: URL0, fleet: "lab", engine: "v1.2.3" }));
    const w = await (await s.handle(new Request(`${URL0}/w`))).text();
    assertEquals(w, windowsLoader({ url: URL0, fleet: "lab", engine: "v1.2.3" }));
    assertStringIncludes(
      w,
      "powershell.exe -NoProfile -ExecutionPolicy Bypass -File $stolosPair --adopt --pair",
    );
    assertStringIncludes(
      await (await s.handle(new Request(`${URL0}/w.ps1`))).text(),
      "--pair <url>",
    );
    assertEquals(
      await (await s.handle(new Request(`${URL0}/bin/stolos-probe.sh`))).text(),
      PROBE_SCRIPT,
    );
    assertEquals(
      await (await s.handle(new Request(`${URL0}/bin/stolos-probe.ps1`))).text(),
      PROBE_SCRIPT_WINDOWS,
    );
    assertEquals((await s.handle(new Request(`${URL0}/etc/passwd`))).status, 404);
  },
);

proves(
  ["098-pair FR-004", "098-pair FR-007"],
  "098: hello is answered with the name, key and probe checksum, signed over the nonce",
  async () => {
    const { s } = session();
    const nonce = "0123456789abcdef0123456789abcdef";
    const a = await post(s, "/hello", `nonce=${nonce}\nhostname=alice-laptop.local\nos=posix\n`);
    const lines = a.split("\n");
    assertEquals(lines[0], "ok");
    const f: Record<string, string> = {};
    for (const l of lines.slice(1)) {
      const i = l.indexOf("=");
      if (i > 0) f[l.slice(0, i)] = l.slice(i + 1);
    }
    assertEquals([f["name"], f["key"]], ["alice-laptop.local", KEY]);
    assertEquals(f["sha256"], await sha256Hex(PROBE_SCRIPT));
    assertEquals(f["mac"], await mac(CODE, `${nonce}\n${KEY}\nalice-laptop.local\n${f["sha256"]}`));
    const w = await post(s, "/hello", `nonce=${nonce}\nhostname=alice-laptop.local\nos=windows\n`);
    assertStringIncludes(w, `sha256=${await sha256Hex(PROBE_SCRIPT_WINDOWS)}`);
    // Another machine cannot use the same code.
    assertStringIncludes(
      await post(s, "/hello", `nonce=${nonce}\nhostname=bob-desk\n`),
      "no this code is already in use by alice-laptop.local",
    );
    // A managed server's name is refused before anything is installed.
    const { s: s2 } = session();
    assertStringIncludes(
      await post(s2, "/hello", `nonce=${nonce}\nhostname=alpha\n`),
      "no alpha is a managed server",
    );
    assertStringIncludes(
      await post(s2, "/hello", "nonce=zz\nhostname=x\n"),
      "no the request has no nonce",
    );
  },
);

proves(
  ["098-pair FR-002"],
  "098: wrong codes cost tries; the fifth ends the pairing; the code expires",
  async () => {
    const { s } = session();
    const body = "nonce=0123456789abcdef\nhostname=m\n";
    for (let i = 1; i < MAX_TRIES; i++) {
      assertStringIncludes(await post(s, "/hello", body, "AAAA-AAAA"), `(${MAX_TRIES - i} tr`);
    }
    assertStringIncludes(await post(s, "/hello", body, "AAAA-AAAA"), "the pairing has ended");
    assertEquals(s.ended, "tries");
    assertStringIncludes(await post(s, "/hello", body), "this pairing has ended");
    let t = 1_000;
    const { s: s2 } = session({ now: () => t });
    t += CODE_TTL_MS + 1;
    assertStringIncludes(await post(s2, "/hello", body), "the code has expired");
    assertEquals(await s2.done(), "expired");
  },
);

proves(
  ["098-pair FR-006"],
  "098: a check-in is approved only after hello, signed, once",
  async () => {
    const { s, seen } = session({ name: "alice-laptop" });
    assertStringIncludes(await post(s, "/checkin", "@checkin\nv=1\n"), "no say hello first");
    await post(s, "/hello", "nonce=0123456789abcdef\nhostname=alice-laptop\n");
    assertEquals(await post(s, "/checkin", "@checkin\nv=1\n"), "ok adopted\n");
    assertEquals(seen, ["@checkin\nv=1\n"]);
    assertEquals(await s.done(), "paired");
    assertStringIncludes(await post(s, "/checkin", "@checkin\nv=1\n"), "this pairing has ended");
  },
);

proves(
  ["098-pair FR-001", "098-pair FR-005", "098-pair FR-006"],
  "098: integrate.sh pairs end to end: the code, the signed key, the probe, the check-in",
  async () => {
    const home = await fs.makeTempDir();
    let got = "";
    const srv = await servePair({ code: CODE, key: KEY, onCheckIn: (t) => void (got = t) });
    // Something listens on --ssh-port, so the script sees SSH on and only writes in the account.
    const ssh = await tcp.listen({ hostname: "127.0.0.1", port: 0 });
    const run = (code: string) =>
      proc.run(["sh", "-c", `curl -fsSL ${srv.url} | sh -s -- --ssh-port ${ssh.addr.port} --yes`], {
        env: {
          HOME: home,
          PATH: proc.env.get("PATH") ?? "/usr/bin:/bin",
          STOLOS_PAIR_CODE: code,
        },
        clearEnv: true,
      });
    try {
      const bad = await run("ZZZZ-ZZZZ");
      assert(bad.code !== 0, "a wrong code changes nothing");
      assertStringIncludes(bad.stdout + bad.stderr, "that code is wrong");
      assertEquals(fs.readDirSync(home).length, 0, "nothing was written");
      const ok = await run("wdjb mjht");
      const out = ok.stdout + ok.stderr;
      assertEquals(ok.code, 0, out);
      assertStringIncludes(out, "is adopted by the fleet lab");
      assertStringIncludes(
        await fs.readTextFile(`${home}/.ssh/authorized_keys`),
        `restrict ${KEY} stolos-probe@lab`,
      );
      assertEquals(await fs.readTextFile(`${home}/.local/bin/stolos-probe`), PROBE_SCRIPT);
      const ci = parseCheckIn(`stolos1:${toBase64(new TextEncoder().encode(got))}`);
      assertEquals([ci.fleet, ci.kinds, ci.port], ["lab", ["adopt"], ssh.addr.port]);
      assertEquals(ci.observed?.probe, "2");
      assertEquals(srv.session.ended, "paired");
    } finally {
      ssh.close();
      srv.close();
      await fs.remove(home, { recursive: true });
    }
  },
  { skip: proc.build.os === "windows" && "integrate.sh is for Linux and macOS" },
);

proves(
  ["098-pair FR-010"],
  "098: stolos mesh lists the choices without preferring one, and this PC's mesh addresses",
  async () => {
    const { MESH_OPTIONS, isCgnat, meshAddresses, meshGuide } =
      await import("../src/archon/adopt/mesh.ts");
    const names = MESH_OPTIONS.map((o) => o.name);
    for (const n of ["Tailscale", "Headscale", "NetBird", "ZeroTier", "Nebula", "WireGuard"]) {
      assert(names.includes(n), n);
    }
    assert(isCgnat("100.64.0.5") && isCgnat("100.127.1.1") && !isCgnat("100.128.0.1"));
    const found = meshAddresses([
      { name: "eth0", family: "IPv4", address: "10.0.0.5" },
      { name: "tailscale0", family: "IPv4", address: "100.100.1.2" },
      { name: "ztabc123", family: "IPv4", address: "10.147.17.3" },
      { name: "wg0", family: "IPv6", address: "fd00::1" },
    ]);
    assertEquals(
      found.map((f) => f.address),
      ["100.100.1.2", "10.147.17.3"],
    );
    const g = meshGuide(found);
    assertStringIncludes(g, "bun run stolos pair --address 100.100.1.2");
    assertStringIncludes(g, "Stolos installs no network product");
    assertStringIncludes(meshGuide([]), "This PC has no mesh address yet");
  },
);
