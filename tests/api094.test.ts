/**
 * Spec 094: the read-only REST API for estate data, in the Stolos Console, with an OpenAPI 3.1
 * document generated from the estate schema's declarations.
 *
 * @module
 */

import { errors, fs } from "@intellectual-frontiers/system";
import {
  assert,
  assertEquals,
  assertStringIncludes,
  test,
  proves,
} from "@intellectual-frontiers/commons/ts/runtime/test";
import { Ajv } from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";
import { ESTATE_SCHEMA } from "../src/archon/estate/schema.ts";
import { openApiDocument, OSCAL_DOCUMENTS } from "../src/archon/api/openapi.ts";
import { listQuery, resourceNamed, RESOURCES } from "../src/archon/api/resources.ts";
import { fakeConsole } from "./console/serve-stolos.ts";
import { at, keys, list, must, parse, text } from "./console/tree.ts";

const PORT = 8094;
const B = `http://127.0.0.1:${PORT}`;
const HOST = { host: `127.0.0.1:${PORT}` };
const BUNDLE = "lab-evidence-2026-01-01-to-2026-06-30.zip";

type Signed = Awaited<ReturnType<typeof fakeConsole>> & {
  cookie: string;
  req: (path: string, init?: RequestInit) => Promise<Response>;
  json: (
    path: string,
    h?: Record<string, string>,
  ) => Promise<{ status: number; type: string | null; body: unknown }>;
};

