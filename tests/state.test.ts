/**
 * Spec 048-observe-by-query (Article 25): each machine keeps its own state in
 * archon.sql (readable, canonical) and archon.auto.sqlite.db (built from it,
 * for osquery); archon query answers one allowlisted SELECT.
 *
 * @module
 */
import { fs } from "@intellectual-frontiers/system";
import { assert, assertEquals, assertStringIncludes, proves } from "@intellectual-frontiers/test";
import { DatabaseSync } from "node:sqlite";
import {
  allRecords,
  getRecord,
  listRecords,
  PROV_KEEP,
  putRecord,
  rebuild,
  removeRecords,
  STATE_DB,
  STATE_SQL,
  VIEWS,
} from "../src/archon/state/store.ts";
import { queryArgv, queryRefusal, queryTables } from "../src/archon/state/query.ts";
import { archonTables, osqueryConf } from "../src/archon/capabilities/osquery.ts";
import { at } from "./fixtures.ts";

proves(
  ["048-observe-by-query FR-001"],
  "048: archon.sql is canonical, readable, and in a fixed order",
  async () => {
    const dir = await fs.makeTempDir({ prefix: "archon-state-" });
    try {
      await putRecord(
        "beta",
        "optin",
        "pg",
        { enabled: true, by: "alice", data: "durable" },
        dir,
        "t2",
      );
      await putRecord("alpha", "install", "install", { ok: true, archon: "abc'd" }, dir, "t1");
      const sql = await fs.readTextFile(`${dir}/${STATE_SQL}`);
      assertStringIncludes(sql, "-- archon.sql (spec 048)");
      assertStringIncludes(sql, "CREATE VIEW IF NOT EXISTS archon_optin");
      assert(sql.indexOf("'alpha'") < sql.indexOf("'beta'"), "ordered by host");
      assertStringIncludes(sql, `'{"ok":true,"archon":"abc''d"}'`, "quotes are escaped");
      // Writing the same records again changes nothing.
      await putRecord("alpha", "install", "install", { ok: true, archon: "abc'd" }, dir, "t1");
      assertEquals(await fs.readTextFile(`${dir}/${STATE_SQL}`), sql);
      // The SQLite file is built from it, and its views have the columns osquery is told.
      const db = new DatabaseSync(`${dir}/${STATE_DB}`, { readOnly: true });
      const row = db.prepare("SELECT * FROM archon_optin").get() as Record<string, unknown>;
      assertEquals(Object.keys(row).sort(), [...(VIEWS["archon_optin"] ?? [])].sort());
      assertEquals([row["host"], row["enabled"], row["data"]], ["beta", 1, "durable"]);
      db.close();
      assertEquals((await getRecord("beta", "optin", "pg", dir))?.body, {
        enabled: true,
        by: "alice",
        data: "durable",
      });
      // A person may edit archon.sql; rebuild makes the SQLite file follow it.
      await fs.writeTextFile(`${dir}/${STATE_SQL}`, sql.replace("'t1'", "'t9'"));
      await rebuild(dir);
      const db2 = new DatabaseSync(`${dir}/${STATE_DB}`, { readOnly: true });
      assertEquals(
        (db2.prepare("SELECT installed FROM archon_install").get() as { installed: string })
          .installed,
        "t9",
      );
      db2.close();
      await removeRecords("beta", undefined, undefined, dir);
      assertEquals(
        (await allRecords(dir)).map((r) => r.host),
        ["alpha"],
      );
    } finally {
      await fs.remove(dir, { recursive: true });
    }
  },
);

proves(
  ["048-observe-by-query FR-001"],
  "048: provenance keeps the newest records only",
  async () => {
    const dir = await fs.makeTempDir({ prefix: "archon-prov-" });
    try {
      for (let i = 0; i < 5; i++) {
        await putRecord("alpha", "prov", `2026-11-13T00:00:0${i}Z`, { ok: true }, dir);
      }
      assertEquals((await listRecords("alpha", "prov", dir)).length, 5);
      assert(PROV_KEEP >= 100);
    } finally {
      await fs.remove(dir, { recursive: true });
    }
  },
);

proves(["048-observe-by-query FR-005"], "048: archon query serves one allowlisted SELECT", () => {
  assertEquals(queryRefusal("select * from uptime"), undefined);
  assertEquals(queryRefusal("SELECT host, ok FROM archon_install;"), undefined);
  assertEquals(
    queryRefusal("with x as (select port from listening_ports) select * from x"),
    undefined,
  );
  assertStringIncludes(queryRefusal("select * from shadow") ?? "", "never served");
  assertStringIncludes(queryRefusal("select * from process_envs") ?? "", "never served");
  assertStringIncludes(queryRefusal("select * from users join curl") ?? "", "never served");
  assertStringIncludes(
    queryRefusal("select * from chrome_extensions") ?? "",
    "not on the allowlist",
  );
  assertStringIncludes(queryRefusal("select 1; select 2") ?? "", "one statement");
  assertStringIncludes(queryRefusal("delete from users") ?? "", "only SELECT");
  assertStringIncludes(
    queryRefusal("select * from users where 1 = (attach 'x')") ?? "",
    "only reading",
  );
  assertEquals(queryTables("select a from users u join groups g on 1"), ["users", "groups"]);
  const argv = queryArgv("select 1");
  assert(argv.includes("--json") && argv.some((a) => a.startsWith("--disable_tables=shadow")));
});

proves(
  ["048-observe-by-query FR-004"],
  "048: osquery reads Archon's tables from the .auto. SQLite file",
  () => {
    const t = archonTables();
    assertEquals(Object.keys(t).sort(), Object.keys(VIEWS).sort());
    assertEquals(t["archon_verify"]?.path, `/var/lib/archon/${STATE_DB}`);
    assertStringIncludes(t["archon_verify"]?.query ?? "", "FROM archon_verify");
    assert(at(JSON.parse(osqueryConf()) as unknown, "auto_table_construction", "archon_install"));
  },
);
