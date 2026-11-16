/**
 * Spec 039: Linux identities are PostgreSQL identities; PostgreSQL is off until an operator turns it on.
 *
 * @module
 */
import { fs, proc } from "@intellectual-frontiers/ifc-ts/runtime";
import {
  assert,
  assertEquals,
  assertExists,
  assertStringIncludes,
  proves,
  the,
} from "@intellectual-frontiers/ifc-ts/runtime/test";
import { fleet, host } from "./fixtures.ts";
import { resolvePlan } from "../src/archon/model/resolve.ts";
import { usersFor } from "../src/archon/model/load.ts";
import type { HostDef, PgDatabaseDef } from "../src/archon/model/types.ts";
import {
  databaseAccessSql,
  desiredMembers,
  groupRoleSql,
  hbaConf,
  instancesOf,
  membershipSql,
  PRIME,
  roleSql,
  schemaAccessSql,
  scramMatches,
  scramVerifier,
  sudoersPg,
  systemServices,
} from "../src/archon/pg/config.ts";

const pgFleet = () =>
  fleet({
    web: { domain: "lab.example.net" },
    services: [
      { name: "s-app2", uid: 850, description: "app two" },
      { name: "s-app1", uid: 851, description: "app one" },
    ],
  });
const rec = (on: boolean): Partial<HostDef> => ({
  optIn: { pg: { enabled: on, by: "alice", at: "2026-11-12T18:00:00Z" } },
  pgState: { instances: { prime: { version: 18, port: 5432, created: "x", by: "alice" } } },
});
const pgHost = (over: Partial<HostDef> = {}) =>
  host({
    ip: "10.0.30.57",
    pg: { instances: [{ ...PRIME, databases: [{ name: "app2", owner: "s-app2" }] }] },
    ...over,
  });

proves(
  ["039-pg-identity FR-001", "040-opt-in FR-001"],
  "040: PostgreSQL is an opt-in service: tooling on every server, masked until turned on",
  () => {
    for (const h of [pgHost(), pgHost(rec(false))]) {
      const plan = resolvePlan(h, pgFleet());
      // Like Samba: Ubuntu's tooling (no clusters), the umbrella unit masked behind the switch.
      assert(plan.packages.some((p) => p.name === "postgresql-common"));
      assert(!plan.packages.some((p) => /^postgresql-\d/.test(p.name)));
      const u = the(plan.units.find((x) => x.unitName === "postgresql.service"));
      assertEquals([u.state, u.switch], ["masked", "pg"]);
      assertStringIncludes(u.verify, "! systemctl is-active --quiet postgresql.service");
      assert(!plan.units.some((x) => x.unitName.startsWith("postgresql@")));
      assert(!plan.units.some((x) => x.unitName.startsWith("archon-pg-backup")));
      assert(!plan.files.some((f) => f.path === "/etc/sudoers.d/archon-pg"));
      assert(
        plan.files.some(
          (f) =>
            f.path === "/etc/postgresql-common/createcluster.d/50-archon.conf" &&
            the(f.content).includes("create_main_cluster = false"),
        ),
      );
    }
    // On: the same unit (the switch enables it), the clusters checked, dumped nightly.
    const on = resolvePlan(pgHost(rec(true)), pgFleet());
    assertEquals(on.units.find((x) => x.unitName === "postgresql.service")?.switch, "pg");
    assertStringIncludes(
      the(on.units.find((x) => x.unitName === "postgresql@18-prime.service")).verify,
      "pg_isready",
    );
    assert(on.units.some((x) => x.unitName === "archon-pg-backup.timer"));
    assert(on.checks.some((c) => c.command === "/usr/local/bin/archon pg who prime"));
  },
);

