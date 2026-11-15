// Spec 094: the read-only REST API for estate data, in the Stolos Console, with an OpenAPI 3.1
// document generated from the estate schema's declarations.
import { assert, assertEquals, assertStringIncludes } from "./assert.ts";
import { Ajv } from "npm:ajv@8.17.1";
import { Ajv2020 } from "npm:ajv@8.17.1/dist/2020.js";
import { ESTATE_SCHEMA } from "../src/archon/estate/schema.ts";
import { openApiDocument, OSCAL_DOCUMENTS } from "../src/archon/api/openapi.ts";
import { listQuery, resourceNamed, RESOURCES } from "../src/archon/api/resources.ts";
import { fakeConsole } from "./console/serve-stolos.ts";

const PORT = 8094;
const B = `http://127.0.0.1:${PORT}`;
const HOST = { host: `127.0.0.1:${PORT}` };
const BUNDLE = "lab-evidence-2026-01-01-to-2026-06-30.zip";

// deno-lint-ignore no-explicit-any
type Doc = Record<string, any>;

async function signedIn() {
  const c = await fakeConsole(PORT);
  const r = await c.handler(new Request(`${B}/launch?t=${c.launch.issue()}`, { headers: HOST }));
  assertEquals(r.status, 303);
  const cookie = r.headers.get("set-cookie")!.split(";")[0];
  const req = (path: string, init: RequestInit = {}) =>
    c.handler(
      new Request(B + path, {
        ...init,
        headers: { ...HOST, cookie, ...(init.headers as Record<string, string> ?? {}) },
      }),
    );
  const json = async (path: string, h: Record<string, string> = {}) => {
    const r = await req(path, { headers: h });
    return { status: r.status, type: r.headers.get("content-type"), body: await r.json() };
  };
  return { ...c, cookie, req, json };
}

