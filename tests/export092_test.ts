// Spec 092 (part A): exporters in standard formats: OCSF JSON Lines, OTLP JSON logs,
// CycloneDX 1.6 attestations, in-toto statements with DSSE, and the exports API.
import { assert, assertEquals, assertStringIncludes } from "./assert.ts";
import { Ajv } from "npm:ajv@8.17.1";
import { unzipSync } from "npm:fflate@0.8.2";
import type { Observation } from "../src/archon/connect/connector.ts";
import { buildGraph, estatePolicies, estateQuery } from "../src/archon/estate/graph.ts";
import type { Snapshot } from "../src/archon/estate/snapshot.ts";
import { CATALOG_FORMAT, SCF_SOURCE, type ScfCatalog } from "../src/archon/compliance/catalog.ts";
import { complianceView, type Evidence, fleetEvidence } from "../src/archon/compliance/report.ts";
import { observationUuid, oscalExports } from "../src/archon/compliance/oscal.ts";
import { SCF } from "../src/archon/compliance/scf.ts";
import { type Item, manifestFor, packBundle, sha256Hex } from "../src/archon/evidence/bundle.ts";
import { VERSION } from "../src/archon/version.ts";
import { FACTS } from "./console/serve-stolos.ts";
import { estateEvents, type OcsfEvent, osTypeId } from "../src/archon/export/ocsf.ts";
import { otlpLogsRequest } from "../src/archon/export/otlp.ts";
import { cdxAttestation, conformance } from "../src/archon/export/cyclonedx.ts";
import {
  base64,
  bundleInfo,
  dsseEnvelope,
  EVIDENCE_BUNDLE_PREDICATE,
  pae,
} from "../src/archon/export/intoto.ts";
import {
  buildExports,
  EXPORT_KINDS,
  type ExportInput,
  ocsfEvents,
} from "../src/archon/export/exports.ts";
import { COMMANDS } from "../src/archon/commands/registry.ts";
import type { OtlpAnyValue } from "../src/archon/telemetry/events.ts";

const enc = new TextEncoder();
const dec = new TextDecoder();
const NOW = new Date("2026-11-15T12:00:00Z");
const AT = "2026-11-01T00:00:00Z";

// The estate: the same lab as spec 090's tests, with one record from a connector SDK.
const obs = (
  provider: string,
  account: string,
  entities: Observation["entities"],
): Observation => ({
  at: AT,
  provider,
  account,
  assets: [],
  posture: {},
  gaps: [],
  ...(entities ? { entities } : {}),
});
const hr = obs("bamboohr", "example", {
  people: [
    {
      email: "alice@example.org",
      name: "Alice",
      status: "active",
      type: "employee",
      manager: "carol@example.org",
      start: "2024-02-01",
    },
    { email: "bob@example.org", name: "Bob", status: "terminated", end: "2026-10-31" },
    { email: "carol@example.org", name: "Carol", status: "active" },
  ],
});
const okta = obs("okta", "example.okta.com", {
  accounts: [
    {
      system: "okta",
      id: "1",
      name: "alice",
      email: "alice@example.org",
      active: true,
      admin: true,
      mfa: false,
      lastLogin: "2026-10-30T08:00:00Z",
    },
    { system: "okta", id: "2", name: "bob", email: "bob@example.org", active: true, mfa: true },
  ],
});
const github: Observation = {
  ...obs("github", "example", {
    accounts: [
      { system: "github", id: "3", name: "ci-bot", active: true, service: true },
      { system: "github", id: "4", name: "mallory", active: true },
    ],
    repositories: [{ system: "github", name: "example/app", private: true, protected: false }],
  }),
  records: [{
    label: "dns_record",
    ocsf_class_uid: 5023,
    native_id: "zone-1",
    display_name: "lab.example.net",
    props: { dnssec: true },
  }],
};
const snapshot: Snapshot = {
  fleet: "lab",
  sources: [["bamboohr", hr], ["okta", okta], ["github", github]].map(([connector, o]) => ({
    connector: connector as string,
    observation: o as Observation,
  })),
  machines: [
    { source: "stolos", id: "alpha", name: "alpha", managed: true, os: "Ubuntu 26.04" },
    {
      source: "adopted",
      id: "alice-mbp",
      name: "alice-mbp.local",
      owner: "alice@example.org",
      managed: false,
      serial: "c02x",
      encrypted: false,
      os: "macOS 15",
    },
    { source: "snmp", id: "printer", name: "printer", managed: false },
  ],
  links: {},
};
const estate = () => {
  const e = buildGraph(snapshot, { now: new Date(AT), fleetTitle: "Lab" });
  estatePolicies(e, new Date(AT));
  return e;
};

