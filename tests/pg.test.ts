/**
 * Spec 038: PostgreSQL instances (archon pg). Apps in these tests are examples (s-app1).
 *
 * @module
 */
import { fs } from "@intellectual-frontiers/system";
import { engineFile } from "../src/archon/core/assets.ts";
import {
  assert,
  assertEquals,
  assertExists,
  assertStringIncludes,
  proves,
  the,
} from "@intellectual-frontiers/test";
import { fleet, host } from "./fixtures.ts";
import { resolvePlan } from "../src/archon/model/resolve.ts";
import { usersFor } from "../src/archon/model/load.ts";
import type { HostDef, PgState } from "../src/archon/model/types.ts";
import {
  allocatePort,
  approvedInSpec,
  archonConf,
  connectInfo,
  createArgv,
  hbaConf,
  instancesOf,
  ownership,
  parseClusters,
  pgdgSource,
  pgpassLine,
  PRIME,
  publishedName,
  scramVerifier,
  serviceBlock,
  upsertPgpass,
  upsertSection,
} from "../src/archon/pg/config.ts";

const webFleet = () =>
  fleet({
    web: { domain: "lab.example.net" },
    services: [{ name: "s-app1", uid: 850, description: "app one" }],
  });
const ON = { enabled: true, by: "alice", at: "2026-11-12T18:00:00Z" };
const recorded = (over: Partial<PgState["instances"][string]> = {}): PgState => ({
  instances: {
    prime: { version: 18, port: 5432, created: "2026-11-12T18:00:00Z", by: "alice", ...over },
  },
});
const pgHost = (over: Partial<HostDef> = {}) =>
  host({
    ip: "10.0.30.57",
    pg: { instances: [{ ...PRIME, databases: [{ name: "app1", owner: "s-app1" }] }] },
    optIn: { pg: ON },
    ...over,
  });

proves(
  ["038-pg FR-001", "038-pg FR-004"],
  "038: instances are the model's and the host's record; the record's version and port win",
  () => {
    const h = pgHost({
      pgState: {
        instances: {
          ...recorded({ port: 5433 }).instances,
          lab: { version: 17, port: 5434, created: "x", by: "alice", environment: "development" },
        },
      },
    });
    const is = instancesOf(h, usersFor(fleet(), h), webFleet());
    assertEquals(
      is.map((i) => [i.name, i.version, i.port, i.inModel]),
      [
        ["lab", 17, 5434, false],
        ["prime", 18, 5433, true],
      ],
    );
    // Defaults: 18, production, protected; development is not protected.
    assertEquals(instancesOf(pgHost(), usersFor(fleet(), pgHost()), webFleet())[0]?.version, 18);
    assert(the(is.find((i) => i.name === "prime")).protected);
    assert(!the(is.find((i) => i.name === "lab")).protected);
  },
);

proves(
  ["038-pg FR-010", "039-pg-identity FR-004"],
  "038/039: roles are the people on the host and the services its databases name",
  () => {
    const prime = instancesOf(pgHost(), usersFor(fleet(), pgHost()), webFleet())[0];
    assertExists(prime);
    assertEquals(
      prime.roles.map((r) => [r.name, r.kind]),
      [
        ["alice", "human"],
        ["s-app1", "service"],
      ],
    );
    assert(!prime.roles.some((r) => r.name === "ops"), "no role for ops");
    assertEquals(prime.databases, [{ name: "app1", owner: "s-app1" }]);
  },
);

proves(["038-pg FR-005"], "038: ports: the first free from 5432; createcluster arguments", () => {
  assertEquals(allocatePort([]), 5432);
  assertEquals(allocatePort([5432, 5433, 5435]), 5434);
  assertEquals(createArgv(17, "lab", 5433), [
    "pg_createcluster",
    "17",
    "lab",
    "--port",
    "5433",
    "--start",
    "--",
    "--auth-local=peer",
    "--auth-host=scram-sha-256",
    "--data-checksums",
  ]);
});

proves(
  ["038-pg FR-003"],
  "038: ownership: only recorded clusters are Archon's; others are left alone",
  () => {
    const cl = parseClusters(
      "16  main    5432 online postgres /var/lib/postgresql/16/main  /var/log/postgresql/postgresql-16-main.log\n" +
        "18  prime   5433 online postgres /var/lib/postgresql/18/prime /var/log/postgresql/postgresql-18-prime.log\n",
    );
    assertEquals(cl.length, 2);
    assertEquals(cl[1], {
      version: 18,
      name: "prime",
      port: 5433,
      status: "online",
      owner: "postgres",
      data: "/var/lib/postgresql/18/prime",
      log: "/var/log/postgresql/postgresql-18-prime.log",
    });
    assertEquals(ownership({ name: "main", record: undefined }, cl).kind, "foreign");
    assertEquals(ownership({ name: "prime", record: undefined }, cl).kind, "foreign");
    assertEquals(ownership({ name: "lab", record: undefined }, cl).kind, "absent");
    const own = ownership({ name: "prime", record: recorded().instances["prime"] }, cl);
    assertEquals(own.kind, "owned");
  },
);