proves(
  ["039-pg-identity FR-002"],
  "039: service accounts: fleet-wide, fixed UIDs, no password, no shell; servers only",
  async () => {
    const plan = resolvePlan(pgHost(), pgFleet());
    const conf = the(
      the(plan.files.find((f) => f.path === "/etc/sysusers.d/archon-services.conf")).content,
    );
    assertStringIncludes(conf, 'u s-app2 850 "app two" /var/lib/s-app2 /usr/sbin/nologin');
    assertStringIncludes(conf, 'u s-app1 851 "app one" /var/lib/s-app1 /usr/sbin/nologin');
    assertStringIncludes(
      the(the(plan.files.find((f) => f.path === "/etc/tmpfiles.d/archon-services.conf")).content),
      "d /var/lib/s-app2 0750 s-app2 s-app2 -",
    );
    const wsHost = host({ name: "pc", kind: "workstation", user: "alice" });
    delete wsHost.mac; // a workstation has no MAC or disk layout in the model
    delete wsHost.disk;
    const ws = resolvePlan(wsHost, pgFleet());
    assert(!ws.files.some((f) => f.path === "/etc/sysusers.d/archon-services.conf"));
    const { validateFleet } = await import("../src/archon/model/validate.ts");
    const bad = validateFleet(
      fleet({
        services: [
          { name: "app1", uid: 850, description: "x" },
          { name: "s-a", uid: 799, description: "x" },
          { name: "s-b", uid: 851, description: "x" },
          { name: "s-c", uid: 851, description: "x" },
        ],
      }),
      [],
    );
    assert(bad.some((p) => p.message.includes("'app1'")));
    assert(bad.some((p) => p.message.includes("uid 799")));
    assert(bad.some((p) => p.message.includes("uid 851")));
  },
);

proves(
  ["039-pg-identity FR-004", "039-pg-identity FR-008"],
  "039: roles: nobody but postgres is a superuser; admins may create databases and watch",
  () => {
    const is = instancesOf(pgHost(), usersFor(pgFleet(), pgHost()), pgFleet())[0];
    assertExists(is);
    const admin = roleSql(the(is.roles.find((r) => r.name === "alice")));
    const svc = roleSql(the(is.roles.find((r) => r.name === "s-app2")));
    for (const sql of [admin, svc]) {
      assertStringIncludes(sql, "NOSUPERUSER");
      assertStringIncludes(sql, "NOCREATEROLE");
      assertStringIncludes(sql, "NOREPLICATION");
      assertStringIncludes(sql, "NOBYPASSRLS");
      assert(!/PASSWORD/.test(sql));
    }
    assertStringIncludes(admin, "CREATEDB");
    assertStringIncludes(admin, 'GRANT pg_monitor, pg_signal_backend TO "alice"');
    assertStringIncludes(svc, "NOCREATEDB");
    // Names identical to Linux, always quoted (s-app2 has a dash).
    assertStringIncludes(svc, 'CREATE ROLE "s-app2"');
    assertStringIncludes(svc, `COMMENT ON ROLE "s-app2" IS 'archon: service (spec 039)'`);
    assertStringIncludes(groupRoleSql("app2_rw"), 'CREATE ROLE "app2_rw" NOLOGIN');
  },
);

