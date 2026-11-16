/**
 * Spec 039's identities against a stand-in PostgreSQL (tests/host.ts: `ARCHON_ROOT`, `psql` and
 * `runuser` stand-ins): what a converge does to the roles an instance has.
 *
 * @module
 */
import { fs, path } from "@intellectual-frontiers/ifc-ts/runtime";
import { assert, assertStringIncludes, proves } from "@intellectual-frontiers/ifc-ts/runtime/test";
import { HOST_ROOT_SKIP, hostRoot } from "./host.ts";
import { fleet, host } from "./fixtures.ts";

const ON = { enabled: true, by: "alice", at: "2026-11-12T18:00:00Z" } as const;

proves(
  ["039-pg-identity FR-006"],
  "039: a login role Archon made and does not want, or with no Linux account, becomes NOLOGIN (never dropped); a wanted superuser becomes NOSUPERUSER",
  async () => {
    const h = await hostRoot();
    try {
      const sql = path.join(h.bin, "psql.sql");
      const F = "\\037";
      // runuser -u postgres -- psql ...: the command after "--", as is.
      await h.standIn("runuser", `while [ "$1" != "--" ]; do shift; done; shift; exec "$@"`);
      // PostgreSQL's roles: alice (wanted, a superuser), old-app (Archon's, not wanted),
      // bob (no Linux account), carol (a Linux account, not Archon's), nologin (cannot log in).
      await h.standIn(
        "psql",
        `in=$(cat); printf '%s\\n;;\\n' "$in" >> '${sql}'
case "$in" in
  *"FROM pg_roles r WHERE"*) printf 'alice${F}t${F}t${F}\\nold-app${F}t${F}f${F}archon: s-old\\nbob${F}t${F}f${F}\\ncarol${F}t${F}f${F}\\nidle${F}f${F}f${F}archon: x\\n';;
  *"rolpassword IS NOT NULL"*) echo f;;
  *"FROM pg_database"*) echo postgres;;
esac`,
      );
      await h.standIn(
        "getent",
        `case "$1 $2" in "passwd alice"|"passwd carol"|"passwd ops") echo "$2:x:1000:1000::/home/$2:/bin/bash";; *) exit 2;; esac`,
      );
      const { instancesOf, PRIME } = await import("../src/archon/pg/config.ts");
      const { convergeIdentities } = await import("../src/archon/pg/converge.ts");
      const { resolvePlan } = await import("../src/archon/model/resolve.ts");
      const alpha = host({ pg: { instances: [PRIME] }, optIn: { pg: ON } });
      const plan = resolvePlan(alpha, fleet());
      const inst = instancesOf(alpha, plan.users, plan.fleet)[0];
      assert(inst !== undefined && inst.roles.some((r) => r.name === "alice"), "alice is wanted");
      const changes: string[] = [];
      const failures: string[] = [];
      const ok = await convergeIdentities(18, inst, {
        check: false,
        change: (m) => void changes.push(m),
        warn: () => {},
        fail: (m) => void failures.push(m),
        unreadable: () => {},
      });
      assert(ok, failures.join("\n"));
      const text = changes.join("\n");
      assertStringIncludes(text, "alice: NOSUPERUSER in prime");
      assertStringIncludes(text, "old-app cannot log in to prime (not in the model)");
      assertStringIncludes(text, "bob cannot log in to prime (no Linux account of that name)");
      assert(!text.includes("carol"), "a role a person made, with a Linux account, is left alone");
      assert(!text.includes("idle"), "a role that cannot log in is left alone");
      const ran = await fs.readTextFile(sql);
      assertStringIncludes(ran, `ALTER ROLE "old-app" NOLOGIN`);
      assertStringIncludes(ran, `ALTER ROLE "bob" NOLOGIN`);
      assert(!ran.includes(`ALTER ROLE "carol" NOLOGIN`), ran);
      assert(/ALTER ROLE "alice" LOGIN NOSUPERUSER/.test(ran), "alice is made NOSUPERUSER");
      assert(!/DROP\s+(ROLE|USER|OWNED)/i.test(ran), "never dropped: ownership would move");
      // Every psql ran as postgres (runuser), never as root.
      assert(
        (await h.calls()).filter((c) => c.startsWith("psql ")).length > 0 &&
          (await h.calls()).every(
            (c) => !c.startsWith("psql ") || c.includes("--cluster 18/prime"),
          ),
      );
      assert(
        (await h.calls()).some((c) => c.startsWith("runuser -u postgres -- psql")),
        "as postgres",
      );
    } finally {
      await h.restore();
    }
  },
  { skip: HOST_ROOT_SKIP, timeout: 120_000 },
);
