// Spec 089: OCSF types, the vocabularies, the schema language, OCSF findings, and the connector SDK.
import { assert, assertEquals, assertStringIncludes } from "./assert.ts";
import { DatabaseSync } from "node:sqlite";
import { Ajv } from "npm:ajv@8.17.1";
import { OCSF_CLASSES, OCSF_OBJECT_NAMES, OCSF_VERSION } from "../src/archon/ocsf/types.auto.ts";
import { D3FEND_ARTIFACTS } from "../src/archon/schema/d3fend.auto.ts";
import { nameProblems, SQL_KEYWORDS, terms } from "../src/archon/schema/vocabulary.ts";
import {
  defineLabel,
  defineTable,
  rowParams,
  schemaDoc,
  schemaProblems,
  schemaSql,
  upsertSql,
} from "../src/archon/schema/define.ts";
import { complianceFindings } from "../src/archon/ocsf/finding.ts";
import type { Evidence } from "../src/archon/compliance/report.ts";
import {
  bearer,
  clientCredentials,
  defineConnector,
  readOnly,
  recordedHttp,
  withBackoff,
} from "../src/archon/connect/sdk.ts";
import { AccessDenied } from "../src/archon/connect/connector.ts";

Deno.test("089: the generated OCSF types and D3FEND names are there", () => {
  assertEquals(OCSF_VERSION, "1.9.0");
  assertEquals(OCSF_CLASSES.compliance_finding.uid, 2003);
  assertEquals(OCSF_CLASSES.inventory_info.uid, 5001);
  assertEquals(OCSF_CLASSES.user_inventory.uid, 5003);
  assertEquals(OCSF_CLASSES.cloud_resources_inventory_info.uid, 5023);
  for (const o of ["device", "user", "account", "node", "edge", "finding"]) {
    assert(OCSF_OBJECT_NAMES.includes(o), o);
  }
  for (const a of ["user_account", "network_printer", "code_repository", "dns_record"]) {
    assert(D3FEND_ARTIFACTS.includes(a), a);
  }
});

Deno.test("089: names are singular lower_snake_case, never SQL keywords, and cite real terms", () => {
  const ocsf = (term: string) => ({ from: "ocsf" as const, term });
  assertEquals(nameProblems("node_label", [ocsf("node"), { from: "gql", term: "label" }]), []);
  assertEquals(nameProblems("person", [{ from: "udm", term: "person" }]), []);
  assertEquals(nameProblems("fixed_asset", [{ from: "udm", term: "fixed_asset" }]), []);
  assertStringIncludes(nameProblems("Person")[0], "not lower_snake_case");
  assertStringIncludes(nameProblems("user")[0], "an SQL keyword");
  assert(SQL_KEYWORDS.has("database"));
  assertStringIncludes(
    nameProblems("devices", [{ from: "ocsf", term: "devices" }]).join(";"),
    "plural",
  );
  assertEquals(nameProblems("status").length, 0, "a column, not plural");
  assertStringIncludes(
    nameProblems("gadget", [{ from: "udm", term: "gadget" }]).join(";"),
    '"gadget" is not a udm term',
  );
  assertStringIncludes(
    nameProblems("node_edge", [ocsf("node")]).join(";"),
    "not the terms it cites",
  );
  assert(terms("ocsf").has("compliance_finding"));
});

