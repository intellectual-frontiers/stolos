// Spec 092, part B: delivery of exports. The DER encoder against known
// vectors; S/MIME (CMS AuthEnvelopedData, AES-256-GCM, RSA-OAEP SHA-256)
// opened by our own reader and by `openssl cms -decrypt` (when openssl is
// here; CI on Ubuntu has it); the collector-or-file choice; per-tenant jobs;
// the scheduled job for Windows, macOS and Linux; the SMTP dialogue with a
// fake server over TLS (curl, as the fleet's mail already uses), refusing to
// send without TLS; and no secret in job files, run records, or errors.

import { assert, assertEquals, assertStringIncludes } from "./assert.ts";
import { fleet } from "./fixtures.ts";
import {
  children,
  encodeLength,
  fromHex,
  hex,
  integer,
  octetString,
  oid,
  readOid,
  readTlv,
  sequence,
  setOf,
  tlv,
} from "../src/archon/export/der.ts";
import {
  authEnveloped,
  certificateProblem,
  OID,
  parseCertificate,
  type RecipientCert,
  smimeMessage,
} from "../src/archon/export/smime.ts";
import {
  deliveryPlan,
  emailFiles,
  type ExportDocument,
  type ExportSource,
  otlpLogs,
  otlpSignal,
  type RunDeps,
  runJob,
} from "../src/archon/export/deliver.ts";
import {
  jobSender,
  tenantFilter,
  tenantMatches,
  validateExportJobs,
} from "../src/archon/export/jobs.ts";
import {
  linuxJob,
  macJob,
  onCalendar,
  scheduledJob,
  type ScheduleInput,
  windowsJob,
} from "../src/archon/export/schedule.ts";
import { type Credential, sendSmtp, smtpConfig } from "../src/archon/notify/transport.ts";
import { validateFleet } from "../src/archon/model/validate.ts";
import type { ExportJobDef, ExportKind, FleetDef } from "../src/archon/model/types.ts";
import { COMMANDS } from "../src/archon/commands/registry.ts";

const enc = new TextEncoder();
const dec = new TextDecoder();
/** A credential the tests must never find again anywhere it should not be. */
const SECRET: Credential = {
  token: "cfat_SECRETsecretSECRETsecret0123456789abcd",
  created: "2026-11-15T00:00:00Z",
};

async function has(cmd: string): Promise<boolean> {
  try {
    const o = await new Deno.Command(cmd, { args: ["--version"], stdout: "null", stderr: "null" })
      .output();
    return o.success || o.code !== 127;
  } catch {
    return false;
  }
}
const OPENSSL = await has("openssl") &&
  (await new Deno.Command("openssl", { args: ["version"], stdout: "null", stderr: "null" })
    .output().then((o) => o.success).catch(() => false));
const CURL = await has("curl");

async function sh(cmd: string, args: string[], cwd?: string): Promise<string> {
  const o = await new Deno.Command(cmd, { args, cwd, stdout: "piped", stderr: "piped" }).output();
  if (!o.success) throw new Error(`${cmd} ${args.join(" ")}: ${dec.decode(o.stderr)}`);
  return dec.decode(o.stdout);
}

/** A key and a self-signed certificate made with openssl (RSA 2048, for this address). */
async function opensslCert(dir: string, name: string, email: string, extra: string[] = []) {
  await sh("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    `${dir}/${name}.key`,
    "-out",
    `${dir}/${name}.pem`,
    "-subj",
    `/CN=${name}`,
    "-addext",
    `subjectAltName=email:${email}`,
    "-days",
    "2",
    ...extra,
  ]);
  return { key: `${dir}/${name}.key`, cert: `${dir}/${name}.pem` };
}

// ------------------------------------------------------------------- DER

Deno.test("der: known encodings (X.690)", () => {
  assertEquals(hex(encodeLength(0)), "00");
  assertEquals(hex(encodeLength(127)), "7f");
  assertEquals(hex(encodeLength(128)), "8180");
  assertEquals(hex(encodeLength(200)), "81c8");
  assertEquals(hex(encodeLength(300)), "82012c");
  assertEquals(hex(encodeLength(65536)), "83010000");
  assertEquals(hex(integer(0)), "020100");
  assertEquals(hex(integer(127)), "02017f");
  assertEquals(hex(integer(128)), "02020080");
  assertEquals(hex(integer(256)), "02020100");
  assertEquals(hex(integer(16)), "020110");
  assertEquals(hex(integer(fromHex("00000080"))), "02020080");
  assertEquals(hex(integer(fromHex("ff"))), "020200ff");
  // RSA's rsaEncryption and the RFC's own example (X.690 8.19.5: 2.100.3 is 06 03 81 34 03).
  assertEquals(hex(oid("1.2.840.113549.1.1.1")), "06092a864886f70d010101");
  assertEquals(hex(oid("2.100.3")), "0603813403");
  assertEquals(hex(oid(OID.aes256gcm)), "060960864801650304012e");
  assertEquals(hex(oid(OID.authEnvelopedData)), "060b2a864886f70d0109100117");
  assertEquals(hex(octetString(fromHex("0102"))), "04020102");
  assertEquals(hex(sequence(integer(1), integer(2))), "3006020101020102");
  // SET OF sorts by encoding: 02 01 02 before 02 01 05, and a prefix first.
  assertEquals(hex(setOf(integer(5), integer(2))), "3106020102020105");
  assertEquals(hex(setOf(fromHex("0401ff00"), fromHex("0401ff"))), "31070401ff0401ff00");
  // The reader gives back what the writer wrote.
  const long = tlv(0x04, new Uint8Array(300));
  const r = readTlv(long);
  assertEquals(r.content.length, 300);
  assertEquals(r.raw.length, 304);
  for (const o of ["1.2.840.113549.1.9.16.1.23", "2.100.3", "2.5.29.17", "0.9.2342"]) {
    assertEquals(readOid(readTlv(oid(o)).content), o);
  }
  assertEquals(children(readTlv(sequence(integer(1), integer(2))).content).length, 2);
});

