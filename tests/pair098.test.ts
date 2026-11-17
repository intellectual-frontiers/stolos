/**
 * Specs 098 and 107-pairing-and-query: pairing with a short code: the code, the signatures, the session (many machines, no expiry,
 * wrong codes per client address, the queue of approvals), and the real integrate.sh paired end to end against the PC's server, under
 * `/device/pair` (spec 103-three-ports).
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
  clientKey,
  mac,
  MAX_ADDRESSES,
  MAX_MACHINES,
  MAX_TRIES,
  newCode,
  normalizeCode,
  PairSession,
  posixScript,
  sha256Hex,
  windowsLoader,
} from "../src/archon/adopt/pair.ts";
import { MemoryPairStore, newPairRecord } from "../src/archon/adopt/pair-store.ts";
import { DEVICE_PAIR_PATH } from "../src/archon/ontology.auto.ts";
import { parseCheckIn } from "../src/archon/adopt/checkin.ts";
import { PROBE_SCRIPT, PROBE_SCRIPT_WINDOWS } from "../src/archon/adopt/probe.ts";
import { toBase64 } from "@intellectual-frontiers/commons/ts/kernel";
import { servePair, untilDelivered } from "./integrate/pair-server.ts";

const KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIexampleexampleexampleexampleexample00";
const CODE = "WDJB-MJHT";
const URL0 = "http://10.0.0.5:8080";
/** The pairing's base: every route is relative to it (spec 103-three-ports FR-003). */
const BASE = `${URL0}${DEVICE_PAIR_PATH}`;

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

const session = (o: { name?: string; decide?: boolean } = {}) => {
  const seen: string[] = [];
  const store = new MemoryPairStore(
    newPairRecord({
      code: CODE,
      fleet: "lab",
      engine: "v1.2.3",
      ...(o.name ? { name: o.name } : {}),
    }),
  );
  const s = new PairSession({
    store,
    pollMs: 10,
    nameFor: (h, rec) =>
      Promise.resolve(
        h === "alpha"
          ? { refuse: "alpha is a managed server in this fleet" }
          : {
              name: (rec.nameUsed ? undefined : rec.name) ?? h.toLowerCase().split(".")[0] ?? h,
              key: KEY,
            },
      ),
    ...(o.decide === false
      ? {}
      : {
          approve: (text) => {
            seen.push(text);
            return Promise.resolve({ ok: true, message: "adopted" });
          },
        }),
  });
  return { s, seen, store };
};

/** A POST from the client address `from`, signed with `code`. */
const post = async (s: PairSession, where: string, body: string, code = CODE, from = "10.0.0.7") =>
  await (
    await s.handle(
      new Request(`${BASE}${where}`, {
        method: "POST",
        body,
        headers: { "x-stolos-mac": await mac(code, body) },
      }),
      from,
    )
  ).text();

const NONCE = "0123456789abcdef0123456789abcdef";
/** A hello body for a hostname. */
const helloBody = (hostname: string, os = "posix") =>
  `nonce=${NONCE}\nhostname=${hostname}\nos=${os}\n`;
/** A check-in body from a hostname. */
const checkInBody = (hostname: string) => `@checkin\nv=1\nhostname=${hostname}\n`;

proves(
  ["098-pair FR-003", "098-pair FR-008", "107-pairing-and-query FR-014"],
  "098: the PC serves this engine's scripts with the pairing filled in (the Windows loader and the routes unchanged)",
  async () => {
    const { s } = session();
    const sh = await (await s.handle(new Request(BASE))).text();
    assertStringIncludes(
      sh,
      `set -- --adopt --pair '${BASE}' --fleet 'lab' --engine 'v1.2.3' "$@"`,
    );
    assertStringIncludes(sh, "--pair <url>");
    assertEquals(sh, posixScript({ url: BASE, fleet: "lab", engine: "v1.2.3" }));
    const w = await (await s.handle(new Request(`${BASE}/w`))).text();
    assertEquals(w, windowsLoader({ url: BASE, fleet: "lab", engine: "v1.2.3" }));
    assertStringIncludes(w, `'${BASE}/w.ps1'`);
    assertStringIncludes(
      w,
      "powershell.exe -NoProfile -ExecutionPolicy Bypass -File $stolosPair --adopt --pair",
    );
    assertStringIncludes(
      await (await s.handle(new Request(`${BASE}/w.ps1`))).text(),
      "--pair <url>",
    );
    assertEquals(
      await (await s.handle(new Request(`${BASE}/bin/stolos-probe.sh`))).text(),
      PROBE_SCRIPT,
    );
    assertEquals(
      await (await s.handle(new Request(`${BASE}/bin/stolos-probe.ps1`))).text(),
      PROBE_SCRIPT_WINDOWS,
    );
    assertEquals((await s.handle(new Request(`${BASE}/etc/passwd`))).status, 404);
    // Nothing is served outside /device/pair, not even the old root.
    assertEquals((await s.handle(new Request(`${URL0}/`))).status, 404);
    assertEquals((await s.handle(new Request(`${URL0}/w`))).status, 404);
  },
);