proves(
  ["038-pg FR-005", "038-pg FR-015"],
  "038: configuration: localhost, scram, TLS 1.3, facts for the prompt; published adds the address",
  () => {
    const i = {
      name: "prime",
      version: 18,
      environment: "production",
      protected: true,
      published: false,
    };
    const priv = archonConf(i, { address: "10.0.30.57" });
    assertStringIncludes(priv, "listen_addresses = 'localhost'\n");
    assertStringIncludes(priv, "password_encryption = 'scram-sha-256'");
    assertStringIncludes(priv, "ssl_min_protocol_version = 'TLSv1.3'");
    assertStringIncludes(priv, "archon.environment = 'production'");
    assertStringIncludes(priv, "archon.protected = 'on'");
    assertStringIncludes(priv, "log_connections = 'authorization'");
    assertStringIncludes(archonConf({ ...i, version: 16 }), "log_connections = on");
    const pub = archonConf(
      { ...i, published: true },
      {
        address: "10.0.30.57",
        tls: { cert: "/c.pem", key: "/k.pem" },
      },
    );
    assertStringIncludes(pub, "listen_addresses = 'localhost,10.0.30.57'");
    assertStringIncludes(pub, "ssl_cert_file = '/c.pem'");
  },
);

proves(
  ["038-pg FR-014", "039-pg-identity FR-007"],
  "038: pg_hba: peer and scram only; published adds hostssl from the local networks, never the world",
  () => {
    const nets = ["10.0.0.0/8", "10.0.0.0/16"];
    const priv = hbaConf(false, nets);
    assert(!/\btrust\b|\bmd5\b|\bpassword\b|0\.0\.0\.0\/0|::\/0/.test(priv));
    assertStringIncludes(priv, "local    all       all                        peer");
    assertStringIncludes(priv, "127.0.0.1/32     scram-sha-256");
    assert(!priv.includes("hostssl"));
    const pub = hbaConf(true, nets);
    assertEquals(pub.split("\n").filter((l) => /^hostssl.*scram-sha-256$/.test(l)).length, 2);
    assert(!/^host\s+all\s+all\s+(10|192)/m.test(pub), "TLS only from the networks");
    // The whole world appears only to refuse postgres (spec 039), never to admit anyone.
    for (const l of pub.split("\n").filter((l) => /0\.0\.0\.0\/0|::\/0/.test(l))) {
      assert(/postgres\s+\S+\s+reject$/.test(l), l);
    }
  },
);