// ------------------------------------------------------------------- S/MIME

/** A recipient made with WebCrypto only (no openssl): a fake issuer, a serial, the key. */
async function webRecipient(): Promise<{ cert: RecipientCert; key: CryptoKey }> {
  const pair = await crypto.subtle.generateKey(
    {
      name: "RSA-OAEP",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["encrypt", "decrypt"],
  );
  const spki = new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey));
  const issuer = sequence(setOf(sequence(oid(OID.commonName), tlv(0x0c, enc.encode("Test CA")))));
  return {
    cert: {
      issuer,
      serial: integer(7),
      spki,
      emails: [],
      keyEncipherment: true,
      serialHex: "07",
    },
    key: pair.privateKey,
  };
}

/** Our own reader for AuthEnvelopedData: proves the structure, for any one recipient's key. */
async function openAuthEnveloped(der: Uint8Array, key: CryptoKey, index = 0): Promise<string> {
  const [ct, inner] = children(readTlv(der).content);
  assertEquals(readOid(ct.content), OID.authEnvelopedData);
  const [version, ris, eci, mac] = children(children(inner.content)[0].content);
  assertEquals(hex(version.raw), "020100");
  const ktri = children(ris.content)[index];
  const [kv, , alg, ek] = children(ktri.content);
  assertEquals(hex(kv.raw), "020100");
  assertEquals(readOid(children(alg.content)[0].content), OID.rsaesOaep);
  const [ctype, calg, encrypted] = children(eci.content);
  assertEquals(readOid(ctype.content), OID.data);
  const [aid, params] = children(calg.content);
  assertEquals(readOid(aid.content), OID.aes256gcm);
  const [nonce, icvLen] = children(params.content);
  assertEquals(nonce.content.length, 12);
  assertEquals(hex(icvLen.raw), "020110");
  assertEquals(encrypted.tag, 0x80);
  assertEquals(mac.content.length, 16);
  const raw = new Uint8Array(
    await crypto.subtle.decrypt({ name: "RSA-OAEP" }, key, new Uint8Array(ek.content)),
  );
  const aes = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["decrypt"]);
  const sealed = new Uint8Array([...encrypted.content, ...mac.content]);
  return dec.decode(
    await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: new Uint8Array(nonce.content), tagLength: 128 },
      aes,
      sealed,
    ),
  );
}

/** The DER inside an S/MIME message (the base64 body). */
function p7m(message: string): Uint8Array {
  const body = message.split("\r\n\r\n").slice(1).join("").replace(/\s+/g, "");
  return Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
}

Deno.test("smime: AuthEnvelopedData opens with each recipient's key, and only theirs", async () => {
  const a = await webRecipient();
  const b = await webRecipient();
  const content = "Content-Type: text/plain\r\n\r\nthe fleet's assessment\r\n";
  const der = await authEnveloped(enc.encode(content), [a.cert, b.cert]);
  // Two recipients, SET OF sorted: find each one's index by trying.
  const opened: string[] = [];
  for (const r of [a, b]) {
    for (const i of [0, 1]) {
      try {
        opened.push(await openAuthEnveloped(der, r.key, i));
        break;
      } catch { /* the other recipient's info */ }
    }
  }
  assertEquals(opened, [content, content]);
  // A stranger's key opens nothing.
  const c = await webRecipient();
  let refused = 0;
  for (const i of [0, 1]) await openAuthEnveloped(der, c.key, i).catch(() => refused++);
  assertEquals(refused, 2);
  // Tampering with the ciphertext fails GCM's tag.
  const bad = new Uint8Array(der);
  bad[bad.length - 20] ^= 1;
  let tampered = false;
  for (const i of [0, 1]) await openAuthEnveloped(bad, a.key, i).catch(() => (tampered = true));
  assert(tampered);
  // The message: RFC 8551's media type, base64, nothing of the content in the clear.
  const msg = await smimeMessage(
    { from: "exports+pc@example.net", to: "auditor@example.com", subject: "x" },
    content,
    [a.cert],
  );
  assertStringIncludes(
    msg,
    'Content-Type: application/pkcs7-mime; smime-type=authEnveloped-data; name="smime.p7m"',
  );
  assert(!msg.includes("assessment"));
  assertEquals(await openAuthEnveloped(p7m(msg), a.key), content);
});