proves(
  [
    "098-pair FR-004",
    "098-pair FR-007",
    "107-pairing-and-query FR-001",
    "107-pairing-and-query FR-006",
  ],
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
    assertEquals([f["name"], f["key"]], ["alice-laptop", KEY]);
    assertEquals(f["sha256"], await sha256Hex(PROBE_SCRIPT));
    assertEquals(f["mac"], await mac(CODE, `${nonce}\n${KEY}\nalice-laptop\n${f["sha256"]}`));
    const w = await post(s, "/hello", `nonce=${nonce}\nhostname=alice-laptop.local\nos=windows\n`);
    assertStringIncludes(w, `sha256=${await sha256Hex(PROBE_SCRIPT_WINDOWS)}`);
    // The code is the session's: another machine uses it too (spec 107 FR-001), but not another one's hostname while it pairs.
    assertStringIncludes(
      await post(s, "/hello", `nonce=${nonce}\nhostname=bob-desk\n`, CODE, "10.0.0.8"),
      "ok\nname=bob-desk",
    );
    assertStringIncludes(
      await post(s, "/hello", `nonce=${nonce}\nhostname=ALICE-LAPTOP.local\n`, CODE, "10.0.0.9"),
      "no another machine called ALICE-LAPTOP.local is pairing from 10.0.0.7",
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
  ["098-pair FR-002", "107-pairing-and-query FR-004", "107-pairing-and-query FR-001"],
  "098: wrong codes cost their own address tries; the fifth refuses that address for the rest of the session, and nothing expires",
  async () => {
    const { s, store } = session();
    const body = helloBody("m");
    for (let i = 1; i < MAX_TRIES; i++) {
      assertStringIncludes(
        await post(s, "/hello", body, "AAAA-AAAA", "10.0.0.9"),
        `(${MAX_TRIES - i} tr`,
      );
    }
    assertStringIncludes(
      await post(s, "/hello", body, "AAAA-AAAA", "10.0.0.9"),
      "no that code is wrong, and this address is refused for the rest of the session",
    );
    // The address is refused on every route, whatever it sends, GET or POST; the session goes on.
    assertStringIncludes(
      await post(s, "/hello", body, CODE, "10.0.0.9"),
      "this address is refused",
    );
    assertEquals((await s.handle(new Request(BASE), "10.0.0.9")).status, 403);
    assertEquals(await s.ended(), undefined);
    // Another address is not affected, and sends the right code.
    assertStringIncludes(await post(s, "/hello", body, CODE, "10.0.0.10"), "ok\nname=m");
    assertEquals((await s.handle(new Request(BASE), "10.0.0.10")).status, 200);
    // The tries are the record's, by address (IPv4-mapped IPv6 is the same address).
    const rec = await store.read();
    assertEquals(rec?.tries, { "10.0.0.9": MAX_TRIES });
    assertEquals(clientKey("::FFFF:10.0.0.9"), "10.0.0.9");
    assertEquals(clientKey(undefined), "unknown");
    // The code has no expiry: the session answers however long it has been open (no clock is read).
    assertEquals(rec?.ended, undefined);
    assert(!("expiresAt" in (rec ?? {})), "the record has no expiry");
  },
);

proves(
  ["107-pairing-and-query FR-004"],
  "107: the record is bounded: addresses counted and machines kept have a cap",
  async () => {
    const { s, store } = session();
    // A flood of wrong signatures from many addresses: the record keeps at most MAX_ADDRESSES of them.
    await store.update((r) => {
      for (let i = 0; i < MAX_ADDRESSES; i++) r.tries[`10.1.${i >> 8}.${i & 255}`] = 1;
    });
    const before = Object.keys((await store.read())?.tries ?? {}).length;
    const flood = await post(s, "/hello", helloBody("x"), "AAAA-AAAA", "10.9.9.9");
    assertStringIncludes(flood, "refused");
    assertEquals(Object.keys((await store.read())?.tries ?? {}).length, before, "nothing grew");
    // A hostname that would be a property of the record's own object is no hostname.
    assertStringIncludes(await post(s, "/hello", helloBody("__proto__")), "no usable hostname");
    assertStringIncludes(
      await post(s, "/hello", helloBody("constructor"), CODE, "10.0.0.5"),
      "ok\nname=constructor",
    );
    assertEquals(Object.keys((await store.read())?.machines ?? {}), ["constructor"]);
    // An address already counted still counts.
    await post(s, "/hello", helloBody("x"), "AAAA-AAAA", "10.1.0.0");
    assertEquals((await store.read())?.tries["10.1.0.0"], 2);
    // The machines kept: past the cap a hello is refused with why, and one that is already there is still answered.
    const { s: s2, store: st2 } = session();
    for (let i = 0; i < MAX_MACHINES; i++) {
      assertStringIncludes(
        await post(s2, "/hello", helloBody(`m${i}`), CODE, `10.2.0.${i}`),
        "ok\n",
      );
    }
    assertEquals(Object.keys((await st2.read())?.machines ?? {}).length, MAX_MACHINES);
    assertStringIncludes(
      await post(s2, "/hello", helloBody("one-more"), CODE, "10.3.0.1"),
      `no this session already has ${MAX_MACHINES} machines`,
    );
    assertStringIncludes(await post(s2, "/hello", helloBody("m0"), CODE, "10.2.0.0"), "ok\n");
  },
);

proves(
  ["098-pair FR-006", "107-pairing-and-query FR-002", "107-pairing-and-query FR-005"],
  "098: a check-in is approved only after hello, signed, once; each machine has its own decision",
  async () => {
    const { s, seen, store } = session({ name: "alice-laptop" });
    assertStringIncludes(
      await post(s, "/checkin", checkInBody("alice-laptop")),
      "no say hello first",
    );
    await post(s, "/hello", helloBody("alice-laptop"));
    assertEquals(await post(s, "/checkin", checkInBody("alice-laptop")), "ok adopted\n");
    assertEquals(seen, [checkInBody("alice-laptop")]);
    // The session stays open: another machine pairs after the first, with the same code, and has its own prompt.
    assertEquals(await s.ended(), undefined);
    await post(s, "/hello", helloBody("bob-desk"), CODE, "10.0.0.8");
    assertEquals(
      await post(s, "/checkin", checkInBody("bob-desk"), CODE, "10.0.0.8"),
      "ok adopted\n",
    );
    assertEquals(seen.length, 2);
    const rec = await store.read();
    assertEquals(
      Object.values(rec?.machines ?? {}).map((m) => [m.name, m.stage, m.address]),
      [
        ["alice-laptop", "adopted", "10.0.0.7"],
        ["bob-desk", "adopted", "10.0.0.8"],
      ],
    );
    // The same check-in again from an adopted machine is a new pairing only after it says hello again.
    assertStringIncludes(
      await post(s, "/checkin", checkInBody("alice-laptop")),
      "no say hello first",
    );
  },
);

proves(
  ["107-pairing-and-query FR-002", "107-pairing-and-query FR-003"],
  "107: many machines at once: each has its stage (hello, installing, waiting), the check-ins wait for the person's decision, and a machine is told its own",
  async () => {
    const { s, store } = session({ decide: false });
    await post(s, "/hello", helloBody("alice-laptop"), CODE, "10.0.0.7");
    await post(s, "/hello", helloBody("bob-desk"), CODE, "10.0.0.8");
    const stage = async (id: string) => (await store.read())?.machines[id]?.stage;
    assertEquals([await stage("alice-laptop"), await stage("bob-desk")], ["hello", "hello"]);
    // A machine that fetches its probe is installing.
    await s.handle(new Request(`${BASE}/bin/stolos-probe.sh`), "10.0.0.8");
    assertEquals([await stage("alice-laptop"), await stage("bob-desk")], ["hello", "installing"]);
    // Both check in and wait; each request is held for its own machine's decision.
    const held = [
      post(s, "/checkin", checkInBody("alice-laptop"), CODE, "10.0.0.7"),
      post(s, "/checkin", checkInBody("bob-desk"), CODE, "10.0.0.8"),
    ];
    for (let i = 0; i < 200 && (await stage("bob-desk")) !== "waiting"; i++) await proc.sleep(10);
    assertEquals([await stage("alice-laptop"), await stage("bob-desk")], ["waiting", "waiting"]);
    // The person (the terminal) decides on bob first: only bob's request is answered.
    await store.update((r) => {
      const m = r.machines["bob-desk"];
      if (m) {
        m.decision = { ok: true, message: "bob-desk is adopted by the fleet lab" };
        m.stage = "adopted";
      }
    });
    assertEquals(await held[1], "ok bob-desk is adopted by the fleet lab\n");
    assertEquals((await store.read())?.machines["bob-desk"]?.delivered, true);
    assertEquals((await store.read())?.machines["alice-laptop"]?.delivered, undefined);
    await store.update((r) => {
      const m = r.machines["alice-laptop"];
      if (m) {
        m.decision = { ok: false, message: "the person at the PC did not approve it" };
        m.stage = "refused";
      }
    });
    assertEquals(await held[0], "no the person at the PC did not approve it\n");
    // A refused machine may pair again: its hello starts it over; and a session that ends tells whoever is waiting.
    assertStringIncludes(
      await post(s, "/hello", helloBody("alice-laptop"), CODE, "10.0.0.7"),
      "ok\n",
    );
    assertEquals((await store.read())?.machines["alice-laptop"]?.stage, "hello");
    const last = post(s, "/checkin", checkInBody("alice-laptop"), CODE, "10.0.0.7");
    for (let i = 0; i < 200 && (await stage("alice-laptop")) !== "waiting"; i++)
      await proc.sleep(10);
    await store.update((r) => {
      r.ended = "closed";
    });
    assertStringIncludes(await last, "no this session has ended");
    assertStringIncludes(await post(s, "/hello", helloBody("z")), "no this session has ended");
    assertEquals((await s.handle(new Request(BASE))).status, 404);
  },
);

proves(
  ["107-pairing-and-query FR-006"],
  "107: --name names the first machine only; two machines cannot have one name",
  async () => {
    const { s, store } = session({ name: "front-pc" });
    assertStringIncludes(
      await post(s, "/hello", helloBody("DESKTOP-ABC"), CODE, "10.0.0.7"),
      "name=front-pc",
    );
    assertStringIncludes(
      await post(s, "/hello", helloBody("DESKTOP-XYZ"), CODE, "10.0.0.8"),
      "name=desktop-xyz",
    );
    assertEquals((await store.read())?.nameUsed, true);
    // A third machine whose hostname gives the second's name is refused, with what to do.
    assertStringIncludes(
      await post(s, "/hello", helloBody("Desktop-XYZ.local"), CODE, "10.0.0.9"),
      "no desktop-xyz is already the name of DESKTOP-XYZ in this session",
    );
    assertEquals(Object.keys((await store.read())?.machines ?? {}).length, 2);
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
      // The session is still open for the next machine; the one that came is adopted.
      assertEquals(await srv.session.ended(), undefined);
      assertEquals(
        Object.values((await srv.store.read())?.machines ?? {}).map((m) => m.stage),
        ["adopted"],
      );
    } finally {
      ssh.close();
      srv.close();
      await fs.remove(home, { recursive: true });
    }
  },
  { skip: proc.build.os === "windows" && "integrate.sh is for Linux and macOS" },
);