/** Ajv (JSON Schema 2020-12) with the document added, so its own $refs resolve. */
function validator(doc: Doc) {
  const ajv = new Ajv2020({ strict: false, logger: false, allErrors: true });
  ajv.addSchema(doc, "openapi.json");
  const at = (pointer: string) => {
    const v = ajv.compile({ $ref: `openapi.json#${pointer}` });
    return (x: unknown, what: string) =>
      assert(v(x), `${what}: ${JSON.stringify(v.errors?.slice(0, 3), null, 1)}`);
  };
  const esc = (s: string) => s.replace(/~/g, "~0").replace(/\//g, "~1");
  return {
    response: (path: string, status = "200", type = "application/json") =>
      at(`/paths/${esc(path)}/get/responses/${status}/content/${esc(type)}/schema`),
    component: (name: string) => at(`/components/schemas/${name}`),
  };
}

Deno.test("094: the OpenAPI document is valid OpenAPI 3.1 (the official schema)", async () => {
  const text = await Deno.readTextFile(
    new URL("../vendor/openapi/3.1/schema.json", import.meta.url),
  );
  // Ajv honors $dynamicAnchor only at a schema resource's root, and the official schema puts its
  // one anchor ("meta") on $defs/schema, so Ajv would resolve "#meta" to the whole document. In
  // this schema the anchor's only target is $defs/schema (an object or a boolean), so a static
  // $ref to it is the same check; the vendored file itself stays unchanged.
  assertEquals(text.match(/"\$dynamicAnchor"/g)?.length, 1);
  const schema = JSON.parse(
    text.replaceAll('"$dynamicRef": "#meta"', '"$ref": "#/$defs/schema"')
      .replace('"$dynamicAnchor": "meta",', ""),
  );
  assert(!JSON.stringify(schema).includes("$dynamic"));
  const ajv = new Ajv2020({ strict: false, logger: false, allErrors: true });
  const valid = ajv.compile(schema);
  const doc = openApiDocument();
  assert(valid(doc), JSON.stringify(valid.errors?.slice(0, 5), null, 1));
  assertEquals(doc.openapi, "3.1.0");
  // The schema rejects what is not OpenAPI (it is not just accepting anything).
  assert(!valid({ openapi: "3.1.0", info: { title: "x" }, paths: {} }), "info.version required");
  assert(!valid({ ...doc, paths: { "v1/no-slash": {} } }), "a path starts with /");
});

Deno.test("094: one path per estate table and view, typed from the declarations", () => {
  const doc = openApiDocument() as Doc;
  for (const d of ESTATE_SCHEMA) {
    const op = doc.paths[`/v1/${d.name}`]?.get;
    assert(op, `${d.name} has a path`);
    assertEquals(op.description, d.doc);
    const row = doc.components.schemas[d.name];
    assertEquals(Object.keys(row.properties), Object.keys(d.columns), d.name);
  }
  const s = doc.components.schemas;
  assertEquals(s.fixed_asset.properties.managed.type, "boolean");
  assertEquals(s.fixed_asset.properties.encrypted.type, ["boolean", "null"]);
  assertEquals(
    s.fixed_asset.properties.managed.description,
    (ESTATE_SCHEMA.find((d) => d.name === "fixed_asset")!.columns.managed as { doc: string }).doc,
  );
  assertEquals(s.node.properties.props.type, "object");
  assertEquals(s.node.properties.ocsf_class_uid.type, ["integer", "null"]);
  assertEquals(s.code_repository.properties.reviews.type, ["integer", "null"]);
  assertEquals(s.user_account.properties.mfa.type, ["boolean", "null"]);
  assertEquals(s.device.properties.is_managed.type, "boolean");
  assertEquals(s.person.properties.status.enum, ["active", "terminated", "leave", "unknown"]);
  assertEquals(s.fixed_asset.properties.fixed_asset_type.enum, [
    "server",
    "workstation",
    "network_device",
    "other",
  ]);
  assertEquals(s.tenant.properties.service_model.enum, ["iaas", "paas", "saas", null]);
  assertEquals(s.compliance_finding.properties.status.enum, ["Pass", "Warning", "Fail", "Unknown"]);
  // Filters for every column but JSON ones; finding also takes ?format.
  const params = (n: string) =>
    (doc.paths[`/v1/${n}`].get.parameters as Array<{ name?: string; $ref?: string }>)
      .map((p) => p.name ?? p.$ref!.split("/").pop());
  assert(!params("node").includes("props"));
  assert(params("node").includes("stale"));
  assert(params("finding").includes("format"));
  assert(!params("person").includes("format"));
  assertEquals(
    Object.keys(doc.paths[`/v1/finding`].get.responses["200"].content),
    ["application/json", "application/vnd.ocsf+json"],
  );
  for (
    const p of [
      "/v1/",
      "/v1/openapi.json",
      "/v1/oscal/{document}",
      "/v1/evidence/",
      "/v1/evidence/{bundle}",
    ]
  ) {
    assert(doc.paths[p]?.get, p);
  }
  // No table or view takes a name the other routes use.
  for (const r of RESOURCES) assert(!["oscal", "evidence", "openapi.json"].includes(r.name));
});

Deno.test("094: every route answers within its schema", async () => {
  const { json, req } = await signedIn();
  const served = await json("/v1/openapi.json");
  assertEquals(served.status, 200);
  const doc = served.body as Doc;
  assertEquals(doc, JSON.parse(JSON.stringify(openApiDocument({ port: PORT }))));
  const v = validator(doc);
  const index = await json("/v1/");
  v.response("/v1/")(index.body, "/v1/");
  assertEquals(index.body.resources.length, ESTATE_SCHEMA.length);
  assertEquals((await json("/v1")).body, index.body);
  for (const r of RESOURCES) {
    const page = await json(`/v1/${r.name}?limit=1000`);
    assertEquals(page.status, 200, r.name);
    v.response(`/v1/${r.name}`)(page.body, r.name);
    assertEquals(page.body.items.length, page.body.total, r.name);
  }
  for (const name of ["person", "device", "user_account", "finding", "node", "fixed_asset"]) {
    assert((await json(`/v1/${name}`)).body.total > 0, `${name} has rows in the fake estate`);
  }
  const ocsf = await json("/v1/finding?format=ocsf");
  assertEquals(ocsf.type, "application/vnd.ocsf+json");
  v.response("/v1/finding", "200", "application/vnd.ocsf+json")(ocsf.body, "ocsf");
  for (const d of OSCAL_DOCUMENTS) {
    const o = await json(`/v1/oscal/${d}`);
    assertEquals(o.status, 200, d);
    v.response("/v1/oscal/{document}")(o.body, d);
  }
  assert("plan-of-action-and-milestones" in (await json("/v1/oscal/poam")).body);
  assertEquals((await json("/v1/oscal/poam.json")).status, 200);
  const ev = await json("/v1/evidence/");
  v.response("/v1/evidence/")(ev.body, "evidence");
  assertEquals(ev.body.items.map((b: { name: string }) => b.name), [BUNDLE]);
  const zip = await req(`/v1/evidence/${BUNDLE}`);
  assertEquals(zip.status, 200);
  assertEquals(zip.headers.get("content-type"), "application/zip");
  assertStringIncludes(zip.headers.get("content-disposition")!, BUNDLE);
  assertEquals((await zip.bytes()).slice(0, 2), new Uint8Array([0x50, 0x4b]));
  // Errors are JSON in the error schema.
  for (const p of ["/v1/nope", "/v1/person?limit=0", "/v1/evidence/nope.zip"]) {
    v.component("error")((await json(p)).body, p);
  }
});

Deno.test("094: filters and paging, with bound values", async () => {
  const { json } = await signedIn();
  const all = (await json("/v1/person")).body;
  assertEquals(all.limit, 100);
  assertEquals(all.offset, 0);
  const active = (await json("/v1/person?status=active")).body;
  assert(active.total > 0 && active.total < all.total, "the filter narrows");
  assert(active.items.every((p: { status: string }) => p.status === "active"));
  const p1 = (await json("/v1/user_account?limit=1")).body;
  const p2 = (await json("/v1/user_account?limit=1&offset=1")).body;
  assertEquals([p1.items.length, p2.items.length, p1.total], [1, 1, 3]);
  assert(p1.items[0].user_account_uid !== p2.items[0].user_account_uid, "pages differ");
  assertEquals((await json("/v1/user_account?offset=99")).body.items, []);
  const admins = (await json("/v1/user_account?admin=true")).body;
  assertEquals(admins.items.map((a: { display_name: string }) => a.display_name), ["alice"]);
  assertEquals((await json("/v1/user_account?admin=1")).body, admins);
  assertEquals(
    (await json("/v1/user_account?connector=okta&mfa=false")).body.items.length,
    1,
  );
  // A value is a value, never SQL.
  for (const evil of ["x' OR '1'='1", "1; DROP TABLE person", "alpha' --"]) {
    const r = await json(`/v1/fixed_asset?hostname=${encodeURIComponent(evil)}`);
    assertEquals([r.status, r.body.total], [200, 0], evil);
  }
  assertEquals((await json("/v1/person")).body.total, all.total, "nothing was dropped");
  for (
    const [q, why] of [
      ["limit=0", "limit"],
      ["limit=1001", "limit"],
      ["limit=ten", "limit"],
      ["offset=-1", "offset"],
      ["status=gone", "one of"],
      ["shoe_size=9", "no column"],
      ["status=active&status=leave", "one value"],
      ["format=ocsf", "format is json"],
    ]
  ) {
    const r = await json(`/v1/person?${q}`);
    assertEquals(r.status, 400, q);
    assertStringIncludes(r.body.error, why);
  }
  assertEquals((await json("/v1/node?props=x")).status, 400);
  assertEquals((await json("/v1/user_account?admin=maybe")).status, 400);
  assertEquals((await json("/v1/code_repository?reviews=two")).status, 400);
  assertEquals((await json("/v1/person?limit=1000")).status, 200);
  const r = resourceNamed("person")!;
  assert("error" in listQuery(r, new URLSearchParams("limit=1e3")));
});

Deno.test("094: booleans are booleans, JSON is an object", async () => {
  const { json } = await signedIn();
  const devices = (await json("/v1/device")).body.items as Array<Record<string, unknown>>;
  assert(devices.every((d) => typeof d.is_managed === "boolean"));
  assert(devices.some((d) => d.is_managed === true) && devices.some((d) => d.is_managed === false));
  assert(devices.every((d) => d.is_encrypted === null || typeof d.is_encrypted === "boolean"));
  assertEquals(devices.find((d) => d.hostname === "alice-mbp")?.is_encrypted, true);
  const accounts = (await json("/v1/user_account")).body.items as Array<Record<string, unknown>>;
  assert(accounts.every((a) => typeof a.active === "boolean"));
  const nodes = (await json("/v1/node")).body.items as Array<Record<string, unknown>>;
  assert(nodes.every((n) => typeof n.stale === "boolean"));
  assert(nodes.every((n) => typeof n.props === "object" && n.props !== null));
  const assets = (await json("/v1/fixed_asset")).body.items as Array<Record<string, unknown>>;
  assert(assets.every((a) => typeof a.managed === "boolean"));
});

Deno.test("094: findings as OCSF Compliance Findings, by Accept or ?format=ocsf", async () => {
  const { json } = await signedIn();
  const ocsfSchema = JSON.parse(
    await Deno.readTextFile(
      new URL("../vendor/ocsf/1.9.0/compliance_finding.schema.json", import.meta.url),
    ),
  );
  const valid = new Ajv({ strict: false, logger: false, allErrors: true }).compile(ocsfSchema);
  const plain = (await json("/v1/finding")).body;
  const byFormat = await json("/v1/finding?format=ocsf");
  const byAccept = await json("/v1/finding", { accept: "application/vnd.ocsf+json" });
  assertEquals(byAccept.type, "application/vnd.ocsf+json");
  assertEquals(byAccept.body, byFormat.body);
  assertEquals(byFormat.body.total, plain.total);
  assertEquals(byFormat.body.items.length, plain.items.length);
  for (const f of byFormat.body.items as Doc[]) {
    assert(valid(f), JSON.stringify(valid.errors?.slice(0, 3)));
    assertEquals(f.class_uid, 2003);
    assertEquals(f.metadata.tenant_uid, "lab");
  }
  const fail = plain.items.findIndex((f: { status: string }) => f.status === "fail");
  assert(fail >= 0);
  assertEquals(byFormat.body.items[fail].compliance.status, "Fail");
  assertEquals(byFormat.body.items[fail].compliance.control, plain.items[fail].scf_control);
  // Filters and paging apply first.
  const one = (await json("/v1/finding?format=ocsf&status=fail&limit=1")).body;
  assertEquals([one.items.length, one.limit], [1, 1]);
  // ?format=json wins over Accept; other resources ignore the OCSF Accept.
  assertEquals(
    (await json("/v1/finding?format=json", { accept: "application/vnd.ocsf+json" })).type,
    "application/json",
  );
  assertEquals(
    (await json("/v1/person", { accept: "application/vnd.ocsf+json" })).type,
    "application/json",
  );
  assertEquals((await json("/v1/finding?format=xml")).status, 400);
});

Deno.test("094: 401 without a session; the loopback Host only", async () => {
  const { handler, cookie } = await signedIn();
  for (const p of ["/v1/", "/v1/person", "/v1/openapi.json", `/v1/evidence/${BUNDLE}`]) {
    const r = await handler(new Request(B + p, { headers: HOST }));
    assertEquals(r.status, 401, p);
    assertEquals(r.headers.get("content-type"), "application/json");
    assertStringIncludes((await r.json()).error, "launch link");
    const forged = await handler(
      new Request(B + p, { headers: { ...HOST, cookie: "stolos_session=guess" } }),
    );
    assertEquals(forged.status, 401, `${p} with a forged cookie`);
    await forged.body?.cancel();
  }
  const evil = await handler(
    new Request(`${B}/v1/person`, { headers: { host: "evil.example", cookie } }),
  );
  assertEquals(evil.status, 421);
});

Deno.test("094: read-only: 405 for anything but GET and HEAD", async () => {
  const { req } = await signedIn();
  for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
    for (const p of ["/v1/", "/v1/person", `/v1/evidence/${BUNDLE}`, "/v1/nope"]) {
      const r = await req(p, {
        method,
        headers: { origin: B, "datastar-request": "true" },
        ...(method === "POST" || method === "PUT" ? { body: "{}" } : {}),
      });
      assertEquals(r.status, 405, `${method} ${p}`);
      assertEquals(r.headers.get("allow"), "GET, HEAD");
      await r.body?.cancel();
    }
  }
  const head = await req("/v1/person", { method: "HEAD" });
  assertEquals(head.status, 200);
  assertEquals(head.headers.get("content-type"), "application/json");
  assertEquals(await head.text(), "");
});