Deno.test({
  name: "smime: openssl cms -decrypt opens our message (interoperability)",
  ignore: !OPENSSL,
  async fn() {
    const dir = await Deno.makeTempDir({ prefix: "stolos-smime-" });
    const r = await opensslCert(dir, "auditor", "auditor@example.com");
    const cert = parseCertificate(await Deno.readTextFile(r.cert));
    assertEquals(cert.subject, "auditor");
    assertEquals(cert.emails, ["auditor@example.com"]);
    assert(cert.notAfter && cert.notAfter > new Date());
    assertEquals(certificateProblem(cert, "auditor@example.com"), undefined);
    assertStringIncludes(
      certificateProblem(cert, "other@example.com")!,
      "names auditor@example.com",
    );
    assertStringIncludes(
      certificateProblem(cert, "auditor@example.com", new Date(Date.now() + 9e9))!,
      "expired",
    );
    // The serial number openssl reports is the one we read.
    const serial = (await sh("openssl", ["x509", "-in", r.cert, "-noout", "-serial"]))
      .trim().split("=")[1].toLowerCase();
    assertEquals(BigInt(`0x${cert.serialHex}`), BigInt(`0x${serial}`));
    // A second recipient: each opens the same message with their own key.
    const r2 = await opensslCert(dir, "second", "second@example.com");
    const cert2 = parseCertificate(await Deno.readTextFile(r2.cert));
    const inner = "Content-Type: text/plain; charset=UTF-8\r\n\r\nhello from the fleet\r\n";
    const msg = await smimeMessage(
      { from: "exports+pc@example.net", to: "auditor@example.com", subject: "test" },
      inner,
      [cert, cert2],
    );
    await Deno.writeTextFile(`${dir}/m.eml`, msg);
    for (const who of [r, r2]) {
      const out = await sh("openssl", [
        "cms",
        "-decrypt",
        "-in",
        `${dir}/m.eml`,
        "-recip",
        who.cert,
        "-inkey",
        who.key,
      ]);
      assertEquals(out.replace(/\r\n/g, "\n"), inner.replace(/\r\n/g, "\n"));
    }
    // Our reader opens it too, with the PKCS #8 key openssl wrote.
    const pem = await Deno.readTextFile(r.key);
    const pk = Uint8Array.from(
      atob(pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "")),
      (c) => c.charCodeAt(0),
    );
    const key = await crypto.subtle.importKey(
      "pkcs8",
      pk,
      { name: "RSA-OAEP", hash: "SHA-256" },
      false,
      ["decrypt"],
    );
    let ours = "";
    for (const i of [0, 1]) {
      ours ||= await openAuthEnveloped(p7m(msg), key, i).catch(() => "");
    }
    assertEquals(ours, inner);
    await Deno.remove(dir, { recursive: true });
  },
});

Deno.test("smime: certificates that cannot be used are refused with a reason", async () => {
  let threw = "";
  try {
    parseCertificate("not a certificate");
  } catch (e) {
    threw = (e as Error).message;
  }
  assertStringIncludes(threw, "no PEM certificate");
  if (!OPENSSL) return;
  const dir = await Deno.makeTempDir({ prefix: "stolos-smime-" });
  await sh("openssl", [
    "req",
    "-x509",
    "-newkey",
    "ec",
    "-pkeyopt",
    "ec_paramgen_curve:P-256",
    "-nodes",
    "-keyout",
    `${dir}/ec.key`,
    "-out",
    `${dir}/ec.pem`,
    "-subj",
    "/CN=ec",
    "-days",
    "2",
  ]);
  threw = "";
  try {
    parseCertificate(await Deno.readTextFile(`${dir}/ec.pem`));
  } catch (e) {
    threw = (e as Error).message;
  }
  assertStringIncludes(threw, "not RSA");
  const sign = await opensslCert(dir, "signer", "s@example.com", [
    "-addext",
    "keyUsage=digitalSignature",
  ]);
  const c = parseCertificate(await Deno.readTextFile(sign.cert));
  assertStringIncludes(certificateProblem(c, "s@example.com")!, "signing only");
  await Deno.remove(dir, { recursive: true });
});

// ------------------------------------------------------------------- jobs

const LAB_MAIL = { to: "fleet@example.net", domain: "example.net", tag: "lab" };

Deno.test("jobs: per-tenant jobs are checked, matched, and send from their own address", () => {
  const f = fleet({
    mail: LAB_MAIL,
    estate: {
      exports: [
        {
          id: "auditor",
          kinds: ["oscal"],
          tenants: ["fleet:lab"],
          email: { to: [{ address: "auditor@example.com", certificate: "certs/auditor.pem" }] },
          schedule: { every: "monthly", at: "06:10", dayOfMonth: 1 },
        },
        {
          id: "acme",
          kinds: ["cyclonedx", "ocsf"],
          tenants: ["aws:*", "microsoft:acme.example"],
          email: {
            to: [{ address: "security@acme.example", certificate: "certs/acme.pem" }],
            from: "reports@acme.example",
            relay: "smtp.acme.example:587",
            credential: "acme",
          },
          schedule: { every: "weekly", weekday: "fri" },
        },
      ],
    },
  });
  assertEquals(validateExportJobs(f), []);
  assertEquals(validateFleet(f, []).filter((p) => p.where.includes("exports")), []);
  const acme = f.estate!.exports![1];
  assert(tenantMatches("aws:*", "aws:123456789012"));
  assert(!tenantMatches("aws:*", "gcp:proj"));
  assert(tenantFilter(acme)("microsoft:acme.example"));
  assert(!tenantFilter(acme)("fleet:lab"));
  assert(tenantFilter({})("anything:at-all"));
  assertEquals(jobSender(f, f.estate!.exports![0], "bootpc"), "exports+bootpc.lab@example.net");
  assertEquals(jobSender(f, acme, "bootpc"), "reports@acme.example");

  const bad = fleet({
    estate: {
      exports: [
        {
          id: "Bad Id",
          kinds: ["pdf" as ExportKind],
          tenants: ["no-colon"],
          email: {
            to: [
              { address: "not-an-address", certificate: "" },
              { address: "x@example.com", certificate: "-----BEGIN PRIVATE KEY-----" },
            ],
            subject: "two\nlines",
          },
          schedule: { every: "yearly" as "daily", at: "25:00", dayOfMonth: 31 },
        },
        { id: "dup", kinds: [] },
        { id: "dup", kinds: ["oscal"] },
      ],
    },
  });
  const msgs = validateExportJobs(bad).map((p) => `${p.where}: ${p.message}`).join("\n");
  for (
    const s of [
      "is not a job id",
      "unknown kind pdf",
      "is not a tenant uid",
      "is not an email address",
      "has no certificate: exports are only emailed encrypted",
      "holds a private key",
      "the fleet has no mail settings",
      "line break",
      "is not a period",
      "is not HH:MM",
      "is not 1 to 28",
      "no kinds",
      "two jobs are named dup",
    ]
  ) {
    assertStringIncludes(msgs, s);
  }
});

// ------------------------------------------------------------------- delivery