proves(
  ["038-pg FR-014", "064-router-filters FR-001"],
  "038, 064: publish: every address (the router decides; no --local-only)",
  async () => {
    assertEquals(publishedName(webFleet(), pgHost(), "prime"), "pg-prime.alpha.lab.example.net");
    const priv = resolvePlan(pgHost({ pgState: recorded() }), webFleet());
    assert(!priv.ports.some((p) => p.port === 5432), "private: no port");
    const ufwOf = (plan: ReturnType<typeof resolvePlan>) =>
      the(the(plan.files.find((f) => f.path === "/etc/ufw/applications.d/archon")).content);
    // Default: open to every address, in the firewall's Archon profile; TLS and scram in pg_hba.
    const pub = resolvePlan(
      pgHost({ pgState: recorded({ published: { at: "x", by: "alice" } }) }),
      webFleet(),
    );
    assert(
      pub.ports.some((p) => p.port === 5432),
      "open to every address",
    );
    assert(/\[Archon\]\n[^[]*\b5432\b/.test(ufwOf(pub)), ufwOf(pub));
    const { ANYWHERE } = await import("../src/archon/pg/config.ts");
    const open = hbaConf(true, ANYWHERE);
    assertStringIncludes(open, "hostssl  all       all       0.0.0.0/0        scram-sha-256");
    assertStringIncludes(open, "hostssl  all       all       ::/0             scram-sha-256");
    assert(
      open.indexOf("postgres  0.0.0.0/0        reject") <
        open.indexOf("all       0.0.0.0/0        scram"),
      "postgres refused first",
    );
    assert(
      !/^host\s/m.test(
        open
          .split("\n")
          .filter((l) => /0\.0\.0\.0\/0|::\/0/.test(l))
          .join("\n"),
      ),
      "TLS only",
    );
    // The machine restricts no network: there is no --local-only (the router decides).
    const { COMMANDS } = await import("../src/archon/commands/registry.ts");
    assert(
      !the(COMMANDS.find((c) => c.name === "pg publish")).args.some((a) => a.name === "local-only"),
    );
    // No Traefik route for PostgreSQL (the owner's decision).
    assert(!pub.routes.some((r) => r.name.startsWith("pg-")));
  },
);

proves(
  ["040-opt-in FR-001", "040-opt-in FR-005"],
  "038: capability: clusters only for instances, while on; workstations never",
  () => {
    const none = resolvePlan(host(), webFleet());
    assert(!none.units.some((u) => u.unitName.startsWith("postgresql@")));
    assert(!none.packages.some((p) => /^postgresql-\d/.test(p.name)));
    const plan = resolvePlan(pgHost({ pgState: recorded() }), webFleet());
    assert(plan.packages.some((p) => p.name === "postgresql-common"));
    assertEquals(
      plan.files
        .find((f) => f.path === "/etc/postgresql-common/createcluster.d/50-archon.conf")
        ?.content?.includes("create_main_cluster = false"),
      true,
    );
    const unit = the(plan.units.find((u) => u.unitName === "postgresql@18-prime.service"));
    assertEquals(unit.managed, false);
    assertStringIncludes(unit.verify, "pg_isready");
    assertStringIncludes(unit.verify, "-p 5432");
    assert(plan.units.some((u) => u.unitName === "archon-pg-backup.timer"));
    const wsHost = pgHost({ kind: "workstation", user: "alice" });
    delete wsHost.mac; // a workstation has no MAC or disk layout in the model
    delete wsHost.disk;
    const ws = resolvePlan(wsHost, fleet());
    assert(!ws.packages.some((p) => p.name === "postgresql-common"));
  },
);

proves(
  ["038-pg FR-012"],
  "038: passwords are set as SCRAM-SHA-256 verifiers (RFC 7677 test vector shape)",
  async () => {
    const salt = Uint8Array.from(atob("W22ZaJ0SNY7soEsUEjb6gQ=="), (c) => c.charCodeAt(0));
    const v = await scramVerifier("pencil", salt, 4096);
    // RFC 7677's example: password "pencil", this salt, 4096 iterations.
    assertEquals(
      v,
      "SCRAM-SHA-256$4096:W22ZaJ0SNY7soEsUEjb6gQ==$WG5d8oPm3OtcPnkdi4Uo7BkeZkBFzpcXkuLmtbsT4qY=:wfPLwcE6nTWhTAmQ7tl2KeoiWGPlZqQxSrmfPwDl2dU=",
    );
    assert(!v.includes("pencil"));
  },
);

proves(
  ["038-pg FR-016", "038-pg FR-019", "039-pg-identity FR-011"],
  "038/039: connect: the service block, .pgpass, and the app contract's JSON",
  () => {
    const i = {
      name: "prime",
      port: 5432,
      published: false,
      databases: [{ name: "app1", owner: "s-app1" }],
    };
    // On the server: the socket, peer, no password; the app's service account owns its database.
    const c = connectInfo(i, "s-app1", { publishedHost: "pg-prime.alpha.lab.example.net" });
    assertEquals(c, {
      service: "prime",
      host: "/var/run/postgresql",
      port: 5432,
      user: "s-app1",
      database: "app1",
      sslmode: "disable",
    });
    assertEquals(
      serviceBlock(c),
      "[prime]\nhost=/var/run/postgresql\nport=5432\ndbname=app1\nuser=s-app1\nsslmode=disable\napplication_name=psql-prime\n",
    );
    // --remote, published: the name, verified TLS against the system's roots.
    const r = connectInfo({ ...i, published: true }, "s-app1", {
      publishedHost: "pg-prime.alpha.lab.example.net",
      remote: true,
    });
    assertEquals([r.host, r.sslmode], ["pg-prime.alpha.lab.example.net", "verify-full"]);
    assertStringIncludes(serviceBlock(r), "sslrootcert=system");
    assertEquals(r.published?.host, "pg-prime.alpha.lab.example.net");
    // A person with no database of theirs lands in postgres.
    assertEquals(connectInfo(i, "alice").database, "postgres");
    assertEquals(
      pgpassLine(r, "a:b\\c"),
      "pg-prime.alpha.lab.example.net:5432:*:s-app1:a\\:b\\\\c",
    );
    // Only that section and that line change; the user's own lines stay.
    const mine = "# my notes\n[other]\nhost=x\n\n[prime]\nhost=old\nport=1\n\n[last]\nhost=y\n";
    const out = upsertSection(mine, "prime", serviceBlock(c));
    assertStringIncludes(out, "# my notes\n[other]\nhost=x");
    assertStringIncludes(out, "[last]\nhost=y");
    assert(!out.includes("host=old"));
    assertEquals(upsertSection("", "prime", serviceBlock(c)), serviceBlock(c));
    assertEquals(
      upsertPgpass("db:1:*:me:x\nh:5432:*:s-app1:old\n", "h:5432:*:s-app1:new"),
      "db:1:*:me:x\nh:5432:*:s-app1:new\n",
    );
  },
);

proves(
  ["038-pg FR-006"],
  "038: commands: tiers, NAME default prime, --json, and the destructive ones never over MCP",
  async () => {
    const { COMMANDS, findCommand } = await import("../src/archon/commands/registry.ts");
    const by = (n: string) => the(COMMANDS.find((c) => c.name === n));
    const tiers: Record<string, string> = {
      "pg list": "read",
      "pg status": "read",
      "pg connect": "read",
      "pg maintain": "read",
      "pg ensure": "mutate",
      "pg start": "mutate",
      "pg stop": "mutate",
      "pg restart": "mutate",
      "pg reload": "mutate",
      "pg backup": "mutate",
      "pg publish": "mutate",
      "pg unpublish": "mutate",
      "pg upgrade": "destructive",
      "pg remove": "destructive",
      "pg restore": "destructive",
    };
    for (const [n, t] of Object.entries(tiers)) {
      assertEquals(by(n)?.tier, t, n);
      if (n !== "pg list") {
        assertEquals(by(n).args.find((a) => a.name === "name")?.default, "prime", n);
      }
    }
    assert(by("pg ensure").precheck, "ensure answers unprivileged when satisfied");
    assertEquals(findCommand(["pg", "connect", "prime", "--write"])?.cmd.name, "pg connect");
    const { listed } = await import("../src/archon/mcp/server.ts");
    for (const n of ["pg upgrade", "pg remove", "pg restore"]) {
      assert(!listed(by(n), "mutate"), `${n} is never served over MCP`);
    }
    assert(listed(by("pg ensure"), "mutate"));
  },
);

proves(
  ["038-pg FR-020"],
  "038: destructive operations need the owner's marker in the spec, and the spec has none",
  async () => {
    assert(approvedInSpec("intro\napprove: destructive\n"));
    assert(!approvedInSpec("an `approve: destructive` line, mentioned"));
    const spec = await fs.readTextFile("specs/038-pg/spec.md");
    assert(!approvedInSpec(spec), "the owner adds it, not Archon");
    const { guardDestructive, PgError } = await import("../src/archon/pg/commands.ts");
    let err: unknown;
    try {
      await guardDestructive("remove", "prime", "prime");
    } catch (e) {
      err = e;
    }
    assert(err instanceof PgError);
    assertStringIncludes(err.message, "approve: destructive");
  },
);

proves(
  ["038-pg FR-001"],
  "038: the model: prime is PostgreSQL 18; every server's owners are known; bad names are rejected",
  async () => {
    const { PRIME } = await import("../src/archon/pg/config.ts");
    assertEquals([PRIME.name, PRIME.version], ["prime", 18]);
    const { fleet: real } = await import("../examples/fleets/lab/fleet.ts");
    const { loadHosts } = await import("../src/archon/model/load.ts");
    // Every database owner in the fleet's model is one of its service accounts or people.
    for (const h of await loadHosts()) {
      for (const d of h.pg?.instances?.flatMap((i) => i.databases ?? []) ?? []) {
        assert(
          (real.services ?? []).some((s) => s.name === d.owner) || d.owner === real.admin.user,
          `${h.name}: ${d.owner}`,
        );
      }
    }
    const { validateFleet } = await import("../src/archon/model/validate.ts");
    const bad = validateFleet(fleet(), [
      pgHost({
        pg: {
          instances: [
            { name: "Bad_Name" },
            {
              name: "x",
              databases: [{ name: "d", owner: "postgres" }],
            },
            {
              name: "y",
              port: 443,
            },
          ],
        },
      }),
    ]);
    assert(bad.some((p) => p.message.includes("Bad_Name")));
    assert(bad.some((p) => p.message.includes("'postgres'")));
    assert(bad.some((p) => p.message.includes("port 443")));
    assertEquals(
      validateFleet(webFleet(), [pgHost()]).filter((p) => /PostgreSQL|prime\//.test(p.message)),
      [],
    );
    // A database's owner must be a person or a fleet service account.
    assert(validateFleet(fleet(), [pgHost()]).some((p) => p.message.includes("'s-app1'")));
  },
);

proves(
  ["038-pg FR-002", "038-pg FR-003"],
  "038: the PGDG source uses Ubuntu's shipped key; the record reads back",
  async () => {
    const src = pgdgSource("resolute", "amd64");
    assertStringIncludes(src, "Suites: resolute-pgdg");
    assertStringIncludes(
      src,
      "Signed-By: /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc",
    );
    const { writeRecord, readState } = await import("../src/archon/pg/converge.ts");
    const { readPgState } = await import("../src/archon/model/load.ts");
    const root = await fs.makeTempDir({ prefix: "archon-pg-test-" });
    try {
      assertEquals(await readPgState("alpha", root), undefined);
      await writeRecord("alpha", "prime", recorded().instances["prime"], root);
      await writeRecord("alpha", "lab", { version: 17, port: 5433, created: "x", by: "y" }, root);
      assertEquals(Object.keys((await readState("alpha", root)).instances), ["lab", "prime"]);
      await writeRecord("alpha", "lab", undefined, root);
      assertEquals(Object.keys(the(await readPgState("alpha", root)).instances), ["prime"]);
    } finally {
      await fs.remove(root, { recursive: true });
    }
  },
);

proves(["038-pg FR-017"], "038: the psql prompt, the guide, and the man page", async () => {
  const rc = await fs.readTextFile("home/dot_psqlrc");
  for (const s of [
    "\\pset linestyle unicode",
    "\\pset border 2",
    "\\pset null '∅'",
    "\\timing on",
    "\\set ON_ERROR_ROLLBACK interactive",
    "\\set AUTOCOMMIT off",
    "%p",
    "%x",
    "%n",
    "%/",
    "%M:%>",
    "archon.environment",
    "archon.protected",
    "rolsuper",
    "\\gset",
    "\\n%:archon_arrow:",
  ])
    assertStringIncludes(rc, s);
  // Colors from SQL carry readline's invisible markers (psql does not expand %[ in variables).
  assertStringIncludes(rc, "chr(1) || chr(27)");
  const { guideFor } = await import("../src/archon/guide/guide.ts");
  const item = the(
    guideFor(resolvePlan(pgHost({ pgState: recorded() }), webFleet())).find((x) => x.id === "pg"),
  );
  assert(the(item.use).some((u) => u.cmd === "psql service=prime"));
  const { GUIDES } = await import("../src/archon/web/serve.ts");
  assert(GUIDES.some((g) => g.name === "pg"));
  const { pgPage } = await import("../src/archon/render/man.ts");
  assertStringIncludes(pgPage(), "archon\\-pg");
  const doc = engineFile("docs/pg.md");
  assertStringIncludes(doc, "Traefik is not in the path");
  assertStringIncludes(doc, "sslmode=verify-full sslrootcert=system");
});

proves(
  ["038-pg FR-022"],
  "038: rainfrog and pgcenter: each project's own release archive, matched exactly",
  async () => {
    const { TOOLS } = await import("../src/archon/tools/catalog.ts");
    const t = (id: string) => the(TOOLS.find((x) => x.id === id));
    for (const id of ["rainfrog", "pgcenter"]) {
      assertEquals(t(id).source, "upstream-binary", id);
      assert(!t(id).serverOnly && !t(id).workstationOnly, `${id}: every host`);
    }
    // The asset names their release builds publish (rainfrog's cd.yml, pgcenter's .goreleaser.yml).
    const rf = the(t("rainfrog").github).asset("amd64", "0.4.7");
    assert(rf.test("rainfrog-v0.4.7-x86_64-unknown-linux-musl.tar.gz"));
    assert(!rf.test("rainfrog-v0.4.7-x86_64-unknown-linux-gnu.tar.gz"), "the static build");
    assert(!rf.test("rainfrog-v0.4.7-x86_64-unknown-linux-musl.sha256"));
    const pc = the(t("pgcenter").github).asset("amd64", "0.11.0");
    assert(pc.test("pgcenter_0.11.0_linux_amd64.tar.gz"));
    assert(!pc.test("pgcenter_0.11.0_linux_arm64.tar.gz"));
    assert(!pc.test("pgcenter_0.11.0_linux_amd64.deb"));
  },
);
