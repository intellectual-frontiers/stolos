// Spec 090: the estate graph: Universal Data Model tables, a property graph, OCSF and D3FEND views,
// people from the source of truth, deduplicated machines, history and diffs from Git, canonical SQL.
import { assert, assertEquals, assertStringIncludes, assertThrows } from "./assert.ts";
import { DatabaseSync } from "node:sqlite";
import { tsLiteral } from "../src/archon/core/ts-literal.ts";
import type { Observation } from "../src/archon/connect/connector.ts";
import {
  buildGraph,
  estatePolicies,
  estateQuery,
  estateRefusal,
  estateSql,
  fixedAssetKey,
  nodeUids,
} from "../src/archon/estate/graph.ts";
import { ESTATE_SCHEMA, estateSchemaDoc } from "../src/archon/estate/schema.ts";
import { schemaProblems } from "../src/archon/schema/define.ts";
import {
  gitReader,
  readSnapshot,
  seenTimes,
  type Snapshot,
} from "../src/archon/estate/snapshot.ts";
import { rowsDiff, writeEstateFiles } from "../src/archon/estate/commands.ts";

const AT = "2026-11-01T00:00:00Z";
const obs = (
  provider: string,
  account: string,
  entities: Observation["entities"],
  gaps: string[] = [],
  at = AT,
): Observation => ({
  at,
  provider,
  account,
  assets: [],
  posture: {},
  gaps,
  ...(entities ? { entities } : {}),
});

const hr = obs("bamboohr", "example", {
  people: [
    {
      email: "Alice@Example.org",
      name: "Alice",
      status: "active",
      type: "employee",
      manager: "carol@example.org",
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
    },
    {
      system: "okta",
      id: "2",
      name: "bob",
      email: "BOB@example.org",
      active: true,
      admin: false,
      mfa: true,
    },
  ],
});
const github = obs("github", "example", {
  accounts: [
    { system: "github", id: "3", name: "ci-bot", active: true, service: true },
    { system: "github", id: "4", name: "mallory", active: true },
    { system: "github", id: "5", name: "carol-gh", active: true },
  ],
  repositories: [{ system: "github", name: "example/app", private: true, protected: false }],
});

const snapshot = (sources: Array<[string, Observation]>): Snapshot => ({
  fleet: "lab",
  sources: sources.map(([connector, observation]) => ({ connector, observation })),
  machines: [
    { source: "stolos", id: "alpha", name: "alpha", managed: true, os: "Ubuntu" },
    {
      source: "adopted",
      id: "alice-mbp",
      name: "alice-mbp.local",
      owner: "alice@example.org",
      managed: false,
      serial: "c02x",
      encrypted: false,
    },
    { source: "snmp", id: "printer", name: "printer", managed: false, serial: "C02X" },
  ],
  links: { "github:carol-gh": "carol@example.org" },
});

Deno.test("090: the schema's names are all cited, and its SQL and docs are generated", () => {
  assertEquals(schemaProblems(ESTATE_SCHEMA), []);
  const doc = estateSchemaDoc();
  assertStringIncludes(doc, "erDiagram");
  assertStringIncludes(doc, "Named from: party_fixed_asset_assignment (udm).");
  assertStringIncludes(doc, "Named from: node (ocsf) + property (gql) + provenance (prov).");
});

Deno.test("090: people come only from the source of truth; others link to them", () => {
  const e = buildGraph(snapshot([["okta", okta], ["bamboohr", hr], ["github", github]]));
  assertEquals(e.personSource, "bamboohr");
  assertEquals(
    estateQuery(e, "select email_addr, status, type from user_inventory order by email_addr"),
    [
      { email_addr: "alice@example.org", status: "active", type: "employee" },
      { email_addr: "bob@example.org", status: "terminated", type: null },
      { email_addr: "carol@example.org", status: "active", type: null },
    ],
  );
  assertEquals(
    estateQuery(e, "select from_party_uid, to_party_uid from party_relationship"),
    [{ from_party_uid: "person:alice@example.org", to_party_uid: "person:carol@example.org" }],
  );
  // Accounts link by email (whatever its case), or by links.ts (manual, with who said so).
  assertEquals(
    estateQuery(
      e,
      "select src_uid, dst_uid, basis, asserted_by from edge where verb = 'has_account' order by dst_uid",
    ),
    [
      {
        src_uid: "person:carol@example.org",
        dst_uid: "github:example:5",
        basis: "manual",
        asserted_by: "links.ts",
      },
      {
        src_uid: "person:alice@example.org",
        dst_uid: "okta:example.okta.com:1",
        basis: "email",
        asserted_by: null,
      },
      {
        src_uid: "person:bob@example.org",
        dst_uid: "okta:example.okta.com:2",
        basis: "email",
        asserted_by: null,
      },
    ],
  );
  // With no HR system, the identity provider is the source of truth.
  const idpOnly = buildGraph(snapshot([["okta", okta]]));
  assertEquals(idpOnly.personSource, "okta");
  assertEquals(estateQuery(idpOnly, "select count(*) as n from person"), [{ n: 2 }]);
  // The order is the fleet's to set.
  assertEquals(
    buildGraph(snapshot([["okta", okta], ["bamboohr", hr]]), {
      personSources: ["okta", "bamboohr"],
    }).personSource,
    "okta",
  );
});