const OTLP_DOC: ExportDocument = {
  fileName: "spans.otlp.json",
  mediaType: "application/x-otlp+json",
  bytes: enc.encode(JSON.stringify({ resourceSpans: [] })),
};
const JSON_DOC: ExportDocument = {
  fileName: "inventory.cdx.json",
  mediaType: "application/vnd.cyclonedx+json",
  bytes: enc.encode('{"bomFormat":"CycloneDX"}'),
};
const BIN_DOC: ExportDocument = {
  fileName: "bundle.bin",
  mediaType: "application/octet-stream",
  bytes: new Uint8Array([0, 1, 2, 255]),
};

/** Fake sources: each kind's documents, only for the tenants it covers. */
function fakeSources(seen: string[] = []): (k: ExportKind) => ExportSource | undefined {
  const by: Partial<Record<ExportKind, ExportSource>> = {
    otlp: (ctx) => {
      seen.push(`otlp:${ctx.job.id}`);
      return Promise.resolve(ctx.tenant("aws:1") ? [OTLP_DOC] : []);
    },
    cyclonedx: (ctx) => {
      seen.push(`cyclonedx:${ctx.job.id}`);
      return Promise.resolve(ctx.tenant("aws:1") ? [JSON_DOC, BIN_DOC] : []);
    },
  };
  return (k) => by[k];
}

function fakeFetch(status = 200) {
  const calls: Array<{ url: string; body: string }> = [];
  const fn = ((url: string | URL, init?: RequestInit) => {
    calls.push({
      url: String(url),
      body: String(init?.body instanceof Uint8Array ? dec.decode(init.body) : init?.body),
    });
    return Promise.resolve(new Response("{}", { status }));
  }) as typeof fetch;
  return { fn, calls };
}

async function deps(f: FleetDef, over: Partial<RunDeps> = {}): Promise<RunDeps> {
  return {
    fleet: f,
    fleetDir: await Deno.makeTempDir({ prefix: "stolos-fleet-" }),
    stateDir: await Deno.makeTempDir({ prefix: "stolos-state-" }),
    pc: "bootpc",
    now: new Date("2026-11-15T02:17:00Z"),
    fetch: fakeFetch().fn,
    smtp: () => Promise.resolve("sent"),
    credential: () => Promise.resolve(SECRET),
    source: fakeSources(),
    ...over,
  };
}

Deno.test("deliver: the collector when configured, otherwise a file; a file too when emailed", () => {
  const job: ExportJobDef = { id: "j", kinds: ["otlp"] };
  const withCollector = fleet({ telemetry: { collector: "http://10.0.0.5:4318/" } });
  assertEquals(deliveryPlan(withCollector, job), {
    otlp: "http://10.0.0.5:4318",
    file: false,
    email: false,
  });
  assertEquals(deliveryPlan(fleet(), job), { file: true, email: false });
  assertEquals(deliveryPlan(withCollector, { ...job, otlp: false }), { file: true, email: false });
  const mailed = { ...job, email: { to: [{ address: "a@example.com", certificate: "c.pem" }] } };
  assertEquals(deliveryPlan(withCollector, mailed), {
    otlp: "http://10.0.0.5:4318",
    file: true,
    email: true,
  });
});

Deno.test("deliver: OTLP documents go to their signal, the rest as log records", async () => {
  assertEquals(otlpSignal(OTLP_DOC), "/v1/traces");
  assertEquals(otlpSignal(JSON_DOC), undefined);
  const f = fleet({ telemetry: { collector: "http://10.0.0.5:4318" } });
  const net = fakeFetch();
  const d = await deps(f, { fetch: net.fn });
  const r = await runJob({ id: "aws", kinds: ["otlp", "cyclonedx"], tenants: ["aws:*"] }, d);
  assert(r.ok, r.problems.join("; "));
  assertEquals(r.otlp, { endpoint: "http://10.0.0.5:4318", ok: true });
  assertEquals(r.files, undefined);
  assertEquals(net.calls.map((c) => c.url), [
    "http://10.0.0.5:4318/v1/traces",
    "http://10.0.0.5:4318/v1/logs",
  ]);
  const logs = JSON.parse(net.calls[1].body);
  const records = logs.resourceLogs[0].scopeLogs[0].logRecords;
  assertEquals(records.length, 2);
  assertEquals(records[0].body.stringValue, '{"bomFormat":"CycloneDX"}');
  assertEquals(records[1].body.bytesValue, "AAEC/w==");
  const names = records.map((
    x: { attributes: Array<{ key: string; value: { stringValue: string } }> },
  ) => x.attributes.find((a) => a.key === "stolos.export.file_name")!.value.stringValue);
  assertEquals(names, ["inventory.cdx.json", "bundle.bin"]);
  const direct = await otlpLogs([{ kind: "cyclonedx", doc: JSON_DOC }], {
    fleet: "lab",
    job: "aws",
    now: d.now,
  }) as { resourceLogs: Array<{ resource: { attributes: Array<{ key: string }> } }> };
  assert(direct.resourceLogs[0].resource.attributes.some((a) => a.key === "stolos.fleet"));
});

