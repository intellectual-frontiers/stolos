/**
 * Spec 093: the estate graph as osquery tables, through osquery's Automatic Table Construction.
 *
 * @module
 */

import {
  assert,
  assertEquals,
  assertStringIncludes,
  proves,
} from "@intellectual-frontiers/ifc-ts/runtime/test";
import { DatabaseSync } from "node:sqlite";
import { fs, path, proc } from "@intellectual-frontiers/ifc-ts/runtime";
import type { Observation } from "../src/archon/connect/connector.ts";
import { buildGraph, estatePolicies, estateQuery } from "../src/archon/estate/graph.ts";
import { ESTATE_SCHEMA } from "../src/archon/estate/schema.ts";
import { defineTable, defineView } from "../src/archon/schema/define.ts";
import type { Snapshot } from "../src/archon/estate/snapshot.ts";
import { writeEstateFiles } from "../src/archon/estate/commands.ts";
import {
  ATC_PLATFORM,
  ATC_RESERVED,
  type AtcConfig,
  atcConfig,
  osqueryHelp,
} from "../src/archon/estate/osquery.ts";

const AT = "2026-11-01T00:00:00Z";
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

const snapshot: Snapshot = {
  fleet: "lab",
  sources: [
    {
      connector: "bamboohr",
      observation: obs("bamboohr", "example", {
        people: [
          { email: "alice@example.org", name: "Alice", status: "active", type: "employee" },
          { email: "bob@example.org", name: "Bob", status: "terminated", end: "2026-10-31" },
        ],
      }),
    },
    {
      connector: "okta",
      observation: obs("okta", "example.okta.com", {
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
          { system: "okta", id: "2", name: "bob", email: "bob@example.org", active: true },
        ],
      }),
    },
  ],
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
  ],
  links: {},
};

const DB = "/var/tmp/estate/estate.auto.sqlite.db";

proves(
  ["093-osquery FR-001", "093-osquery FR-002"],
  "093: one osquery table per estate table and view, with exactly its declared columns and the path",
  () => {
    const c = atcConfig(DB);
    assertEquals(Object.keys(c), ["auto_table_construction"]);
    const t = c.auto_table_construction;
    assertEquals(
      Object.keys(t),
      ESTATE_SCHEMA.map((d) => `stolos_${d.name}`),
    );
    for (const d of ESTATE_SCHEMA) {
      const x = t[`stolos_${d.name}`];
      assert(x !== undefined, d.name);
      assertEquals(Object.keys(x).sort(), ["columns", "path", "platform", "query"], d.name);
      assertEquals(x.columns, Object.keys(d.columns), d.name);
      assertEquals(x.query, `SELECT ${Object.keys(d.columns).join(", ")} FROM ${d.name}`);
      assertEquals(x.path, path.resolve(DB), "absolute, as this system writes it");
      assertEquals(x.platform, ATC_PLATFORM);
      for (const p of ["darwin", "linux", "windows"]) assert(x.platform.includes(p));
      for (const col of x.columns) {
        assert(!ATC_RESERVED.includes(col.toLowerCase()), `${d.name}.${col} is reserved by ATC`);
        assert(/^[a-z][a-z0-9_]*$/.test(col), col);
      }
    }
    // Every value is a string or an array of strings: the shape osquery's parser accepts.
    const json = JSON.parse(JSON.stringify(c)) as AtcConfig;
    for (const x of Object.values(json.auto_table_construction)) {
      assert(typeof x.query === "string" && typeof x.path === "string");
      assert(typeof x.platform === "string" && x.columns.every((s) => typeof s === "string"));
    }
    assert(osqueryHelp("/x/estate.osquery.json").includes('osqueryi --config_path "/x/'));
  },
);

proves(
  ["093-osquery FR-004"],
  "093: a column osquery reserves is renamed in osquery only, never in the estate",
  () => {
    const t = defineTable({
      name: "file_thing",
      terms: [],
      doc: "A test table.",
      columns: {
        path: { type: "text", doc: "A path.", required: true },
        estate_path: { type: "text", doc: "Taken already." },
        size: { type: "integer", doc: "Its size." },
      },
      key: ["path"],
    });
    const v = defineView({
      name: "file_view",
      terms: [],
      doc: "A test view.",
      columns: { Path: "A path." },
      select: "SELECT path AS Path FROM file_thing",
      reads: ["file_thing"],
    });
    const c = atcConfig("relative/estate.auto.sqlite.db", [t, v]).auto_table_construction;
    const thing = c["stolos_file_thing"];
    assert(thing !== undefined);
    assertEquals(thing.columns, ["estate_estate_path", "estate_path", "size"]);
    assertEquals(
      thing.query,
      "SELECT path AS estate_estate_path, estate_path, size FROM file_thing",
    );
    assertEquals(c["stolos_file_view"]?.columns, ["estate_Path"]);
    assert(thing.path.startsWith("/") || /^[A-Za-z]:\\/.test(thing.path));
    assert(thing.path.endsWith("estate.auto.sqlite.db"), "made absolute");
  },
);

