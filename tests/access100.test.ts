/**
 * Spec 100: remote access to the Stolos Console: the names and fleet.ts; DNS, the heartbeat and
 * the certificate against a fake Cloudflare and a fake ACME; the addresses Article 28 allows; the
 * HTTPS listener; a passkey made with WebCrypto (an Ed25519 authenticator played by the test) and
 * verified by commons' WebAuthn; the code flow end to end (pending, `devices approve` writing
 * access.ts in a sandbox fleet and applying it signed, the controller honouring the signed tip and
 * refusing an unsigned one, sign-in, revoke); the privilege rule; the Remote Access page; mail; the
 * doctor and the controller policy.
 *
 * @module
 */

import { cbor, toBase64Url } from "@intellectual-frontiers/formats";
import { cose } from "@intellectual-frontiers/crypto";
import { fs, path, proc } from "@intellectual-frontiers/system";
import { serve } from "@intellectual-frontiers/commons/ts/runtime";
import {
  assert,
  assertEquals,
  assertStringIncludes,
  proves,
} from "@intellectual-frontiers/commons/ts/runtime/test";
import { Sessions } from "../src/archon/console/auth.ts";
import type { ActivityEntry } from "../src/archon/console/pages.ts";
import type {
  ConsoleRemote,
  StolosDeps,
  stolosHandler,
} from "../src/archon/console/stolos-server.ts";
import type { ConsoleDevice, FleetDef } from "../src/archon/model/types.ts";
import type { Event } from "../src/archon/notify/notify.ts";
import {
  type ConsoleNames,
  consoleNames,
  proposedSettings,
  stolosProblems,
  withStolosSettings,
} from "../src/archon/access/names.ts";
import {
  accessSource,
  defaultDeviceName,
  deviceOf,
  parseAccess,
  PENDING_TTL_MS,
  PendingStore,
  unusedDevices,
} from "../src/archon/access/devices.ts";
import {
  type AcmeIssue,
  consoleRecords,
  ensureCertificate,
  keepDns,
  listenAddress,
  needsNew,
  otherController,
  parseTls,
  trustedAddress,
} from "../src/archon/access/tls.ts";
import { commonsPasskeys, type Passkeys } from "../src/archon/access/passkeys.ts";
import { digestText, RemoteAccess } from "../src/archon/access/service.ts";
import { accessPage, type AccessView } from "../src/archon/access/pages.ts";
import { accessDoctor, consoleFirewallCommand } from "../src/archon/access/doctor.ts";
import { controllerUrl, pendingFrom } from "../src/archon/access/commands.ts";
import { serveTls } from "../src/archon/access/https.ts";
import { decisionOf, splitChanges, yoursNamed } from "../src/archon/fleet/records.ts";
import { policies } from "../src/archon/adopt/policy.ts";
import type { AdoptedDef, Observed } from "../src/archon/adopt/adopt.ts";
import { askpassHelper, linkEngine, sandbox } from "./sandbox.ts";
import { fakeConsole } from "./console/serve-stolos.ts";

const FLEET = { web: { domain: "lab.example.net" } };
const PC = "alpha-pc";
const NAMES: ConsoleNames = ((): ConsoleNames => {
  const n = consoleNames(FLEET, PC);
  if (!n) throw new Error("no names");
  return n;
})();
const OWN = NAMES.own;
const ORIGIN = `https://${OWN}`;
const NOW = Date.parse("2026-11-16T12:00:00Z");

// ------------------------------------------------------------- an authenticator (WebCrypto)

const utf8 = (s: string): Uint8Array<ArrayBuffer> => new TextEncoder().encode(s);
const sha = async (b: Uint8Array): Promise<Uint8Array> =>
  new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(b)));