Deno.test("deliver: no collector, or one that refuses: files in the state directory", async () => {
  const d = await deps(fleet());
  const r = await runJob({ id: "aws", kinds: ["cyclonedx"] }, d);
  assert(r.ok);
  assertEquals(r.files!.length, 2);
  assert(r.files![0].startsWith(`${d.stateDir}/exports/aws/2026-11-15T02-17-00Z/`));
  assertEquals(await Deno.readTextFile(r.files![0]), '{"bomFormat":"CycloneDX"}');
  const last = JSON.parse(await Deno.readTextFile(`${d.stateDir}/exports/aws/last-run.json`));
  assertEquals(last.ok, true);

  const down = fakeFetch(503);
  const d2 = await deps(fleet({ telemetry: { collector: "http://10.0.0.5:4318" } }), {
    fetch: down.fn,
  });
  const r2 = await runJob({ id: "aws", kinds: ["cyclonedx"] }, d2);
  assertEquals(r2.otlp?.ok, false);
  assertEquals(r2.files!.length, 2);
  assertStringIncludes(r2.problems.join(), "kept as a file instead");

  // A tenant the job leaves out makes nothing; an unknown source says so.
  const seen: string[] = [];
  const r3 = await runJob(
    { id: "gcp", kinds: ["cyclonedx", "in-toto"], tenants: ["gcp:*"] },
    await deps(fleet(), { source: fakeSources(seen) }),
  );
  assertEquals(seen, ["cyclonedx:gcp"]);
  assertStringIncludes(
    r3.problems.join("\n"),
    "in-toto: this version of Stolos cannot make it yet",
  );
  assertStringIncludes(r3.problems.join("\n"), "nothing to deliver");
  assert(!r3.ok);
});

Deno.test("deliver: each job emails its own recipients through its own credential", async () => {
  const a = await webRecipient();
  const b = await webRecipient();
  const f = fleet({ mail: LAB_MAIL });
  const sent: Array<{ to: string; from: string; relay?: string; user?: string; mime: string }> = [];
  const asked: Array<string | undefined> = [];
  const certs: Record<string, RecipientCert> = { "a.pem": a.cert, "b.pem": b.cert };
  const d = await deps(f, {
    smtp: (c, o, mime) => {
      sent.push({ to: o.to, from: o.from, relay: o.relay, user: c.user, mime });
      return Promise.resolve("sent");
    },
    credential: (name) => {
      asked.push(name);
      return Promise.resolve(name ? { ...SECRET, user: `${name}-sender` } : SECRET);
    },
  });
  const job: ExportJobDef = {
    id: "acme",
    kinds: ["cyclonedx"],
    tenants: ["aws:*"],
    email: {
      to: [{ address: "a@example.com", certificate: "a.pem" }],
      from: "reports@acme.example",
      relay: "smtp.acme.example:465",
      credential: "acme",
    },
  };
  // One copy per recipient, each encrypted to that recipient only (WebCrypto keys, any platform);
  // the whole run, with certificate files and openssl opening each copy, follows when openssl is here.
  const results = [];
  for (const [addr, file] of [["a@example.com", "a.pem"], ["b@example.com", "b.pem"]]) {
    const msg = await smimeMessage(
      { from: "x@example.net", to: addr, subject: "s" },
      "Content-Type: text/plain\r\n\r\nfor " + addr,
      [certs[file]],
    );
    results.push(msg);
  }
  assertStringIncludes(await openAuthEnveloped(p7m(results[0]), a.key), "for a@example.com");
  let crossed = false;
  await openAuthEnveloped(p7m(results[0]), b.key).catch(() => (crossed = true));
  assert(crossed, "b cannot open a's copy");

  if (!OPENSSL) return;
  const dir = d.fleetDir;
  await Deno.mkdir(`${dir}/certs`);
  const ra = await opensslCert(`${dir}/certs`, "a", "a@example.com");
  const rb = await opensslCert(`${dir}/certs`, "b", "b@example.com");
  const jobs: ExportJobDef[] = [
    {
      ...job,
      email: { ...job.email!, to: [{ address: "a@example.com", certificate: "certs/a.pem" }] },
    },
    {
      id: "auditor",
      kinds: ["cyclonedx"],
      email: { to: [{ address: "b@example.com", certificate: "certs/b.pem" }] },
    },
  ];
  for (const j of jobs) {
    const r = await runJob(j, d);
    assert(r.ok, r.problems.join("; "));
  }
  assertEquals(asked, ["acme", undefined]);
  assertEquals(sent.map((s) => [s.to, s.from, s.relay, s.user]), [
    ["a@example.com", "reports@acme.example", "smtp.acme.example:465", "acme-sender"],
    ["b@example.com", "exports+bootpc.lab@example.net", "smtp.mx.cloudflare.net:465", undefined],
  ]);
  // Each recipient opens their own copy with openssl and finds the files attached.
  for (const [i, who] of [[0, ra], [1, rb]] as const) {
    await Deno.writeTextFile(`${dir}/m${i}.eml`, sent[i].mime);
    const out = await sh("openssl", [
      "cms",
      "-decrypt",
      "-in",
      `${dir}/m${i}.eml`,
      "-recip",
      who.cert,
      "-inkey",
      who.key,
    ]);
    assertStringIncludes(out, 'filename="inventory.cdx.json"');
    assertStringIncludes(out, 'filename="bundle.bin"');
    assertStringIncludes(out, "Content-Type: multipart/mixed");
    assert(!sent[i].mime.includes("CycloneDX"), "nothing of the files in the clear");
  }
  // A recipient whose certificate is missing gets nothing, and the run says so.
  const r = await emailFiles(
    { ...jobs[1], email: { to: [{ address: "c@example.com", certificate: "certs/none.pem" }] } },
    [JSON_DOC],
    { ...d, credential: SECRET },
  );
  assertEquals(r[0].ok, false);
  assertEquals(r[0].to, "c@example.com");
});

Deno.test("deliver: no secret in the run record, even when the relay's error echoes it", async () => {
  if (!OPENSSL) return;
  const d = await deps(fleet({ mail: LAB_MAIL }), {
    smtp: () => Promise.reject(new Error(`login failed for api_token:${SECRET.token}`)),
  });
  await Deno.mkdir(`${d.fleetDir}/certs`);
  await opensslCert(`${d.fleetDir}/certs`, "a", "a@example.com");
  const r = await runJob({
    id: "leak",
    kinds: ["cyclonedx"],
    email: { to: [{ address: "a@example.com", certificate: "certs/a.pem" }] },
  }, d);
  assert(!r.ok);
  const text = await Deno.readTextFile(`${d.stateDir}/exports/leak/last-run.json`);
  assert(!text.includes(SECRET.token), "the token is not in last-run.json");
  assert(!JSON.stringify(r).includes(SECRET.token));
  assertStringIncludes(text, "[redacted");
  // Without a credential, it says how to make one.
  const r2 = await runJob({
    id: "nocred",
    kinds: ["cyclonedx"],
    email: { to: [{ address: "a@example.com", certificate: "certs/a.pem" }], credential: "acme" },
  }, { ...d, credential: () => Promise.resolve(undefined) });
  assertStringIncludes(r2.problems.join(), "stolos export credential acme");
});