// A small SCF catalog (two controls mapped), in the cached format.
const NO_MAPS = {
  soc2: [],
  hipaa: [],
  pci: [],
  cmmc: [],
  nist80053: [],
  nist800171: [],
  fedramp: [],
};
const CATALOG: ScfCatalog = {
  format: CATALOG_FORMAT,
  version: SCF_SOURCE.version,
  controls: {
    "CRY-07": {
      domain: "Cryptographic Protections",
      name: "Encrypting Data At Rest",
      description: "Mechanisms exist to prevent unauthorized disclosure of data at rest.",
      maps: { ...NO_MAPS, soc2: ["CC6.1"], nist80053: ["SC-28"] },
    },
    "CHG-03": {
      domain: "Change Management",
      name: "Configuration Change Control",
      description:
        "Mechanisms exist to govern the technical configuration change control processes.",
      maps: { ...NO_MAPS, nist80053: ["CM-03"] },
    },
  },
};
const accepted: Evidence = {
  scf: ["CRY-07"],
  subject: "alice-mbp",
  source: "adopted",
  check: "The disk is encrypted",
  status: "accepted",
  detail: "accepted by Alice until 2026-12-31",
};
const view = () => complianceView([...fleetEvidence(FACTS, NOW.getTime()), accepted], CATALOG);
const FLEET = { id: "lab", title: "Lab", repo: "example/fleet" };

/** A small bundle, as spec 072 packs it (the signature is a stand-in: nothing verifies it here). */
async function bundle(): Promise<{ name: string; zip: Uint8Array }> {
  const items: Item[] = [
    {
      kind: "commit",
      name: "commit 1111111111111111111111111111111111111111",
      at: "2026-11-02T10:00:00Z",
      content: enc.encode("tree x\n\nfirst\n"),
    },
    {
      kind: "observation",
      name: "fleets/lab/adopted/alice-mbp/observed.ts @ 111111111111",
      at: "2026-11-02T10:00:00Z",
      content: enc.encode("export const observed = {};\n"),
    },
    {
      kind: "verify",
      name: "alpha verify all",
      at: "2026-11-03T10:00:00Z",
      content: enc.encode('{"ok":true}\n'),
    },
    {
      kind: "oscal",
      name: "assessment-results.json",
      at: NOW.toISOString(),
      content: enc.encode('{"assessment-results":{}}\n'),
    },
    {
      kind: "signers",
      name: "fleets/lab/signers.ts",
      at: NOW.toISOString(),
      content: enc.encode("x"),
    },
  ];
  const m = await manifestFor(items, {
    fleet: FLEET,
    period: { from: "2026-11-01", to: "2026-11-15" },
    created: "2026-11-15T12:00:00Z",
    stolos: "0.0.0",
    signer: "alice",
    omitted: [],
  });
  return {
    name: "lab-evidence-2026-11-01-to-2026-11-15.zip",
    zip: packBundle(items, m, "-----BEGIN SSH SIGNATURE-----\n", "alice ssh-ed25519 AAAA\n"),
  };
}

const ajv = () => new Ajv({ strict: false, logger: false, allErrors: true });
const readJson = async (path: string) =>
  JSON.parse(await Deno.readTextFile(new URL(path, import.meta.url)));
const OCSF_SCHEMA: Record<number, string> = {
  5001: "inventory_info",
  5003: "user_inventory",
  5023: "cloud_resources_inventory_info",
  2003: "compliance_finding",
};
const ocsfValidators = Object.fromEntries(
  await Promise.all(
    Object.entries(OCSF_SCHEMA).map(async ([uid, name]) => [
      uid,
      ajv().compile(await readJson(`../vendor/ocsf/1.9.0/${name}.schema.json`)),
    ]),
  ),
);
const cdx = ajv();
cdx.addSchema(await readJson("../vendor/cyclonedx/1.6/spdx.schema.json"));
cdx.addSchema(await readJson("../vendor/cyclonedx/1.6/jsf-0.82.schema.json"));
const validCdx = cdx.compile(await readJson("../vendor/cyclonedx/1.6/bom-1.6.schema.json"));

