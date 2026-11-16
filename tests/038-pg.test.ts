/**
 * Spec 038 (PostgreSQL): what the plan and the commands' fixed parts say, for the parts that run as
 * root against a real PostgreSQL on the host (dumps, VACUUM, pg_isready).
 *
 * @module
 */

import {
  assert,
  assertEquals,
  assertStringIncludes,
  proves,
} from "@intellectual-frontiers/commons/ts/runtime/test";
import { MAINTAIN_SQL } from "../src/archon/pg/commands.ts";
import { PG, PRIME } from "../src/archon/pg/config.ts";
import { resolvePlan } from "../src/archon/model/resolve.ts";
import type { HostDef, PgState } from "../src/archon/model/types.ts";
import { DEFAULT_BACKUP } from "../src/archon/capabilities/backup.ts";
import { fleet, host } from "./fixtures.ts";

const ON = { enabled: true, by: "alice", at: "2026-11-12T18:00:00Z" };
const recorded: PgState = {
  instances: { prime: { version: 18, port: 5433, created: "2026-11-12T18:00:00Z", by: "alice" } },
};
const pgHost = (over: Partial<HostDef> = {}) =>
  host({ ip: "10.0.30.57", pg: { instances: [PRIME] }, optIn: { pg: ON }, ...over });

proves(
  ["038-pg FR-011"],
  "038: the nightly dumps: every instance at 02:07, into /var/backups/archon/pg, the last 7, carried by the 02:37 archive",
  () => {
    const plan = resolvePlan(pgHost({ pgState: recorded }), fleet());
    const timer = plan.units.find((u) => u.unitName === "archon-pg-backup.timer");
    assertEquals([timer?.state, timer?.onCalendar], ["enabled", "*-*-* 02:07:00"]);
    const svc = plan.units.find((u) => u.unitName === "archon-pg-backup.service");
    assertStringIncludes(svc?.content ?? "", "pg backup --all");
    assertEquals([PG.dumps, PG.keepDumps], ["/var/backups/archon/pg", 7]);
    // Before spec 016's archive, which carries /var/backups/archon (its own target folder).
    assert("02:07:00" < (DEFAULT_BACKUP.onCalendar.split(" ")[1] ?? ""));
    assert(PG.dumps.startsWith(`${DEFAULT_BACKUP.target}/`));
  },
);

proves(
  ["038-pg FR-013"],
  "038: maintain reports connections by database and state against max_connections, sizes, and the ten tables with the most dead rows",
  () => {
    assertStringIncludes(MAINTAIN_SQL.connections, "FROM pg_stat_activity GROUP BY datname, state");
    assertEquals(MAINTAIN_SQL.max, "SHOW max_connections");
    assertStringIncludes(MAINTAIN_SQL.sizes, "pg_database_size(datname)");
    assertStringIncludes(MAINTAIN_SQL.sizes, "WHERE NOT datistemplate");
    assertStringIncludes(MAINTAIN_SQL.bloat, "FROM pg_stat_user_tables");
    assertStringIncludes(MAINTAIN_SQL.bloat, "ORDER BY n_dead_tup DESC LIMIT 10");
  },
);

proves(
  ["038-pg FR-018"],
  "038: verify checks each recorded instance's unit with pg_isready on its port",
  () => {
    const plan = resolvePlan(pgHost({ pgState: recorded }), fleet());
    const u = plan.units.find((x) => x.unitName === "postgresql@18-prime.service");
    assertEquals(u?.verify, "pg_isready -q -h /var/run/postgresql -p 5433");
    assertEquals([u?.managed, u?.state], [false, "ignore"]);
    // Off: no instance unit to check.
    const off = resolvePlan(pgHost({ optIn: {} }), fleet());
    assert(!off.units.some((x) => x.unitName.startsWith("postgresql@")));
  },
);