// ------------------------------------------------------------------- schedule

function input(os: ScheduleInput["os"], job: ExportJobDef): ScheduleInput {
  return os === "windows"
    ? {
      os,
      fleet: "lab",
      job,
      deno: "C:\\Users\\alice\\.deno\\bin\\deno.exe",
      repo: "C:\\Users\\alice\\src\\fleet",
      home: "C:\\Users\\alice",
      stateDir: "C:\\Users\\alice\\AppData\\Local\\stolos\\state\\lab",
    }
    : {
      os,
      fleet: "lab",
      job,
      deno: os === "darwin" ? "/Users/alice/.deno/bin/deno" : "/home/alice/.deno/bin/deno",
      repo: os === "darwin" ? "/Users/alice/src/my fleet" : "/home/alice/src/fleet",
      home: os === "darwin" ? "/Users/alice" : "/home/alice",
      stateDir: os === "darwin"
        ? "/Users/alice/.local/share/stolos/state/lab"
        : "/home/alice/.local/share/stolos/state/lab",
      uid: 501,
    };
}

Deno.test("schedule: Windows Task Scheduler, every shape", () => {
  const job = (s: ExportJobDef["schedule"]): ExportJobDef => ({
    id: "auditor",
    kinds: ["oscal"],
    schedule: s,
  });
  const w = windowsJob(input("windows", job({ every: "daily", at: "06:10" })));
  assertEquals(w.name, "Stolos\\export-lab-auditor");
  const cmd = w.files[0];
  assertEquals(
    cmd.path,
    "C:\\Users\\alice\\AppData\\Local\\stolos\\state\\lab\\exports\\auditor\\run.cmd",
  );
  assertStringIncludes(cmd.content, "cd /d C:\\Users\\alice\\src\\fleet\r\n");
  assertStringIncludes(
    cmd.content,
    "C:\\Users\\alice\\.deno\\bin\\deno.exe task stolos --fleet lab export run auditor >> ",
  );
  assertEquals(w.create[0].argv, [
    "schtasks",
    "/Create",
    "/F",
    "/TN",
    "Stolos\\export-lab-auditor",
    "/TR",
    `"${cmd.path}"`,
    "/SC",
    "DAILY",
    "/ST",
    "06:10",
  ]);
  assert(!w.create[0].argv.some((a) => /^\/(RP|RU)$/i.test(a)), "no stored password, no user");
  assertEquals(w.remove[0].argv, [
    "schtasks",
    "/Delete",
    "/F",
    "/TN",
    "Stolos\\export-lab-auditor",
  ]);
  const tail = (s: ExportJobDef["schedule"]) =>
    windowsJob(input("windows", job(s))).create[0].argv.slice(8);
  assertEquals(tail({ every: "hourly", at: "06:42" }), ["HOURLY", "/ST", "00:42"]);
  assertEquals(tail({ every: "weekly", weekday: "fri" }), ["WEEKLY", "/ST", "02:17", "/D", "FRI"]);
  assertEquals(tail({ every: "monthly", dayOfMonth: 3, at: "05:00" }), [
    "MONTHLY",
    "/ST",
    "05:00",
    "/D",
    "3",
  ]);
});

Deno.test("schedule: macOS LaunchAgent, every shape", () => {
  const m = macJob(input("darwin", {
    id: "auditor",
    kinds: ["oscal"],
    schedule: { every: "weekly", weekday: "sun", at: "07:05" },
  }));
  assertEquals(m.name, "net.stolos.export.lab.auditor");
  assertEquals(
    m.files[0].path,
    "/Users/alice/Library/LaunchAgents/net.stolos.export.lab.auditor.plist",
  );
  const x = m.files[0].content;
  for (
    const s of [
      "<key>Label</key>\n  <string>net.stolos.export.lab.auditor</string>",
      "<string>/Users/alice/.deno/bin/deno</string>\n    <string>task</string>\n    <string>stolos</string>",
      "<string>export</string>\n    <string>run</string>\n    <string>auditor</string>",
      "<key>WorkingDirectory</key>\n  <string>/Users/alice/src/my fleet</string>",
      "<key>Minute</key>\n    <integer>5</integer>",
      "<key>Hour</key>\n    <integer>7</integer>",
      "<key>Weekday</key>\n    <integer>0</integer>",
    ]
  ) {
    assertStringIncludes(x, s);
  }
  assertEquals(m.create.map((s) => s.argv), [
    ["launchctl", "bootout", "gui/501/net.stolos.export.lab.auditor"],
    [
      "launchctl",
      "bootstrap",
      "gui/501",
      "/Users/alice/Library/LaunchAgents/net.stolos.export.lab.auditor.plist",
    ],
  ]);
  assert(m.create[0].mayFail);
  const hourly = macJob(
    input("darwin", { id: "h", kinds: ["oscal"], schedule: { every: "hourly", at: "00:30" } }),
  )
    .files[0].content;
  assert(hourly.includes("<key>Minute</key>") && !hourly.includes("<key>Hour</key>"));
  const monthly = macJob(
    input("darwin", {
      id: "m",
      kinds: ["oscal"],
      schedule: { every: "monthly", dayOfMonth: 15 },
    }),
  )
    .files[0].content;
  assertStringIncludes(monthly, "<key>Day</key>\n    <integer>15</integer>");
});