// A small graph, declared the way spec 090 will declare the estate.
const tenant = defineTable({
  name: "tenant",
  terms: [{ from: "iso22123", term: "tenant" }],
  doc: "One connected account.",
  columns: {
    tenant_uid: { type: "text", doc: "Its uid.", required: true },
    connector: { type: "text", doc: "The connector.", required: true },
  },
  key: ["tenant_uid"],
});
const node = defineTable({
  name: "node",
  terms: [{ from: "ocsf", term: "node" }],
  doc: "Every record from every source.",
  columns: {
    node_uid: { type: "text", doc: "Its uid.", required: true },
    tenant_uid: { type: "text", doc: "Its tenant.", required: true, references: "tenant" },
    native_id: { type: "text", doc: "Its id there.", required: true },
    display_name: { type: "text", doc: "Its name." },
    stale: { type: "boolean", doc: "Kept from an earlier observation.", required: true },
    props: { type: "json", doc: "Its properties.", required: true },
  },
  key: ["node_uid"],
});
const nodeLabel = defineTable({
  name: "node_label",
  terms: [{ from: "ocsf", term: "node" }, { from: "gql", term: "label" }],
  doc: "The labels a node carries.",
  columns: {
    node_uid: { type: "text", doc: "The node.", required: true, references: "node" },
    label: { type: "text", doc: "The label.", required: true, index: true },
    kind: { type: "text", doc: "Its kind.", required: true, values: ["standard", "ontology"] },
  },
  key: ["node_uid", "label"],
});
const userAccount = defineLabel({
  name: "user_account",
  terms: [{ from: "d3fend", term: "user_account" }],
  doc: "An account in some system.",
  props: {
    email: { type: "text", doc: "The work email." },
    admin: { type: "boolean", doc: "An administrator." },
    mfa: { type: "boolean", doc: "Has a second factor." },
  },
});
const SCHEMA = [userAccount, nodeLabel, node, tenant];

Deno.test("089: one declaration gives the SQL, the upsert, typed rows, and the docs", () => {
  assertEquals(schemaProblems(SCHEMA), []);
  const sql = schemaSql("test graph", SCHEMA);
  // Tables come before what references them, views last.
  assert(
    sql.indexOf("CREATE TABLE IF NOT EXISTS tenant") <
      sql.indexOf("CREATE TABLE IF NOT EXISTS node ("),
  );
  assert(sql.indexOf("CREATE TABLE IF NOT EXISTS node_label") < sql.indexOf("CREATE VIEW"));
  assertStringIncludes(sql, "CHECK (kind IN ('standard', 'ontology'))");
  assertStringIncludes(sql, "CHECK (stale IN (0, 1))");
  assertStringIncludes(
    sql,
    "CREATE INDEX IF NOT EXISTS node_label_label_idx ON node_label (label);",
  );
  const db = new DatabaseSync(":memory:");
  db.exec(sql);
  db.prepare(upsertSql(tenant)).run(
    ...rowParams(tenant, { tenant_uid: "okta:example", connector: "okta" }),
  );
  db.prepare(upsertSql(node)).run(...rowParams(node, {
    node_uid: "okta:example:00u1",
    tenant_uid: "okta:example",
    native_id: "00u1",
    display_name: "alice@example.com",
    stale: false,
    props: { email: "alice@example.com", admin: true, mfa: false },
  }));
  db.prepare(upsertSql(nodeLabel)).run(
    ...rowParams(nodeLabel, {
      node_uid: "okta:example:00u1",
      label: "user_account",
      kind: "ontology",
    }),
  );
  // The upsert updates, never duplicates.
  db.prepare(upsertSql(node)).run(...rowParams(node, {
    node_uid: "okta:example:00u1",
    tenant_uid: "okta:example",
    native_id: "00u1",
    display_name: "Alice",
    stale: false,
    props: { email: "alice@example.com", admin: true, mfa: true },
  }));
  const rows = db.prepare("SELECT * FROM user_account").all().map((r) => ({ ...r }));
  assertEquals(rows, [{
    user_account_uid: "okta:example:00u1",
    connector: "okta",
    tenant_uid: "okta:example",
    native_id: "00u1",
    display_name: "Alice",
    email: "alice@example.com",
    admin: 1,
    mfa: 1,
  }]);
  const doc = schemaDoc("test graph", SCHEMA);
  assertStringIncludes(doc, "erDiagram");
  assertStringIncludes(doc, "tenant ||--o{ node");
  assertStringIncludes(doc, "Named from: user_account (d3fend).");
});