const cat = (...parts: readonly Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};
const u32 = (n: number): Uint8Array =>
  Uint8Array.of((n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff);

/** A passkey on a device: an Ed25519 key, played by the test as a platform authenticator would. */
async function authenticator(): Promise<{
  id: string;
  create(options: unknown, origin: string): Promise<unknown>;
  get(options: unknown, origin: string): Promise<unknown>;
}> {
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const c = cose.coseKeyFromJwk(await crypto.subtle.exportKey("jwk", pair.publicKey));
  if (c.kind === "err") throw new Error(c.error);
  const rawId = crypto.getRandomValues(new Uint8Array(16));
  const id = toBase64Url(rawId);
  let counter = 0;
  const challengeOf = (o: unknown): string => (o as { challenge: string }).challenge;
  const data = async (attested: boolean): Promise<Uint8Array> => {
    // up | uv | be | bs (a synced passkey), and at when a credential is attached.
    const flags = 0x01 | 0x04 | 0x08 | 0x10 | (attested ? 0x40 : 0);
    const head = cat(await sha(utf8(NAMES.domain)), Uint8Array.of(flags), u32(counter));
    return attested
      ? cat(head, new Uint8Array(16), Uint8Array.of(0, rawId.length), rawId, c.value)
      : head;
  };
  const client = (type: string, challenge: string, origin: string): Uint8Array =>
    utf8(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
  return {
    id,
    async create(options, origin) {
      const ad = await data(true);
      const att = cbor.encodeCbor(
        new Map<cbor.CborKey, cbor.CborValue>([
          ["fmt", "none"],
          ["attStmt", new Map()],
          ["authData", ad],
        ]),
      );
      return {
        id,
        rawId: id,
        type: "public-key",
        clientExtensionResults: {},
        authenticatorAttachment: "platform",
        response: {
          clientDataJSON: toBase64Url(client("webauthn.create", challengeOf(options), origin)),
          attestationObject: toBase64Url(att),
          transports: ["internal", "hybrid"],
        },
      };
    },
    async get(options, origin) {
      counter++;
      const ad = await data(false);
      const cd = client("webauthn.get", challengeOf(options), origin);
      const sig = new Uint8Array(
        await crypto.subtle.sign(
          { name: "Ed25519" },
          pair.privateKey,
          new Uint8Array(cat(ad, await sha(cd))),
        ),
      );
      return {
        id,
        rawId: id,
        type: "public-key",
        clientExtensionResults: {},
        response: {
          clientDataJSON: toBase64Url(cd),
          authenticatorData: toBase64Url(ad),
          signature: toBase64Url(sig),
          userHandle: toBase64Url(utf8("alice")),
        },
      };
    },
  };
}

// ------------------------------------------------------------------ fakes

/** A Cloudflare API that keeps records in memory (zone lab.example.net). */
function fakeCloudflare(): {
  fetch: typeof fetch;
  records: Array<{
    id: string;
    type: string;
    name: string;
    content: string;
    proxied?: boolean;
    ttl: number;
  }>;
} {
  const records: Array<{
    id: string;
    type: string;
    name: string;
    content: string;
    proxied?: boolean;
    ttl: number;
  }> = [];
  const ok = (result: unknown) =>
    new Response(JSON.stringify({ success: true, result }), {
      headers: { "content-type": "application/json" },
    });
  const f = ((input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const u = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    const p = u.pathname.replace(/^\/client\/v4/, "");
    const method = init?.method ?? "GET";
    if (p === "/zones")
      return Promise.resolve(ok([{ id: "z1", name: u.searchParams.get("name") }]));
    if (p === "/zones/z1/dns_records" && method === "GET") {
      return Promise.resolve(
        ok(
          records.filter(
            (r) => r.type === u.searchParams.get("type") && r.name === u.searchParams.get("name"),
          ),
        ),
      );
    }
    const body = JSON.parse(
      typeof init?.body === "string" ? init.body : "{}",
    ) as (typeof records)[number];
    if (p === "/zones/z1/dns_records" && method === "POST") {
      records.push({ ...body, id: `r${records.length + 1}` });
      return Promise.resolve(ok({}));
    }
    const id = p.match(/^\/zones\/z1\/dns_records\/(\w+)$/)?.[1];
    const at = records.findIndex((r) => r.id === id);
    if (at >= 0 && method === "PUT") {
      records[at] = { ...body, id: records[at]?.id ?? "" };
      return Promise.resolve(ok({}));
    }
    return Promise.resolve(new Response("{}", { status: 404 }));
  }) as typeof fetch;
  return { fetch: f, records };
}

/** An in-memory activity record and mailbox. */
function recorder(): {
  log: ActivityEntry[];
  mails: Event[];
  activity: { add(e: ActivityEntry): Promise<void>; recent(n: number): Promise<ActivityEntry[]> };
  mail(ev: Event): Promise<unknown>;
} {
  const log: ActivityEntry[] = [];
  const mails: Event[] = [];
  return {
    log,
    mails,
    activity: {
      add: (e) => (log.push(e), Promise.resolve()),
      recent: (n) => Promise.resolve(log.slice(-n).reverse()),
    },
    mail: (ev) => (mails.push(ev), Promise.resolve("queued")),
  };
}

const DEVICE: ConsoleDevice = {
  id: "AAECAwQFBgcICQoL",
  signer: "alice-daily",
  name: "iPhone (Safari)",
  credential: { id: "AAECAwQFBgcICQoLDA0ODw", publicKey: "pQECAyYgASFYIA", alg: -8 },
  backedUp: true,
  registered: "2026-11-01T10:00:00.000Z",
  approvedBy: "alice-daily",
  registeredFrom: "10.0.0.23",
  userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Safari/605.1",
};

// ------------------------------------------------------------------ FR-001

proves(
  ["100-remote-access FR-001"],
  "100: the names under the web domain, validated, and written into fleet.ts",
  async () => {
    assertEquals(NAMES.own, "alpha-pc.stolos.lab.example.net");
    assertEquals(NAMES.base, "stolos.lab.example.net");
    assert(NAMES.primary, "the only controller is the primary");
    assertEquals(NAMES.served, ["alpha-pc.stolos.lab.example.net", "stolos.lab.example.net"]);
    // A wildcard does not cover its parent: the base is listed too, on the primary.
    assertEquals(NAMES.certNames, [
      "alpha-pc.stolos.lab.example.net",
      "*.stolos.lab.example.net",
      "stolos.lab.example.net",
    ]);
    assertEquals(NAMES.heartbeat, "_stolos-console.stolos.lab.example.net");
    const other = consoleNames({ ...FLEET, stolos: { console: { primary: "beta-pc" } } }, PC);
    assertEquals(other?.primary, false);
    assertEquals(other?.served, ["alpha-pc.stolos.lab.example.net"]);
    assertEquals(other?.certNames, ["alpha-pc.stolos.lab.example.net", "*.stolos.lab.example.net"]);
    assertEquals(consoleNames({}, PC), undefined, "no web domain, no names");
    assertEquals(
      consoleNames({ ...FLEET, stolos: { console: { name: "ops" } } }, PC)?.own,
      "alpha-pc.ops.lab.example.net",
    );

    assertEquals(stolosProblems({ ...FLEET, stolos: { console: { name: "stolos" } } }), []);
    const bad = stolosProblems({ stolos: { console: { name: "No Good", primary: "x_y" } } });
    assertEquals(
      bad.map((p) => p.where),
      ["fleet.stolos.console.name", "fleet.stolos.console.primary", "fleet.stolos.console"],
    );
    const { validateFleet } = await import("../src/archon/model/validate.ts");
    const { fleetExport } = await import("../src/archon/model/load.ts");
    const fleet = await fleetExport<FleetDef>(
      path.resolve("examples/fleets/lab/fleet.ts"),
      "fleet",
    );
    assert(fleet, "the lab fleet");
    const found = validateFleet({ ...fleet, stolos: { console: { name: "-bad" } } }, []).filter(
      (p) => p.where.startsWith("fleet.stolos"),
    );
    assertEquals(found.length, 1, "validate reports it");

    assertEquals(proposedSettings({}, PC), { name: "stolos", primary: PC, lan: true });
    const src = await fs.readTextFile("examples/fleets/lab/fleet.ts");
    const next = withStolosSettings(src, proposedSettings({}, PC));
    assert(next !== undefined, "inserted");
    assertStringIncludes(
      next,
      'stolos: {\n    console: {\n      name: "stolos",\n      primary: "alpha-pc",\n      lan: true,',
    );
    assert(next.startsWith(src.slice(0, src.lastIndexOf("};")).trimEnd()), "nothing else changed");
    assertEquals(withStolosSettings(next, proposedSettings({}, PC)), undefined, "kept when there");
    // It still reads as the fleet, with the settings (inside the checkout, so its imports of the
    // engine resolve).
    const dir = await fs.makeTempDir({ dir: path.resolve("."), prefix: ".access100-" });
    try {
      await fs.writeTextFile(
        path.join(dir, "site.ts"),
        await fs.readTextFile("examples/fleets/lab/site.ts"),
      );
      await fs.writeTextFile(path.join(dir, "fleet.ts"), next);
      const { fleetExport } = await import("../src/archon/model/load.ts");
      const f = await fleetExport<{ stolos?: unknown }>(path.join(dir, "fleet.ts"), "fleet");
      assertEquals(f?.stolos, { console: { name: "stolos", primary: "alpha-pc", lan: true } });
    } finally {
      await fs.remove(dir, { recursive: true });
    }
  },
);

// ------------------------------------------------------------------ FR-002

proves(
  ["100-remote-access FR-002"],
  "100: the A records and the heartbeat in Cloudflare; another controller seen",
  async () => {
    const cf = fakeCloudflare();
    assertEquals(consoleRecords(NAMES, "10.0.0.5"), [
      { type: "A", name: "alpha-pc.stolos.lab.example.net", content: "10.0.0.5" },
      { type: "A", name: "stolos.lab.example.net", content: "10.0.0.5" },
    ]);
    let r = await keepDns({
      token: "t",
      zone: "lab.example.net",
      names: NAMES,
      address: "10.0.0.5",
      now: NOW,
      fetch: cf.fetch,
    });
    assertEquals(r.other, undefined);
    const a = cf.records.filter((x) => x.type === "A");
    assertEquals(
      a.map((x) => [x.name, x.content, x.proxied, x.ttl]),
      [
        ["alpha-pc.stolos.lab.example.net", "10.0.0.5", false, 60],
        ["stolos.lab.example.net", "10.0.0.5", false, 60],
      ],
    );
    const txt = () => cf.records.filter((x) => x.type === "TXT").map((x) => x.content);
    assertEquals(txt(), ["alpha-pc 2026-11-16T12:00:00.000Z"]);
    // Five minutes later: the heartbeat refreshed in place, nothing added.
    await keepDns({
      token: "t",
      zone: "lab.example.net",
      names: NAMES,
      address: "10.0.0.5",
      now: NOW + 300_000,
      fetch: cf.fetch,
    });
    assertEquals(txt(), ["alpha-pc 2026-11-16T12:05:00.000Z"]);
    assertEquals(cf.records.length, 3);
    // A second controller (not the primary) sees the primary's live heartbeat and leaves it.
    const beta = consoleNames({ ...FLEET, stolos: { console: { primary: PC } } }, "beta-pc");
    assert(beta);
    r = await keepDns({
      token: "t",
      zone: "lab.example.net",
      names: beta,
      address: "10.0.0.6",
      now: NOW + 360_000,
      fetch: cf.fetch,
    });
    assertEquals(r.other?.pc, "alpha-pc");
    assertEquals(txt(), ["alpha-pc 2026-11-16T12:05:00.000Z"]);
    assert(
      cf.records.some(
        (x) => x.name === "beta-pc.stolos.lab.example.net" && x.content === "10.0.0.6",
      ),
    );
    assert(
      !cf.records.some((x) => x.name === "stolos.lab.example.net" && x.content === "10.0.0.6"),
    );
    // A stale heartbeat is no one's.
    assertEquals(otherController(["beta-pc 2026-11-16T11:00:00.000Z"], PC, NOW), undefined);
    assertEquals(otherController(["beta-pc 2026-11-16T11:58:00.000Z"], PC, NOW)?.pc, "beta-pc");
  },
);

proves(
  ["100-remote-access FR-002"],
  "100: the certificate from ACME, kept in the vault, reused, renewed at 30 days",
  async () => {
    let calls: Array<{ domains: string[]; accountKey?: unknown }> = [];
    let notAfter = NOW + 90 * 86_400_000;
    let fail = "";
    const issue: AcmeIssue = (o) => {
      calls.push({
        domains: o.domains,
        ...(o.accountKey !== undefined ? { accountKey: o.accountKey } : {}),
      });
      return Promise.resolve(
        fail
          ? { kind: "err", error: fail }
          : {
              kind: "ok",
              value: {
                certificatePem: "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n",
                privateKeyPem: "(a key)",
                accountKey: { kty: "EC", crv: "P-256", x: "x", y: "y", d: "d" },
                notAfter: new Date(notAfter).toISOString(),
              },
            },
      );
    };
    let vault: string | undefined;
    const o = {
      names: NAMES.certNames,
      directory: "https://acme-staging-v02.api.letsencrypt.org/directory",
      issue,
      read: () => Promise.resolve(vault),
      write: (t: string) => ((vault = t), Promise.resolve()),
    };
    let r = await ensureCertificate({ ...o, now: NOW });
    assert("tls" in r && r.tls, "issued");
    assertEquals(calls.length, 1);
    assertEquals(calls[0]?.domains, NAMES.certNames);
    assertEquals(calls[0]?.accountKey, undefined, "a new account the first time");
    assertStringIncludes(vault ?? "", "BEGIN CERTIFICATE");
    // Good for 90 days: kept.
    await ensureCertificate({ ...o, now: NOW + 59 * 86_400_000 });
    assertEquals(calls.length, 1);
    // 30 days left: renewed, with the same ACME account.
    calls = [];
    notAfter = NOW + 150 * 86_400_000;
    await ensureCertificate({ ...o, now: NOW + 61 * 86_400_000 });
    assertEquals(calls.length, 1);
    assert(calls[0]?.accountKey, "the account kept in the vault is used again");
    // Other names (another primary): issued again.
    assert(needsNew(parseTls(vault), [OWN, `*.${NAMES.base}`], NOW));
    // A failed renewal keeps the certificate that still serves.
    fail = "the DNS challenge failed";
    r = await ensureCertificate({ ...o, names: [OWN], now: NOW + 61 * 86_400_000 });
    assert("why" in r && r.tls, "the old one serves");
    // The secret's path is in the vault's folder, so every backup holds it.
    const { SECRETS } = await import("../src/archon/core/secrets.ts");
    assert(SECRETS.consoleTls.startsWith(SECRETS.dir), SECRETS.consoleTls);
  },
);

// ------------------------------------------------------------------ FR-003

proves(
  ["100-remote-access FR-003"],
  "100: only a LAN or mesh address is bound (Article 28)",
  () => {
    for (const a of [
      "10.0.0.5",
      "172.16.3.4",
      "172.31.255.1",
      "192.168.1.9",
      "100.64.0.1",
      "100.127.9.9",
    ]) {
      assert(trustedAddress(a), a);
    }
    for (const a of [
      "8.8.8.8",
      "172.32.0.1",
      "100.128.0.1",
      "203.0.113.5",
      "127.0.0.1",
      "fe80::1",
      "",
    ]) {
      assert(!trustedAddress(a), a);
    }
    assertEquals(listenAddress(["203.0.113.5", "192.168.1.9"]), "192.168.1.9");
    assertEquals(listenAddress(["203.0.113.5"]), undefined, "a public address only: refused");
  },
);

proves(
  ["100-remote-access FR-003"],
  "100: HTTPS with the console's certificate, renewed in place; the Host check takes the names",
  async () => {
    const dir = await fs.makeTempDir();
    try {
      const cert = async (cn: string) => {
        const r = await proc.run(
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
            `/CN=${cn}`,
            "-keyout",
            path.join(dir, `${cn}.key`),
            "-out",
            path.join(dir, `${cn}.crt`),
          ],
          { stdout: "piped", stderr: "piped" },
        );
        assertEquals(r.code, 0, r.stderr);
        return {
          cert: await fs.readTextFile(path.join(dir, `${cn}.crt`)),
          key: await fs.readTextFile(path.join(dir, `${cn}.key`)),
        };
      };
      const one = await cert("one");
      const s = await serveTls(
        { hostname: "127.0.0.1", port: 0, ...one },
        (req, info) =>
          new Response(
            `${new URL(req.url).protocol} ${req.headers.get("host")} ${info.remoteAddr.hostname}`,
          ),
      );
      try {
        const subject = async () => {
          const r = await proc.run(
            ["openssl", "s_client", "-connect", `127.0.0.1:${s.addr.port}`, "-servername", OWN],
            { input: "", stdout: "piped", stderr: "piped" },
          );
          return r.stdout.match(/subject=.*CN\s*=\s*(\w+)/)?.[1];
        };
        assertEquals(await subject(), "one");
        await s.setCertificate(await cert("two"));
        assertEquals(await subject(), "two", "a renewal is served without a restart");
      } finally {
        await s.shutdown();
      }
    } finally {
      await fs.remove(dir, { recursive: true });
    }
    // The Host check: the two names (port 443: no port in Host), never another.
    const { handler } = await consoleWith(fakePasskeys(), recorder());
    for (const host of [OWN, NAMES.base]) {
      assertEquals(
        (await handler(new Request(`https://${host}/`, { headers: { host } }))).status,
        401,
        host,
      );
    }
    for (const host of ["evil.example", `${OWN}:8443`, "beta-pc.stolos.lab.example.net"]) {
      assertEquals(
        (await handler(new Request(`https://${host}/`, { headers: { host } }))).status,
        421,
        host,
      );
    }
    // The launch link never works on the LAN names.
    assertEquals(
      (await handler(new Request(`https://${OWN}/launch?t=x`, { headers: { host: OWN } }))).status,
      404,
    );
    assertStringIncludes(consoleFirewallCommand("windows", 443), "-Profile Private,Domain");
    assert(!consoleFirewallCommand("windows", 443).includes("Public"));
  },
);

// ------------------------------------------------------------------ helpers for the console

/** Passkeys that accept what the test says (for the flows that are not about cryptography). */
function fakePasskeys(): Passkeys {
  return {
    registrationOptions: (o) => ({ challenge: o.challenge }),
    authenticationOptions: (o) => ({ challenge: o.challenge }),
    verifyRegistration: (o) => {
      const r = o.response as { id: string; ok?: boolean };
      return Promise.resolve(
        r.ok === false
          ? { kind: "err", error: "a bad signature" }
          : {
              kind: "ok",
              value: {
                credentialId: r.id,
                publicKey: "pQ",
                alg: -8,
                signCount: 0,
                userVerified: true,
                backedUp: false,
              },
            },
      );
    },
    verifyAuthentication: (o) => {
      const r = o.response as { ok?: boolean };
      return Promise.resolve(
        r.ok === false
          ? { kind: "err", error: "a bad signature" }
          : {
              kind: "ok",
              value: { signCount: o.credential.signCount + 1, userVerified: true, backedUp: false },
            },
      );
    },
  };
}

const SIGNERS = [
  { name: "alice-daily", role: "daily" as const, key: "ssh-ed25519 AAAA", added: "2026-11-01" },
  { name: "bob-daily", role: "daily" as const, key: "ssh-ed25519 BBBB", added: "2026-11-01" },
];

/** A console with remote access over a fake repository (git answers as the test says). */
async function consoleWith(
  passkeys: Passkeys,
  rec: ReturnType<typeof recorder>,
  o: { repo?: string; localSigners?: string[]; sessions?: Sessions; now?: () => number } = {},
): Promise<{
  handler: ReturnType<typeof stolosHandler>;
  access: RemoteAccess;
  sessions: Sessions;
  state: string;
}> {
  const state = await fs.makeTempDir();
  const access = new RemoteAccess({
    names: NAMES,
    fleet: { id: "lab", title: "Example lab fleet", branch: "main" },
    repo: o.repo ?? state,
    localSigners: new Set(o.localSigners ?? ["alice-daily"]),
    passkeys,
    statePath: path.join(state, "console-access.json"),
    allowedFile: path.join(state, "allowed_signers"),
    activity: rec.activity,
    mail: (ev) => rec.mail(ev),
    ...(o.now ? { now: o.now } : {}),
  });
  await access.load();
  const remote: ConsoleRemote = {
    access,
    hosts: [...NAMES.served],
    signers: () => Promise.resolve(SIGNERS),
    view: () => ({ listener: { address: "10.0.0.5", port: 443 } }),
    controller: `https://${NAMES.base}`,
  };
  const sessions = o.sessions ?? new Sessions();
  const extra: Partial<StolosDeps> = { remote, activity: rec.activity, sessions };
  const { handler } = await fakeConsole(8091, extra);
  return { handler, access, sessions, state };
}

const lanReq = (p: string, init: RequestInit & { cookie?: string } = {}): Request =>
  new Request(`https://${OWN}${p}`, {
    ...init,
    headers: {
      host: OWN,
      ...(init.body ? { "content-type": "application/json", origin: ORIGIN } : {}),
      ...(init.cookie ? { cookie: init.cookie } : {}),
      "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Safari/605.1",
    },
  });
const INFO = { remoteAddr: { hostname: "10.0.0.23", port: 50000 } };

// ------------------------------------------------------------------ FR-004 .. FR-008, end to end

proves(
  [
    "100-remote-access FR-004",
    "100-remote-access FR-005",
    "100-remote-access FR-006",
    "100-remote-access FR-007",
    "100-remote-access FR-008",
    "100-remote-access FR-011",
  ],
  "100: a passkey registered, approved with a signed commit by devices approve, honoured from the signed tip, signed in; an unsigned tip refused; revoked",
  async () => {
    const sb = await sandbox("archon-access-");
    let server: Awaited<ReturnType<typeof serve>> | undefined;
    try {
      const home = sb.home;
      const PASS = "correct horse battery staple";
      const askpass = await askpassHelper(home, PASS);
      const gitconfig = path.join(home, "gitconfig");
      await fs.writeTextFile(gitconfig, "[user]\n\tname = t\n\temail = t@example.invalid\n");
      const env: Record<string, string> = {
        GIT_CONFIG_GLOBAL: gitconfig,
        GIT_CONFIG_NOSYSTEM: "1",
        ARCHON_TEST_PASSPHRASE: PASS,
        SSH_ASKPASS: askpass,
        SSH_ASKPASS_REQUIRE: "force",
        DISPLAY: ":0",
        SSH_AUTH_SOCK: path.join(home, "no-agent"),
        NO_PROXY: "127.0.0.1,localhost",
        no_proxy: "127.0.0.1,localhost",
      };
      const sh = async (cwd: string, ...a: string[]) => {
        const r = await proc.output(a, {
          cwd,
          env: { ...proc.env.toObject(), ...env, HOME: home },
          stdin: "null",
        });
        if (!r.success) throw new Error(`${a.join(" ")}: ${new TextDecoder().decode(r.stderr)}`);
        return new TextDecoder().decode(r.stdout).trim();
      };
      const origin = path.join(home, "origin.git");
      const repo = path.join(home, "fleet");
      await sh(home, "git", "init", "-q", "--bare", "-b", "main", origin);
      await sh(home, "git", "clone", "-q", origin, repo);
      await fs.mkdir(path.join(repo, "fleets"), { recursive: true });
      await sh(".", "cp", "-r", "examples/fleets/lab", path.join(repo, "fleets", "lab"));
      await linkEngine(repo);
      await fs.remove(path.join(repo, "fleets", "lab", "signers.ts")).catch(() => {});
      await fs.writeTextFile(path.join(repo, ".gitignore"), "out/\nnode_modules/\n");
      await fs.writeTextFile(
        path.join(repo, "package.json"),
        JSON.stringify({
          scripts: { stolos: `bun ${path.toPosix(proc.cwd())}/src/stolos/main.ts` },
        }) + "\n",
      );
      const stolos = (args: string[]) =>
        sb.run("src/stolos/main.ts", args, "", { ...env, ARCHON_REPO: repo, ARCHON_FLEET: "lab" });
      assertEquals((await stolos(["keys", "setup"])).code, 0);
      let r = await stolos(["apply", "-m", "lab: the fleet and its signers"]);
      assertEquals(r.code, 0, r.out);
      const { parseSignersSource } = await import("../src/archon/identity/keys.ts");
      const signers = parseSignersSource(
        await fs.readTextFile(path.join(repo, "fleets/lab/signers.ts")),
      );
      const me = signers.find((s) => s.role === "daily")?.name ?? "";
      assert(me, "keys setup listed a daily signer");

      // The controller: this test's process, over the sandbox's checkout (git as the test's user,
      // with the sandbox's Git settings).
      const rec = recorder();
      const git = async (args: string[]) => {
        const o = await proc.output(["git", "-C", repo, ...args], {
          env: { ...proc.env.toObject(), ...env, HOME: home },
          stdin: "null",
        });
        const dec = new TextDecoder();
        return {
          ok: o.success,
          code: o.code,
          stdout: dec.decode(o.stdout),
          stderr: dec.decode(o.stderr),
        };
      };
      const state = await fs.makeTempDir();
      const access = new RemoteAccess({
        names: NAMES,
        fleet: { id: "lab", title: "Example lab fleet", branch: "main" },
        repo,
        localSigners: new Set([me]),
        passkeys: commonsPasskeys(),
        statePath: path.join(state, "console-access.json"),
        allowedFile: path.join(state, "allowed_signers"),
        activity: rec.activity,
        mail: (ev) => rec.mail(ev),
        git,
      });
      await access.load();
      const box: { handler?: ReturnType<typeof stolosHandler> } = {};
      server = await serve({ hostname: "127.0.0.1", port: 0 }, (req, info) =>
        box.handler ? box.handler(req, info) : new Response("not yet", { status: 503 }),
      );
      const port = server.addr.port;
      const { loadSigners } = await import("../src/archon/identity/signers.ts");
      const handler = (
        await fakeConsole(port, {
          remote: {
            access,
            hosts: [...NAMES.served],
            signers: () => loadSigners(path.join(repo, "fleets/lab/signers.ts")),
            view: () => ({}),
            controller: `https://${NAMES.base}`,
          },
          activity: rec.activity,
        })
      ).handler;
      box.handler = handler;
      await access.refresh({ fetch: true });
      assertEquals(access.devices(), [], "no access.ts yet");

      // FR-004: a device registers: the signer, a name, a passkey made now.
      const phone = await authenticator();
      const welcome = await handler(lanReq("/"), INFO);
      assertEquals(welcome.status, 401);
      const page = await welcome.text();
      assertStringIncludes(page, "Sign in with your passkey");
      assertStringIncludes(page, `<option value="${me}">`);
      assertStringIncludes(page, 'value="iPhone (Safari)"');
      const opts = (await (
        await handler(
          lanReq("/access/register/options", {
            method: "POST",
            body: JSON.stringify({ signer: me, name: "Alice's phone" }),
          }),
          INFO,
        )
      ).json()) as { ticket: string; options: { rp: { id: string } } };
      assertEquals(opts.options.rp.id, "lab.example.net", "the relying party is the web domain");
      // A wrong origin is refused by WebAuthn.
      const fin = async (origin: string, o: { ticket: string; options: unknown }) =>
        (await (
          await handler(
            lanReq("/access/register/finish", {
              method: "POST",
              body: JSON.stringify({
                ticket: o.ticket,
                response: await phone.create(o.options, origin),
              }),
            }),
            INFO,
          )
        ).json()) as { code?: string; error?: string };
      const evil = await fin("https://evil.example", opts);
      assert(evil.error, "a passkey made for another origin");
      const opts2 = (await (
        await handler(
          lanReq("/access/register/options", {
            method: "POST",
            body: JSON.stringify({ signer: me, name: "Alice's phone" }),
          }),
          INFO,
        )
      ).json()) as { ticket: string; options: { rp: { id: string } } };
      const done = await fin(ORIGIN, opts2);
      const code = done.code ?? "";
      assert(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/.test(code), code);
      assertEquals(access.status(code), "waiting");
      assert(
        rec.mails.some((m) => m.event.includes("wants to sign in")),
        "mail: registered",
      );
      // The public fields, for an approver (no secret: a public key only).
      const pub = (await (
        await handler(
          new Request(`http://127.0.0.1:${port}/access/pending/${code}`, {
            headers: { host: `127.0.0.1:${port}` },
          }),
        )
      ).json()) as Record<string, unknown>;
      assertEquals(pub["signer"], me);
      assertEquals(pendingFrom(pub)?.credential.id, phone.id);

      // FR-005: a signer approves on their PC: access.ts written, applied, signed by their key.
      r = await stolos([
        "devices",
        "approve",
        code,
        "--controller",
        `http://127.0.0.1:${port}`,
        "--yes",
      ]);
      assertEquals(r.code, 0, r.out);
      assertEquals(
        await sh(origin, "git", "log", "-1", "--format=%s", "main"),
        `100-remote-access: approve Alice's phone for ${me}`,
      );
      const written = parseAccess(await fs.readTextFile(path.join(repo, "fleets/lab/access.ts")));
      assertEquals(written.length, 1);
      assertEquals(written[0]?.approvedBy, me);
      assertEquals(written[0]?.credential.id, phone.id);
      assert(!(await fs.readTextFile(path.join(repo, "fleets/lab/access.ts"))).includes("PRIVATE"));

      // FR-006: the controller honours it from the signed tip.
      const read = await access.refresh();
      assertEquals(read.refused, undefined);
      assertEquals(
        read.added.map((d) => d.name),
        ["Alice's phone"],
      );
      assertEquals(access.status(code), "approved");
      assert(
        rec.mails.some((m) => m.event.includes("approved for")),
        "mail: approved",
      );

      // FR-007: sign in with the passkey.
      const so = (await (
        await handler(lanReq("/access/signin/options", { method: "POST", body: "{}" }), INFO)
      ).json()) as { ticket: string; options: unknown };
      const signin = await handler(
        lanReq("/access/signin/finish", {
          method: "POST",
          body: JSON.stringify({
            ticket: so.ticket,
            response: await phone.get(so.options, ORIGIN),
          }),
        }),
        INFO,
      );
      assertEquals(signin.status, 200);
      const setCookie = signin.headers.get("set-cookie") ?? "";
      for (const flag of ["Secure", "HttpOnly", "SameSite=Strict"])
        assertStringIncludes(setCookie, flag);
      const cookie = setCookie.split(";")[0] ?? "";
      const home1 = await handler(lanReq("/", { cookie }), INFO);
      assertEquals(home1.status, 200);
      assertStringIncludes(await home1.text(), "Overview");
      assertEquals(access.use()[written[0]?.id ?? ""]?.lastFrom, "10.0.0.23");
      assertEquals(access.use()[written[0]?.id ?? ""]?.signCount, 1);
      // The device's cookie does not work on 127.0.0.1 (this PC's own session is the launch link's).
      assertEquals(
        (
          await handler(
            new Request(`http://127.0.0.1:${port}/`, {
              headers: { host: `127.0.0.1:${port}`, cookie },
            }),
          )
        ).status,
        401,
      );
      // A replayed sign-in (the same answer again) is refused.
      const replay = await handler(
        lanReq("/access/signin/finish", {
          method: "POST",
          body: JSON.stringify({ ticket: so.ticket, response: {} }),
        }),
        INFO,
      );
      assertEquals(replay.status, 401);

      // FR-006: an unsigned commit on GitHub that adds a device is not honoured.
      const extra = deviceOf(
        {
          code: "X",
          signer: me,
          deviceName: "Mallory",
          credential: { id: "bWFsbG9yeQ", publicKey: "pQ", alg: -8 },
          backedUp: false,
          from: "10.0.0.66",
          userAgent: "x",
          created: new Date().toISOString(),
          expires: "",
        },
        me,
      );
      await fs.writeTextFile(
        path.join(repo, "fleets/lab/access.ts"),
        accessSource([...written, extra]),
      );
      await sh(repo, "git", "add", "-A");
      await sh(repo, "git", "commit", "-q", "--no-gpg-sign", "-m", "unsigned");
      await sh(repo, "git", "push", "-q", "--no-verify", "origin", "main");
      const bad = await access.refresh();
      assert(bad.refused, "refused");
      assertEquals(
        access.devices().map((d) => d.name),
        ["Alice's phone"],
      );
      // Undo it, as an owner would (signed, on top).
      await fs.writeTextFile(path.join(repo, "fleets/lab/access.ts"), accessSource(written));
      r = await stolos(["apply", "-m", "lab: undo the unsigned device"]);
      assertEquals(r.code, 0, r.out);
      assertEquals((await access.refresh()).refused, undefined);

      // FR-008: revoke: removed, signed, honoured; the session ends.
      r = await stolos(["devices"]);
      assertStringIncludes(r.out, "Alice's phone");
      r = await stolos(["devices", "revoke", written[0]?.id ?? "", "--yes"]);
      assertEquals(r.code, 0, r.out);
      assertStringIncludes(
        await sh(origin, "git", "log", "-1", "--format=%s", "main"),
        "100-remote-access: revoke Alice's phone",
      );
      const after = await access.refresh();
      assertEquals(
        after.removed.map((d) => d.name),
        ["Alice's phone"],
      );
      assertEquals(access.devices(), []);
      assertEquals((await handler(lanReq("/", { cookie }), INFO)).status, 401, "the session ended");
      assert(
        rec.mails.some((m) => m.event.includes("revoked")),
        "mail: revoked",
      );
      assert(
        rec.log.every((e) => !JSON.stringify(e).includes(PASS)),
        "no passphrase in the record",
      );
    } finally {
      await server?.shutdown();
      await fs.remove(sb.home, { recursive: true });
    }
  },
  { timeout: 180_000 },
);

// ------------------------------------------------------------------ FR-004, FR-007 with fakes

proves(
  ["100-remote-access FR-004", "100-remote-access FR-007", "100-remote-access FR-011"],
  "100: codes expire, deny drops one, five failures pause an address and mail",
  async () => {
    let t = NOW;
    const store = new PendingStore(() => t);
    const p = store.add({
      signer: "alice-daily",
      deviceName: "x",
      credential: { id: "aWQ", publicKey: "pQ", alg: -8 },
      backedUp: false,
      from: "10.0.0.2",
      userAgent: "ua",
    });
    assertEquals(
      store.get(p.code.toLowerCase().replace("-", ""))?.code,
      p.code,
      "typed in any case, with or without the dash",
    );
    t += PENDING_TTL_MS + 1;
    assertEquals(store.get(p.code), undefined, "15 minutes, then gone");

    const rec = recorder();
    const { handler, access } = await consoleWith(fakePasskeys(), rec);
    const post = (p2: string, body: unknown, from = "10.0.0.23") =>
      handler(lanReq(p2, { method: "POST", body: JSON.stringify(body) }), {
        remoteAddr: { hostname: from, port: 1 },
      });
    // Not a signer: refused before any passkey is made.
    assertEquals(
      (await post("/access/register/options", { signer: "mallory", name: "x" })).status,
      400,
    );
    const o = (await (
      await post("/access/register/options", { signer: "bob-daily", name: "Bob's laptop" })
    ).json()) as { ticket: string };
    const f = (await (
      await post("/access/register/finish", { ticket: o.ticket, response: { id: "Ym9i" } })
    ).json()) as { code: string };
    // A cross-site POST is refused.
    const cross = await handler(
      new Request(`https://${OWN}/access/register/options`, {
        method: "POST",
        headers: { host: OWN, origin: "https://evil.example", "content-type": "application/json" },
        body: "{}",
      }),
      INFO,
    );
    assertEquals(cross.status, 403);
    assert(await access.deny(f.code, "alice", "this PC"));
    assertEquals(access.status(f.code), "gone");
    assert(
      rec.mails.some((m) => m.event.includes("denied")),
      "mail: denied",
    );
    assert(
      rec.log.some((e) => e.kind === "access" && e.detail.startsWith("denied")),
      "recorded",
    );

    // Five failed sign-ins in a minute from one address: paused, and one mail.
    access.state.devices = [{ ...DEVICE, credential: { ...DEVICE.credential, id: "ZGV2" } }];
    for (let i = 0; i < 5; i++) {
      const so = (await (await post("/access/signin/options", {}, "10.0.0.66")).json()) as {
        ticket: string;
      };
      assertEquals(
        (
          await post(
            "/access/signin/finish",
            { ticket: so.ticket, response: { id: "ZGV2", ok: false } },
            "10.0.0.66",
          )
        ).status,
        401,
      );
    }
    assertEquals((await post("/access/signin/options", {}, "10.0.0.66")).status, 400, "paused");
    assertEquals(rec.mails.filter((m) => m.event.includes("five failed sign-ins")).length, 1);
    assertEquals(rec.log.filter((e) => e.kind === "sign-in failed").length, 5);
    // Another address is not paused.
    assertEquals((await post("/access/signin/options", {}, "10.0.0.67")).status, 200);
    // Wrong codes count too.
    for (let i = 0; i < 5; i++) {
      await handler(lanReq("/access/pending/AAAA-AAAA"), {
        remoteAddr: { hostname: "10.0.0.99", port: 1 },
      });
    }
    assertEquals(
      (
        await handler(lanReq("/access/pending/AAAA-AAAA"), {
          remoteAddr: { hostname: "10.0.0.99", port: 1 },
        })
      ).status,
      429,
    );
    assertEquals(
      defaultDeviceName(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0 Safari/537.36 Edg/130.0",
      ),
      "Windows PC (Edge)",
    );
    assertEquals(controllerUrl(undefined, FLEET), "https://stolos.lab.example.net");
    assertEquals(controllerUrl("http://203.0.113.5", FLEET), {
      why: "the controller is reached over HTTPS (plain HTTP only on 127.0.0.1)",
    });
  },
);

// ------------------------------------------------------------------ FR-009

proves(
  ["100-remote-access FR-009"],
  "100: a signer whose key is here runs anything; another looks only and is told where to run it",
  async () => {
    const rec = recorder();
    const sessions = new Sessions();
    const { handler, access } = await consoleWith(fakePasskeys(), rec, {
      sessions,
      localSigners: ["alice-daily"],
    });
    access.state.devices = [
      DEVICE,
      { ...DEVICE, id: "Ym9ib2JvYm9ib2Jv", signer: "bob-daily", name: "Bob's laptop" },
    ];
    const cookieFor = (signer: string) => {
      const s = sessions.create({ user: signer, name: signer, groups: [] }, "10.0.0.23");
      access.bind(s.id, access.devices().find((d) => d.signer === signer) ?? DEVICE, "10.0.0.23");
      return `stolos_session=${s.id}`;
    };
    const runAs = async (cookie: string, command: string) =>
      await (
        await handler(
          new Request(`https://${OWN}/actions/run`, {
            method: "POST",
            headers: { host: OWN, cookie, origin: ORIGIN, "datastar-request": "true" },
            body: new URLSearchParams({ command }),
          }),
          INFO,
        )
      ).text();
    const bob = cookieFor("bob-daily");
    const refused = await runAs(bob, "apply");
    assertStringIncludes(
      refused,
      "This would be signed by alice-daily&#39;s key: run it from your PC: bun run stolos apply",
    );
    assert(rec.log.some((e) => e.kind === "refused" && e.user === "bob-daily"));
    assert(!(await runAs(bob, "where")).includes("would be signed"), "a read-only command runs");
    const alice = cookieFor("alice-daily");
    assert(!(await runAs(alice, "apply")).includes("would be signed"), "the owner runs it");
    // The Remote Access page: Approve, Deny and Revoke only for a signer who may sign here.
    access.pending.add({
      signer: "bob-daily",
      deviceName: "Bob's phone",
      credential: { id: "cGhvbmU", publicKey: "pQ", alg: -8 },
      backedUp: true,
      from: "10.0.0.31",
      userAgent: "ua",
    });
    const forBob = await (await handler(lanReq("/access", { cookie: bob }), INFO)).text();
    const forAlice = await (await handler(lanReq("/access", { cookie: alice }), INFO)).text();
    assert(
      !forBob.includes(">Approve<") && !forBob.includes(">Revoke<") && !forBob.includes(">Deny<"),
    );
    assertStringIncludes(forBob, "bun run stolos devices approve");
    for (const b of [">Approve<", ">Revoke<", ">Deny<"]) assertStringIncludes(forAlice, b);
    // Deny is refused for a look-only session.
    const deny = await handler(
      new Request(`https://${OWN}/access/deny`, {
        method: "POST",
        headers: { host: OWN, cookie: bob, origin: ORIGIN },
        body: new URLSearchParams({ code: "X" }),
      }),
      INFO,
    );
    assertEquals(deny.status, 403);
  },
);

// ------------------------------------------------------------------ FR-010

proves(
  ["100-remote-access FR-010"],
  "100: the Remote Access page: every section, the 90-day review, the CSV, the overview",
  async () => {
    const view: AccessView = {
      fleet: { id: "lab", title: "Example lab fleet" },
      names: NAMES,
      listener: { address: "10.0.0.5", port: 443 },
      tls: {
        names: NAMES.certNames,
        notAfter: "2026-11-25T00:00:00Z",
        directory: "https://acme-v02.api.letsencrypt.org/directory",
      },
      other: { pc: "beta-pc", at: "2026-11-16T11:58:00Z" },
      signers: SIGNERS,
      localSigners: ["alice-daily"],
      devices: [DEVICE],
      use: {},
      pending: [],
      events: [
        {
          at: "2026-11-16T11:00:00Z",
          user: "10.0.0.66",
          from: "10.0.0.66",
          kind: "sign-in failed",
          detail: "a passkey that is not approved",
        },
      ],
      may: true,
      controller: "http://127.0.0.1:8091",
      now: Date.parse("2026-11-16T12:00:00Z") + 100 * 86_400_000,
    };
    const h = String(accessPage(view));
    for (const id of [
      "addresses",
      "listener",
      "certificate",
      "pending",
      "signers",
      "devices",
      "events",
    ]) {
      assertStringIncludes(h, `id="${id}"`);
    }
    for (const s of [
      "https://stolos.lab.example.net",
      "this PC is the primary controller",
      "also open on beta-pc",
      "Let&#39;s Encrypt",
      "may sign here",
      "looks only",
      "synced",
      "10.0.0.23",
      "unused for 90 days: review or revoke",
      "a passkey that is not approved",
      "/export/access.csv",
      "sequenceDiagram",
    ]) {
      assertStringIncludes(h, s);
    }
    assertEquals(unusedDevices([DEVICE], {}, view.now).length, 1);
    assertEquals(
      unusedDevices(
        [DEVICE],
        { [DEVICE.id]: { signCount: 3, lastUsed: new Date(view.now - 86_400_000).toISOString() } },
        view.now,
      ).length,
      0,
    );
    // Through the console: the menu, the page, the CSV, the Overview's Needs attention.
    const rec = recorder();
    const { handler, access, sessions } = await consoleWith(fakePasskeys(), rec);
    const waiting = access.pending.add({
      signer: "alice-daily",
      deviceName: "Phone",
      credential: { id: "cGg", publicKey: "pQ", alg: -8 },
      backedUp: false,
      from: "10.0.0.31",
      userAgent: "ua",
    });
    const s = sessions.create({ user: "alice", name: "Alice", groups: ["archon-ops"] }, "this PC");
    const local = (p: string) =>
      handler(
        new Request(`http://127.0.0.1:8091${p}`, {
          headers: { host: "127.0.0.1:8091", cookie: `stolos_session=${s.id}` },
        }),
      );
    const pageText = await (await local("/access")).text();
    assertStringIncludes(pageText, 'href="/access"');
    assertStringIncludes(pageText, "Remote Access");
    assertStringIncludes(pageText, "cmd=devices%20approve&amp;code=");
    assertStringIncludes(await (await local("/")).text(), "1 device(s) waiting for a signer");
    await access.deny(waiting.code, "alice", "this PC");
    const csv = await local("/export/access.csv");
    assertStringIncludes(csv.headers.get("content-type") ?? "", "text/csv");
    assertStringIncludes(await csv.text(), "denied Phone for alice-daily");
  },
);

// ------------------------------------------------------------------ FR-011

proves(
  ["100-remote-access FR-011"],
  "100: the daily digest of remote use, once a day across restarts; no secret",
  async () => {
    let t = NOW;
    const rec = recorder();
    const { access, state } = await consoleWith(fakePasskeys(), rec, { now: () => t });
    await rec.activity.add({
      at: new Date(t - 3600_000).toISOString(),
      user: "alice-daily",
      from: "10.0.0.23",
      kind: "sign-in",
      detail: "passkey: iPhone",
    });
    await rec.activity.add({
      at: new Date(t - 1800_000).toISOString(),
      user: "alice-daily",
      from: "10.0.0.23",
      kind: "run",
      detail: "bun run stolos where",
      code: 0,
    });
    await rec.activity.add({
      at: new Date(t - 1800_000).toISOString(),
      user: "alice",
      from: "this PC",
      kind: "run",
      detail: "bun run stolos apply",
      code: 0,
    });
    assert(await access.digest(), "sent");
    const m = rec.mails.at(-1);
    assertStringIncludes(m?.what ?? "", "alice-daily  from 10.0.0.23  signed in (passkey: iPhone)");
    assertStringIncludes(m?.what ?? "", "ran: bun run stolos where");
    assert(!(m?.what ?? "").includes("stolos apply"), "this PC's own commands are not remote use");
    // A restart an hour later does not send it again (the last digest is in local state).
    t += 3600_000;
    const again = new RemoteAccess({
      names: NAMES,
      fleet: { id: "lab", title: "Example lab fleet", branch: "main" },
      repo: state,
      localSigners: new Set(),
      passkeys: fakePasskeys(),
      statePath: path.join(state, "console-access.json"),
      allowedFile: path.join(state, "allowed_signers"),
      activity: rec.activity,
      mail: (ev) => rec.mail(ev),
      now: () => t,
    });
    await again.load();
    assert(!(await again.digest()), "not twice a day");
    assertEquals(
      digestText([]).split("\n")[0],
      "Sign-ins and commands from devices other than this PC (spec 100):",
    );
  },
);

// ------------------------------------------------------------------ FR-012

proves(
  ["100-remote-access FR-012"],
  "100: the doctor's lines (⚡ for the certificate, unused devices, the firewall) and the controller policy",
  () => {
    const now = NOW;
    assertEquals(
      accessDoctor({ configured: false, unused: 0, devices: 0 }, now, [], "linux")[0]?.level,
      "hint",
    );
    const lines = accessDoctor(
      {
        configured: true,
        listening: { address: "10.0.0.5", port: 443, at: new Date(now - 60_000).toISOString() },
        notAfter: new Date(now + 5 * 86_400_000).toISOString(),
        unused: 1,
        devices: 2,
      },
      now,
      ["ufw: may be blocked"],
      "windows",
    );
    assertStringIncludes(lines[0]?.msg ?? "", "LAN listener on");
    const actions = lines.filter((l) => l.level === "action").map((l) => l.msg);
    assertEquals(actions.length, 3, JSON.stringify(lines));
    assertStringIncludes(actions[0] ?? "", "expires in 5 day(s)");
    assertStringIncludes(actions[1] ?? "", "unused for 90 days");
    assertStringIncludes(lines.at(-1)?.fix ?? "", "New-NetFirewallRule");
    assert(
      !lines.some((l) => (l.level as string) === "fail" || (l.level as string) === "warn"),
      "never a failure",
    );
    const off = accessDoctor(
      {
        configured: true,
        unused: 0,
        devices: 0,
        notAfter: new Date(now + 60 * 86_400_000).toISOString(),
      },
      now,
      [],
      "linux",
    );
    assertStringIncludes(off[0]?.msg ?? "", "LAN listener off");
    assertEquals(off.filter((l) => l.level === "action").length, 0);

    const machine: AdoptedDef = {
      name: PC,
      role: "controller",
      ssh: { user: "alice", address: PC },
      hostKeys: [],
      adopted: "2026-11-16T00:00:00Z",
    };
    const base = {
      at: "2026-11-16T11:00:00Z",
      probe: "2",
      os: {
        family: "windows",
        name: "Windows 11",
        version: "26200",
        kernel: "Windows",
        arch: "AMD64",
        hostname: PC,
      },
      hardware: {},
      security: {
        diskEncryption: "on",
        firewall: "on",
        autoUpdates: "on",
        antivirus: "on",
        admins: ["alice"],
      },
      software: {},
      listening: [],
    } as unknown as Observed;
    const ctl = {
      signingKey: "locked" as const,
      backup: "current" as const,
      unbacked: 0,
      recoveryInVault: true,
    };
    const st = (ra: unknown) =>
      policies(
        machine,
        { ...base, controller: { ...ctl, ...(ra ? { remoteAccess: ra } : {}) } } as Observed,
        now,
      ).find((r) => r.id === "controller-remote-access");
    assertEquals(st(undefined), undefined, "no remote access: no policy");
    assertEquals(
      st({ certificate: new Date(now + 40 * 86_400_000).toISOString(), devices: 2, unused: 0 })
        ?.status,
      "pass",
    );
    assertEquals(
      st({ certificate: new Date(now - 86_400_000).toISOString(), devices: 2, unused: 0 })?.status,
      "fail",
    );
    const due = st({
      certificate: new Date(now + 40 * 86_400_000).toISOString(),
      devices: 2,
      unused: 1,
    });
    assertEquals(due?.status, "fail");
    assertStringIncludes(due?.fix ?? "", "devices revoke");
  },
);

// ------------------------------------------------------------------ FR-013, and access.ts

proves(
  ["100-remote-access FR-013", "100-remote-access FR-005"],
  "100: SCF labels already in the catalog; access.ts is a decision, read back without running it",
  async () => {
    const text = await fs.readTextFile("src/archon/compliance/scf.ts");
    const { ADOPTED_CONTROLS } = await import("../src/archon/adopt/policy.ts");
    const c = ADOPTED_CONTROLS.find((x) => x.id === "controller-remote-access");
    assert(c, "the controller's remote access policy");
    for (const id of [...(c.scf ?? []), "IAC-30", "CHG-03"])
      assertStringIncludes(text, `id: "${id}"`);
    assertEquals(c.scf, ["CRY-05", "IAC-14", "IAC-12"]);
    const src = accessSource([DEVICE]);
    assertStringIncludes(src, "export const access: ConsoleDevice[] = [");
    assertStringIncludes(src, "Written by stolos devices approve");
    assertEquals(parseAccess(src), [DEVICE]);
    assertEquals(parseAccess("export const access = [(() => 1)()];"), [], "never run");
    assertEquals(decisionOf("fleets/lab/access.ts"), "who may sign in to the console (access.ts)");
    assertEquals(
      splitChanges(["fleets/lab/access.ts"]).records,
      [],
      "not a record update sends by itself",
    );
    assertEquals(yoursNamed("fleets/lab/access.ts"), "who may sign in to the console (access.ts)");
  },
);