function validOcsf(e: OcsfEvent): void {
  const v = ocsfValidators[e.class_uid];
  assert(v, `no schema for class ${e.class_uid}`);
  assert(v(e), `${e.class_uid}: ${JSON.stringify(v.errors?.slice(0, 3))}\n${JSON.stringify(e)}`);
}

Deno.test("092: the estate as OCSF inventory, each event valid against its OCSF 1.9.0 class schema", () => {
  const events = estateEvents(estate(), { fleet: "lab", fleetTitle: "Lab", now: NOW });
  for (const e of events) validOcsf(e);
  const by = (uid: number) => events.filter((e) => e.class_uid === uid);
  // 3 people, 4 accounts; 3 machines (alice-mbp's serial dedupes nothing else); a repository and a DNS record.
  assertEquals(by(5003).length, 7);
  assertEquals(by(5001).length, 3);
  assertEquals(by(5023).length, 2);
  for (const e of events) {
    assertEquals(e.metadata.product, {
      name: "Stolos",
      vendor_name: "Intellectual Frontiers LLC",
      version: VERSION,
    });
    assertEquals(e.metadata.tenant_uid, "lab");
    assertEquals(e.time, NOW.getTime());
  }
  // Each person, then their accounts (tied by correlation_uid); then the accounts of no one.
  const users = by(5003).flatMap((e) => e.class_uid === 5003 ? [e] : []);
  assertEquals(users.map((u) => u.user.uid), [
    "person:alice@example.org",
    "okta:example.okta.com:1",
    "person:bob@example.org",
    "okta:example.okta.com:2",
    "person:carol@example.org",
    "github:example:3",
    "github:example:4",
  ]);
  const alice = users[0].user;
  assertEquals(alice.ldap_person?.manager?.uid, "person:carol@example.org");
  assertEquals(alice.ldap_person?.hire_time, Date.parse("2024-02-01"));
  assertEquals(alice.ldap_person?.labels, ["employee"]);
  assertEquals(users[1].metadata.correlation_uid, "person:alice@example.org");
  assertEquals(users[1].user.type_id, 2, "an administrator");
  assertEquals(users[1].user.has_mfa, false);
  assertEquals(users[5].user.type_id, 4, "a service account");
  assertEquals(users[5].metadata.correlation_uid, undefined);
  const devices = by(5001).flatMap((e) => e.class_uid === 5001 ? [e.device] : []);
  const mbp = devices.find((d) => d.hostname === "alice-mbp")!;
  assertEquals(mbp.hw_info?.serial_number, "c02x");
  assertEquals(mbp.os, { name: "macOS 15", type_id: 300 });
  assertEquals(mbp.owner?.email_addr, "alice@example.org");
  assertEquals(devices.find((d) => d.hostname === "alpha")?.type_id, 1);
  assertEquals(osTypeId("Ubuntu 26.04"), 200);
  assertEquals(osTypeId("Windows 11"), 100);
});

Deno.test("092: compliance findings join the stream; JSON Lines, one valid event per line", async () => {
  const input: ExportInput = {
    fleet: FLEET,
    now: NOW,
    estate: estate(),
    view: view(),
    catalog: CATALOG,
  };
  const events = ocsfEvents(input);
  const findings = events.filter((e) => e.class_uid === 2003);
  const pieces = new Set(view().controls.flatMap((c) => c.evidence));
  assertEquals(findings.length, [...pieces].reduce((n, e) => n + e.scf.length, 0));
  const f = await buildExports("ocsf-jsonl", input);
  assertEquals(f.fileName, "lab-ocsf.jsonl");
  assertEquals(f.mediaType, "application/x-ndjson");
  const text = dec.decode(f.bytes);
  assert(text.endsWith("\n"));
  const lines = text.trimEnd().split("\n");
  assertEquals(lines.length, events.length);
  for (const l of lines) validOcsf(JSON.parse(l));
});

/** An OTLP AnyValue back to a JavaScript value. */
function fromAny(v: OtlpAnyValue): unknown {
  if ("stringValue" in v) return v.stringValue;
  if ("boolValue" in v) return v.boolValue;
  if ("intValue" in v) return Number(v.intValue);
  if ("doubleValue" in v) return v.doubleValue;
  if ("arrayValue" in v) return v.arrayValue.values.map(fromAny);
  if ("kvlistValue" in v) {
    return Object.fromEntries(v.kvlistValue.values.map((kv) => [kv.key, fromAny(kv.value)]));
  }
  return null;
}