Deno.test("schedule: Linux systemd user service and timer, every shape", () => {
  const l = linuxJob(input("linux", {
    id: "auditor",
    kinds: ["oscal"],
    schedule: { every: "daily", at: "06:10" },
  }));
  assertEquals(l.name, "stolos-export-lab-auditor.timer");
  assertEquals(l.files.map((f) => f.path), [
    "/home/alice/.config/systemd/user/stolos-export-lab-auditor.service",
    "/home/alice/.config/systemd/user/stolos-export-lab-auditor.timer",
  ]);
  assertStringIncludes(
    l.files[0].content,
    "Type=oneshot\nWorkingDirectory=/home/alice/src/fleet\n",
  );
  assertStringIncludes(
    l.files[0].content,
    "ExecStart=/home/alice/.deno/bin/deno task stolos --fleet lab export run auditor\n",
  );
  assertStringIncludes(l.files[1].content, "OnCalendar=*-*-* 06:10:00\nPersistent=true\n");
  assertStringIncludes(l.files[1].content, "WantedBy=timers.target");
  assertEquals(l.create.map((s) => s.argv), [
    ["systemctl", "--user", "daemon-reload"],
    ["systemctl", "--user", "enable", "--now", "stolos-export-lab-auditor.timer"],
  ]);
  const cal = (s: ExportJobDef["schedule"]) =>
    onCalendar({ id: "x", kinds: ["oscal"], schedule: s });
  assertEquals(cal({ every: "hourly", at: "00:42" }), "*-*-* *:42:00");
  assertEquals(cal({ every: "weekly", weekday: "fri", at: "08:00" }), "Fri *-*-* 08:00:00");
  assertEquals(cal({ every: "monthly", dayOfMonth: 3 }), "*-*-03 02:17:00");
  assertEquals(cal(undefined), "*-*-* 02:17:00");
  // A path with a space is quoted for systemd.
  const spaced = linuxJob({
    ...input("linux", { id: "a", kinds: ["oscal"] }),
    deno: "/opt/my deno/deno",
  });
  assertStringIncludes(spaced.files[0].content, 'ExecStart="/opt/my deno/deno" task');
});

Deno.test("schedule: no secret in any job definition, on any OS", () => {
  Deno.env.set("STOLOS_TEST_SECRET", SECRET.token);
  try {
    for (const os of ["windows", "darwin", "linux"] as const) {
      const j = scheduledJob(input(os, {
        id: "acme",
        kinds: ["cyclonedx"],
        email: {
          to: [{ address: "a@example.com", certificate: "certs/a.pem" }],
          credential: "acme",
        },
        schedule: { every: "daily" },
      }));
      const all = JSON.stringify(j);
      assert(!all.includes(SECRET.token), os);
      assert(!/api_token|password|token\s*=/i.test(all), os);
    }
  } finally {
    Deno.env.delete("STOLOS_TEST_SECRET");
  }
});

// ------------------------------------------------------------------- SMTP

/** A tiny SMTP server: records every line, offers AUTH PLAIN (and STARTTLS never). */
function fakeSmtp(listener: Deno.Listener) {
  const lines: string[] = [];
  const messages: string[] = [];
  const serve = async (conn: Deno.Conn) => {
    const w = (s: string) => conn.write(enc.encode(s)).catch(() => 0);
    let buf = "";
    let data = false;
    let awaitingAuth = false;
    await w("220 fake.example ESMTP\r\n");
    const chunk = new Uint8Array(65536);
    try {
      while (true) {
        const n = await conn.read(chunk);
        if (n === null) break;
        buf += dec.decode(chunk.subarray(0, n));
        while (true) {
          if (data) {
            const end = buf.indexOf("\r\n.\r\n");
            if (end < 0) break;
            messages.push(buf.slice(0, end));
            buf = buf.slice(end + 5);
            data = false;
            await w("250 queued\r\n");
            continue;
          }
          const i = buf.indexOf("\r\n");
          if (i < 0) break;
          const line = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const verb = line.split(" ")[0].toUpperCase();
          if (awaitingAuth) {
            // The client's response to "334": AUTH PLAIN's credentials, recorded as one line.
            awaitingAuth = false;
            lines.push(`AUTH PLAIN ${line}`);
            await w("235 ok\r\n");
            continue;
          }
          lines.push(line);
          if (verb === "EHLO") {
            await w("250-fake.example\r\n250-AUTH PLAIN\r\n250 SIZE 20000000\r\n");
          } else if (verb === "AUTH" && line.split(" ").length === 2) {
            awaitingAuth = true;
            lines.pop();
            await w("334 \r\n");
          } else if (verb === "AUTH") await w("235 ok\r\n");
          else if (verb === "MAIL" || verb === "RCPT" || verb === "NOOP") await w("250 ok\r\n");
          else if (verb === "DATA") {
            data = true;
            await w("354 go on\r\n");
          } else if (verb === "QUIT") {
            await w("221 bye\r\n");
            conn.close();
            return;
          } else await w("502 no\r\n");
        }
      }
    } catch { /* the client went away */ }
    try {
      conn.close();
    } catch { /* closed */ }
  };
  const accepting = (async () => {
    try {
      for await (const c of listener) serve(c);
    } catch { /* closed */ }
  })();
  return { lines, messages, close: async () => (listener.close(), await accepting) };
}