Deno.test("090: machines are deduplicated by serial, then hostname; each property says where it came from", () => {
  const e = buildGraph(snapshot([["bamboohr", hr]]));
  assertEquals(
    estateQuery(
      e,
      "select uid, hostname, type, is_encrypted, is_managed, owner_email_addr from device order by uid",
    ),
    [
      {
        uid: "hostname:alpha",
        hostname: "alpha",
        type: "server",
        is_encrypted: null,
        is_managed: 1,
        owner_email_addr: null,
      },
      {
        uid: "serial:C02X",
        hostname: "alice-mbp",
        type: "workstation",
        is_encrypted: 0,
        is_managed: 0,
        owner_email_addr: "alice@example.org",
      },
    ],
  );
  assertEquals(
    estateQuery(
      e,
      "select property, source from node_property_provenance where node_uid = 'serial:C02X' order by property",
    ),
    [
      { property: "encrypted", source: "adopted" },
      { property: "hostname", source: "adopted" },
      { property: "serial_number", source: "adopted" },
    ],
  );
  assertEquals(
    estateQuery(
      e,
      "select dst_uid, basis from edge where verb = 'observed_as' and src_uid = 'serial:C02X' order by dst_uid",
    ),
    [{ dst_uid: "adopted:alice-mbp", basis: "serial" }, {
      dst_uid: "snmp:printer",
      basis: "serial",
    }],
  );
  // A manual link overrides the automatic match.
  assertEquals(
    fixedAssetKey({
      source: "snmp",
      id: "printer",
      name: "printer",
      managed: false,
      serial: "C02X",
    }, {
      "device:snmp:printer": "hostname:front-printer",
    }),
    "hostname:front-printer",
  );
});

Deno.test("090: the cross-system policies, on the new tables, write findings", () => {
  const e = buildGraph(snapshot([["bamboohr", hr], ["okta", okta], ["github", github]]));
  const by = Object.fromEntries(estatePolicies(e, new Date(AT)).map((p) => [p.id, p]));
  assertEquals(by.leavers.status, "fail");
  assertStringIncludes(by.leavers.detail, "bob@example.org in okta");
  assertEquals(by.orphans.status, "warn");
  assertStringIncludes(by.orphans.detail, "mallory in github");
  assert(!by.orphans.detail.includes("ci-bot"), "a service account is not an orphan");
  assert(!by.orphans.detail.includes("carol-gh"), "a manual link is a link");
  assertEquals(by["admins-mfa"].status, "fail");
  assertEquals(by["devices-encrypted"].status, "fail");
  assertEquals(by["devices-for-people"].status, "warn"); // carol has no machine
  assertEquals(by["repos-protected"].status, "fail");
  assertEquals(
    estateQuery(
      e,
      "select title, control, status, resource_uid from compliance_finding where title = 'leavers'",
    ),
    [{
      title: "leavers",
      control: "IAC-04",
      status: "Fail",
      resource_uid: "okta:example.okta.com:2",
    }],
  );
});

Deno.test("090: one SELECT; anything else is refused", () => {
  const e = buildGraph(snapshot([["bamboohr", hr]]));
  for (
    const bad of [
      "delete from person",
      "select 1; select 2",
      "pragma table_info(person)",
      "attach database 'x' as y",
      "",
    ]
  ) {
    assert(estateRefusal(bad), bad);
    assertThrows(() => estateQuery(e, bad));
  }
});

Deno.test("090: a source that could not read something keeps its earlier nodes, marked stale", () => {
  const before = snapshot([["github", github]]);
  const partial = obs("github", "example", { accounts: [github.entities!.accounts![0]] }, [
    "repositories: /orgs/example/repos: 403 (the credential may not read this)",
  ]);
  const e = buildGraph(snapshot([["github", partial]]), { previous: before });
  assertEquals(
    estateQuery(e, "select native_id, stale from node order by native_id"),
    [
      { native_id: "3", stale: 0 },
      { native_id: "4", stale: 1 },
      { native_id: "5", stale: 1 },
      { native_id: "example/app", stale: 1 },
    ],
  );
  assertEquals(estateQuery(e, "select resource, reason from observation"), [{
    resource: "repositories",
    reason: "/orgs/example/repos: 403 (the credential may not read this)",
  }]);
});