Deno.test("092: OTLP/HTTP JSON logs: each OCSF event a LogRecord, entity events only when asked", async () => {
  const input: ExportInput = { fleet: FLEET, now: NOW, estate: estate(), view: view() };
  const events = ocsfEvents(input);
  const req = JSON.parse(dec.decode((await buildExports("otlp-json", input)).bytes));
  assertEquals(req.resourceLogs.length, 1);
  const rl = req.resourceLogs[0];
  const res = Object.fromEntries(
    rl.resource.attributes.map((
      a: { key: string; value: OtlpAnyValue },
    ) => [a.key, fromAny(a.value)]),
  );
  assertEquals(res, {
    "service.name": "stolos",
    "service.version": VERSION,
    "service.namespace": "lab",
  });
  assertEquals(rl.scopeLogs[0].scope, { name: "stolos.export", version: VERSION });
  const recs = rl.scopeLogs[0].logRecords;
  assertEquals(recs.length, events.length, "no entity events by default");
  recs.forEach((r: Record<string, unknown>, k: number) => {
    const e = events[k];
    assert(/^\d+$/.test(String(r.timeUnixNano)), "nanoseconds as a decimal string");
    assertEquals(r.timeUnixNano, `${e.time}000000`);
    assert([9, 13].includes(Number(r.severityNumber)));
    assert(String(r.eventName).startsWith("ocsf."));
    const attrs = r.attributes as Array<{ key: string; value: OtlpAnyValue }>;
    assertEquals(attrs.map((a) => a.key), ["ocsf.class_uid", "ocsf.category_uid"]);
    assertEquals(attrs[0].value, { intValue: String(e.class_uid) });
    assertEquals(
      fromAny(r.body as OtlpAnyValue),
      JSON.parse(JSON.stringify(e)),
      "the body is the event",
    );
  });
  assertEquals(recs[0].eventName, "ocsf.user_inventory");
  assert(recs.some((r: { eventName: string }) => r.eventName === "ocsf.compliance_finding"));
  const withEntities = otlpLogsRequest(events, { fleet: "lab", entities: true, now: NOW });
  const ent = withEntities.resourceLogs[0].scopeLogs[0].logRecords.filter((r) =>
    r.eventName === "entity.state"
  );
  assertEquals(ent.length, 3 + 2, "each machine and each other node; never people or accounts");
  const host = Object.fromEntries(ent[0].attributes.map((a) => [a.key, fromAny(a.value)]));
  assertEquals(host["entity.type"], "host");
  assertEquals(Object.keys(host["entity.id"] as object), ["host.id"]);
});

Deno.test("092: a CycloneDX 1.6 attestation, valid against the official schema, with and without a bundle", async () => {
  const v = view();
  const plain = await cdxAttestation({ view: v, fleet: FLEET, now: NOW, signer: "alice" });
  assert(validCdx(plain), JSON.stringify(validCdx.errors?.slice(0, 5), null, 1));
  const b = await bundle();
  const info = await bundleInfo(`/somewhere/${b.name}`, b.zip);
  assertEquals(info.fileName, b.name);
  const doc = await cdxAttestation({ view: v, fleet: FLEET, now: NOW, bundle: info });
  assert(validCdx(doc), JSON.stringify(validCdx.errors?.slice(0, 5), null, 1));

  const std = doc.definitions.standards[0];
  assertEquals(std.name, "Secure Controls Framework");
  assertEquals(std.version, SCF_SOURCE.version);
  assertEquals(std.requirements.map((r) => r.identifier), SCF.map((c) => c.id));
  assertEquals(
    std.requirements.find((r) => r.identifier === "CRY-07")?.text,
    CATALOG.controls["CRY-07"].description,
  );
  const d = doc.declarations;
  assertEquals(d.claims.length, SCF.length, "one claim per control");
  const chg = d.claims.find((c) => c["bom-ref"] === "claim:CHG-03")!;
  assertStringIncludes(chg.predicate, SCF.find((c) => c.id === "CHG-03")!.how);
  assertEquals(chg.externalReferences?.[0].hashes?.[0], { alg: "SHA-256", content: info.sha256 });
  // Every reference resolves, and every bom-ref is unique.
  const refs = [
    ...std.requirements.map((r) => r["bom-ref"]),
    ...d.claims.map((c) => c["bom-ref"]),
    ...d.evidence.map((e) => e["bom-ref"]),
    ...d.assessors.map((a) => a["bom-ref"]),
    ...d.targets.components.map((t) => t["bom-ref"]),
    std["bom-ref"],
  ];
  assertEquals(new Set(refs).size, refs.length);
  const known = new Set(refs);
  for (const c of d.claims) {
    assert(known.has(c.target));
    for (const r of c.evidence ?? []) assert(known.has(r), r);
  }
  for (const m of d.attestations[0].map) {
    assert(known.has(m.requirement));
    for (const c of m.claims) assert(known.has(c));
  }
  // Bundle items by SHA-256; checks by their OSCAL observation's UUID.
  for (const it of info.manifest.items) {
    const e = d.evidence.find((x) => x["bom-ref"] === `evidence:sha256:${it.sha256}`)!;
    assertEquals(e.data[0].contents.url, `objects/${it.sha256}`);
  }
  const uuid = await observationUuid("lab", NOW, accepted);
  assert(d.evidence.some((e) => e.data[0].contents.url === `urn:uuid:${uuid}`));
  assert(
    chg.evidence?.includes(
      `evidence:sha256:${info.manifest.items.find((i) => i.kind === "commit")!.sha256}`,
    ),
  );
  // The signatory is the bundle's signer, without a signature.
  assertEquals(d.affirmation.signatories?.[0].name, "alice");
  assertEquals(JSON.stringify(doc).includes('"signature"'), false);
  // Conformance: the share of checks that pass.
  const cry = v.controls.find((c) => c.control.id === "CRY-07")!;
  const pass = cry.evidence.filter((e) => e.status === "pass").length;
  assertEquals(conformance(cry).score, Math.round((pass / cry.evidence.length) * 1000) / 1000);
  assertEquals(
    d.attestations[0].map.find((m) => m.requirement === "requirement:CRY-07")?.conformance,
    conformance(cry),
  );
  const none = v.controls.find((c) => !c.evidence.length);
  if (none) assertEquals(conformance(none), { score: 0, rationale: "no evidence yet" });
});