/** Rows as osquery shows them: every value text, NULL empty, plus its own path column. */
const asOsquery = (rows: Array<Record<string, unknown>>, path: string) =>
  rows.map((r) => ({
    ...Object.fromEntries(
      Object.entries(r).map(([k, v]) => [
        k,
        v === null || v === undefined ? "" : typeof v === "string" ? v : JSON.stringify(v),
      ]),
    ),
    path,
  }));

const sortRows = (rows: Array<Record<string, string>>) =>
  rows.map((r) => JSON.stringify(Object.entries(r).sort())).sort();

proves(
  ["093-osquery FR-002", "093-osquery FR-003"],
  "093: the built files: the config next to the database; the database answers each ATC query",
  async () => {
    const e = buildGraph(snapshot, { now: new Date(AT) });
    estatePolicies(e, new Date(AT));
    const dir = await fs.makeTempDir();
    try {
      const files = {
        sql: `${dir}/estate.sql`,
        db: `${dir}/estate.auto.sqlite.db`,
        osquery: `${dir}/estate.osquery.json`,
      };
      await writeEstateFiles(e, files);
      const c = JSON.parse(await fs.readTextFile(files.osquery)) as AtcConfig;
      assertEquals(c, atcConfig(files.db));
      for await (const f of fs.readDir(dir)) assert(!f.name.endsWith(".tmp"), f.name);
      const db = new DatabaseSync(files.db, { readOnly: true });
      try {
        for (const d of ESTATE_SCHEMA) {
          const x = c.auto_table_construction[`stolos_${d.name}`];
          assert(x !== undefined, d.name);
          const st = db.prepare(x.query);
          assertEquals(
            st.columns().map((k) => k.name),
            x.columns,
            d.name,
          );
          assertEquals(st.all().length, estateQuery(e, `select * from ${d.name}`).length, d.name);
        }
      } finally {
        db.close();
      }
    } finally {
      await fs.remove(dir, { recursive: true });
    }
  },
);

const osqueryi = await (async (): Promise<string | undefined> => {
  if (proc.which("osqueryi") === undefined) return undefined;
  const r = await proc.run(["osqueryi", "--version"]);
  return r.success ? r.stdout.trim() : undefined;
})();
if (!osqueryi && proc.env.get("STOLOS_REQUIRE_OSQUERY")) {
  throw new Error("093: STOLOS_REQUIRE_OSQUERY is set (CI) but osqueryi is not installed");
}

proves(
  ["093-osquery FR-001", "093-osquery FR-005"],
  "093: osqueryi reads the estate through ATC: the same rows as estate query",
  async () => {
    const e = buildGraph(snapshot, { now: new Date(AT) });
    estatePolicies(e, new Date(AT));
    const dir = await fs.makeTempDir();
    try {
      const files = {
        sql: `${dir}/estate.sql`,
        db: `${dir}/estate.auto.sqlite.db`,
        osquery: `${dir}/estate.osquery.json`,
      };
      await writeEstateFiles(e, files);
      const query = async (sql: string): Promise<Array<Record<string, string>>> => {
        const r = await proc.run([
          "osqueryi",
          "--config_path",
          files.osquery,
          "--database_path",
          `${dir}/osquery.db`,
          "--disable_extensions",
          "--json",
          sql,
        ]);
        assert(r.success, `${sql}: ${r.stderr}`);
        return JSON.parse(r.stdout) as Array<Record<string, string>>;
      };
      for (const name of ["device", "user_account", "person", "compliance_finding"]) {
        const got = await query(`select * from stolos_${name}`);
        const want = asOsquery(estateQuery(e, `select * from ${name}`), files.db);
        assert(want.length > 0, `${name}: the fixture has rows`);
        assertEquals(sortRows(got), sortRows(want), name);
      }
      const admins = await query(
        "select display_name from stolos_user_account where admin = '1' and mfa = '0'",
      );
      assertEquals(admins, [{ display_name: "alice" }]);
    } finally {
      await fs.remove(dir, { recursive: true });
    }
  },
  { skip: !osqueryi && "osqueryi is not installed (CI installs it)", timeout: 120_000 },
);

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
  ["093-osquery FR-005", "093-osquery FR-006"],
  "093: the docs: the adopted guide's estate section and estate/commands.ts, each with a diagram; TEXT columns said",
  async () => {
    const { engineFile } = await import("../src/archon/core/assets.ts");
    const s = guideSection(engineFile("docs/adopted.md"), "### The estate graph in osquery");
    assertStringIncludes(s, "```mermaid\n");
    assertStringIncludes(s, "Every column is text in osquery");
    const { guideMarkdown } = await import("../src/archon/core/guides.ts");
    const commands = guideMarkdown(await fs.readTextFile("src/archon/estate/commands.ts"));
    assertStringIncludes(guideSection(commands, "## osquery (spec 093)"), "```mermaid\n");
    const atc = guideMarkdown(await fs.readTextFile("src/archon/estate/osquery.ts"));
    assertStringIncludes(
      atc,
      "Every column is TEXT in\nosquery (integers and booleans arrive as their decimal text; NULL as an\nempty value)",
    );
  },
);