async function signedIn(): Promise<Signed> {
  const c = await fakeConsole(PORT);
  const r = await c.handler(new Request(`${B}/launch?t=${c.launch.issue()}`, { headers: HOST }));
  assertEquals(r.status, 303);
  const cookie = (r.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  const req = (path: string, init: RequestInit = {}): Promise<Response> =>
    c.handler(
      new Request(B + path, {
        ...init,
        headers: { ...HOST, cookie, ...((init.headers as Record<string, string>) ?? {}) },
      }),
    );
  const json = async (
    path: string,
    h: Record<string, string> = {},
  ): Promise<{ status: number; type: string | null; body: unknown }> => {
    const r = await req(path, { headers: h });
    return { status: r.status, type: r.headers.get("content-type"), body: parse(await r.text()) };
  };
  return { ...c, cookie, req, json };
}

/** Ajv (JSON Schema 2020-12) with the document added, so its own $refs resolve. */
function validator(doc: unknown): {
  response: (path: string, status?: string, type?: string) => (x: unknown, what: string) => void;
  component: (name: string) => (x: unknown, what: string) => void;
} {
  const ajv = new Ajv2020({ strict: false, logger: false, allErrors: true });
  ajv.addSchema(doc as object, "openapi.json");
  const ref = (pointer: string): ((x: unknown, what: string) => void) => {
    const v = ajv.compile({ $ref: `openapi.json#${pointer}` });
    return (x: unknown, what: string): void =>
      assert(v(x), `${what}: ${JSON.stringify(v.errors?.slice(0, 3), null, 1)}`);
  };
  const esc = (s: string): string => s.replace(/~/g, "~0").replace(/\//g, "~1");
  return {
    response: (path: string, status = "200", type = "application/json") =>
      ref(`/paths/${esc(path)}/get/responses/${status}/content/${esc(type)}/schema`),
    component: (name: string) => ref(`/components/schemas/${name}`),
  };
}

proves(
  ["094-rest-api FR-004"],
  "094: the OpenAPI document is valid OpenAPI 3.1 (the official schema)",
  async () => {
    const schemaText = await fs.readTextFile(
      new URL("../vendor/openapi/3.1/schema.json", import.meta.url),
    );
    // Ajv honors $dynamicAnchor only at a schema resource's root, and the official schema puts its
    // one anchor ("meta") on $defs/schema, so Ajv would resolve "#meta" to the whole document. In
    // this schema the anchor's only target is $defs/schema (an object or a boolean), so a static
    // $ref to it is the same check; the vendored file itself stays unchanged.
    assertEquals(schemaText.match(/"\$dynamicAnchor"/g)?.length, 1);
    const schema = parse(
      schemaText
        .replaceAll('"$dynamicRef": "#meta"', '"$ref": "#/$defs/schema"')
        .replace('"$dynamicAnchor": "meta",', ""),
    );
    assert(!JSON.stringify(schema).includes("$dynamic"));
    const ajv = new Ajv2020({ strict: false, logger: false, allErrors: true });
    const valid = ajv.compile(schema as object);
    const doc = openApiDocument();
    assert(valid(doc), JSON.stringify(valid.errors?.slice(0, 5), null, 1));
    assertEquals(doc["openapi"], "3.1.0");
    // The schema rejects what is not OpenAPI (it is not just accepting anything).
    assert(!valid({ openapi: "3.1.0", info: { title: "x" }, paths: {} }), "info.version required");
    assert(!valid({ ...doc, paths: { "v1/no-slash": {} } }), "a path starts with /");
  },
);

proves(
  ["094-rest-api FR-004", "094-rest-api FR-005"],
  "094: one path per estate table and view, typed from the declarations",
  () => {
    const doc: unknown = openApiDocument();
    for (const d of ESTATE_SCHEMA) {
      const op = at(doc, "paths", `/v1/${d.name}`, "get");
      assert(op, `${d.name} has a path`);
      assertEquals(at(op, "description"), d.doc);
      assertEquals(
        keys(doc, "components", "schemas", d.name, "properties"),
        Object.keys(d.columns),
        d.name,
      );
    }
    const sJ = at(doc, "components", "schemas");
    assertEquals(at(sJ, "fixed_asset", "properties", "managed", "type"), "boolean");
    assertEquals(at(sJ, "fixed_asset", "properties", "encrypted", "type"), ["boolean", "null"]);
    assertEquals(
      at(sJ, "fixed_asset", "properties", "managed", "description"),
      at(must(ESTATE_SCHEMA.find((d) => d.name === "fixed_asset")).columns, "managed", "doc"),
    );
    assertEquals(at(sJ, "node", "properties", "props", "type"), "object");
    assertEquals(at(sJ, "node", "properties", "ocsf_class_uid", "type"), ["integer", "null"]);
    assertEquals(at(sJ, "code_repository", "properties", "reviews", "type"), ["integer", "null"]);
    assertEquals(at(sJ, "user_account", "properties", "mfa", "type"), ["boolean", "null"]);
    assertEquals(at(sJ, "device", "properties", "is_managed", "type"), "boolean");
    assertEquals(at(sJ, "person", "properties", "status", "enum"), [
      "active",
      "terminated",
      "leave",
      "unknown",
    ]);
    assertEquals(at(sJ, "fixed_asset", "properties", "fixed_asset_type", "enum"), [
      "server",
      "workstation",
      "network_device",
      "other",
    ]);
    assertEquals(at(sJ, "tenant", "properties", "service_model", "enum"), [
      "iaas",
      "paas",
      "saas",
      null,
    ]);
    assertEquals(at(sJ, "compliance_finding", "properties", "status", "enum"), [
      "Pass",
      "Warning",
      "Fail",
      "Unknown",
    ]);
    // Filters for every column but JSON ones; finding also takes ?format.
    const params = (n: string): unknown[] =>
      list(doc, "paths", `/v1/${n}`, "get", "parameters").map(
        (p) => at(p, "name") ?? text(p, "$ref").split("/").pop(),
      );
    assert(!params("node").includes("props"));
    assert(params("node").includes("stale"));
    assert(params("finding").includes("format"));
    assert(!params("person").includes("format"));
    assertEquals(keys(doc, "paths", "/v1/finding", "get", "responses", "200", "content"), [
      "application/json",
      "application/vnd.ocsf+json",
    ]);
    for (const p of [
      "/v1/",
      "/v1/openapi.json",
      "/v1/oscal/{document}",
      "/v1/evidence/",
      "/v1/evidence/{bundle}",
    ]) {
      assert(at(doc, "paths", p, "get"), p);
    }
    // No table or view takes a name the other routes use.
    for (const r of RESOURCES) assert(!["oscal", "evidence", "openapi.json"].includes(r.name));
  },
);

proves(
  ["094-rest-api FR-001", "094-rest-api FR-004"],
  "094: every route answers within its schema",
  async () => {
    const { json, req } = await signedIn();
    const served = await json("/v1/openapi.json");
    assertEquals(served.status, 200);
    const doc = served.body;
    assertEquals(doc, parse(JSON.stringify(openApiDocument({ port: PORT }))));
    const v = validator(doc);
    const index = await json("/v1/");
    v.response("/v1/")(index.body, "/v1/");
    assertEquals(list(index.body, "resources").length, ESTATE_SCHEMA.length);
    assertEquals((await json("/v1")).body, index.body);
    for (const r of RESOURCES) {
      const page = await json(`/v1/${r.name}?limit=1000`);
      assertEquals(page.status, 200, r.name);
      v.response(`/v1/${r.name}`)(page.body, r.name);
      assertEquals(list(page.body, "items").length, at(page.body, "total"), r.name);
    }
    for (const name of ["person", "device", "user_account", "finding", "node", "fixed_asset"]) {
      assert(
        Number(at((await json(`/v1/${name}`)).body, "total")) > 0,
        `${name} has rows in the fake estate`,
      );
    }
    const ocsf = await json("/v1/finding?format=ocsf");
    assertEquals(ocsf.type, "application/vnd.ocsf+json");
    v.response("/v1/finding", "200", "application/vnd.ocsf+json")(ocsf.body, "ocsf");
    for (const d of OSCAL_DOCUMENTS) {
      const o = await json(`/v1/oscal/${d}`);
      assertEquals(o.status, 200, d);
      v.response("/v1/oscal/{document}")(o.body, d);
    }
    assert(at((await json("/v1/oscal/poam")).body, "plan-of-action-and-milestones") !== undefined);
    assertEquals((await json("/v1/oscal/poam.json")).status, 200);
    const ev = await json("/v1/evidence/");
    v.response("/v1/evidence/")(ev.body, "evidence");
    assertEquals(
      list(ev.body, "items").map((b) => at(b, "name")),
      [BUNDLE],
    );
    const zip = await req(`/v1/evidence/${BUNDLE}`);
    assertEquals(zip.status, 200);
    assertEquals(zip.headers.get("content-type"), "application/zip");
    assertStringIncludes(zip.headers.get("content-disposition") ?? "", BUNDLE);
    assertEquals(new Uint8Array(await zip.arrayBuffer()).slice(0, 2), new Uint8Array([0x50, 0x4b]));
    // Errors are JSON in the error schema.
    for (const p of ["/v1/nope", "/v1/person?limit=0", "/v1/evidence/nope.zip"]) {
      v.component("error")((await json(p)).body, p);
    }
  },
);

proves(["094-rest-api FR-001"], "094: filters and paging, with bound values", async () => {
  const { json } = await signedIn();
  const all = (await json("/v1/person")).body;
  assertEquals(at(all, "limit"), 100);
  assertEquals(at(all, "offset"), 0);
  const active = (await json("/v1/person?status=active")).body;
  const narrowed = Number(at(active, "total"));
  assert(narrowed > 0 && narrowed < Number(at(all, "total")), "the filter narrows");
  assert(list(active, "items").every((p) => at(p, "status") === "active"));
  const p1 = (await json("/v1/user_account?limit=1")).body;
  const p2 = (await json("/v1/user_account?limit=1&offset=1")).body;
  assertEquals([list(p1, "items").length, list(p2, "items").length, at(p1, "total")], [1, 1, 3]);
  assert(
    at(p1, "items", 0, "user_account_uid") !== at(p2, "items", 0, "user_account_uid"),
    "pages differ",
  );
  assertEquals(at((await json("/v1/user_account?offset=99")).body, "items"), []);
  const admins = (await json("/v1/user_account?admin=true")).body;
  assertEquals(
    list(admins, "items").map((a) => at(a, "display_name")),
    ["alice"],
  );
  assertEquals((await json("/v1/user_account?admin=1")).body, admins);
  assertEquals(
    list((await json("/v1/user_account?connector=okta&mfa=false")).body, "items").length,
    1,
  );
  // A value is a value, never SQL.
  for (const evil of ["x' OR '1'='1", "1; DROP TABLE person", "alpha' --"]) {
    const r = await json(`/v1/fixed_asset?hostname=${encodeURIComponent(evil)}`);
    assertEquals([r.status, at(r.body, "total")], [200, 0], evil);
  }
  assertEquals(
    at((await json("/v1/person")).body, "total"),
    at(all, "total"),
    "nothing was dropped",
  );
  for (const [q, why] of [
    ["limit=0", "limit"],
    ["limit=1001", "limit"],
    ["limit=ten", "limit"],
    ["offset=-1", "offset"],
    ["status=gone", "one of"],
    ["shoe_size=9", "no column"],
    ["status=active&status=leave", "one value"],
    ["format=ocsf", "format is json"],
  ] as const) {
    const r = await json(`/v1/person?${q}`);
    assertEquals(r.status, 400, q);
    assertStringIncludes(text(r.body, "error"), why);
  }
  assertEquals((await json("/v1/node?props=x")).status, 400);
  assertEquals((await json("/v1/user_account?admin=maybe")).status, 400);
  assertEquals((await json("/v1/code_repository?reviews=two")).status, 400);
  assertEquals((await json("/v1/person?limit=1000")).status, 200);
  const r = must(resourceNamed("person"));
  assert("error" in listQuery(r, new URLSearchParams("limit=1e3")));
});

proves(["094-rest-api FR-005"], "094: booleans are booleans, JSON is an object", async () => {
  const { json } = await signedIn();
  const devices = list((await json("/v1/device")).body, "items") as Array<Record<string, unknown>>;
  assert(devices.every((d) => typeof d["is_managed"] === "boolean"));
  assert(
    devices.some((d) => d["is_managed"] === true) && devices.some((d) => d["is_managed"] === false),
  );
  assert(
    devices.every((d) => d["is_encrypted"] === null || typeof d["is_encrypted"] === "boolean"),
  );
  assertEquals(devices.find((d) => d["hostname"] === "alice-mbp")?.["is_encrypted"], true);
  const accounts = list((await json("/v1/user_account")).body, "items") as Array<
    Record<string, unknown>
  >;
  assert(accounts.every((a) => typeof a["active"] === "boolean"));
  const nodes = list((await json("/v1/node")).body, "items") as Array<Record<string, unknown>>;
  assert(nodes.every((n) => typeof n["stale"] === "boolean"));
  assert(nodes.every((n) => typeof n["props"] === "object" && n["props"] !== null));
  const assets = list((await json("/v1/fixed_asset")).body, "items") as Array<
    Record<string, unknown>
  >;
  assert(assets.every((a) => typeof a["managed"] === "boolean"));
});

proves(
  ["094-rest-api FR-001"],
  "094: findings as OCSF Compliance Findings, by Accept or ?format=ocsf",
  async () => {
    const { json } = await signedIn();
    const ocsfSchema = parse(
      await fs.readTextFile(
        new URL("../vendor/ocsf/1.9.0/compliance_finding.schema.json", import.meta.url),
      ),
    );
    const valid = new Ajv({ strict: false, logger: false, allErrors: true }).compile(
      ocsfSchema as object,
    );
    const plain = (await json("/v1/finding")).body;
    const byFormat = await json("/v1/finding?format=ocsf");
    const byAccept = await json("/v1/finding", { accept: "application/vnd.ocsf+json" });
    assertEquals(byAccept.type, "application/vnd.ocsf+json");
    assertEquals(byAccept.body, byFormat.body);
    assertEquals(at(byFormat.body, "total"), at(plain, "total"));
    assertEquals(list(byFormat.body, "items").length, list(plain, "items").length);
    for (const f of list(byFormat.body, "items")) {
      assert(valid(f), JSON.stringify(valid.errors?.slice(0, 3)));
      assertEquals(at(f, "class_uid"), 2003);
      assertEquals(at(f, "metadata", "tenant_uid"), "lab");
    }
    const fail = list(plain, "items").findIndex((f) => at(f, "status") === "fail");
    assert(fail >= 0);
    assertEquals(at(byFormat.body, "items", fail, "compliance", "status"), "Fail");
    assertEquals(
      at(byFormat.body, "items", fail, "compliance", "control"),
      at(plain, "items", fail, "scf_control"),
    );
    // Filters and paging apply first.
    const one = (await json("/v1/finding?format=ocsf&status=fail&limit=1")).body;
    assertEquals([list(one, "items").length, at(one, "limit")], [1, 1]);
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
  },
);

proves(["094-rest-api FR-003"], "094: 401 without a session; the loopback Host only", async () => {
  const { handler, cookie } = await signedIn();
  for (const p of ["/v1/", "/v1/person", "/v1/openapi.json", `/v1/evidence/${BUNDLE}`]) {
    const r = await handler(new Request(B + p, { headers: HOST }));
    assertEquals(r.status, 401, p);
    assertEquals(r.headers.get("content-type"), "application/json");
    assertStringIncludes(text(parse(await r.text()), "error"), "launch link");
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

proves(["094-rest-api FR-002"], "094: read-only: 405 for anything but GET and HEAD", async () => {
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

proves(["094-rest-api FR-001"], "094: 404 for what is not served", async () => {
  const { json } = await signedIn();
  for (const p of [
    "/v1/nope",
    "/v1/sqlite_master",
    "/v1/person/extra",
    "/v1/oscal/nope",
    "/v1/oscal/",
    "/v1/evidence/missing.zip",
    "/v1/v1/person",
  ]) {
    const r = await json(p);
    assertEquals(r.status, 404, p);
    assert(typeof at(r.body, "error") === "string");
  }
});

proves(
  ["094-rest-api FR-001"],
  "094: evidence: safe file names only, no path traversal",
  async () => {
    const { req, evidenceDir } = await signedIn();
    for (const p of [
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
    ]) {
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
      await fs.symlink(`${evidenceDir}/../secret.txt`, `${evidenceDir}/linked.zip`);
      const linked = await req("/v1/evidence/linked.zip");
      assertEquals(linked.status, 404);
      await linked.body?.cancel();
    } catch (e) {
      if (!(e instanceof errors.PermissionDenied)) throw e; // no symlinks here (Windows)
    }
    const ok = await req(`/v1/evidence/${BUNDLE}`);
    assertEquals(ok.status, 200);
    await ok.body?.cancel();
  },
);

test("094: an estate that cannot be read is a JSON 500, not a page", async () => {
  const { apiHandler } = await import("../src/archon/api/handler.ts");
  const { ui } = await import("../src/archon/core/ui.ts");
  const quiet = ui.quiet;
  ui.quiet = true; // the handler says the failure on the console's terminal
  try {
    const r = await apiHandler(new Request(`${B}/v1/person`), {
      fleet: "lab",
      port: PORT,
      estate: () => Promise.reject(new Error("no fleet repository here")),
      oscal: () => Promise.resolve({}),
      evidenceDir: "/nonexistent",
    });
    assertEquals(r.status, 500);
    assertStringIncludes(text(parse(await r.text()), "error"), "no fleet repository here");
    const ev = await apiHandler(new Request(`${B}/v1/evidence/`), {
      fleet: "lab",
      port: PORT,
      estate: () => Promise.reject(new Error("unused")),
      oscal: () => Promise.resolve({}),
      evidenceDir: "/nonexistent",
    });
    assertEquals(at(parse(await ev.text()), "total"), 0, "no evidence directory yet: no bundles");
  } finally {
    ui.quiet = quiet;
  }
});

/** A guide's section: from its heading to the next heading of its level or higher (outside code). */
function guideSection(md: string, heading: string): string {
  const lines = md.split("\n");
  const start = lines.indexOf(heading);
  assert(start >= 0, `"${heading}" in the guide`);
  const level = heading.indexOf(" ");
  let fence = false;
  const out: string[] = [];
  for (const l of lines.slice(start + 1)) {
    if (/^\s*```/.test(l)) fence = !fence;
    if (!fence && new RegExp(`^#{1,${level}} `).test(l)) break;
    out.push(l);
  }
  return out.join("\n");
}

proves(
  ["094-rest-api FR-006"],
  "094: the Console guide's REST section has a curl example with the session cookie; How it works has its card",
  async () => {
    const { engineFile } = await import("../src/archon/core/assets.ts");
    const s = guideSection(engineFile("docs/console.md"), "## The REST API (read-only)");
    assertStringIncludes(s, '```bash\ncurl -s --cookie "stolos_session=');
    assertStringIncludes(s, "/v1/user_account?");
    assertStringIncludes(s, "no API keys");
    const c = await signedIn();
    const how = await (await c.req("/how")).text();
    assertStringIncludes(how, "<h3>For scripts: a read-only REST API</h3>");
    assertStringIncludes(how, '<a href="/v1/openapi.json">/v1/openapi.json</a>');
  },
);