Deno.test("092: DSSE's PAE matches the specification's example", () => {
  assertEquals(
    dec.decode(pae("http://example.com/HelloWorld", enc.encode("hello world"))),
    "DSSEv1 29 http://example.com/HelloWorld 11 hello world",
  );
  // Lengths are in bytes, not characters.
  assertEquals(dec.decode(pae("t", enc.encode("é"))), "DSSEv1 1 t 2 é");
  assertEquals(base64(enc.encode("hello world")), "aGVsbG8gd29ybGQ=");
});

Deno.test("092: an in-toto Statement v1 for an evidence bundle, wrapped in a signed DSSE envelope", async () => {
  const b = await bundle();
  const info = await bundleInfo(b.name, b.zip);
  const f = await buildExports("intoto-statement", { fleet: FLEET, now: NOW, bundle: info });
  assertEquals(f.fileName, "lab-evidence-2026-11-01-to-2026-11-15.intoto.json");
  assertEquals(f.mediaType, "application/vnd.in-toto+json");
  const st = JSON.parse(dec.decode(f.bytes));
  assertEquals(st._type, "https://in-toto.io/Statement/v1");
  assertEquals(st.predicateType, EVIDENCE_BUNDLE_PREDICATE);
  assert(EVIDENCE_BUNDLE_PREDICATE.startsWith("https://github.com/intellectual-frontiers/stolos/"));
  assertEquals(st.subject[0], {
    name: b.name,
    digest: { sha256: await sha256Hex(b.zip) },
    mediaType: "application/zip",
  });
  const files = unzipSync(b.zip);
  for (const s of st.subject.slice(1)) {
    assertEquals(await sha256Hex(files[s.name]), s.digest.sha256, s.name);
  }
  assertEquals(st.subject.length, 1 + info.manifest.items.length);
  assertEquals(st.predicate.signer, "alice");
  assertEquals(st.predicate.items, {
    total: 5,
    by_kind: { commit: 1, observation: 1, verify: 1, oscal: 1, signers: 1 },
  });
  assertEquals(st.predicate.manifest.digest.sha256, await sha256Hex(files["manifest.json"]));
  assertEquals(st.predicate.head, info.manifest.head);

  // A signature over PAE, as a DSSE verifier checks it.
  const keys = await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ]) as CryptoKeyPair;
  const env = await dsseEnvelope(st, [async (bytes) => ({
    keyid: "alice",
    sig: new Uint8Array(await crypto.subtle.sign("Ed25519", keys.privateKey, bytes)),
  })]);
  assertEquals(env.payloadType, "application/vnd.in-toto+json");
  const payload = Uint8Array.from(atob(env.payload), (c) => c.charCodeAt(0));
  assertEquals(JSON.parse(dec.decode(payload)), st);
  const sig = Uint8Array.from(atob(env.signatures[0].sig), (c) => c.charCodeAt(0));
  assert(
    await crypto.subtle.verify("Ed25519", keys.publicKey, sig, pae(env.payloadType, payload)),
  );
  assertEquals(env.signatures[0].keyid, "alice");
});