Deno.test("089: rows are checked: required values, allowed values, booleans as 0 and 1", () => {
  let err = "";
  try {
    // deno-lint-ignore no-explicit-any
    rowParams(tenant, { tenant_uid: "x" } as any);
  } catch (e) {
    err = (e as Error).message;
  }
  assertEquals(err, "tenant.connector is required");
  try {
    // deno-lint-ignore no-explicit-any
    rowParams(nodeLabel, { node_uid: "n", label: "l", kind: "other" as any });
  } catch (e) {
    err = (e as Error).message;
  }
  assertStringIncludes(err, '"other" is not one of standard, ontology');
  const bad = schemaProblems([
    defineTable({
      name: "gadgets",
      terms: [{ from: "udm", term: "gadgets" }],
      doc: "",
      columns: { id: { type: "text", doc: "", references: "nowhere" } },
      key: ["id"],
    }),
  ]);
  assert(bad.some((p) => p.includes("plural")));
  assert(bad.some((p) => p.includes("not a udm term")));
  assert(bad.some((p) => p.includes("references nowhere, which is not declared")));
});

const ocsfSchema = JSON.parse(
  await Deno.readTextFile(
    new URL("../vendor/ocsf/1.9.0/compliance_finding.schema.json", import.meta.url),
  ),
);
const validFinding = new Ajv({ strict: false, logger: false, allErrors: true }).compile(ocsfSchema);

Deno.test("089: every result is an OCSF Compliance Finding that validates against OCSF's schema", () => {
  const now = new Date("2026-11-15T12:00:00Z");
  const cases: Array<[Evidence["status"], number, number]> = [
    ["pass", 1, 4],
    ["warn", 2, 1],
    ["fail", 3, 1],
    ["accepted", 3, 3],
    ["unknown", 0, 1],
  ];
  for (const [status, compliance, finding] of cases) {
    const e: Evidence = {
      scf: ["CRY-07", "AST-04"],
      subject: "alice-mbp",
      source: "adopted",
      check: "The disk is encrypted",
      status,
      detail: "FileVault on",
      fix: "turn on FileVault",
    };
    const fs = complianceFindings(e, {
      now,
      fleet: "lab",
      catalog: {
        format: 1,
        version: "test",
        controls: {
          "CRY-07": {
            domain: "",
            name: "",
            description: "",
            maps: {
              soc2: ["CC6.1"],
              hipaa: [],
              pci: [],
              cmmc: [],
              nist80053: ["SC-28"],
              nist800171: [],
              fedramp: [],
            },
          },
        },
      },
    });
    assertEquals(fs.length, 2, "one per SCF control");
    for (const f of fs) {
      assert(validFinding(f), `${status}: ${JSON.stringify(validFinding.errors?.slice(0, 3))}`);
      assertEquals(f.compliance.status_id, compliance);
      assertEquals(f.status_id, finding);
    }
    assertEquals(fs[0].compliance.requirements, ["SOC 2 CC6.1", "800-53 SC-28"]);
    assertEquals(fs[1].compliance.requirements, undefined);
    assertEquals(fs[0].remediation?.desc, status === "pass" ? undefined : "turn on FileVault");
  }
  assert(!validFinding({ class_uid: 2003 }), "the schema bites");
});

Deno.test("089: HTTP is read-only except declared token endpoints; 429 and 503 back off", async () => {
  const calls: Array<{ method: string; url: string }> = [];
  const http = readOnly(
    recordedHttp({
      "https://api.example.com/x": { body: [] },
      "https://id.example.com/token": { body: {} },
    }, calls),
    ["https://id.example.com/token"],
  );
  assertEquals((await http("https://api.example.com/x")).status, 200);
  const refused = await http("https://api.example.com/x", { method: "DELETE" }).then(
    () => "",
    (e: Error) => e.message,
  );
  assertStringIncludes(refused, "read-only: DELETE https://api.example.com is refused");
  assertEquals((await http("https://id.example.com/token", { method: "POST" })).status, 200);
  const post = await http("https://api.example.com/x", { method: "POST" }).then(
    () => "",
    (e: Error) => e.message,
  );
  assertStringIncludes(post, "refused");
  let n = 0;
  const waits: number[] = [];
  const flaky = withBackoff(
    () =>
      Promise.resolve(
        n++ < 2 ? { status: 429, text: "", retryAfter: "2" } : { status: 200, text: "ok" },
      ),
    3,
    (ms) => (waits.push(ms), Promise.resolve()),
  );
  assertEquals((await flaky("https://api.example.com/y")).text, "ok");
  assertEquals(waits, [2000, 2000]);
});