proves(
  ["039-pg-identity FR-003", "039-pg-identity FR-005"],
  "039: access: CONNECT only by grant; rights now and for tables made later",
  () => {
    const d: PgDatabaseDef = {
      name: "app2",
      owner: "s-app2",
      write: ["s-app1"],
      read: ["@analysts", "alice"],
    };
    const db = databaseAccessSql(d);
    assertStringIncludes(db, 'ALTER DATABASE "app2" OWNER TO "s-app2"');
    assertStringIncludes(db, 'REVOKE CONNECT, TEMPORARY ON DATABASE "app2" FROM PUBLIC');
    assertStringIncludes(db, 'GRANT CONNECT, TEMPORARY ON DATABASE "app2" TO "app2_rw", "app2_ro"');
    const sc = schemaAccessSql(d);
    assertStringIncludes(
      sc,
      'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO "app2_rw"',
    );
    assertStringIncludes(sc, 'GRANT SELECT ON ALL TABLES IN SCHEMA public TO "app2_ro"');
    assertStringIncludes(
      sc,
      'ALTER DEFAULT PRIVILEGES FOR ROLE "s-app2" IN SCHEMA public GRANT SELECT ON TABLES TO "app2_ro"',
    );
    // Members: groups expanded; only known roles; the owner owns; write wins over read.
    const roles = [
      { name: "alice", kind: "human" as const, admin: true },
      { name: "ann", kind: "human" as const, admin: false },
      { name: "s-app1", kind: "service" as const, admin: false },
      { name: "s-app2", kind: "service" as const, admin: false },
    ];
    const m = desiredMembers(
      { ...d, read: ["@analysts", "alice", "s-app1"] },
      (g) => (g === "analysts" ? ["ann", "stranger", "s-app2"] : []),
      roles,
    );
    assertEquals(m, { write: ["s-app1"], read: ["alice", "ann"] });
    assertEquals(membershipSql("app2_ro", ["ann", "alice"], ["alice", "old"]), [
      'GRANT "app2_ro" TO "ann";',
      'REVOKE "app2_ro" FROM "old";',
    ]);
  },
);