Deno.test({
  name: "smtp: the dialogue over implicit TLS with a fake relay: AUTH PLAIN, MAIL, RCPT, DATA",
  ignore: !OPENSSL || !CURL,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const dir = await Deno.makeTempDir({ prefix: "stolos-smtp-" });
    await sh("openssl", [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      `${dir}/tls.key`,
      "-out",
      `${dir}/tls.pem`,
      "-subj",
      "/CN=127.0.0.1",
      "-addext",
      "subjectAltName=IP:127.0.0.1",
      "-days",
      "2",
    ]);
    const listener = Deno.listenTls({
      hostname: "127.0.0.1",
      port: 0,
      cert: await Deno.readTextFile(`${dir}/tls.pem`),
      key: await Deno.readTextFile(`${dir}/tls.key`),
    });
    const port = (listener.addr as Deno.NetAddr).port;
    const srv = fakeSmtp(listener);
    const a = await webRecipient();
    const mime = await smimeMessage(
      { from: "exports+pc@example.net", to: "auditor@example.com", subject: "export" },
      "Content-Type: text/plain\r\n\r\nsecret contents\r\n",
      [a.cert],
    );
    await sendSmtp(SECRET, {
      relay: `127.0.0.1:${port}`,
      ipv4: true,
      from: "exports+pc@example.net",
      to: "auditor@example.com",
      tls: "implicit",
      cacert: `${dir}/tls.pem`,
    }, mime).catch((e) => {
      throw new Error(`${e.message}; the server saw: ${srv.lines.join(" | ")}`);
    });
    await srv.close();
    const auth = srv.lines.find((l) => l.startsWith("AUTH PLAIN"))!;
    assertEquals(atob(auth.split(" ")[2]), `\0api_token\0${SECRET.token}`);
    assert(srv.lines.some((l) => l.startsWith("MAIL FROM:<exports+pc@example.net>")));
    assert(srv.lines.some((l) => l.startsWith("RCPT TO:<auditor@example.com>")));
    assertEquals(srv.messages.length, 1);
    assertStringIncludes(srv.messages[0], "smime-type=authEnveloped-data");
    assert(!srv.messages[0].includes("secret contents"));
    await Deno.remove(dir, { recursive: true });
  },
});

Deno.test({
  name: "smtp: refuses to log in or send without TLS (no STARTTLS offered, or no TLS at all)",
  ignore: !CURL,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    for (const tls of ["starttls", "implicit"] as const) {
      const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
      const port = (listener.addr as Deno.NetAddr).port;
      const srv = fakeSmtp(listener);
      let error = "";
      try {
        await sendSmtp(SECRET, {
          relay: `127.0.0.1:${port}`,
          ipv4: true,
          from: "exports+pc@example.net",
          to: "auditor@example.com",
          tls,
        }, "Subject: x\r\n\r\nnever sent\r\n");
      } catch (e) {
        error = (e as Error).message;
      }
      await srv.close();
      assert(error, `${tls}: it must fail`);
      assert(!error.includes(SECRET.token), "the error never carries the token");
      assert(!srv.lines.some((l) => /^AUTH|^MAIL|^RCPT|^DATA/i.test(l)), srv.lines.join("|"));
      assertEquals(srv.messages, []);
      if (tls === "starttls") assertStringIncludes(error, "did not offer TLS");
    }
    // The configuration itself: TLS required on both schemes, the token only on stdin.
    const c = smtpConfig(SECRET, { relay: "smtp.example.net:587", ipv4: false });
    assertStringIncludes(c, 'url = "smtp://smtp.example.net:587"');
    assertStringIncludes(c, "\nssl-reqd\n");
    assertStringIncludes(
      smtpConfig(SECRET, { ipv4: false }),
      'url = "smtps://smtp.mx.cloudflare.net:465"',
    );
    assertStringIncludes(
      smtpConfig({ ...SECRET, user: "reports" }, { ipv4: false }),
      `user = "reports:${SECRET.token}"`,
    );
  },
});

// ------------------------------------------------------------------- commands

Deno.test("commands: export run, schedule, list, credential are PC-only and never over MCP", () => {
  for (const name of ["export run", "export schedule", "export list", "export credential"]) {
    const c = COMMANDS.find((x) => x.name === name);
    assert(c, name);
    assertEquals(c.place, "pc", name);
    assertEquals(c.noMcp, true, name);
  }
  const s = COMMANDS.find((x) => x.name === "export schedule")!;
  assert(s.args.some((a) => a.name === "remove") && s.args.some((a) => a.name === "dry-run"));
});

Deno.test("092: a job's tenants limit what the estate formats carry", async () => {
  const { buildGraph } = await import("../src/archon/estate/graph.ts");
  const { estateForTenants } = await import("../src/archon/export/deliver.ts");
  const obs = (provider: string, account: string) => ({
    at: "2026-11-01T00:00:00Z",
    provider,
    account,
    assets: [],
    posture: {},
    gaps: [],
    entities: {
      accounts: [{
        system: provider,
        id: "1",
        name: "alice",
        email: "alice@example.org",
        active: true,
      }],
    },
  });
  const e = buildGraph({
    fleet: "lab",
    sources: [{ connector: "okta", observation: obs("okta", "a") }, {
      connector: "github",
      observation: obs("github", "b"),
    }],
    machines: [{ source: "stolos", id: "alpha", name: "alpha", managed: true }],
    links: {},
  });
  const ctx = {
    // deno-lint-ignore no-explicit-any
    fleet: { id: "lab" } as any,
    // deno-lint-ignore no-explicit-any
    job: {} as any,
    tenant: (uid: string) => uid.startsWith("okta:"),
    now: new Date(),
  };
  estateForTenants(e, ctx);
  const n = (sql: string) => (e.db.prepare(sql).get() as { n: number }).n;
  assertEquals(n("SELECT count(*) AS n FROM node WHERE tenant_uid = 'okta:a'"), 1);
  assertEquals(n("SELECT count(*) AS n FROM node WHERE tenant_uid = 'github:b'"), 0);
  assertEquals(
    n("SELECT count(*) AS n FROM fixed_asset"),
    0,
    "the fleet's machines only with the fleet's tenant",
  );
});