Deno.test("089: a declared connector pages, maps, records OCSF classes, and turns denials into gaps", async () => {
  const account = defineLabel({
    name: "user_account",
    terms: [{ from: "d3fend", term: "user_account" }],
    doc: "",
    props: { email: { type: "text", doc: "" }, admin: { type: "boolean", doc: "" } },
  });
  const repo = defineLabel({
    name: "code_repository",
    terms: [{ from: "d3fend", term: "code_repository" }],
    doc: "",
    props: { private: { type: "boolean", doc: "" } },
  });
  type U = { id: string; login: string; admin: boolean };
  const c = defineConnector({
    id: "example",
    title: "Example",
    logo: "",
    serviceModels: ["SaaS"],
    markets: ["access-management"],
    connectHelp: ["make a read-only token"],
    recipe: {},
    fields: {
      client_id: { secret: false, hint: "the client id" },
      client_secret: { secret: true, hint: "the client secret" },
    },
    tokenEndpoints: () => ["https://id.example.com/token"],
    auth: (cred, http) =>
      clientCredentials(
        http,
        "https://id.example.com/token",
        cred.client_id,
        cred.client_secret,
        "read",
      ),
    account: () => "example org",
    resources: {
      users: {
        label: account,
        ocsf: "user_inventory",
        keepUnmapped: true,
        list: (ctx) => ctx.linkPages<U>("https://api.example.com/users"),
        map: (u: U) => ({
          native_id: u.id,
          display_name: u.login,
          props: { email: u.login, admin: u.admin },
        }),
      },
      repos: {
        label: repo,
        ocsf: "cloud_resources_inventory_info",
        list: (ctx) =>
          ctx.cursorPages<
            { items: Array<{ id: string; name: string }> },
            { id: string; name: string }
          >(
            "https://api.example.com/repos",
            (b) => b.items,
            () => undefined,
          ),
        map: (r: { id: string; name: string }) => ({
          native_id: r.id,
          display_name: r.name,
          props: { private: true },
        }),
      },
    },
    posture: (records) => ({ admins: records.filter((r) => r.props.admin).length }),
    policies: () => [],
  });
  const calls: Array<{ method: string; url: string }> = [];
  const http = recordedHttp({
    "https://id.example.com/token": { body: { access_token: "t0ken" } },
    "https://api.example.com/users": {
      body: [{ id: "1", login: "alice@example.com", admin: true }],
      link: '<https://api.example.com/users?page=2>; rel="next"',
    },
    "https://api.example.com/users?page=2": {
      body: [{ id: "2", login: "bob@example.com", admin: false }],
    },
    "https://api.example.com/repos": { status: 403, body: {} },
  }, calls);
  const o = await c.observe(
    { client_id: "id", client_secret: "s" },
    http,
    new Date("2026-11-15T00:00:00Z"),
  );
  assertEquals(o.records?.map((r) => [r.label, r.ocsf_class_uid, r.native_id]), [
    ["user_account", 5003, "1"],
    ["user_account", 5003, "2"],
  ]);
  assertEquals(o.records?.[0].unmapped, { id: "1", login: "alice@example.com", admin: true });
  assertEquals(o.posture, { admins: 1 });
  assertEquals(o.gaps.length, 1);
  assertStringIncludes(o.gaps[0], "repos: /repos: 403");
  assertEquals(calls.map((x) => x.method), ["POST", "GET", "GET", "GET"]);
  assertEquals(c.fields.map((f) => f.name), ["client_id", "client_secret"]);
  assertEquals(bearer("x").Authorization, "Bearer x");
  const denied = await clientCredentials(
    recordedHttp({ "https://id.example.com/token": { status: 401, body: {} } }),
    "https://id.example.com/token",
    "a",
    "b",
  ).then(() => undefined, (e) => e);
  assert(denied instanceof AccessDenied);
});