proves(
  ["039-pg-identity FR-007"],
  "039: pg_hba: peer on the socket; postgres never over a network; scram otherwise",
  () => {
    const priv = hbaConf(false, ["10.0.0.0/16"]);
    assertStringIncludes(priv, "local    all       all                        peer");
    assertStringIncludes(priv, "host     all       postgres  127.0.0.1/32     reject");
    assert(
      priv.indexOf("postgres  127.0.0.1/32     reject") <
        priv.indexOf("all       127.0.0.1/32     scram"),
      "the reject comes first",
    );
    const pub = hbaConf(true, ["10.0.0.0/16"]);
    assertStringIncludes(pub, "hostssl  all       postgres  0.0.0.0/0        reject");
    assertStringIncludes(pub, "hostssl  all       postgres  ::/0             reject");
    assert(!/\b(trust|md5|password|ident|pam)\b/.test(pub.replace(/^#.*$/gm, "")));
  },
);

proves(
  ["039-pg-identity FR-009"],
  "039: a person's Linux password: verifiers compared by their own salt; 100k rounds",
  async () => {
    const v = await scramVerifier("Linux pass 1", undefined, 100_000);
    assertStringIncludes(v, "SCRAM-SHA-256$100000:");
    assert(await scramMatches(v, "Linux pass 1"));
    assert(!(await scramMatches(v, "Linux pass 2")));
    assert(!(await scramMatches("", "x")));
    const { PG } = await import("../src/archon/pg/config.ts");
    assertEquals(PG.humanIterations, 100_000);
  },
);

proves(
  ["039-pg-identity FR-008"],
  "039: sudo is the only way to the superuser (and to act as an app); the system service file",
  async () => {
    const s = sudoersPg(["s-app1", "s-app2"]);
    assertStringIncludes(s, "%archon-ops ALL=(postgres) /usr/bin/psql, /usr/bin/psql *");
    assertStringIncludes(s, "%archon-ops ALL=(s-app1, s-app2) /usr/bin/psql, /usr/bin/psql *");
    assert(!/NOPASSWD/.test(s), "their own password, every time");
    assert(!sudoersPg([]).includes("ALL=()"));
    if (proc.which("visudo") !== undefined) {
      const f = await fs.makeTempFile();
      await fs.writeTextFile(f, s);
      const r = await proc.run(["visudo", "-cf", f], { stdout: "null" });
      assertEquals(r.code, 0, r.stderr);
      await fs.remove(f);
    }
    const plan = resolvePlan(pgHost(rec(true)), pgFleet());
    const sudoers = the(plan.files.find((f) => f.path === "/etc/sudoers.d/archon-pg"));
    assertEquals(sudoers.mode, "0440");
    assertEquals(sudoers.validate?.[0], "visudo");
    assertStringIncludes(the(sudoers.content), "(s-app2)");
    const svc = systemServices([
      { name: "prime", port: 5432 },
      { name: "lab", port: undefined },
    ]);
    assertStringIncludes(svc, "[prime]\nhost=/var/run/postgresql\nport=5432\ndbname=postgres");
    assert(!svc.includes("[lab]"), "an instance without a port yet is left out");
    assert(!/user=|password=/.test(svc.replace(/^#.*$/gm, "")));
  },
);

proves(
  ["039-pg-identity FR-012"],
  "039: who: every login a Linux account, postgres the only superuser, no private passwords",
  async () => {
    const { whoProblems } = await import("../src/archon/pg/commands.ts");
    const v = (o: Record<string, unknown>) => ({
      role: "x",
      kind: "human",
      linuxAccount: true,
      login: true,
      superuser: false,
      password: false,
      memberOf: [],
      ...o,
    });
    assertEquals(
      whoProblems([v({ role: "postgres", superuser: true, linuxAccount: true })], false),
      [],
    );
    assertEquals(
      whoProblems([v({ role: "ghost", kind: "unmanaged", linuxAccount: false })], false),
      ["ghost can log in but has no Linux account."],
    );
    assertEquals(whoProblems([v({ role: "alice", superuser: true })], false), [
      "alice is a superuser; only postgres should be (through sudo).",
    ]);
    assertEquals(whoProblems([v({ role: "alice", password: true })], false).length, 1);
    assertEquals(whoProblems([v({ role: "alice", password: true })], true), [], "published: fine");
    assertEquals(
      whoProblems(
        [v({ role: "app2_ro", kind: "group", login: false, linuxAccount: false })],
        false,
      ),
      [],
    );
  },
);

proves(
  ["039-pg-identity FR-011", "039-pg-identity FR-012"],
  "039: commands: on, off, who, connect --remote; passwd-sync never over MCP",
  async () => {
    const { COMMANDS } = await import("../src/archon/commands/registry.ts");
    const by = (n: string) => the(COMMANDS.find((c) => c.name === n));
    assertEquals(by("pg on").tier, "mutate");
    assertEquals(by("pg off").tier, "mutate");
    assertEquals(by("pg who").tier, "read");
    assert(by("pg passwd-sync").noMcp && by("pg passwd-sync").unlocked);
    const connect = by("pg connect");
    assert(connect.args.some((a) => a.name === "remote"));
    assert(!connect.args.some((a) => a.name === "user"), "you connect as yourself");
  },
);

proves(
  ["039-pg-identity FR-009", "039-pg-identity FR-010"],
  "039: one PAM hook: Samba and (while on) PostgreSQL get the Linux password; real accounts only",
  async () => {
    const { PASSWORD_SYNC, PASSWORDS_PROFILE, PASSWORDS } =
      await import("../src/archon/capabilities/passwords.ts");
    assertStringIncludes(PASSWORDS_PROFILE, "Auth-Type: Additional\nAuth:\n");
    // PAM leaves the hook almost no environment: archon is given root's.
    assertStringIncludes(
      PASSWORD_SYNC,
      "HOME=/root PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    );
    assertStringIncludes(PASSWORDS_PROFILE, "Password-Type: Additional\nPassword:\n");
    assert(!PASSWORDS_PROFILE.includes("-Final:"));
    assertStringIncludes(
      PASSWORDS_PROFILE,
      `optional pam_exec.so quiet seteuid expose_authtok ${PASSWORDS.hook}`,
    );
    const plan = resolvePlan(pgHost(), pgFleet());
    const prof = the(plan.files.find((f) => f.path === PASSWORDS.profile));
    assert(prof.onChange?.some((a) => a.kind === "run" && a.argv[0] === "pam-auth-update"));
    assertEquals(plan.files.find((f) => f.path === PASSWORDS.hook)?.mode, "0700");

    // Run the hook with stand-ins for smbpasswd, id, archon, and the "on" marker.
    const dir = await fs.makeTempDir({ prefix: "archon-pw-sync-" });
    try {
      await fs.writeTextFile(
        `${dir}/smbpasswd`,
        `#!/bin/sh\necho "$3" > ${dir}/smb.user\ncat > ${dir}/smb\n`,
      );
      await fs.writeTextFile(
        `${dir}/archon`,
        `#!/bin/sh\necho "$3" > ${dir}/pg.user\ncat > ${dir}/pg\n`,
      );
      for (const f of ["smbpasswd", "archon"]) await fs.chmod(`${dir}/${f}`, 0o755);
      const script = PASSWORD_SYNC.replaceAll("/usr/bin/smbpasswd", `${dir}/smbpasswd`)
        .replaceAll("/usr/local/bin/archon", `${dir}/archon`)
        .replace("/usr/bin/systemctl is-enabled --quiet postgresql.service", `test -e ${dir}/on`)
        .replace('uid=$(id -u "$u" 2>/dev/null) || exit 0', "uid=${TEST_UID:-1000}");
      await fs.writeTextFile(`${dir}/sync`, script);
      const run = async (env: Record<string, string>, stdin: string) => {
        for (const f of ["smb", "pg", "smb.user", "pg.user"]) {
          await fs.remove(`${dir}/${f}`).catch(() => {});
        }
        const c = proc.spawn(["sh", `${dir}/sync`], { env, stdin: "piped" });
        const w = c.stdin?.getWriter();
        // The hook may exit without reading (not a real account): a closed pipe is fine.
        await w?.write(new TextEncoder().encode(stdin)).catch(() => {});
        await w?.close().catch(() => {});
        await c.status;
        await new Promise((r) => setTimeout(r, 300)); // the PostgreSQL part runs in the background
        const read = (f: string) => fs.readTextFile(`${dir}/${f}`).catch(() => undefined);
        return {
          smb: await read("smb"),
          pg: await read("pg"),
          pgUser: (await read("pg.user"))?.trim(),
        };
      };
      // PostgreSQL off: Samba only.
      assertEquals(await run({ PAM_TYPE: "auth", PAM_USER: "alice" }, "s3cret pass\0"), {
        smb: "s3cret pass\ns3cret pass\n",
        pg: undefined,
        pgUser: undefined,
      });
      await fs.writeTextFile(`${dir}/on`, "on\n");
      const both = await run({ PAM_TYPE: "password", PAM_USER: "alice" }, "new one");
      assertEquals([both.smb, both.pg, both.pgUser], ["new one\nnew one\n", "new one", "alice"]);
      // Not for ops, root, system or service accounts, other PAM steps, or an empty password.
      for (const [env, pw] of [
        [{ PAM_TYPE: "auth", PAM_USER: "ops" }, "x"],
        [{ PAM_TYPE: "auth", PAM_USER: "root" }, "x"],
        [{ PAM_TYPE: "auth", PAM_USER: "s-app2", TEST_UID: "850" }, "x"],
        [{ PAM_TYPE: "account", PAM_USER: "alice" }, "x"],
        [{ PAM_TYPE: "password", PAM_USER: "alice" }, ""],
      ] as Array<[Record<string, string>, string]>)
        assertEquals(await run(env, pw), { smb: undefined, pg: undefined, pgUser: undefined });
    } finally {
      await fs.remove(dir, { recursive: true });
    }
  },
  {
    // The hook and its stand-ins (smbpasswd, psql) are POSIX shell scripts PAM runs on a host.
    skip: proc.build.os === "windows" && "the PAM hook is a host's (Linux) shell script",
  },
);