proves(
  ["107-pairing-and-query FR-001", "107-pairing-and-query FR-002", "107-pairing-and-query FR-006"],
  "107: integrate.sh pairs two machines in one session at the same time, each with its own name, key and decision",
  async () => {
    const bin = await fs.makeTempDir({ prefix: "stolos-hostname-" });
    const homes = [await fs.makeTempDir(), await fs.makeTempDir()];
    // A real program: `hostname` that says another machine's name (anything with arguments is the real one's).
    await fs.writeTextFile(
      `${bin}/hostname`,
      `#!/bin/sh\n[ "$#" -eq 0 ] && { echo "$FAKE_HOSTNAME"; exit 0; }\nexec "$REAL_HOSTNAME" "$@"\n`,
      { mode: 0o755 },
    );
    const real = proc.which("hostname") ?? "/bin/hostname";
    const names: string[] = [];
    const srv = await servePair({
      code: CODE,
      key: KEY,
      onCheckIn: (t) => void names.push(/^hostname=(.*)$/m.exec(t)?.[1] ?? "?"),
    });
    const ssh = await tcp.listen({ hostname: "127.0.0.1", port: 0 });
    const pair = (i: number, hostname: string) =>
      proc.run(["sh", "-c", `curl -fsSL ${srv.url} | sh -s -- --ssh-port ${ssh.addr.port} --yes`], {
        env: {
          HOME: homes[i] ?? "",
          PATH: `${bin}:${proc.env.get("PATH") ?? "/usr/bin:/bin"}`,
          STOLOS_PAIR_CODE: CODE,
          FAKE_HOSTNAME: hostname,
          REAL_HOSTNAME: real,
        },
        clearEnv: true,
      });
    try {
      const [a, b] = await Promise.all([pair(0, "alice-laptop"), pair(1, "bob-desk")]);
      assertEquals([a.code, b.code], [0, 0], a.stdout + a.stderr + b.stdout + b.stderr);
      assertStringIncludes(a.stdout + a.stderr, "alice-laptop is adopted by the fleet lab");
      assertStringIncludes(b.stdout + b.stderr, "bob-desk is adopted by the fleet lab");
      assertEquals(names.sort(), ["alice-laptop", "bob-desk"]);
      const rec = await srv.store.read();
      assertEquals(
        Object.values(rec?.machines ?? {})
          .map((m) => `${m.name} ${m.stage}`)
          .sort(),
        ["alice-laptop adopted", "bob-desk adopted"],
      );
      for (const home of homes) {
        assertStringIncludes(
          await fs.readTextFile(`${home}/.ssh/authorized_keys`),
          `restrict ${KEY} stolos-probe@lab`,
        );
      }
    } finally {
      ssh.close();
      srv.close();
      for (const d of [bin, ...homes]) await fs.remove(d, { recursive: true });
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

proves(
  ["106-one-passphrase-speed FR-006", "107-pairing-and-query FR-003"],
  "106: a closed session says what came of it, shows each adopted machine's outcome line in calm mode, and records no failure (exit 0)",
  async () => {
    const { endPairing } = await import("../src/archon/adopt/pair-command.ts");
    const { ui } = await import("../src/archon/core/ui.ts");
    const { P } = await import("../src/archon/core/paths.ts");
    const was = ui.mode;
    const fails = (): number => ui.problems.filter((p) => p.level === "fail").length;
    const before = fails();
    const m = (name: string, stage: "adopted" | "refused" | "waiting") => ({
      hostname: name,
      name,
      key: KEY,
      address: "10.0.0.7",
      stage,
      seq: 1,
      helloAt: 0,
    });
    try {
      ui.setMode("calm");
      assert(ui.shows("outcome"), "calm shows outcome lines");
      endPairing(ui.phase("Waiting"), {
        adopted: [m("intrepid", "adopted")],
        refused: [m("bob-desk", "refused")],
        waiting: [m("front-pc", "waiting")],
      });
      assert(
        ui.outcomes.includes(`intrepid is adopted by the fleet ${P.fleetId}`),
        `the outcome line: ${ui.outcomes.join("|")}`,
      );
      assertEquals(fails(), before, "closing a session is not a failure");
      endPairing(ui.phase("Waiting"), { adopted: [], refused: [], waiting: [] });
      assertEquals(fails(), before);
    } finally {
      ui.setMode(was);
      ui.outcomes.splice(0);
      ui.problems.splice(0);
    }
  },
);

proves(
  ["107-pairing-and-query FR-014", "098-pair FR-006"],
  "107: the pairing program answers a held check-in before it exits, for a client that polls late and keeps no connection (Windows CI)",
  async () => {
    // A slow poll (as on a busy Windows runner): the program must not exit 500 ms after the approval while the answer is still due.
    const srv = await servePair({ code: CODE, key: KEY, fleet: "ci", pollMs: 1200 });
    const hdr = async (body: string) => ({
      "content-type": "text/plain",
      connection: "close",
      "x-stolos-mac": await mac(CODE, body),
    });
    try {
      const hello = `nonce=${"ab".repeat(16)}\nhostname=RUNNERVM1\nos=windows\n`;
      const h = await fetch(`${srv.url}/hello`, {
        method: "POST",
        body: hello,
        headers: await hdr(hello),
      });
      assertEquals((await h.text()).split("\n")[0], "ok");
      const text = "@checkin\nv=1\nfleet=ci\nhostname=RUNNERVM1\n";
      const closed = untilDelivered(srv);
      let over = false;
      void closed.then(() => (over = true));
      const res = await fetch(`${srv.url}/checkin`, {
        method: "POST",
        body: text,
        headers: await hdr(text),
        signal: AbortSignal.timeout(20000),
      });
      assertEquals(res.status, 200);
      assertEquals(res.headers.get("content-type")?.startsWith("text/plain"), true);
      assertStringIncludes(await res.text(), "ok runnervm1 is adopted by the fleet ci");
      assert(!over, "the program was still serving when the answer was sent");
      await closed;
    } finally {
      srv.close();
    }
  },
);