Deno.test("092: buildExports: every kind, the same bytes for the same input; OSCAL as spec 071 makes it", async () => {
  const b = await bundle();
  const input: ExportInput = {
    fleet: FLEET,
    now: NOW,
    estate: estate(),
    view: view(),
    catalog: CATALOG,
    machines: FACTS.machines,
    bundle: await bundleInfo(b.name, b.zip),
  };
  const again = { ...input, estate: estate(), view: view() };
  const names = new Set<string>();
  for (const k of EXPORT_KINDS) {
    const a = await buildExports(k, input);
    const z = await buildExports(k, again);
    assertEquals(dec.decode(a.bytes), dec.decode(z.bytes), k);
    assert(a.fileName.length && !a.fileName.includes("/"), k);
    names.add(a.fileName);
  }
  assertEquals(names.size, EXPORT_KINDS.length, "each kind its own file name");
  const ssp = JSON.parse(dec.decode((await buildExports("oscal-ssp", input)).bytes));
  const docs = await oscalExports({
    view: input.view!,
    fleet: FLEET,
    machines: FACTS.machines,
    version: VERSION,
    now: NOW,
  });
  assertEquals(ssp, JSON.parse(JSON.stringify(docs["system-security-plan.json"])));
  // What is missing is named.
  const missing = async (k: (typeof EXPORT_KINDS)[number], i: ExportInput, text: string) => {
    let msg = "";
    await buildExports(k, i).catch((e) => msg = (e as Error).message);
    assertStringIncludes(msg, text);
  };
  await missing("intoto-statement", { fleet: FLEET, now: NOW }, "evidence bundle");
  await missing("ocsf-jsonl", { fleet: FLEET, now: NOW }, "nothing to export");
  await missing("oscal-poam", { fleet: FLEET, now: NOW, view: complianceView([]) }, "SCF catalog");
});

Deno.test("092: no personal fields beyond what the estate holds", async () => {
  const e = estate();
  const input: ExportInput = { fleet: FLEET, now: NOW, estate: e, view: view() };
  const text = [
    dec.decode((await buildExports("ocsf-jsonl", input)).bytes),
    dec.decode((await buildExports("otlp-json", { ...input, entityEvents: true })).bytes),
  ].join("\n");
  // Every email address that goes out is one the estate already holds.
  const held = new Set([
    ...estateQuery(e, "SELECT address FROM contact_mechanism").map((r) => String(r.address)),
    ...estateQuery(e, "SELECT email FROM user_account WHERE email IS NOT NULL").map((r) =>
      String(r.email)
    ),
  ]);
  const sent = new Set(text.match(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g) ?? []);
  for (const a of sent) assert(held.has(a), `${a} is not in the estate`);
  // Names: only the people's own, as the source of truth gave them.
  const people = estateQuery(e, "SELECT name FROM person").map((r) => String(r.name));
  for (const m of text.matchAll(/"full_name":"([^"]*)"/g)) assert(people.includes(m[1]), m[1]);
  // OCSF's other personal attributes are never filled.
  const keys = new Set<string>();
  const walk = (x: unknown) => {
    if (Array.isArray(x)) x.forEach(walk);
    else if (x && typeof x === "object") {
      for (const [k, v] of Object.entries(x)) {
        keys.add(k);
        walk(v);
      }
    }
  };
  walk(ocsfEvents(input));
  for (
    const k of [
      "phone_number",
      "given_name",
      "surname",
      "job_title",
      "cost_center",
      "department",
      "location",
      "office_location",
      "employee_uid",
      "forward_addr",
      "credential_uid",
    ]
  ) {
    assert(!keys.has(k), `${k} is exported`);
  }
});

Deno.test("092: stolos export <kind> is a read-tier command with every kind", () => {
  const c = COMMANDS.find((x) => x.name === "export")!;
  assertEquals(c.tier, "read");
  assertEquals(c.place, "pc");
  const kind = c.args.find((a) => a.name === "kind")!;
  assertEquals(kind.choices, ["rdf", ...EXPORT_KINDS]);
  assert(c.args.some((a) => a.name === "out"));
});
