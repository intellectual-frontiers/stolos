/**
 * Spec 092, part B: delivery of exports. S/MIME (CMS AuthEnvelopedData through IFC TypeScript's
 * kernel `cms`, AES-256-GCM, RSA-OAEP SHA-256) opened with each recipient's key and by
 * `openssl cms -decrypt` (when openssl is here; CI on Ubuntu has it); the collector-or-file choice;
 * per-tenant jobs; the job's schedule and command for the operating system's scheduler; the SMTP
 * dialogue with a fake server over TLS (curl, as the fleet's mail already uses), refusing to send
 * without TLS; and no secret in job files, run records, or errors. The DER and scheduler files are
 * IFC TypeScript's, tested there.
 *
 * @module
 */

import { fs, path, proc, tcp } from "@intellectual-frontiers/ifc-ts/runtime";
import {
  assert,
  assertEquals,
  assertStringIncludes,
  proves,
  test,
} from "@intellectual-frontiers/ifc-ts/runtime/test";
import { fleet } from "./fixtures.ts";
import { cms, type jobs } from "@intellectual-frontiers/ifc-ts/kernel";
import {
  describeCertificateProblem,
  parseCertificate,
  smimeMessage,
} from "../src/archon/export/smime.ts";
import {
  deliveryPlan,
  emailFiles,
  type ExportContext,
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
import { describeSchedule, exportJobSpec, jobWhen } from "../src/archon/export/jobs.ts";
import { type Credential, sendSmtp, smtpConfig } from "../src/archon/notify/transport.ts";
import { validateFleet } from "../src/archon/model/validate.ts";
import type { ExportJobDef, ExportKind, FleetDef } from "../src/archon/model/types.ts";
import { COMMANDS } from "../src/archon/commands/registry.ts";
import { at, list, must, parse } from "./console/tree.ts";

const enc = new TextEncoder();
const dec = new TextDecoder();
/** A credential the tests must never find again anywhere it should not be. */
const SECRET: Credential = {
  token: "cfat_SECRETsecretSECRETsecret0123456789abcd",
  created: "2026-11-15T00:00:00Z",
};

async function has(cmd: string): Promise<boolean> {
  try {
    const o = await proc.output([cmd, "version"], { stdout: "null", stderr: "null" });
    return o.success || o.code !== 127;
  } catch {
    return false;
  }
}
const OPENSSL = await has("openssl");
const CURL = proc.which("curl") !== undefined;

async function sh(cmd: string, args: string[], cwd?: string): Promise<string> {
  const o = await proc.output([cmd, ...args], cwd === undefined ? {} : { cwd });
  if (!o.success) throw new Error(`${cmd} ${args.join(" ")}: ${dec.decode(o.stderr)}`);
  return dec.decode(o.stdout);
}

/** A key and a self-signed certificate made with openssl (RSA 2048, for this address). */
async function opensslCert(
  dir: string,
  name: string,
  email: string,
  extra: string[] = [],
): Promise<{ key: string; cert: string }> {
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

// ------------------------------------------------------------------- S/MIME

/** The DER inside an S/MIME message (the base64 body). */
function p7m(message: string): Uint8Array {
  const body = message.split("\r\n\r\n").slice(1).join("").replace(/\s+/g, "");
  return Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
}

/** An openssl recipient: its certificate, read, and its private key for RSA-OAEP SHA-256. */
async function recipient(
  dir: string,
  name: string,
): Promise<{ files: { key: string; cert: string }; cert: cms.Certificate; key: CryptoKey }> {
  const files = await opensslCert(dir, name, `${name}@example.com`);
  const pem = cms.readPem(await fs.readTextFile(files.key), "PRIVATE KEY");
  assert(pem.kind === "ok");
  const key = await crypto.subtle.importKey(
    "pkcs8",
    new Uint8Array(must(pem.value[0])),
    { name: "RSA-OAEP", hash: "SHA-256" },
    false,
    ["decrypt"],
  );
  return { files, cert: parseCertificate(await fs.readTextFile(files.cert)), key };
}

proves(
  ["092-exporters FR-B03"],
  "smime: AuthEnvelopedData opens with each recipient's key, and only theirs",
  async () => {
    const dir = await fs.makeTempDir({ prefix: "stolos-smime-" });
    try {
      const [a, b, c] = [
        await recipient(dir, "a"),
        await recipient(dir, "b"),
        await recipient(dir, "c"),
      ];
      const content = "Content-Type: text/plain\r\n\r\nthe fleet's assessment\r\n";
      const msg = await smimeMessage(
        { from: "exports+pc@example.net", to: "auditor@example.com", subject: "x" },
        content,
        [a.cert, b.cert],
      );
      // RFC 8551's media type, base64, nothing of the content in the clear.
      assertStringIncludes(
        msg,
        'Content-Type: application/pkcs7-mime; smime-type=authEnveloped-data; name="smime.p7m"',
      );
      assert(!msg.includes("assessment"));
      const der = p7m(msg);
      for (const r of [a, b]) {
        const opened = await cms.openAuthEnveloped(der, r.cert, r.key);
        assert(opened.kind === "ok");
        assertEquals(dec.decode(opened.value), content);
      }
      // A stranger's key opens nothing.
      assertEquals((await cms.openAuthEnveloped(der, c.cert, c.key)).kind, "err");
      // Tampering with the ciphertext fails GCM's tag.
      const bad = new Uint8Array(der);
      bad[bad.length - 20] = (bad[bad.length - 20] ?? 0) ^ 1;
      assertEquals((await cms.openAuthEnveloped(bad, a.cert, a.key)).kind, "err");
    } finally {
      await fs.remove(dir, { recursive: true });
    }
  },
  { skip: !OPENSSL && "openssl makes the test certificates" },
);

proves(
  ["092-exporters FR-B03"],
  "smime: openssl cms -decrypt opens our message (interoperability)",
  async () => {
    const dir = await fs.makeTempDir({ prefix: "stolos-smime-" });
    try {
      const r = await recipient(dir, "auditor");
      assertEquals(r.cert.commonName, "auditor");
      assertEquals(r.cert.emails, ["auditor@example.com"]);
      assert(r.cert.notAfter && r.cert.notAfter > new Date());
      const now = new Date();
      assertEquals(cms.certificateProblem(r.cert, "auditor@example.com", now), undefined);
      assertStringIncludes(
        describeCertificateProblem(must(cms.certificateProblem(r.cert, "other@example.com", now))),
        "auditor@example.com",
      );
      assertStringIncludes(
        describeCertificateProblem(
          must(cms.certificateProblem(r.cert, "auditor@example.com", new Date(Date.now() + 9e9))),
        ),
        "expired",
      );
      // The serial number openssl reports is the one we read.
      const serial = (
        (await sh("openssl", ["x509", "-in", r.files.cert, "-noout", "-serial"]))
          .trim()
          .split("=")[1] ?? ""
      ).toLowerCase();
      assertEquals(BigInt(`0x${r.cert.serialHex}`), BigInt(`0x${serial}`));
      // A second recipient: each opens the same message with their own key.
      const r2 = await recipient(dir, "second");
      const inner = "Content-Type: text/plain; charset=UTF-8\r\n\r\nhello from the fleet\r\n";
      const msg = await smimeMessage(
        { from: "exports+pc@example.net", to: "auditor@example.com", subject: "test" },
        inner,
        [r.cert, r2.cert],
      );
      await fs.writeTextFile(`${dir}/m.eml`, msg);
      for (const who of [r, r2]) {
        const out = await sh("openssl", [
          "cms",
          "-decrypt",
          "-in",
          `${dir}/m.eml`,
          "-recip",
          who.files.cert,
          "-inkey",
          who.files.key,
        ]);
        // Line ends as openssl writes them here (Windows: \r\r\n, its text mode on CRLF).
        assertEquals(out.replace(/\r+\n/g, "\n"), inner.replace(/\r\n/g, "\n"));
      }
    } finally {
      await fs.remove(dir, { recursive: true });
    }
  },
  { skip: !OPENSSL && "no openssl here" },
);

proves(
  ["092-exporters FR-B03"],
  "smime: certificates that cannot be used are refused with a reason",
  async () => {
    let threw = "";
    try {
      parseCertificate("not a certificate");
    } catch (e) {
      threw = (e as Error).message;
    }
    assert(threw !== "", "not a certificate is refused");
    if (!OPENSSL) return;
    const dir = await fs.makeTempDir({ prefix: "stolos-smime-" });
    try {
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
      const ec = parseCertificate(await fs.readTextFile(`${dir}/ec.pem`));
      assertStringIncludes(
        describeCertificateProblem(must(cms.certificateProblem(ec, "ec@example.com", new Date()))),
        "not RSA",
      );
      const sign = await opensslCert(dir, "signer", "s@example.com", [
        "-addext",
        "keyUsage=digitalSignature",
      ]);
      const c = parseCertificate(await fs.readTextFile(sign.cert));
      assertStringIncludes(
        describeCertificateProblem(must(cms.certificateProblem(c, "s@example.com", new Date()))),
        "signing only",
      );
    } finally {
      await fs.remove(dir, { recursive: true });
    }
  },
);

// ------------------------------------------------------------------- jobs

const LAB_MAIL = { to: "fleet@example.net", domain: "example.net", tag: "lab" };

proves(
  ["092-exporters FR-B01"],
  "jobs: per-tenant jobs are checked, matched, and send from their own address",
  () => {
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
    assertEquals(
      validateFleet(f, []).filter((p) => p.where.includes("exports")),
      [],
    );
    const acme = must(must(must(f.estate).exports)[1]);
    assert(tenantMatches("aws:*", "aws:123456789012"));
    assert(!tenantMatches("aws:*", "gcp:proj"));
    assert(tenantFilter(acme)("microsoft:acme.example"));
    assert(!tenantFilter(acme)("fleet:lab"));
    assert(tenantFilter({})("anything:at-all"));
    assertEquals(
      jobSender(f, must(must(must(f.estate).exports)[0]), "bootpc"),
      "exports+bootpc.lab@example.net",
    );
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
    const msgs = validateExportJobs(bad)
      .map((p) => `${p.where}: ${p.message}`)
      .join("\n");
    for (const s of [
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
    ]) {
      assertStringIncludes(msgs, s);
    }
  },
);

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

function fakeFetch(status = 200): {
  fn: typeof fetch;
  calls: Array<{ url: string; body: string }>;
} {
  const calls: Array<{ url: string; body: string }> = [];
  const fn = ((url: string | URL, init?: RequestInit) => {
    calls.push({
      url: String(url),
      body:
        init?.body instanceof Uint8Array
          ? dec.decode(init.body)
          : typeof init?.body === "string"
            ? init.body
            : "",
    });
    return Promise.resolve(new Response("{}", { status }));
  }) as typeof fetch;
  return { fn, calls };
}

async function deps(f: FleetDef, over: Partial<RunDeps> = {}): Promise<RunDeps> {
  return {
    fleet: f,
    fleetDir: await fs.makeTempDir({ prefix: "stolos-fleet-" }),
    stateDir: await fs.makeTempDir({ prefix: "stolos-state-" }),
    pc: "bootpc",
    now: new Date("2026-11-15T02:17:00Z"),
    fetch: fakeFetch().fn,
    smtp: () => Promise.resolve("sent"),
    credential: () => Promise.resolve(SECRET),
    source: fakeSources(),
    ...over,
  };
}

proves(
  ["092-exporters FR-B02"],
  "deliver: the collector when configured, otherwise a file; a file too when emailed",
  () => {
    const job: ExportJobDef = { id: "j", kinds: ["otlp"] };
    const withCollector = fleet({ telemetry: { collector: "http://10.0.0.5:4318/" } });
    assertEquals(deliveryPlan(withCollector, job), {
      otlp: "http://10.0.0.5:4318",
      file: false,
      email: false,
    });
    assertEquals(deliveryPlan(fleet(), job), { file: true, email: false });
    assertEquals(deliveryPlan(withCollector, { ...job, otlp: false }), {
      file: true,
      email: false,
    });
    const mailed = { ...job, email: { to: [{ address: "a@example.com", certificate: "c.pem" }] } };
    assertEquals(deliveryPlan(withCollector, mailed), {
      otlp: "http://10.0.0.5:4318",
      file: true,
      email: true,
    });
  },
);

proves(
  ["092-exporters FR-B02"],
  "deliver: OTLP documents go to their signal, the rest as log records",
  async () => {
    assertEquals(otlpSignal(OTLP_DOC), "/v1/traces");
    assertEquals(otlpSignal(JSON_DOC), undefined);
    const f = fleet({ telemetry: { collector: "http://10.0.0.5:4318" } });
    const net = fakeFetch();
    const d = await deps(f, { fetch: net.fn });
    const r = await runJob({ id: "aws", kinds: ["otlp", "cyclonedx"], tenants: ["aws:*"] }, d);
    assert(r.ok, r.problems.join("; "));
    assertEquals(r.otlp, { endpoint: "http://10.0.0.5:4318", ok: true });
    assertEquals(r.files, undefined);
    assertEquals(
      net.calls.map((c) => c.url),
      ["http://10.0.0.5:4318/v1/traces", "http://10.0.0.5:4318/v1/logs"],
    );
    const logs = parse(must(net.calls[1]).body);
    const records = list(logs, "resourceLogs", 0, "scopeLogs", 0, "logRecords");
    assertEquals(records.length, 2);
    assertEquals(at(records, 0, "body", "stringValue"), '{"bomFormat":"CycloneDX"}');
    assertEquals(at(records, 1, "body", "bytesValue"), "AAEC/w==");
    const names = records.map((x) =>
      at(
        list(x, "attributes").find((a) => at(a, "key") === "stolos.export.file_name"),
        "value",
        "stringValue",
      ),
    );
    assertEquals(names, ["inventory.cdx.json", "bundle.bin"]);
    const direct: unknown = await otlpLogs([{ kind: "cyclonedx", doc: JSON_DOC }], {
      fleet: "lab",
      job: "aws",
      now: d.now,
    });
    assert(
      list(direct, "resourceLogs", 0, "resource", "attributes").some(
        (a) => at(a, "key") === "stolos.fleet",
      ),
    );
  },
);

proves(
  ["092-exporters FR-B02"],
  "deliver: no collector, or one that refuses: files in the state directory",
  async () => {
    const d = await deps(fleet());
    const r = await runJob({ id: "aws", kinds: ["cyclonedx"] }, d);
    assert(r.ok);
    assertEquals(must(r.files).length, 2);
    const first = must(must(r.files)[0]);
    assert(first.startsWith(path.join(d.stateDir, "exports", "aws", "2026-11-15T02-17-00Z")));
    assertEquals(await fs.readTextFile(first), '{"bomFormat":"CycloneDX"}');
    const last = parse(await fs.readTextFile(`${d.stateDir}/exports/aws/last-run.json`));
    assertEquals(at(last, "ok"), true);

    const down = fakeFetch(503);
    const d2 = await deps(fleet({ telemetry: { collector: "http://10.0.0.5:4318" } }), {
      fetch: down.fn,
    });
    const r2 = await runJob({ id: "aws", kinds: ["cyclonedx"] }, d2);
    assertEquals(r2.otlp?.ok, false);
    assertEquals(must(r2.files).length, 2);
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
  },
);

proves(
  ["092-exporters FR-B02", "092-exporters FR-B03"],
  "deliver: each job emails its own recipients through its own credential",
  async () => {
    const f = fleet({ mail: LAB_MAIL });
    const sent: Array<{
      to: string;
      from: string;
      relay?: string | undefined;
      user?: string | undefined;
      mime: string;
    }> = [];
    const asked: Array<string | undefined> = [];
    const d = await deps(f, {
      // Now, not the fixed run time: openssl makes the certificates valid from now on.
      now: new Date(Date.now() + 60_000),
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
    // One copy per recipient, each encrypted to that recipient only.
    const keys = await fs.makeTempDir({ prefix: "stolos-smime-" });
    const a = await recipient(keys, "a");
    const b = await recipient(keys, "b");
    const results: string[] = [];
    for (const [addr, cert] of [
      ["a@example.com", a.cert],
      ["b@example.com", b.cert],
    ] as const) {
      results.push(
        await smimeMessage(
          { from: "x@example.net", to: addr, subject: "s" },
          "Content-Type: text/plain\r\n\r\nfor " + addr,
          [cert],
        ),
      );
    }
    const mine = await cms.openAuthEnveloped(p7m(must(results[0])), a.cert, a.key);
    assert(mine.kind === "ok");
    assertStringIncludes(dec.decode(mine.value), "for a@example.com");
    assertEquals(
      (await cms.openAuthEnveloped(p7m(must(results[0])), b.cert, b.key)).kind,
      "err",
      "b cannot open a's copy",
    );
    await fs.remove(keys, { recursive: true });

    const dir = d.fleetDir;
    await fs.mkdir(`${dir}/certs`);
    const ra = await opensslCert(`${dir}/certs`, "a", "a@example.com");
    const rb = await opensslCert(`${dir}/certs`, "b", "b@example.com");
    const jobs: ExportJobDef[] = [
      {
        ...job,
        email: {
          ...must(job.email),
          to: [{ address: "a@example.com", certificate: "certs/a.pem" }],
        },
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
    assertEquals(
      sent.map((s) => [s.to, s.from, s.relay, s.user]),
      [
        ["a@example.com", "reports@acme.example", "smtp.acme.example:465", "acme-sender"],
        [
          "b@example.com",
          "exports+bootpc.lab@example.net",
          "smtp.mx.cloudflare.net:465",
          undefined,
        ],
      ],
    );
    // Each recipient opens their own copy with openssl and finds the files attached.
    for (const [i, who] of [
      [0, ra],
      [1, rb],
    ] as const) {
      const mail = must(sent[i]).mime;
      await fs.writeTextFile(`${dir}/m${i}.eml`, mail);
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
      assert(!mail.includes("CycloneDX"), "nothing of the files in the clear");
    }
    // A recipient whose certificate is missing gets nothing, and the run says so.
    const r = await emailFiles(
      {
        ...must(jobs[1]),
        email: { to: [{ address: "c@example.com", certificate: "certs/none.pem" }] },
      },
      [JSON_DOC],
      { ...d, credential: SECRET },
    );
    assertEquals(r[0]?.ok, false);
    assertEquals(r[0]?.to, "c@example.com");
  },
  { skip: !OPENSSL && "openssl makes the recipients' certificates", timeout: 120_000 },
);

test("deliver: no secret in the run record, even when the relay's error echoes it", async () => {
  if (!OPENSSL) return;
  const d = await deps(fleet({ mail: LAB_MAIL }), {
    now: new Date(Date.now() + 60_000),
    smtp: () => Promise.reject(new Error(`login failed for api_token:${SECRET.token}`)),
  });
  await fs.mkdir(`${d.fleetDir}/certs`);
  await opensslCert(`${d.fleetDir}/certs`, "a", "a@example.com");
  const r = await runJob(
    {
      id: "leak",
      kinds: ["cyclonedx"],
      email: { to: [{ address: "a@example.com", certificate: "certs/a.pem" }] },
    },
    d,
  );
  assert(!r.ok);
  const text = await fs.readTextFile(`${d.stateDir}/exports/leak/last-run.json`);
  assert(!text.includes(SECRET.token), "the token is not in last-run.json");
  assert(!JSON.stringify(r).includes(SECRET.token));
  assertStringIncludes(text, "REDACTED");
  // Without a credential, it says how to make one.
  const r2 = await runJob(
    {
      id: "nocred",
      kinds: ["cyclonedx"],
      email: { to: [{ address: "a@example.com", certificate: "certs/a.pem" }], credential: "acme" },
    },
    { ...d, credential: () => Promise.resolve(undefined) },
  );
  assertStringIncludes(r2.problems.join(), "stolos export credential acme");
});

// ------------------------------------------------------------------- schedule

proves(
  ["092-exporters FR-B04"],
  "schedule: a job's schedule, in IFC TypeScript's terms, and the command it runs",
  () => {
    const job = (sch: ExportJobDef["schedule"]): ExportJobDef => ({
      id: "auditor",
      kinds: ["oscal"],
      ...(sch === undefined ? {} : { schedule: sch }),
    });
    const spec = exportJobSpec("lab", job({ every: "daily", at: "06:10" }), {
      command: ["/home/alice/.bun/bin/bun", "stolos.ts"],
      workdir: "/home/alice/src/fleet",
    });
    assert(spec.kind === "ok");
    assertEquals(spec.value.argv, [
      "/home/alice/.bun/bin/bun",
      "stolos.ts",
      "--fleet",
      "lab",
      "export",
      "run",
      "auditor",
    ]);
    assertEquals(spec.value.workdir, "/home/alice/src/fleet");
    assertStringIncludes(spec.value.name, "export-lab-auditor");
    const when = (sch: ExportJobDef["schedule"]): jobs.Schedule => {
      const w = jobWhen(job(sch));
      assert(w.kind === "ok");
      return w.value;
    };
    assertEquals(when({ every: "daily", at: "06:10" }), when({ every: "daily", at: "06:10" }));
    assertStringIncludes(describeSchedule(job(undefined)), "02:17");
    assertStringIncludes(describeSchedule(job({ every: "weekly", weekday: "fri" })), "02:17");
    assertEquals(jobWhen(job({ every: "daily", at: "25:00" })).kind, "err");
  },
);

proves(["092-exporters FR-B04"], "schedule: no secret in any job definition", () => {
  proc.env.set("STOLOS_TEST_SECRET", SECRET.token);
  try {
    const spec = exportJobSpec(
      "lab",
      {
        id: "acme",
        kinds: ["cyclonedx"],
        email: {
          to: [{ address: "a@example.com", certificate: "certs/a.pem" }],
          credential: "acme",
        },
        schedule: { every: "daily" },
      },
      { command: ["bun", "stolos.ts"], workdir: "/home/alice/src/fleet" },
    );
    const all = JSON.stringify(spec);
    assert(!all.includes(SECRET.token));
    assert(!/api_token|password|token\s*=/i.test(all));
  } finally {
    proc.env.delete("STOLOS_TEST_SECRET");
  }
});

// ------------------------------------------------------------------- SMTP

/** A tiny SMTP server: records every line, offers AUTH PLAIN (and STARTTLS never). */
function fakeSmtp(listener: tcp.Listener): {
  lines: string[];
  messages: string[];
  close: () => Promise<void>;
} {
  const lines: string[] = [];
  const messages: string[] = [];
  const serve = async (conn: tcp.Conn): Promise<void> => {
    const writer = conn.writable.getWriter();
    const w = (s: string): Promise<void> => writer.write(enc.encode(s)).catch(() => undefined);
    let buf = "";
    let data = false;
    let awaitingAuth = false;
    await w("220 fake.example ESMTP\r\n");
    const reader = conn.readable.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
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
          const verb = (line.split(" ")[0] ?? "").toUpperCase();
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
    } catch {
      /* the client went away */
    }
    conn.close();
  };
  const accepting = (async (): Promise<void> => {
    try {
      for await (const c of listener) void serve(c);
    } catch {
      /* closed */
    }
  })();
  return {
    lines,
    messages,
    close: async (): Promise<void> => {
      listener.close();
      await accepting;
    },
  };
}

proves(
  ["092-exporters FR-B03"],
  "smtp: the dialogue over implicit TLS with a fake relay: AUTH PLAIN, MAIL, RCPT, DATA",
  async () => {
    const dir = await fs.makeTempDir({ prefix: "stolos-smtp-" });
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
    const listener = await tcp.listenTls({
      hostname: "127.0.0.1",
      port: 0,
      cert: await fs.readTextFile(`${dir}/tls.pem`),
      key: await fs.readTextFile(`${dir}/tls.key`),
    });
    const port = listener.addr.port;
    const srv = fakeSmtp(listener);
    const a = await recipient(dir, "auditor");
    const mime = await smimeMessage(
      { from: "exports+pc@example.net", to: "auditor@example.com", subject: "export" },
      "Content-Type: text/plain\r\n\r\nsecret contents\r\n",
      [a.cert],
    );
    await sendSmtp(
      SECRET,
      {
        relay: `127.0.0.1:${port}`,
        ipv4: true,
        from: "exports+pc@example.net",
        to: "auditor@example.com",
        tls: "implicit",
        cacert: `${dir}/tls.pem`,
      },
      mime,
    ).catch((e: unknown) => {
      throw new Error(
        `${e instanceof Error ? e.message : String(e)}; the server saw: ${srv.lines.join(" | ")}`,
      );
    });
    await srv.close();
    const auth = must(srv.lines.find((l) => l.startsWith("AUTH PLAIN")));
    assertEquals(atob(auth.split(" ")[2] ?? ""), `\0api_token\0${SECRET.token}`);
    assert(srv.lines.some((l) => l.startsWith("MAIL FROM:<exports+pc@example.net>")));
    assert(srv.lines.some((l) => l.startsWith("RCPT TO:<auditor@example.com>")));
    assertEquals(srv.messages.length, 1);
    assertStringIncludes(must(srv.messages[0]), "smime-type=authEnveloped-data");
    assert(!must(srv.messages[0]).includes("secret contents"));
    await fs.remove(dir, { recursive: true });
  },
  { skip: (!OPENSSL || !CURL) && "needs openssl and curl" },
);

proves(
  ["092-exporters FR-B03"],
  "smtp: refuses to log in or send without TLS (no STARTTLS offered, or no TLS at all)",
  async () => {
    for (const tls of ["starttls", "implicit"] as const) {
      const listener = await tcp.listen({ hostname: "127.0.0.1", port: 0 });
      const port = listener.addr.port;
      const srv = fakeSmtp(listener);
      let error = "";
      try {
        await sendSmtp(
          SECRET,
          {
            relay: `127.0.0.1:${port}`,
            ipv4: true,
            from: "exports+pc@example.net",
            to: "auditor@example.com",
            tls,
          },
          "Subject: x\r\n\r\nnever sent\r\n",
        );
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
  { skip: !CURL && "needs curl" },
);

// ------------------------------------------------------------------- commands

test("commands: export run, schedule, list, credential are PC-only and never over MCP", () => {
  for (const name of ["export run", "export schedule", "export list", "export credential"]) {
    const c = COMMANDS.find((x) => x.name === name);
    assert(c, name);
    assertEquals(c.place, "pc", name);
    assertEquals(c.noMcp, true, name);
  }
  const s = must(COMMANDS.find((x) => x.name === "export schedule"));
  assert(s.args.some((a) => a.name === "remove") && s.args.some((a) => a.name === "dry-run"));
});

proves(
  ["092-exporters FR-B01"],
  "092: a job's tenants limit what the estate formats carry",
  async () => {
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
        accounts: [
          {
            system: provider,
            id: "1",
            name: "alice",
            email: "alice@example.org",
            active: true,
          },
        ],
      },
    });
    const e = buildGraph({
      fleet: "lab",
      sources: [
        { connector: "okta", observation: obs("okta", "a") },
        {
          connector: "github",
          observation: obs("github", "b"),
        },
      ],
      machines: [{ source: "stolos", id: "alpha", name: "alpha", managed: true }],
      links: {},
    });
    const ctx: ExportContext = {
      fleet: fleet({ id: "lab" }),
      job: { id: "okta", kinds: ["ocsf"] },
      tenant: (uid: string) => uid.startsWith("okta:"),
      now: new Date(Date.now() + 60_000),
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
  },
);
