/**
 * Specs 103-three-ports and 107-pairing-and-query: the controller opens three ports (UDP 69, TCP 8080, TCP 443). The ports are the ontology's; pairing is
 * `/device/pair`, answered by two doors (the boot server's HTTP, the console's TLS handler) from one handler over one short-lived
 * file that holds a session of many machines (no expiry, wrong codes per client address, closed by Ctrl+C); the console has no 8443 fallback; a scan of `src/` fails on a socket opened anywhere not on the allow-list.
 *
 * @module
 */

import {
  assert,
  assertEquals,
  assertStringIncludes,
  proves,
} from "@intellectual-frontiers/commons/ts/runtime/test";
import { fs, path, proc, serve, tcp } from "@intellectual-frontiers/commons/ts/runtime";
import { CODE_LISTS } from "../ontology/stolos/mod.ts";
import {
  DEVICE_PAIR_PATH,
  DEVICE_PATHS,
  DOOR_LISTENERS,
  LISTENER_KINDS,
  LISTENERS,
  PAIRING_DOORS,
} from "../src/archon/ontology.auto.ts";
import {
  choosePort,
  firewallRule,
  isStandard,
  outsideStandardNote,
  standardPort,
  standardPortsText,
  standardProtocol,
} from "../src/archon/core/listeners.ts";
import { BOOT_PORT } from "../src/archon/core/net.ts";
import { SECRETS } from "../src/archon/core/secrets.ts";
import { secretFor } from "../src/archon/model/secret-inventory.ts";
import { mac, MAX_TRIES, PairSession } from "../src/archon/adopt/pair.ts";
import {
  FilePairStore,
  MemoryPairStore,
  newPairRecord,
  type PairRecord,
} from "../src/archon/adopt/pair-store.ts";
import { devicePairHandler, pairNameFor } from "../src/archon/adopt/pair-service.ts";
import {
  findDoors,
  liveView,
  pairInstructions,
  runPairing,
  sessionStatus,
  SCRIPT_START,
  startPairOnly,
} from "../src/archon/adopt/pair-command.ts";
import { PROBE_SCRIPT } from "../src/archon/adopt/probe.ts";
import { handler as bootHandler, serve as bootServe } from "../src/archon-boot/server.ts";
import { HTTPS_PORT } from "../src/archon/access/tls.ts";
import * as tlsModule from "../src/archon/access/tls.ts";
import { serveTls } from "../src/archon/access/https.ts";
import {
  bindProblem,
  holderCommand,
  listenRefusal,
  parseLsof,
  parseSs,
  parseWindows,
  portHolder,
} from "../src/archon/access/holder.ts";
import { accessDoctor } from "../src/archon/access/doctor.ts";
import type { ConsoleRemote } from "../src/archon/console/stolos-server.ts";
import type { RemoteAccess } from "../src/archon/access/service.ts";
import { fakeConsole } from "./console/serve-stolos.ts";

const KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIexampleexampleexampleexampleexample00";
const CODE = "WDJB-MJHT";
const POSIX_ONLY = proc.build.os === "windows" && "integrate.sh is for Linux and macOS";

// ------------------------------------------------------------------------------ FR-001, FR-002: the ontology's ports

proves(
  ["103-three-ports FR-001", "103-three-ports FR-002"],
  "103: the three ports are the ontology's, and the engine's defaults come from it",
  () => {
    assertEquals([...LISTENER_KINDS], ["boot-tftp", "boot-http", "console-https"]);
    assertEquals(LISTENERS, {
      "boot-tftp": { protocol: "udp", port: 69 },
      "boot-http": { protocol: "tcp", port: 8080 },
      "console-https": { protocol: "tcp", port: 443 },
    });
    // What the generated file says is what the ontology individuals state (not a copy of it).
    for (const kind of LISTENER_KINDS) {
      const i = CODE_LISTS.ListenerKind.list[kind] as unknown as {
        values: { port: number; protocol: string; notation: string };
      };
      assertEquals(
        [i.values.notation, i.values.protocol, i.values.port],
        [kind, LISTENERS[kind].protocol, LISTENERS[kind].port],
      );
      assertEquals(standardPort(kind), LISTENERS[kind].port);
      assertEquals(standardProtocol(kind), LISTENERS[kind].protocol);
    }
    assertEquals(BOOT_PORT, standardPort("boot-http"));
    assertEquals(HTTPS_PORT, standardPort("console-https"));
    assertEquals(standardPortsText(), "UDP 69, TCP 8080, TCP 443");
    // A port is standard, or an explicit choice that says so and carries its own rule.
    assertEquals(choosePort("boot-http", undefined), { port: 8080, explicit: false });
    assertEquals(choosePort("boot-http", 8080), { port: 8080, explicit: false });
    assertEquals(choosePort("boot-http", 9090), { port: 9090, explicit: true });
    assert(isStandard("udp", 69) && isStandard("tcp", 443) && !isStandard("tcp", 69));
    assert(!isStandard("tcp", 7457) && !isStandard("tcp", 8443));
    assertStringIncludes(outsideStandardNote("tcp", 9090), "outside the three standard ports");
    assertStringIncludes(firewallRule("windows", "tcp", 9090, "pair"), "-LocalPort 9090");
    assertStringIncludes(firewallRule("linux", "tcp", 9090, "pair"), "ufw allow from");
    // The doors are on two of the three; the device path is pairing's.
    assertEquals([...PAIRING_DOORS], ["lan-http", "tls"]);
    assertEquals(DOOR_LISTENERS, {
      "lan-http": { onListener: "boot-http" },
      tls: { onListener: "console-https" },
    });
    assertEquals(DEVICE_PATHS.pair.pathPrefix, "/device/pair");
    assertEquals(DEVICE_PAIR_PATH, "/device/pair");
  },
);

// ------------------------------------------------------------------------------ FR-011: the guard

/** A file allowed to open a socket, and why; `standard` files choose a default port, so they take it from core/listeners.ts. */
interface Allowed {
  file: string;
  why: string;
  standard?: true;
}

/** Every file of `src/` that opens a socket, with the allow-list's reason: a new listener elsewhere fails the scan. */
const ALLOW: readonly Allowed[] = [
  {
    file: "src/archon/core/passphrase.ts",
    why: "the passphrase broker of one command (spec 106-one-passphrase-speed FR-002): loopback only, an ephemeral port chosen by the system, a token made for the run, gone when the command ends; not one of the three ports",
  },
  {
    file: "src/archon-boot/http.ts",
    why: "the boot server's HTTP listener (door A of pairing too): its default port is the ontology's boot-http",
    standard: true,
  },
  {
    file: "src/archon-boot/tftp.ts",
    why: "the boot server's TFTP: its default port is the ontology's boot-tftp; the per-transfer sockets bind(0), an ephemeral port as TFTP requires",
    standard: true,
  },
  {
    file: "src/archon-boot/server.ts",
    why: "serve() hands the caller's port to archon-boot/http.ts",
  },
  {
    file: "src/archon-boot/main.ts",
    why: "boot serve: its ports come from choosePort (the ontology's, or the person's explicit --port and --tftp-port)",
    standard: true,
  },
  {
    file: "src/archon-boot/doctor.ts",
    why: "boot doctor binds a port and lets go at once, to learn whether it is free",
  },
  {
    file: "src/archon/access/holder.ts",
    why: "binds a port and lets go at once, to learn whether the console may have it",
  },
  {
    file: "src/archon/access/https.ts",
    why: "the console's TLS listener (door B of pairing): its default port is the ontology's console-https",
    standard: true,
  },
  {
    file: "src/archon/access/launch.ts",
    why: "starts the TLS listener on choosePort's port: 443, or the person's explicit --lan-port",
    standard: true,
  },
  {
    file: "src/archon/adopt/pair-command.ts",
    why: "stolos pair's pair-only server on the boot server's port, when boot serve is not running",
    standard: true,
  },
  {
    file: "src/archon/console/stolos-launch.ts",
    why: "the console's own listener: 127.0.0.1 only (loopback)",
  },
  {
    file: "src/archon/clients/commands.ts",
    why: "the clients' console: 127.0.0.1 only (loopback)",
  },
  {
    file: "src/archon/web/serve.ts",
    why: "a server's own web front: loopback, behind Traefik",
  },
];

