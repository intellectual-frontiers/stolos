/**
 * archon pg admin-tui (rainfrog) and archon pg observe-tui (pgcenter top), and
 * archon fs s3 key --rotate.
 *
 * @module
 */
import {
  assert,
  assertEquals,
  assertExists,
  assertStringIncludes,
  proves,
  test,
} from "@intellectual-frontiers/ifc-ts/runtime/test";
import { pgcenterArgs, rainfrogArgs, SYSTEM_ROOTS } from "../src/archon/pg/tui.ts";
import type { Target } from "../src/archon/pg/connections.ts";
import { COMMANDS } from "../src/archon/commands/registry.ts";
import { effectiveTier, parseArgs } from "../src/archon/core/registry-types.ts";
import { allowed } from "../src/archon/mcp/server.ts";

/** A value the test expects to be there: fails the test where it is not. */
function the<T>(value: T | undefined | null): T {
  assertExists(value);
  return value;
}

const local: Target = {
  name: "prime",
  host: "/var/run/postgresql",
  port: 5433,
  database: "postgres",
  user: "alice",
  network: false,
};
const remote: Target = {
  ...local,
  host: "pg-prime.alpha.lab.example.net",
  port: 5432,
  network: true,
};

proves(
  ["043-pg-connections FR-006f"],
  "admin-tui: rainfrog through the socket as you, or verify-full over the network",
  () => {
    assertEquals(rainfrogArgs(local), [
      "--driver",
      "postgres",
      "--url",
      "postgres://alice@localhost:5433/postgres?host=%2Fvar%2Frun%2Fpostgresql&sslmode=disable",
    ]);
    const url = the(rainfrogArgs(remote).at(-1));
    assertEquals(
      url,
      `postgres://alice@pg-prime.alpha.lab.example.net:5432/postgres?sslmode=verify-full&sslrootcert=${encodeURIComponent(
        SYSTEM_ROOTS,
      )}`,
    );
  },
);

proves(
  ["043-pg-connections FR-006f"],
  "observe-tui: pgcenter top with libpq's flags; TLS through its environment",
  () => {
    assertEquals(pgcenterArgs(local), {
      args: ["top", "-h", "/var/run/postgresql", "-p", "5433", "-U", "alice", "-d", "postgres"],
      env: { PGSSLMODE: "disable" },
    });
    const r = pgcenterArgs(remote);
    assertEquals(r.args.slice(1, 5), ["-h", "pg-prime.alpha.lab.example.net", "-p", "5432"]);
    assertEquals(r.env, { PGSSLMODE: "verify-full", PGSSLROOTCERT: SYSTEM_ROOTS });
  },
);

proves(
  ["043-pg-connections FR-006f"],
  "the TUIs never carry a password, and are not MCP tools",
  () => {
    for (const t of [local, remote]) {
      for (const a of [...rainfrogArgs(t), ...pgcenterArgs(t).args]) {
        assert(!/password|:[^@/]*@/i.test(a), `no password on a command line: ${a}`);
      }
      assert(!("PGPASSWORD" in pgcenterArgs(t).env), "only asked for, never built in");
    }
    for (const name of ["pg admin-tui", "pg observe-tui"]) {
      const c = the(COMMANDS.find((x) => x.name === name));
      assert(c.noMcp, `${name} is full screen: not an MCP tool`);
      assertEquals(c.tier, "read");
    }
  },
);

test("fs s3 key --rotate: mutate (sudo; asks an agent), the rest of fs s3 key stays read", () => {
  const c = the(COMMANDS.find((x) => x.name === "fs s3 key"));
  assertEquals(effectiveTier(c, parseArgs(c, [])), "read");
  assertEquals(effectiveTier(c, parseArgs(c, ["--write"])), "read");
  assertEquals(effectiveTier(c, parseArgs(c, ["--rotate"])), "mutate");
  assert(!allowed(c, { rotate: true }, "read"), "a read-only MCP server refuses it");
  assert(allowed(c, {}, "read"));
  assertStringIncludes(c.description, "--rotate");
});