Deno.test("094: 404 for what is not served", async () => {
  const { json } = await signedIn();
  for (
    const p of [
      "/v1/nope",
      "/v1/sqlite_master",
      "/v1/person/extra",
      "/v1/oscal/nope",
      "/v1/oscal/",
      "/v1/evidence/missing.zip",
      "/v1/v1/person",
    ]
  ) {
    const r = await json(p);
    assertEquals(r.status, 404, p);
    assert(typeof r.body.error === "string");
  }
});

Deno.test("094: evidence: safe file names only, no path traversal", async () => {
  const { req, evidenceDir } = await signedIn();
  for (
    const p of [
      "/v1/evidence/..%2Fsecret.txt",
      "/v1/evidence/%2e%2e%2fsecret.txt",
      "/v1/evidence/..%5Csecret.txt",
      "/v1/evidence/%2E%2E%2F%2E%2E%2Fetc%2Fpasswd",
      "/v1/evidence/notes.txt",
      "/v1/evidence/.hidden.zip",
      "/v1/evidence/a%00.zip",
      "/v1/evidence/%E0%A4%A",
      `/v1/evidence/sub%2F${BUNDLE}`,
      "/v1/evidence/..zip",
    ]
  ) {
    const r = await req(p);
    assertEquals(r.status, 400, p);
    await r.body?.cancel();
  }
  // A dot-dot path the URL parser folds away reaches no file either.
  const folded = await req("/v1/evidence/../secret.txt");
  assertEquals(folded.status, 404);
  await folded.body?.cancel();
  // A link to a file outside the directory, even with a bundle's name, is not served.
  try {
    await Deno.symlink(`${evidenceDir}/../secret.txt`, `${evidenceDir}/linked.zip`);
    const linked = await req("/v1/evidence/linked.zip");
    assertEquals(linked.status, 404);
    await linked.body?.cancel();
  } catch (e) {
    if (!(e instanceof Deno.errors.PermissionDenied)) throw e; // no symlinks here (Windows)
  }
  const ok = await req(`/v1/evidence/${BUNDLE}`);
  assertEquals(ok.status, 200);
  await ok.body?.cancel();
});

Deno.test("094: an estate that cannot be read is a JSON 500, not a page", async () => {
  const { apiHandler } = await import("../src/archon/api/handler.ts");
  const err = console.error;
  console.error = () => {};
  try {
    const r = await apiHandler(new Request(`${B}/v1/person`), {
      fleet: "lab",
      port: PORT,
      estate: () => Promise.reject(new Error("no fleet repository here")),
      oscal: () => Promise.resolve({}),
      evidenceDir: "/nonexistent",
    });
    assertEquals(r.status, 500);
    assertStringIncludes((await r.json()).error, "no fleet repository here");
    const ev = await apiHandler(new Request(`${B}/v1/evidence/`), {
      fleet: "lab",
      port: PORT,
      estate: () => Promise.reject(new Error("unused")),
      oscal: () => Promise.resolve({}),
      evidenceDir: "/nonexistent",
    });
    assertEquals((await ev.json()).total, 0, "no evidence directory yet: no bundles");
  } finally {
    console.error = err;
  }
});