/** The text of a source file without its comments, so a mention of a call is not a call. */
function code(text: string): string {
  return text
    .replace(/\r/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((l) => l.replace(/^\s*\/\/.*$/, ""))
    .join("\n");
}

/** Why a file opens a socket (what in it does), or undefined where it does not. */
function opens(text: string): string | undefined {
  const t = code(text);
  const direct: readonly [RegExp, string][] = [
    [/\btcp\.listen\(/, "tcp.listen"],
    [/\blistenTls\(/, "listenTls"],
    [/\bcreateServer\(/, "createServer"],
    [/\.listen\(/, ".listen("],
    [/\b(serveTls|serveTftp|startPairOnly)\(/, "a listener of the engine"],
  ];
  for (const [re, what] of direct) if (re.test(t)) return what;
  // dgram: a socket that binds a fixed port (bind(0) is an ephemeral one).
  if (/\bcreateSocket\(/.test(t) && /\.bind\(\s*(?!0\s*[,)])/.test(t)) return "dgram bind";
  // The runtime's serve(), or the engine's own listen() and serve().
  const imports = (name: string, from: RegExp): boolean =>
    new RegExp(
      `import\\s*(?:type\\s*)?\\{[^}]*\\b${name}\\b[^}]*\\}\\s*from\\s*"[^"]*${from.source}"`,
    ).test(t);
  if (imports("serve", /commons\/ts\/runtime/) && /\bserve\(/.test(t)) return "serve()";
  if (imports("listen", /http\.ts/) && /\blisten\(/.test(t)) return "listen()";
  if (imports("serve", /\.\/server\.ts/) && /\bserve\(/.test(t)) return "boot serve()";
  return undefined;
}

/** The files of `root/src` that open a socket and are not allowed, as `file: what`; and the allowed that do not. */
async function scan(
  root: string,
  allow: readonly Allowed[],
): Promise<{ offenders: string[]; stale: string[]; unstandard: string[] }> {
  const found = new Map<string, string>();
  for (const rel of await fs.walkFiles(path.join(root, "src"))) {
    const file = `src/${rel.replace(/\\/g, "/")}`;
    // Generated files carry other files' text (the engine's docs and sources) as data.
    if (!file.endsWith(".ts") || file.endsWith(".auto.ts") || file.endsWith("/logos.ts")) continue;
    const what = opens(await fs.readTextFile(path.join(root, file)));
    if (what) found.set(file, what);
  }
  const allowed = new Set(allow.map((a) => a.file));
  const offenders = [...found].filter(([f]) => !allowed.has(f)).map(([f, w]) => `${f}: ${w}`);
  const stale = allow.filter((a) => !found.has(a.file)).map((a) => a.file);
  const unstandard: string[] = [];
  for (const a of allow) {
    if (a.standard && found.has(a.file)) {
      const text = await fs.readTextFile(path.join(root, a.file));
      if (!/core\/listeners\.ts"/.test(text)) unstandard.push(a.file);
    }
  }
  return { offenders, stale, unstandard };
}

proves(
  ["103-three-ports FR-011"],
  "103: no file of src/ opens a socket unless the allow-list says why; listeners take their default from the ontology",
  async () => {
    const r = await scan(proc.cwd(), ALLOW);
    assertEquals(
      r.offenders,
      [],
      "a new listener: add it to the allow-list with its reason, or serve it as a route",
    );
    assertEquals(
      r.stale,
      [],
      "an allow-listed file that no longer opens a socket: remove its entry",
    );
    assertEquals(r.unstandard, [], "a listener's default port must come from core/listeners.ts");
    for (const a of ALLOW) assert(a.why.length > 20, `${a.file} has no reason`);
  },
);

proves(
  ["103-three-ports FR-011"],
  "103: the guard fails on a fake new listener (a temporary tree)",
  async () => {
    const root = await fs.makeTempDir({ prefix: "ports103-" });
    try {
      const put = async (rel: string, text: string): Promise<void> => {
        await fs.ensureDir(path.dirname(path.join(root, rel)));
        await fs.writeTextFile(path.join(root, rel), text);
      };
      await put(
        "src/ok/quiet.ts",
        "// a comment that says tcp.listen({ port: 1 }) opens nothing\nexport const x = 1;\n",
      );
      await put(
        "src/rogue/server.ts",
        'import { tcp } from "@intellectual-frontiers/commons/ts/runtime";\nawait tcp.listen({ port: 9999, hostname: "0.0.0.0" });\n',
      );
      await put(
        "src/rogue/udp.ts",
        'import dgram from "node:dgram";\nconst s = dgram.createSocket("udp4");\ns.bind(5353);\n',
      );
      await put(
        "src/fine/transfer.ts",
        'import dgram from "node:dgram";\nconst s = dgram.createSocket("udp4");\ns.bind(0);\n',
      );
      await put(
        "src/rogue/web.ts",
        'import { serve } from "@intellectual-frontiers/commons/ts/runtime";\nawait serve({ port: 8000 }, () => new Response("hi"));\n',
      );
      await put(
        "src/rogue/node.ts",
        'import { createServer } from "node:http";\ncreateServer(() => {}).listen(80);\n',
      );
      await put("src/gen/data.auto.ts", 'export const t = "server.listen(1)";\n');
      const bad = await scan(root, []);
      assertEquals(bad.offenders.map((o) => o.split(":")[0]).sort(), [
        "src/rogue/node.ts",
        "src/rogue/server.ts",
        "src/rogue/udp.ts",
        "src/rogue/web.ts",
      ]);
      // Allowed with a reason: no offender; an entry for a file that opens nothing is stale; a default port not from the ontology is named.
      const ok = await scan(root, [
        {
          file: "src/rogue/server.ts",
          why: "a fake listener, allowed for this test",
          standard: true,
        },
        { file: "src/rogue/udp.ts", why: "a fake socket, allowed for this test" },
        { file: "src/rogue/web.ts", why: "a fake server, allowed for this test" },
        { file: "src/rogue/node.ts", why: "a fake server, allowed for this test" },
        { file: "src/ok/quiet.ts", why: "does nothing, so its entry is stale" },
      ]);
      assertEquals(ok.offenders, []);
      assertEquals(ok.stale, ["src/ok/quiet.ts"]);
      assertEquals(ok.unstandard, ["src/rogue/server.ts"]);
    } finally {
      await fs.remove(root, { recursive: true });
    }
  },
);

proves(
  ["103-three-ports FR-001", "103-three-ports FR-012"],
  "103: no 7457 and no 8443 anywhere in the engine's sources, and the guides say three ports, two doors, /device/pair",
  async () => {
    const hits: string[] = [];
    for (const rel of await fs.walkFiles("src")) {
      const file = `src/${rel.replace(/\\/g, "/")}`;
      if (!file.endsWith(".ts") || file.endsWith(".auto.ts") || file.endsWith("/logos.ts"))
        continue;
      const text = await fs.readTextFile(file);
      for (const old of ["7457", "8443"]) if (text.includes(old)) hits.push(`${file}: ${old}`);
    }
    assertEquals(hits, []);
    const guide = async (f: string): Promise<string> => await fs.readTextFile(f);
    const adopt = await guide("src/archon/adopt/mod.ts");
    assertStringIncludes(adopt, "/device/pair");
    assertStringIncludes(adopt, "Three ports, two doors");
    assertStringIncludes(adopt, "TCP 8080");
    const boot = await guide("src/archon-boot/mod.ts");
    assertStringIncludes(boot, "The three ports (constitution Article 29)");
    assertStringIncludes(boot, "**UDP 69**");
    const access = await guide("src/archon/access/mod.ts");
    assertStringIncludes(access, "Port 443 only");
    assertStringIncludes(access, "--lan-port");
    const constitution = await guide(".specify/memory/constitution.md");
    assertStringIncludes(constitution, "## Article 29: The Controller Opens Three Ports");
  },
);

// ------------------------------------------------------------------------------ a pairing's helpers

const hostLine = (hostname: string): string =>
  `nonce=0123456789abcdef0123456789abcdef\nhostname=${hostname}\nos=posix\n`;

const post = async (
  s: PairSession,
  base: string,
  where: string,
  body: string,
  code = CODE,
  from = "10.0.0.7",
) =>
  await (
    await s.handle(
      new Request(`${base}${DEVICE_PAIR_PATH}${where}`, {
        method: "POST",
        body,
        headers: { "x-stolos-mac": await mac(code, body) },
      }),
      from,
    )
  ).text();

const session = (store: FilePairStore | MemoryPairStore) =>
  new PairSession({
    store,
    pollMs: 10,
    nameFor: (h) => Promise.resolve({ name: h.split(".")[0] ?? h, key: KEY }),
  });

const fresh = (o: { code?: string; name?: string } = {}): PairRecord =>
  newPairRecord({
    code: o.code ?? CODE,
    fleet: "lab",
    engine: "v1.2.3",
    ...(o.name ? { name: o.name } : {}),
  });

/** A folder for a pairing file, removed afterwards; the file is where the secrets folder would put it. */
async function inTemp<T>(f: (file: string, dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.makeTempDir({ prefix: "ports103-" });
  try {
    return await f(path.join(dir, "pair", "pairing"), dir);
  } finally {
    await fs.remove(dir, { recursive: true });
  }
}

// ------------------------------------------------------------------------------ FR-006, FR-007: the shared state

proves(
  [
    "103-three-ports FR-006",
    "103-three-ports FR-007",
    "107-pairing-and-query FR-004",
    "107-pairing-and-query FR-005",
  ],
  "103: two sessions over one file count wrong tries together per address, and keep every machine that says hello, over either door",
  async () => {
    await inTemp(async (file) => {
      const a = session(new FilePairStore(file));
      const b = session(new FilePairStore(file));
      await new FilePairStore(file).create(fresh());
      // Three wrong through one door, two through the other: the fifth refuses that address, for both doors.
      const wrong = (s: PairSession, from = "10.0.0.9") =>
        post(s, "http://10.0.0.5:8080", "/hello", hostLine("m"), "AAAA-AAAA", from);
      for (const s of [a, a, a]) assertStringIncludes(await wrong(s), "that code is wrong");
      assertStringIncludes(await wrong(b), "(1 try left)");
      assertStringIncludes(await wrong(b), "this address is refused for the rest of the session");
      assertEquals((await new FilePairStore(file).read())?.tries, { "10.0.0.9": MAX_TRIES });
      assertStringIncludes(
        await post(a, "https://stolos.lab.example.net", "/hello", hostLine("m"), CODE, "10.0.0.9"),
        "this address is refused",
      );
      // The session is not over, and another address is not affected.
      assertEquals(await a.ended(), undefined);
      assert(
        (
          await post(a, "https://stolos.lab.example.net", "/hello", hostLine("m"), CODE, "10.0.0.8")
        ).startsWith("ok\n"),
      );
      // Concurrently, from both doors and one address: never more than the limit is counted.
      await new FilePairStore(file).create(fresh());
      await Promise.all([a, b, a, b, a, b, a, b].map((s) => wrong(s)));
      assertEquals((await new FilePairStore(file).read())?.tries, { "10.0.0.9": MAX_TRIES });
      // Many machines, over either door, even when they say hello at once: every one is kept, with its own address.
      await new FilePairStore(file).create(fresh());
      const both = await Promise.all([
        post(a, "http://10.0.0.5:8080", "/hello", hostLine("alice-laptop"), CODE, "10.0.0.7"),
        post(b, "https://stolos.lab.example.net", "/hello", hostLine("bob-desk"), CODE, "10.0.0.8"),
        post(b, "http://10.0.0.5:8080", "/hello", hostLine("front-pc"), CODE, "10.0.0.6"),
      ]);
      assertEquals(
        both.map((x) => x.split("\n")[0]),
        ["ok", "ok", "ok"],
        both.join("|"),
      );
      const rec = await new FilePairStore(file).read();
      assertEquals(
        Object.values(rec?.machines ?? {})
          .map((m) => `${m.name}@${m.address}:${m.stage}`)
          .sort(),
        ["alice-laptop@10.0.0.7:hello", "bob-desk@10.0.0.8:hello", "front-pc@10.0.0.6:hello"],
      );
      assertEquals(rec?.v, 2);
      // A machine may say hello again, from the other door.
      assert(
        (
          await post(
            b,
            "http://10.0.0.5:8080",
            "/hello",
            hostLine("alice-laptop"),
            CODE,
            "10.0.0.7",
          )
        ).startsWith("ok\n"),
      );
    });
  },
);

proves(
  ["103-three-ports FR-007"],
  "103: the memory store changes one record at a time and copies it; none means no pairing",
  async () => {
    const empty = new MemoryPairStore();
    assertEquals(await empty.read(), undefined);
    assertEquals(await empty.update(() => 1), undefined);
    const store = new MemoryPairStore(fresh());
    const got = await store.update((r) => (r.tries["10.0.0.7"] = 1));
    assertEquals(got?.result, 1);
    const copy = await store.read();
    assert(copy);
    copy.tries = { "10.0.0.7": 99 };
    assertEquals((await store.read())?.tries, { "10.0.0.7": 1 }, "a read is a copy");
    assert(!("expiresAt" in copy), "a session has no expiry");
    await store.remove();
    assertEquals(await store.read(), undefined);
  },
);

proves(
  ["103-three-ports FR-006"],
  "103: the pairing's file is owner only, is the secrets folder's ephemeral file, and holds what the doors and the terminal share, with no expiry",
  async () => {
    // The inventory lists the file and its lock and temporary siblings as ephemeral: the vault never backs them up.
    const rel = (p: string) =>
      p.slice(path.dirname(path.dirname(SECRETS.pairing)).length + 1).replace(/\\/g, "/");
    for (const p of [SECRETS.pairing, `${SECRETS.pairing}-lock`, `${SECRETS.pairing}-tmp`]) {
      const ref = secretFor(rel(p));
      assert(ref, `not in the inventory: ${rel(p)}`);
      assertEquals(
        [ref.ephemeral, ref.holder, ref.spec],
        [true, "boot-machine", "103-three-ports"],
      );
    }
    await inTemp(async (file) => {
      const store = new FilePairStore(file);
      await store.create(fresh({ name: "alice-laptop" }));
      if (proc.build.os !== "windows") {
        assertEquals((fs.statSync(file).mode ?? 0) & 0o777, 0o600, "the file is owner only");
        assertEquals(
          (fs.statSync(path.dirname(file)).mode ?? 0) & 0o777,
          0o700,
          "so is its folder",
        );
      }
      const door = session(new FilePairStore(file));
      await post(door, "http://10.0.0.5:8080", "/hello", hostLine("alice-laptop"));
      const rec = await store.read();
      const m = rec?.machines["alice-laptop"];
      assertEquals(
        [rec?.code, rec?.fleet, rec?.name, rec?.tries, m?.name, m?.key, m?.address, m?.stage],
        [CODE, "lab", "alice-laptop", {}, "alice-laptop", KEY, "10.0.0.7", "hello"],
      );
      assert(!("expiresAt" in (rec ?? {})), "the record has no expiry");
      assert(!(await fs.exists(`${file}-lock`)), "no lock is left behind");
      assert(!(await fs.exists(`${file}-tmp`)), "no temporary file is left behind");
      // Changes under the lock are never lost: many at once, each counted.
      await Promise.all(
        Array.from({ length: 12 }, () =>
          new FilePairStore(file).update(
            (r) => (r.tries["10.0.0.9"] = (r.tries["10.0.0.9"] ?? 0) + 1),
          ),
        ),
      );
      assertEquals((await store.read())?.tries, { "10.0.0.9": 12 });
    });
  },
);

/** Start a session and wait until its record is in the file; the interrupt that closes it. */
async function open(
  store: FilePairStore,
  r: Partial<Parameters<typeof runPairing>[0]> & Pick<Parameters<typeof runPairing>[0], "approve">,
) {
  let interrupt: () => void = () => undefined;
  const run = runPairing({
    store,
    record: fresh(),
    pollMs: 10,
    graceMs: 500,
    doors: () => Promise.resolve(true),
    close: () => Promise.resolve(),
    onInterrupt: (cb) => {
      interrupt = cb;
      return () => undefined;
    },
    ...r,
  });
  for (let i = 0; i < 200 && !(await store.read()); i++) await proc.sleep(10);
  return { run, close: () => interrupt() };
}

proves(
  [
    "103-three-ports FR-006",
    "103-three-ports FR-008",
    "107-pairing-and-query FR-001",
    "107-pairing-and-query FR-002",
    "107-pairing-and-query FR-003",
  ],
  "103: stolos pair's session holds the record for many machines, asks the person one machine at a time in the order they came, tells each machine its own answer, and removes the file on Ctrl+C",
  async () => {
    await inTemp(async (file) => {
      const store = new FilePairStore(file);
      const door = session(new FilePairStore(file));
      const asked: string[] = [];
      let busy = 0;
      let overlap = false;
      const states: string[][] = [];
      const s = await open(store, {
        record: fresh({ name: "alice-laptop" }),
        approve: async (text, hello) => {
          if (++busy > 1) overlap = true;
          asked.push(`${hello.name}: ${text.trim().split("\n").at(-1)}`);
          await proc.sleep(60);
          busy--;
          return hello.name === "front-pc"
            ? { ok: false, message: "the person at the PC did not approve it; nothing was kept" }
            : { ok: true, message: `${hello.name} is adopted by the fleet lab` };
        },
        onState: (rec) =>
          states.push(Object.values(rec.machines).map((m) => `${m.name}:${m.stage}`)),
      });
      // Three machines, through a door that is another store over the same file; they check in together.
      const base = "http://10.0.0.5:8080";
      for (const [h, ip] of [
        ["alice-laptop", "10.0.0.7"],
        ["bob-desk", "10.0.0.8"],
        ["front-pc", "10.0.0.6"],
      ] as const) {
        assertStringIncludes(await post(door, base, "/hello", hostLine(h), CODE, ip), "ok\n");
        await proc.sleep(15);
      }
      const answers = await Promise.all(
        (
          [
            ["alice-laptop", "10.0.0.7"],
            ["bob-desk", "10.0.0.8"],
            ["front-pc", "10.0.0.6"],
          ] as const
        ).map(([h, ip]) =>
          post(door, base, "/checkin", `@checkin\nv=1\nhostname=${h}\n`, CODE, ip),
        ),
      );
      assertEquals(answers, [
        "ok alice-laptop is adopted by the fleet lab\n",
        "ok bob-desk is adopted by the fleet lab\n",
        "no the person at the PC did not approve it; nothing was kept\n",
      ]);
      assert(!overlap, "one prompt at a time");
      assertEquals(asked.length, 3);
      assertEquals(asked.map((x) => x.split(":")[0]).sort(), [
        "alice-laptop",
        "bob-desk",
        "front-pc",
      ]);
      // The session is still open: it does not end by itself, whatever was decided.
      assert(await fs.exists(file), "the session stays open");
      assertEquals((await store.read())?.ended, undefined);
      assert(states.some((x) => x.includes("front-pc:hello") || x.includes("front-pc:waiting")));
      // Ctrl+C closes it: the file is gone, and the summary says what came of it.
      s.close();
      const sum = await s.run;
      assertEquals(sum.end, "closed");
      assertEquals(sum.adopted.map((m) => m.name).sort(), ["alice-laptop", "bob-desk"]);
      assertEquals(
        sum.refused.map((m) => m.name),
        ["front-pc"],
      );
      assertEquals(sum.waiting, []);
      assert(!(await fs.exists(file)), "the file is gone");
      assert(!(await fs.exists(`${file}-lock`)));
      // With no session open, the door answers 404 (and a late POST has nothing to ask).
      assertEquals(
        (await door.handle(new Request(`http://10.0.0.5:8080${DEVICE_PAIR_PATH}`))).status,
        404,
      );
    });
  },
);

proves(
  ["103-three-ports FR-006", "103-three-ports FR-008", "107-pairing-and-query FR-003"],
  "103: the file goes on Ctrl+C (telling a machine still waiting), where no door is up, and where another stolos pair replaced it; the person's refusal does not end the session",
  async () => {
    await inTemp(async (file) => {
      const store = new FilePairStore(file);
      const door = session(new FilePairStore(file));
      const base = "http://10.0.0.5:8080";
      // A refusal: the machine is told, and the session goes on.
      const refused = await open(store, {
        approve: () => Promise.resolve({ ok: false, message: "the person did not approve it" }),
      });
      await post(door, base, "/hello", hostLine("m"));
      assertEquals(
        await post(door, base, "/checkin", "@checkin\nhostname=m\n"),
        "no the person did not approve it\n",
      );
      assert(await fs.exists(file), "still open after a refusal");
      refused.close();
      assertEquals((await refused.run).refused.length, 1);
      assert(!(await fs.exists(file)));
      // Ctrl+C with a machine waiting for the person: it is told the session ended (nothing was written for it).
      let release: () => void = () => undefined;
      const waiting = await open(store, {
        approve: () => new Promise((ok) => (release = () => ok({ ok: true, message: "never" }))),
      });
      await post(door, base, "/hello", hostLine("m"));
      const held = post(door, base, "/checkin", "@checkin\nhostname=m\n");
      for (let i = 0; i < 200 && (await store.read())?.machines["m"]?.stage !== "waiting"; i++) {
        await proc.sleep(10);
      }
      waiting.close();
      const sum = await waiting.run;
      assertEquals(
        sum.waiting.map((m) => m.name),
        ["m"],
      );
      assertEquals(sum.adopted, []);
      assertStringIncludes(await held, "no this session has ended");
      release();
      assert(!(await fs.exists(file)));
      // No door is up: nothing could pair, and nothing is left.
      assertEquals(
        (
          await runPairing({
            store,
            record: fresh(),
            pollMs: 10,
            graceMs: 50,
            doors: () => Promise.resolve(false),
            close: () => Promise.resolve(),
            approve: () => Promise.resolve({ ok: false, message: "" }),
          })
        ).end,
        "no-door",
      );
      assert(!(await fs.exists(file)));
      // Another stolos pair replaced the record: this one gives way and does not remove the other's.
      const replaced = await open(store, {
        approve: () => Promise.resolve({ ok: false, message: "" }),
      });
      await new FilePairStore(file).create(fresh({ code: "ZZZZ-ZZZZ" }));
      assertEquals((await replaced.run).end, "closed");
    });
  },
);

proves(
  ["107-pairing-and-query FR-003", "107-pairing-and-query FR-004"],
  "107: the terminal shows each machine's stage as it changes and an address that was refused, and says the session is open",
  () => {
    const lines: string[] = [];
    const view = liveView((l) => lines.push(l));
    const rec = fresh();
    const m = (stage: "hello" | "installing" | "waiting" | "adopted" | "refused") => ({
      hostname: "alice-laptop",
      name: "alice-laptop",
      key: KEY,
      address: "10.0.0.7",
      stage,
      seq: 1,
      helloAt: 0,
    });
    rec.machines["alice-laptop"] = m("hello");
    view(rec);
    view(rec);
    rec.machines["alice-laptop"] = m("installing");
    view(rec);
    rec.machines["alice-laptop"] = m("waiting");
    view(rec);
    rec.machines["alice-laptop"] = m("adopted");
    rec.machines["bob-desk"] = { ...m("refused"), hostname: "bob-desk", name: "bob-desk", seq: 2 };
    rec.tries["10.0.0.9"] = MAX_TRIES;
    view(rec);
    assertEquals(lines, [
      "  alice-laptop (10.0.0.7) said hello",
      "  alice-laptop (10.0.0.7) is installing",
      "  alice-laptop (10.0.0.7) is waiting for you",
      "  alice-laptop (10.0.0.7) is adopted",
      "  bob-desk (10.0.0.7) was refused",
      "  10.0.0.9 sent 5 wrong codes: it is refused for the rest of this session",
    ]);
    assertEquals(sessionStatus(rec), "Session is open: Ctrl+C closes it · 1 adopted · 1 refused");
    assertEquals(sessionStatus(fresh()), "Session is open: Ctrl+C closes it · no machine yet");
  },
);

// ------------------------------------------------------------------------------ FR-003, FR-005: the routes

proves(
  ["103-three-ports FR-005"],
  "103: every /device/pair route answers 404 while no pairing session is open, on any door",
  async () => {
    const none = session(new MemoryPairStore());
    const origin = "http://10.0.0.5:8080";
    for (const where of [
      "",
      "/",
      "/w",
      "/w.ps1",
      "/bin/stolos-probe.sh",
      "/bin/stolos-probe.ps1",
    ]) {
      const res = await none.handle(new Request(`${origin}${DEVICE_PAIR_PATH}${where}`));
      assertEquals([where, res.status], [where, 404]);
    }
    for (const where of ["/hello", "/checkin"]) {
      const res = await none.handle(
        new Request(`${origin}${DEVICE_PAIR_PATH}${where}`, { method: "POST", body: "x" }),
      );
      assertEquals([where, res.status], [where, 404]);
    }
    // The handler a door mounts: undefined for a path that is not pairing's, 404 for pairing's.
    const handle = devicePairHandler(new MemoryPairStore());
    assertEquals(await handle(new Request(`${origin}/boot/grub/grub.cfg`)), undefined);
    assertEquals((await handle(new Request(`${origin}${DEVICE_PAIR_PATH}`)))?.status, 404);
    // Once the session has ended, the scripts are gone too.
    const ended = session(new MemoryPairStore({ ...fresh(), ended: "closed" }));
    assertEquals((await ended.handle(new Request(`${origin}${DEVICE_PAIR_PATH}`))).status, 404);
  },
);

proves(
  ["103-three-ports FR-003"],
  "103: the scripts are built from the base of the request: http on 8080, or https by a name",
  async () => {
    const s = session(new MemoryPairStore(fresh()));
    for (const origin of ["http://10.0.0.5:8080", "https://stolos.lab.example.net"]) {
      const sh = await (await s.handle(new Request(`${origin}${DEVICE_PAIR_PATH}`))).text();
      assertStringIncludes(sh, `--pair '${origin}${DEVICE_PAIR_PATH}'`);
      const w = await (await s.handle(new Request(`${origin}${DEVICE_PAIR_PATH}/w`))).text();
      assertStringIncludes(w, `'${origin}${DEVICE_PAIR_PATH}/w.ps1'`);
      assertStringIncludes(w, `--pair '${origin}${DEVICE_PAIR_PATH}'`);
    }
    // The old paths are gone, and nothing else is served.
    for (const p of ["/", "/w", "/hello", "/bin/stolos-probe.sh", "/device", "/device/pairs"]) {
      assertEquals([p, (await s.handle(new Request(`http://10.0.0.5:8080${p}`))).status], [p, 404]);
    }
  },
);

// ------------------------------------------------------------------------------ FR-004: the doors

/** A temporary boot handler (door A) with the pairing mounted, listening on a free port. */
async function doorA(devicePair: (req: Request, from?: string) => Promise<Response | undefined>) {
  const events: string[] = [];
  const opts = {
    port: 0,
    hostname: "127.0.0.1",
    emit: (e: { message?: string }) => void events.push(e.message ?? ""),
    devicePair,
  };
  const h = bootHandler({ files: {}, iso: "" }, opts);
  const listener = await bootServe(opts, h);
  return {
    url: `http://127.0.0.1:${(listener.addr as { port: number }).port}`,
    close: () => listener.close(),
  };
}

/** A console handler (door B) in lan mode: 127.0.0.1:<port> is one of its LAN names; 127.0.0.1:1 is its loopback listener. */
async function doorB(devicePair: (req: Request, from?: string) => Promise<Response | undefined>) {
  const box: { handler?: Awaited<ReturnType<typeof fakeConsole>>["handler"] } = {};
  const server = await serve({ hostname: "127.0.0.1", port: 0 }, (req, info) =>
    box.handler ? box.handler(req, info) : new Response("not yet", { status: 503 }),
  );
  const port = server.addr.port;
  const remote = {
    access: { names: { served: [`127.0.0.1:${port}`] } } as unknown as RemoteAccess,
    hosts: [`127.0.0.1:${port}`],
    signers: () => Promise.resolve([]),
    view: () => ({}),
    controller: `https://127.0.0.1:${port}`,
  } satisfies ConsoleRemote;
  const { handler } = await fakeConsole(1, { remote, devicePair });
  box.handler = handler;
  return { url: `http://127.0.0.1:${port}`, handler, close: () => server.shutdown() };
}

proves(
  ["103-three-ports FR-003", "103-three-ports FR-004"],
  "103: no route of the boot server collides with /device/pair, and the console's loopback listener never serves it",
  async () => {
    // Without the pairing mounted, the boot server answers /device/pair with its own "not found": no route of its answers.
    const plain = await doorA(() => Promise.resolve(undefined));
    try {
      for (const p of [
        DEVICE_PAIR_PATH,
        `${DEVICE_PAIR_PATH}/w`,
        `${DEVICE_PAIR_PATH}/hello`,
        "/device/anything",
      ]) {
        const res = await fetch(`${plain.url}${p}`);
        assertEquals([p, res.status], [p, 404]);
        assertEquals(await res.text(), "not found\n");
      }
    } finally {
      plain.close();
    }
    // With a mounted handler that answers everything with a marker, the boot server returns the marker for each pairing path.
    const marked = await doorA(() => Promise.resolve(new Response("pairing\n")));
    try {
      for (const p of [
        DEVICE_PAIR_PATH,
        `${DEVICE_PAIR_PATH}/w`,
        `${DEVICE_PAIR_PATH}/bin/stolos-probe.sh`,
      ]) {
        assertEquals(await (await fetch(`${marked.url}${p}`)).text(), "pairing\n");
      }
      // And the boot server's own routes are still its own.
      assertEquals(await (await fetch(`${marked.url}/health`)).text(), "archon-boot ok\n");
    } finally {
      marked.close();
    }
    // The console: a LAN name serves it; the 127.0.0.1 listener (its own Host) never does; another Host is refused first.
    const b = await doorB(
      devicePairHandler(new MemoryPairStore(fresh()), {
        nameFor: () => Promise.resolve({ name: "m", key: KEY }),
      }),
    );
    try {
      const lan = await fetch(`${b.url}${DEVICE_PAIR_PATH}`);
      assertEquals(lan.status, 200);
      assertEquals((await lan.text()).startsWith(SCRIPT_START), true, "no session is needed");
      const loopback = await b.handler(
        new Request(`http://127.0.0.1:1${DEVICE_PAIR_PATH}`, { headers: { host: "127.0.0.1:1" } }),
        { remoteAddr: { hostname: "127.0.0.1", port: 50000 } },
      );
      assertEquals(loopback.status, 404);
      // Built for the handler, not sent with fetch: Node's fetch replaces a forged Host with the URL's own.
      const other = await b.handler(
        new Request(`http://evil.example${DEVICE_PAIR_PATH}`, {
          headers: { host: "evil.example" },
        }),
        { remoteAddr: { hostname: "192.168.1.9", port: 50000 } },
      );
      assertEquals(other.status, 421, "the Host check holds");
    } finally {
      await b.close();
    }
  },
);

/** Pair the real bin/integrate.sh against `base`: its exit code, and what it said. */
async function integrate(base: string, code: string, home: string, sshPort: number) {
  const r = await proc.run(
    ["sh", "-c", `curl -fsSL ${base} | sh -s -- --ssh-port ${sshPort} --yes`],
    {
      env: {
        HOME: home,
        PATH: proc.env.get("PATH") ?? "/usr/bin:/bin",
        STOLOS_PAIR_CODE: code,
      },
      clearEnv: true,
    },
  );
  return { code: r.code, out: r.stdout + r.stderr };
}

proves(
  [
    "103-three-ports FR-003",
    "103-three-ports FR-004",
    "103-three-ports FR-006",
    "103-three-ports FR-007",
    "107-pairing-and-query FR-001",
    "107-pairing-and-query FR-004",
  ],
  "103: both doors, over one file, complete full pairings with the real integrate.sh against /device/pair, in one session; the tries are shared per address",
  async () => {
    await inTemp(async (file) => {
      const home = await fs.makeTempDir({ prefix: "ports103-home-" });
      const ssh = await tcp.listen({ hostname: "127.0.0.1", port: 0 });
      // One file, three stores: the terminal's, door A's and door B's, as three processes would have.
      const terminal = new FilePairStore(file);
      const nameFor = (h: string) =>
        Promise.resolve({ name: h.toLowerCase().split(".")[0] ?? "m", key: KEY });
      const a = await doorA(devicePairHandler(new FilePairStore(file), { nameFor, pollMs: 10 }));
      const b = await doorB(devicePairHandler(new FilePairStore(file), { nameFor, pollMs: 10 }));
      try {
        const s = await open(terminal, {
          approve: (_t, hello) =>
            Promise.resolve({ ok: true, message: `${hello.name} is adopted by the fleet lab` }),
        });
        // Door A (the boot server's HTTP): a whole pairing.
        const okA = await integrate(
          `${a.url}${DEVICE_PAIR_PATH}`,
          "wdjb mjht",
          home,
          ssh.addr.port,
        );
        assertEquals(okA.code, 0, okA.out);
        assertStringIncludes(okA.out, "is adopted by the fleet lab");
        assertStringIncludes(
          await fs.readTextFile(`${home}/.ssh/authorized_keys`),
          `restrict ${KEY} stolos-probe@lab`,
        );
        assertEquals(await fs.readTextFile(`${home}/.local/bin/stolos-probe`), PROBE_SCRIPT);
        // The session is still open: door B (the console's handler) pairs another, with the same code.
        assert(await fs.exists(file), "the session stays open");
        await fs.remove(`${home}/.ssh`, { recursive: true });
        const okB = await integrate(`${b.url}${DEVICE_PAIR_PATH}`, "wdjbmjht", home, ssh.addr.port);
        assertEquals(okB.code, 0, okB.out);
        assertStringIncludes(okB.out, "is adopted by the fleet lab");
        assertStringIncludes(
          await fs.readTextFile(`${home}/.ssh/authorized_keys`),
          "stolos-probe@lab",
        );
        // The limit of 5 wrong tries is one limit for both doors: the script asks three times at door A, then door B takes the rest.
        await fs.remove(`${home}/.ssh`, { recursive: true });
        await fs.remove(`${home}/.local`, { recursive: true });
        const viaA = await integrate(
          `${a.url}${DEVICE_PAIR_PATH}`,
          "ZZZZ-ZZZZ",
          home,
          ssh.addr.port,
        );
        assert(viaA.code !== 0, viaA.out);
        assertStringIncludes(viaA.out, "that code is wrong");
        assertEquals((await terminal.read())?.tries, { "127.0.0.1": 3 });
        const viaB = await integrate(
          `${b.url}${DEVICE_PAIR_PATH}`,
          "ZZZZ-ZZZZ",
          home,
          ssh.addr.port,
        );
        assert(viaB.code !== 0, viaB.out);
        assertStringIncludes(viaB.out, "this address is refused for the rest of the session");
        assertEquals((await terminal.read())?.tries, { "127.0.0.1": MAX_TRIES });
        // That address is refused now, even with the right code; nothing was written on the machine by the wrong ones.
        const late = await integrate(
          `${a.url}${DEVICE_PAIR_PATH}`,
          "wdjb mjht",
          home,
          ssh.addr.port,
        );
        assertStringIncludes(late.out, "403");
        assertEquals(
          (await fs.exists(`${home}/.ssh`)) ? "written" : "untouched",
          "untouched",
          "nothing was written",
        );
        s.close();
        const sum = await s.run;
        assertEquals(sum.adopted.length, 1, "the same machine paired twice is one machine");
        assertEquals(sum.blocked, ["127.0.0.1"]);
        assert(!(await fs.exists(file)));
        // The session is over: both doors answer 404.
        assertEquals((await fetch(`${a.url}${DEVICE_PAIR_PATH}`)).status, 404);
        assertEquals((await fetch(`${b.url}${DEVICE_PAIR_PATH}`)).status, 404);
      } finally {
        ssh.close();
        a.close();
        await b.close();
        await fs.remove(home, { recursive: true });
      }
    });
  },
  { skip: POSIX_ONLY },
);

// ------------------------------------------------------------------------------ FR-008: stolos pair

proves(
  ["103-three-ports FR-004", "103-three-ports FR-008"],
  "103: the pair-only server binds the ontology's port unless told another, and serves nothing but /device/pair",
  async () => {
    // The explicit choice, on a free port: it is marked as outside the three.
    const free = await tcp.listen({ hostname: "127.0.0.1", port: 0 });
    const port = free.addr.port;
    free.close();
    const store = new MemoryPairStore(fresh());
    const handle = devicePairHandler(store, {
      nameFor: () => Promise.resolve({ name: "m", key: KEY }),
    });
    const only = await startPairOnly(handle, port);
    try {
      assertEquals([only.port, only.explicit], [port, true]);
      const script = await fetch(`http://127.0.0.1:${port}${DEVICE_PAIR_PATH}`);
      assertEquals(script.status, 200);
      assert((await script.text()).startsWith(SCRIPT_START));
      for (const p of ["/", "/health", "/boot/grub/grub.cfg", "/iso/ubuntu.iso", "/device"]) {
        assertEquals([p, (await fetch(`http://127.0.0.1:${port}${p}`)).status], [p, 404]);
      }
    } finally {
      only.close();
    }
    // Told nothing, it takes the ontology's TCP 8080: where this machine has it free, bind it and see; else the port is the claim.
    assertEquals(choosePort("boot-http", undefined).port, 8080);
    if ((await bindProblem(8080)) === undefined) {
      const std = await startPairOnly(handle);
      try {
        assertEquals([std.port, std.explicit], [8080, false]);
      } finally {
        std.close();
      }
    }
  },
);

proves(
  ["103-three-ports FR-008"],
  "103: stolos pair shows a line per door that is up, HTTPS first, only when the name is this PC's and answers",
  async () => {
    const script = `${SCRIPT_START}\n# Served by stolos pair\n`;
    const base = {
      address: "10.0.0.5",
      port: 8080,
      addresses: ["10.0.0.5", "192.168.1.5"],
      names: ["stolos.lab.example.net", "alpha-pc.stolos.lab.example.net"],
    };
    const http = { via: "this command, on TCP 8080" };
    // The name is this PC's and the console answers: HTTPS first, then plain HTTP.
    const both = await findDoors({
      ...base,
      httpUp: http,
      resolve: (n) => Promise.resolve(n === "stolos.lab.example.net" ? ["10.0.0.5"] : []),
      fetchText: (u) =>
        Promise.resolve(u.startsWith("https://stolos.lab.example.net/") ? script : undefined),
    });
    assertEquals(
      both.doors.map((d) => [d.door, d.base]),
      [
        ["tls", "https://stolos.lab.example.net/device/pair"],
        ["lan-http", "http://10.0.0.5:8080/device/pair"],
      ],
    );
    assertEquals(both.notes, []);
    const text = pairInstructions(both.doors, "WDJB-MJHT");
    const lines = text.split("\n");
    const first = lines.findIndex((l) =>
      l.includes("curl -fsSL https://stolos.lab.example.net/device/pair | sh"),
    );
    const second = lines.findIndex((l) =>
      l.includes("curl -fsSL http://10.0.0.5:8080/device/pair | sh"),
    );
    assert(first > 0 && second > first, "HTTPS first");
    assertStringIncludes(text, "irm https://stolos.lab.example.net/device/pair/w | iex");
    assertStringIncludes(text, "irm http://10.0.0.5:8080/device/pair/w | iex");
    assertStringIncludes(text, "WDJB-MJHT      (the same for every machine)");
    assertStringIncludes(text, "Session is open: Ctrl+C closes it.");
    assertStringIncludes(text, "An open session is less safe than a short one");
    assertStringIncludes(text, "Nothing is adopted without your yes");
    assert(!text.includes("expires"), "nothing expires");
    assert(!text.includes("7457"));
    // The primary's name resolves elsewhere, this controller's own does here: its own is the door.
    const own = await findDoors({
      ...base,
      httpUp: http,
      resolve: (n) =>
        Promise.resolve(n === "stolos.lab.example.net" ? ["10.0.0.99"] : ["192.168.1.5"]),
      fetchText: () => Promise.resolve(script),
    });
    assertEquals(own.doors[0]?.base, "https://alpha-pc.stolos.lab.example.net/device/pair");
    // The name does not resolve to this PC yet: only plain HTTP, and one plain line says how to get the other.
    const elsewhere = await findDoors({
      ...base,
      httpUp: http,
      resolve: () => Promise.resolve(["10.0.0.99"]),
      fetchText: () => Promise.resolve(script),
    });
    assertEquals(
      elsewhere.doors.map((d) => d.door),
      ["lan-http"],
    );
    assertEquals(elsewhere.notes.length, 1);
    assertStringIncludes(elsewhere.notes[0] ?? "", "does not resolve to this PC yet");
    assertStringIncludes(elsewhere.notes[0] ?? "", "stolos console --lan");
    // The name is this PC's, but the console does not answer (it is not serving): one line again.
    const silent = await findDoors({
      ...base,
      httpUp: http,
      resolve: () => Promise.resolve(["10.0.0.5"]),
      fetchText: () => Promise.resolve(undefined),
    });
    assertEquals(
      silent.doors.map((d) => d.door),
      ["lan-http"],
    );
    assertStringIncludes(silent.notes[0] ?? "", "the console does not answer there");
    // A resolver that fails counts as not this PC's; a fleet with no web domain has no HTTPS door and says so.
    const failing = await findDoors({
      ...base,
      httpUp: http,
      resolve: () => Promise.reject(new Error("no dns")),
      fetchText: () => Promise.resolve(script),
    });
    assertEquals(
      failing.doors.map((d) => d.door),
      ["lan-http"],
    );
    const nameless = await findDoors({
      ...base,
      names: [],
      httpUp: undefined,
      resolve: () => Promise.resolve([]),
      fetchText: () => Promise.resolve(undefined),
    });
    assertEquals(nameless.doors, []);
    assertStringIncludes(nameless.notes[0] ?? "", "web.domain");
    // Only the HTTPS door: the plain-HTTP reminder is not shown.
    const tlsOnly = pairInstructions([both.doors[0] as never], "WDJB-MJHT");
    assert(!tlsOnly.includes("Plain HTTP"));
  },
);

proves(
  ["098-pair FR-007", "103-three-ports FR-006"],
  "103: the machine is named by the record's --name, else its hostname; a managed server's name or a bad name is refused; its key is made",
  async () => {
    const managed = () => Promise.resolve(new Set(["alpha", "beta"]));
    const made: string[] = [];
    const keyFor = (name: string, fleet: string) => {
      made.push(`${name}@${fleet}`);
      return Promise.resolve(KEY);
    };
    assertEquals(await pairNameFor("Alice-Laptop.local", { fleet: "lab" }, managed, keyFor), {
      name: "alice-laptop",
      key: KEY,
    });
    assertEquals(
      await pairNameFor("whatever", { fleet: "lab", name: "bob-desk" }, managed, keyFor),
      { name: "bob-desk", key: KEY },
    );
    const refusedManaged = await pairNameFor("alpha", { fleet: "lab" }, managed, keyFor);
    assertStringIncludes(
      "refuse" in refusedManaged ? refusedManaged.refuse : "",
      "alpha is a managed server",
    );
    const refusedName = await pairNameFor(
      "x",
      { fleet: "lab", name: "Not A Name" },
      managed,
      keyFor,
    );
    assertStringIncludes("refuse" in refusedName ? refusedName.refuse : "", "is not a name");
    assertEquals(made, ["alice-laptop@lab", "bob-desk@lab"], "no key is made for a refused name");
  },
);

// ------------------------------------------------------------------------------ FR-009: the console's 443

proves(
  ["103-three-ports FR-009"],
  "103: the console has only 443: no fallback list, a held port is refused, and the refusal names what holds it",
  async () => {
    assertEquals(HTTPS_PORT, 443);
    assert(!("HTTPS_PORTS" in tlsModule), "there is no list of ports to fall back along");
    // A held port: the TLS listener rejects with EADDRINUSE, and nothing tries another.
    const held = await tcp.listen({ hostname: "127.0.0.1", port: 0 });
    const port = held.addr.port;
    const dir = await fs.makeTempDir({ prefix: "ports103-tls-" });
    try {
      const made = await proc.run(
        [
          "openssl",
          "req",
          "-x509",
          "-newkey",
          "ec",
          "-pkeyopt",
          "ec_paramgen_curve:P-256",
          "-nodes",
          "-days",
          "1",
          "-subj",
          "/CN=stolos",
          "-keyout",
          path.join(dir, "k.pem"),
          "-out",
          path.join(dir, "c.pem"),
        ],
        { stdout: "piped", stderr: "piped" },
      );
      assertEquals(made.code, 0, made.stderr);
      const pem = {
        cert: await fs.readTextFile(path.join(dir, "c.pem")),
        key: await fs.readTextFile(path.join(dir, "k.pem")),
      };
      let code = "";
      try {
        await serveTls({ hostname: "127.0.0.1", port, ...pem }, () => new Response("hi"));
      } catch (e) {
        code = (e as { code?: string }).code ?? (e as Error).name;
      }
      assertEquals(code, "EADDRINUSE");
    } finally {
      held.close();
      await fs.remove(dir, { recursive: true });
    }
    const r = listenRefusal({
      port: 443,
      code: "EADDRINUSE",
      holder: "nginx (process 812)",
      os: "linux",
    });
    assertStringIncludes(r.why, "does not fall back to another port");
    assertStringIncludes(r.why, "TCP 443 is in use, held by nginx (process 812)");
    assertStringIncludes(r.fix, "stop nginx");
    assertStringIncludes(r.fix, "stolos console --lan --lan-port <n>");
    assertStringIncludes(r.fix, "outside the three standard ports");
    assert(!(r.why + r.fix).includes("8443"));
    const noHolder = listenRefusal({ port: 443, code: "EADDRINUSE", os: "windows" });
    assertStringIncludes(noHolder.fix, "Get-NetTCPConnection -LocalPort 443 -State Listen");
    assertStringIncludes(listenRefusal({ port: 443, code: "EACCES", os: "linux" }).fix, "setcap");
    // The doctor says the same, as an action.
    const lines = accessDoctor(
      {
        configured: true,
        unused: 0,
        devices: 0,
        blocked: { port: 443, code: "EADDRINUSE", holder: "nginx (process 812)" },
      },
      Date.now(),
      [],
      "linux",
    );
    const action = lines.find((l) => l.level === "action");
    assertStringIncludes(action?.msg ?? "", "held by nginx (process 812)");
    assertStringIncludes(action?.fix ?? "", "--lan-port");
  },
);

proves(
  ["103-three-ports FR-009"],
  "103: what holds a port is read from ss, lsof or PowerShell, and a failed lookup never fails",
  async () => {
    assertEquals(
      parseSs(
        'State Recv-Q Send-Q Local Address:Port Peer Address:Port Process\nLISTEN 0 511 0.0.0.0:443 0.0.0.0:* users:(("nginx",pid=812,fd=6))\nLISTEN 0 4096 127.0.0.54:53 0.0.0.0:*',
        443,
      ),
      "nginx (process 812)",
    );
    assertEquals(
      parseSs("LISTEN 0 511 [::]:443 [::]:*", 443),
      "another process (run as root to see which)",
    );
    assertEquals(parseSs("LISTEN 0 511 0.0.0.0:4430 0.0.0.0:*", 443), undefined);
    assertEquals(
      parseLsof("COMMAND PID USER FD TYPE\nnginx 812 root 6u IPv4 0x1 0t0 TCP *:443 (LISTEN)\n"),
      "nginx (process 812)",
    );
    assertEquals(parseLsof("COMMAND PID\n"), undefined);
    assertEquals(parseWindows("IIS Worker 1234\n"), "IIS Worker (process 1234)");
    assertEquals(parseWindows(""), undefined);
    assertEquals(holderCommand("linux", 443), ["ss", "-ltnp"]);
    assertEquals(holderCommand("darwin", 443), ["lsof", "-nP", "-iTCP:443", "-sTCP:LISTEN"]);
    assertStringIncludes(
      holderCommand("windows", 443).join(" "),
      "Get-NetTCPConnection -LocalPort 443 -State Listen",
    );
    assertEquals(
      await portHolder(443, "linux", () =>
        Promise.resolve('LISTEN 0 1 *:443 *:* users:(("caddy",pid=7,fd=3))'),
      ),
      "caddy (process 7)",
    );
    assertEquals(
      await portHolder(443, "linux", () => Promise.reject(new Error("no ss"))),
      undefined,
    );
    assertEquals(await portHolder(443, "darwin", () => Promise.resolve(undefined)), undefined);
  },
);

proves(
  ["103-three-ports FR-010"],
  "103: boot serve keeps --port and --tftp-port as explicit choices, marked as outside the three",
  async () => {
    const text = await fs.readTextFile("src/archon-boot/main.ts");
    assertStringIncludes(text, 'choosePort("boot-http"');
    assertStringIncludes(text, '"boot-tftp"');
    assertStringIncludes(text, "outsideStandardNote");
    assertStringIncludes(text, "--tftp-port");
    assertStringIncludes(text, "devicePair");
    assertEquals(choosePort("boot-tftp", 6969), { port: 6969, explicit: true });
    assertEquals(choosePort("boot-tftp", 69), { port: 69, explicit: false });
    assertStringIncludes(
      firewallRule("windows", "udp", 6969, "boot TFTP"),
      "-Protocol UDP -LocalPort 6969",
    );
  },
);