async function git(dir: string, ...args: string[]) {
  const r = await new Deno.Command("git", {
    args,
    cwd: dir,
    env: {
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_DATE: AT,
      GIT_COMMITTER_DATE: AT,
    },
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!r.success) throw new Error(new TextDecoder().decode(r.stderr));
  return new TextDecoder().decode(r.stdout).trim();
}
const write = (dir: string, path: string, name: string, type: string, value: unknown) =>
  Deno.mkdir(`${dir}/${path.split("/").slice(0, -1).join("/")}`, { recursive: true }).then(() =>
    Deno.writeTextFile(
      `${dir}/${path}`,
      `// GENERATED\nimport type { ${type} } from "@stolos/archon/x.ts";\n\nexport const ${name}: ${type} = ${
        tsLiteral(value)
      };\n`,
    )
  );

Deno.test("090: from Git: the fleet as it was, first and last seen, and what a query gained and lost", async () => {
  const dir = await Deno.makeTempDir();
  await git(dir, "init", "-q", "-b", "main");
  await git(dir, "config", "user.name", "T");
  await git(dir, "config", "user.email", "t@example.org");
  const f = "fleets/lab";
  await Deno.mkdir(`${dir}/${f}/hosts/alpha`, { recursive: true });
  await Deno.writeTextFile(`${dir}/${f}/hosts/alpha/host.ts`, "export const host = {};\n");
  await write(dir, `${f}/estate/okta.ts`, "observed", "Observation", {
    ...okta,
    at: "2026-10-01T00:00:00Z",
    entities: { accounts: [okta.entities!.accounts![0]] },
  });
  await write(dir, `${f}/estate/links.ts`, "links", "Record<string, string>", {
    "github:carol-gh": "carol@example.org",
  });
  await write(dir, `${f}/adopted/alice-mbp/machine.ts`, "machine", "AdoptedDef", {
    name: "alice-mbp",
    owner: "alice@example.org",
  });
  await write(dir, `${f}/adopted/alice-mbp/observed.ts`, "observed", "Observed", {
    at: "2026-10-01T00:00:00Z",
    os: { name: "macOS", version: "15.1", serial: "C02X" },
    security: { diskEncryption: "on" },
  });
  await git(dir, "add", "-A");
  await git(dir, "commit", "-q", "-m", "first");
  const first = await git(dir, "rev-parse", "HEAD");
  await write(dir, `${f}/estate/okta.ts`, "observed", "Observation", {
    ...okta,
    at: "2026-11-01T00:00:00Z",
  });
  await git(dir, "add", "-A");
  await git(dir, "commit", "-q", "-m", "second");

  const now = await readSnapshot(gitReader(dir), "lab");
  assertEquals(now.sources.map((s) => [s.connector, s.observation.entities?.accounts?.length]), [[
    "okta",
    2,
  ]]);
  assertEquals(now.links, { "github:carol-gh": "carol@example.org" });
  assertEquals(now.machines.map((m) => [m.source, m.id, m.serial ?? null, m.encrypted ?? null]), [
    ["stolos", "alpha", null, null],
    ["adopted", "alice-mbp", "C02X", true],
  ]);
  const then = await readSnapshot(gitReader(dir, first), "lab", first);
  assertEquals(then.sources[0].observation.entities?.accounts?.length, 1);

  const seen = await seenTimes(dir, [`${f}/estate/okta.ts`], nodeUids);
  assertEquals(seen.get("okta:example.okta.com:1"), {
    first: "2026-10-01T00:00:00Z",
    last: "2026-11-01T00:00:00Z",
  });
  assertEquals(seen.get("okta:example.okta.com:2"), {
    first: "2026-11-01T00:00:00Z",
    last: "2026-11-01T00:00:00Z",
  });

  const sql = "select native_id from user_account order by native_id";
  const d = rowsDiff(
    estateQuery(buildGraph(then), sql),
    estateQuery(buildGraph(now, { seen }), sql),
  );
  assertEquals(d, { added: [{ native_id: "2" }], removed: [] });
  const e = buildGraph(now, { seen });
  assertEquals(
    estateQuery(e, "select native_id, first_seen from node order by native_id"),
    [{ native_id: "1", first_seen: "2026-10-01T00:00:00Z" }, {
      native_id: "2",
      first_seen: "2026-11-01T00:00:00Z",
    }],
  );
  await Deno.remove(dir, { recursive: true });
});

Deno.test("090: estate.sql is canonical: loaded anywhere, it is the same graph; the SQLite file is made from it", async () => {
  const e = buildGraph(snapshot([["bamboohr", hr], ["okta", okta], ["github", github]]), {
    now: new Date(AT),
  });
  estatePolicies(e, new Date(AT));
  const sql = estateSql(e);
  assertEquals(estateSql(e), sql, "stable");
  const copy = new DatabaseSync(":memory:");
  copy.exec(sql);
  const q = "select * from user_account order by user_account_uid";
  assertEquals(
    (copy.prepare(q).all() as Array<Record<string, unknown>>).map((r) => ({ ...r })),
    estateQuery(e, q),
  );
  const dir = await Deno.makeTempDir();
  const files = { sql: `${dir}/estate.sql`, db: `${dir}/estate.auto.sqlite.db` };
  await writeEstateFiles(e, files);
  assertEquals(await Deno.readTextFile(files.sql), sql);
  const db = new DatabaseSync(files.db);
  assertEquals(
    (db.prepare("select count(*) as n from finding").get() as { n: number }).n > 0,
    true,
  );
  db.close();
  await Deno.remove(dir, { recursive: true });
});
