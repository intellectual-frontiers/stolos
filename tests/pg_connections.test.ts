// Spec 043: archon pg connections and archon pg show. Read-only; never a password.
import { assert, assertEquals, assertStringIncludes } from "./assert.ts";
import {
  connectionsReport,
  FORMS,
  lookupKey,
  parseForm,
  parsePgpass,
  parseServiceFile,
  renderConnections,
  renderShow,
  splitPgpassLine,
} from "../src/archon/pg/connections.ts";

/** The password planted in every fixture: it must appear in no output, anywhere. */
const SECRET = "Pw-NEVER-shown-7f3a";
const ESCAPED = "Pw\\:NEVER\\:shown"; // a password with escaped colons
const PGPASS = [
  "# my databases",
  `localhost:5433:*:alice:${SECRET}`,
  `db.example.org:5432:app:s-app1:${ESCAPED}`,
  `alpha:5432:arca:${SECRET}`, // the user left out: four fields
  `*:*:*:nobody:${SECRET}`,
  "",
].join("\n");
const SERVICES = [
  "[prime]",
  "host=/var/run/postgresql",
  "port=5433",
  "dbname=postgres",
  "",
  "[app]",
  "host=db.example.org",
  "dbname=app",
  "user=s-app1",
  `password=${SECRET}`,
  "",
].join("\n");
const SYSTEM = "[lab]\nhost=/var/run/postgresql\nport=5434\ndbname=postgres\n[prime]\nport=9999\n";

Deno.test("043: the password field is dropped as a line is split", () => {
  const a = splitPgpassLine(`h:5432:db:me:${SECRET}`);
  assertEquals(a, { fields: ["h", "5432", "db", "me"], hasPassword: true });
  assertEquals(splitPgpassLine("a\\:b:1:d:u:x").fields[0], "a:b", "backslash escapes ':'");
  const entries = parsePgpass(PGPASS);
  assertEquals(entries.map((e) => e.line), [2, 3, 4, 5], "comments and blank lines skipped");
  assertEquals(entries[2].malformed !== undefined, true);
  assertEquals(
    [entries[2].host, entries[2].user],
    ["", ""],
    "a malformed line's fields are not kept",
  );
  assert(!JSON.stringify(entries).includes(SECRET) && !JSON.stringify(entries).includes("NEVER"));
  const svc = parseServiceFile(SERVICES, "/x", "user");
  assertEquals(svc.find((s) => s.name === "app")!.hadPassword, true);
  assert(!JSON.stringify(svc).includes(SECRET));
});

Deno.test("043: matched the way libpq matches; problems named with their reason", () => {
  const services = [
    { path: "/home/alice/.pg_service.conf", source: "user" as const, text: SERVICES },
    { path: "/etc/postgresql-common/pg_service.conf", source: "system" as const, text: SYSTEM },
  ];
  const r = connectionsReport({
    me: "alice",
    pgpass: { path: "/home/alice/.pgpass", text: PGPASS, mode: 0o100600, isFile: true },
    serviceFiles: services,
  });
  assert(r.passwordFile.usable);
  // The socket directory counts as localhost; '*' matches anything.
  assertEquals(
    lookupKey({ params: { host: "/var/run/postgresql", port: "5433" } }, "alice").host,
    "localhost",
  );
  const line = (n: number) => r.entries.find((e) => e.line === n)!;
  assertEquals(line(2).services, ["prime"]);
  assertEquals(line(3).services, ["app"]);
  assert(line(4).problems[0].includes("five fields") && !line(4).usable);
  assert(line(5).problems.some((p) => p.includes("no service")));
  // The user's [prime] hides the system's; the system's [lab] stays.
  assertEquals(r.services.map((s) => s.name), ["prime", "app", "lab"]);
  assertEquals(r.services.find((s) => s.name === "prime")!.passwordEntry, 2);
  const app = r.services.find((s) => s.name === "app")!;
  assert(app.problems.some((p) => p.includes("holds a password")));
  assert(app.problems.some((p) => p.includes("verify-full")), "network without verify-full");
  // A password file others can read: libpq ignores it, and so every entry is unusable.
  const open = connectionsReport({
    me: "alice",
    pgpass: { path: "/p", text: PGPASS, mode: 0o100644, isFile: true },
    serviceFiles: services,
  });
  assert(!open.passwordFile.usable);
  assertStringIncludes(open.passwordFile.problem!, "chmod 600");
  assert(open.entries.every((e) => !e.usable));
  for (
    const out of [
      JSON.stringify(r),
      renderConnections(r),
      JSON.stringify(open),
      renderConnections(open),
    ]
  ) {
    assert(!out.includes(SECRET) && !out.includes("NEVER"), "no password in the report");
  }
});

Deno.test("043: show: four forms; a network host verifies the server; no password", () => {
  const local = {
    name: "prime",
    host: "/var/run/postgresql",
    port: 5433,
    database: "postgres",
    user: "alice",
    network: false,
  };
  assertEquals(
    renderShow(local, "conninfo"),
    "host=/var/run/postgresql port=5433 dbname=postgres user=alice",
  );
  assertEquals(
    renderShow(local, "url"),
    "postgresql://alice@%2Fvar%2Frun%2Fpostgresql:5433/postgres",
  );
  assertStringIncludes(renderShow(local, "env"), "export PGHOST=/var/run/postgresql");
  assertStringIncludes(
    renderShow(local, "service"),
    "[prime]\nhost=/var/run/postgresql\nport=5433",
  );
  for (const f of FORMS.filter((x) => x !== "external" && x !== "jdbc")) {
    assert(!/sslmode|password/i.test(renderShow(local, f)), `${f}: the socket, peer`);
  }
  const net = { ...local, host: "pg-prime.alpha.lab.example.net", network: true };
  for (const f of ["conninfo", "url", "env", "service"] as const) {
    const out = renderShow(net, f);
    assert(/verify-full/.test(out), `${f}: verify-full`);
    assert(!/(prefer|allow|disable|require)\b/.test(out), `${f}: never a fallback`);
    assert(!/password/i.test(out), `${f}: no password`);
  }
  assertEquals(
    renderShow(net, "url"),
    "postgresql://alice@pg-prime.alpha.lab.example.net:5433/postgres?sslmode=verify-full&sslrootcert=system",
  );
  assertEquals(parseForm(undefined), "conninfo");
  let msg = "";
  try {
    parseForm("json");
  } catch (e) {
    msg = (e as Error).message;
  }
  for (const f of FORMS) assertStringIncludes(msg, f);
});

Deno.test("043: commands are read-only and served over MCP", async () => {
  const { COMMANDS } = await import("../src/archon/commands/registry.ts");
  const { listed } = await import("../src/archon/mcp/server.ts");
  for (const n of ["pg connections", "pg show"]) {
    const c = COMMANDS.find((x) => x.name === n)!;
    assertEquals(c.tier, "read", n);
    assert(listed(c, "read"), `${n} is an MCP tool`);
    assert(!c.args.some((a) => a.name === "write"), `${n}: nothing is written`);
  }
});

Deno.test("043: a planted password appears nowhere: CLI text, JSON, errors, and MCP results", async () => {
  const dir = await Deno.makeTempDir({ prefix: "archon-pgpass-" });
  const env = {
    HOME: dir,
    PGPASSFILE: `${dir}/.pgpass`,
    PGSERVICEFILE: `${dir}/.pg_service.conf`,
    PGSYSCONFDIR: `${dir}/sys`,
    NO_COLOR: "1",
  };
  try {
    await Deno.mkdir(`${dir}/sys`);
    await Deno.writeTextFile(env.PGPASSFILE, PGPASS, { mode: 0o600 });
    await Deno.chmod(env.PGPASSFILE, 0o600);
    await Deno.writeTextFile(env.PGSERVICEFILE, SERVICES);
    await Deno.writeTextFile(`${dir}/sys/pg_service.conf`, SYSTEM);
    const runs: string[][] = [
      ["pg", "connections"],
      ["pg", "connections", "--json"],
      ["pg", "show", "app"],
      ["pg", "show", "app", "--json"],
      // ca fetches over the network (tested on its own, below).
      ...FORMS.filter((f) => f !== "ca").map((f) => ["pg", "show", "app", "--form", f]),
      ["pg", "show", "lab", "--form", "url"],
      ["pg", "show", "nosuch"],
      ["pg", "show", "app", "--form", "bogus"],
    ];
    const outputs: string[] = [];
    const cli = (args: string[]) =>
      new Deno.Command(Deno.execPath(), {
        args: ["run", "-A", "src/archon/main.ts", ...args, "--host", "alpha"],
        env,
        stdout: "piped",
        stderr: "piped",
      }).output();
    for (const a of runs) {
      const r = await cli(a);
      const out = new TextDecoder().decode(r.stdout) + new TextDecoder().decode(r.stderr);
      outputs.push(out);
      if (a.includes("bogus")) {
        assertEquals(r.code, 2, "a usage error");
        for (const f of FORMS) assertStringIncludes(out, f);
      }
    }
    assertStringIncludes(
      outputs[2],
      "sslmode=verify-full",
      "the network service verifies the server",
    );
    // Again with the file readable by others: the warning path.
    await Deno.chmod(env.PGPASSFILE, 0o644);
    const open = await cli(["pg", "connections"]);
    outputs.push(new TextDecoder().decode(open.stdout) + new TextDecoder().decode(open.stderr));
    assertStringIncludes(outputs.at(-1)!, "UNUSABLE");
    // The MCP server's own path: tools/call runs archon as a subprocess.
    const launcher = `${dir}/archon`;
    await Deno.writeTextFile(
      launcher,
      `#!/bin/sh\nexec "${Deno.execPath()}" run -A "${Deno.cwd()}/src/archon/main.ts" "$@" --host alpha\n`,
    );
    await Deno.chmod(launcher, 0o755);
    const saved = Object.fromEntries(Object.keys(env).map((k) => [k, Deno.env.get(k)]));
    for (const [k, v] of Object.entries({ ...env, ARCHON_SELF: launcher })) Deno.env.set(k, v);
    try {
      const { handle } = await import("../src/archon/mcp/server.ts");
      for (
        const [name, args] of [
          ["archon_pg_connections", { json: true }],
          ["archon_pg_connections", {}],
          ["archon_pg_show", { name: "app", form: "env" }],
          ["archon_pg_show", { name: "app", form: "bogus" }],
        ] as Array<[string, Record<string, unknown>]>
      ) {
        outputs.push(
          JSON.stringify(
            await handle({
              jsonrpc: "2.0",
              id: 1,
              method: "tools/call",
              params: { name, arguments: args },
            }, "read"),
          ),
        );
      }
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        v === undefined ? Deno.env.delete(k) : Deno.env.set(k, v);
      }
      Deno.env.delete("ARCHON_SELF");
    }
    for (const [i, out] of outputs.entries()) {
      assert(out.length > 0, `run ${i} printed something`);
      assert(!out.includes(SECRET), `run ${i} leaked the password`);
      assert(!out.includes("NEVER"), `run ${i} leaked part of a password`);
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("043: a near miss is explained: a service on another socket directory is not localhost", () => {
  const dir = "/home/ann/work/build/db";
  const r = connectionsReport({
    me: "ann",
    pgpass: {
      path: "/p",
      text: `localhost:55432:*:postgres:${SECRET}\n127.0.0.1:55432:*:postgres:${SECRET}\n`,
      mode: 0o100600,
      isFile: true,
    },
    serviceFiles: [{
      path: "/s",
      source: "user",
      text: `[local]\nhost=${dir}\nport=55432\ndbname=app\nuser=postgres\n`,
    }],
  });
  // As libpq: neither line serves a service on a non-default socket directory.
  assertEquals(r.services[0].passwordEntry, null);
  for (const e of r.entries) {
    assert(
      e.problems.some((p) =>
        p.includes(`socket directory ${dir}`) && p.includes(`set host=${e.host}`)
      ),
      e.host,
    );
    assert(
      !e.problems.some((p) => p.startsWith("no service")),
      "the reason replaces the generic message",
    );
  }
  assert(!JSON.stringify(r).includes(SECRET) && !renderConnections(r).includes(SECRET));
  // With the socket path as the host, the line serves it.
  const ok = connectionsReport({
    me: "ann",
    pgpass: {
      path: "/p",
      text: `${dir}:55432:*:postgres:${SECRET}\n`,
      mode: 0o100600,
      isFile: true,
    },
    serviceFiles: [{
      path: "/s",
      source: "user",
      text: `[local]\nhost=${dir}\nport=55432\ndbname=app\nuser=postgres\n`,
    }],
  });
  assertEquals(ok.services[0].passwordEntry, 1);
});

Deno.test("043: --form without a value names the four forms", async () => {
  const { COMMANDS } = await import("../src/archon/commands/registry.ts");
  const { parseArgs } = await import("../src/archon/core/registry-types.ts");
  let msg = "";
  try {
    parseArgs(COMMANDS.find((c) => c.name === "pg show")!, ["prime", "--form"]);
  } catch (e) {
    msg = (e as Error).message;
  }
  assertStringIncludes(msg, "--form needs a value");
  for (const f of FORMS) assertStringIncludes(msg, f);
});

Deno.test("043: the external form: everything a client elsewhere needs, verified TLS, no password", () => {
  const t = {
    name: "prime",
    host: "pg-prime.alpha.lab.example.net",
    port: 5433,
    database: "postgres",
    user: "alice",
    network: true,
    address: "10.0.30.57",
    kind: "human" as const,
  };
  const out = renderShow(t, "external");
  for (
    const s of [
      "host:        pg-prime.alpha.lab.example.net",
      "hostaddr:    10.0.30.57",
      "port:        5433",
      "sslmode:     verify-full",
      "sslrootcert: system",
      "your Linux password",
      "postgresql://alice@pg-prime.alpha.lab.example.net:5433/postgres?sslmode=verify-full",
      "export PGSSLMODE=verify-full",
      "[prime]",
    ]
  ) assertStringIncludes(out, s);
  assert(!/(prefer|allow|disable)\b/.test(out), "never a fallback");
  // require only where Prisma verifies with it (sslaccept=strict).
  for (const l of out.split("\n").filter((l) => /sslmode=require/.test(l))) {
    assertStringIncludes(l, "sslaccept=strict");
  }
  assertStringIncludes(
    renderShow({ ...t, user: "s-app1", kind: "service" }, "external"),
    "run as s-app1",
  );
  assert(FORMS.includes("external"));
});

Deno.test("043: the jdbc form: pgJDBC's own TLS settings, verified, no password", () => {
  const t = {
    name: "prime",
    host: "pg-prime.alpha.lab.example.net",
    port: 5433,
    database: "postgres",
    user: "alice",
    network: true,
  };
  assertEquals(
    renderShow(t, "jdbc"),
    "jdbc:postgresql://pg-prime.alpha.lab.example.net:5433/postgres?sslmode=verify-full&sslfactory=org.postgresql.ssl.DefaultJavaSSLFactory&user=alice",
  );
  assert(!renderShow(t, "jdbc").includes("sslrootcert"), "pgJDBC reads sslrootcert as a file");
  const ext = renderShow(t, "external");
  assertStringIncludes(ext, "jdbc (DBeaver");
  assertStringIncludes(ext, "sslfactory=org.postgresql.ssl.DefaultJavaSSLFactory");
  assertStringIncludes(ext, "Use Windows trust store");
});

Deno.test("043: pg test: TLS to the published name, a typed password, a reason on failure, and no password in any output", async () => {
  const psql = await new Deno.Command("sh", { args: ["-c", "command -v psql"] }).output();
  if (psql.code !== 0) return; // needs psql
  const dir = await Deno.makeTempDir({ prefix: "archon-pg-test-" });
  try {
    await Deno.mkdir(`${dir}/sys`);
    await Deno.writeTextFile(
      `${dir}/.pg_service.conf`,
      "[far]\nhost=no-such-host.invalid\nport=5432\ndbname=app\nuser=s-app1\n",
    );
    const c = new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", "src/archon/main.ts", "pg", "test", "far", "--host", "alpha"],
      env: {
        HOME: dir,
        PGSERVICEFILE: `${dir}/.pg_service.conf`,
        PGSYSCONFDIR: `${dir}/sys`,
        PGPASSFILE: `${dir}/.pgpass`,
        NO_COLOR: "1",
      },
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    const w = c.stdin.getWriter();
    await w.write(new TextEncoder().encode(`${SECRET}\n`));
    await w.close();
    const r = await c.output();
    const out = new TextDecoder().decode(r.stdout) + new TextDecoder().decode(r.stderr);
    assertEquals(r.code, 1, out);
    assertStringIncludes(out, "over TLS (verify-full), not through localhost");
    assertStringIncludes(out, "FAILED");
    assertStringIncludes(out, "does not resolve here");
    assert(!out.includes(SECRET) && !out.includes("NEVER"), "the typed password appears nowhere");
    // The temporary password file is gone.
    const left = [...Deno.readDirSync("/tmp")].filter((e) =>
      e.name.startsWith("archon-pg-test-") && e.name !== dir.split("/").pop()
    );
    for (const e of left) {
      assert(![...Deno.readDirSync(`/tmp/${e.name}`)].some((f) => f.name === "pgpass"));
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("043: the PAM reminder: with every external connection for a person, not for a service", async () => {
  const { pamReminder, explainFailure } = await import("../src/archon/pg/connections.ts");
  const t = {
    name: "prime",
    host: "pg-prime.alpha.lab.example.net",
    port: 5433,
    database: "postgres",
    user: "alice",
    network: true,
    kind: "human" as const,
    server: "alpha",
  };
  const note = pamReminder(t)!;
  assertStringIncludes(note, "sudo -k && sudo -v");
  assertStringIncludes(note, "archon pg test prime");
  assertStringIncludes(renderShow(t, "external"), "sudo -k && sudo -v");
  assertEquals(pamReminder({ ...t, user: "s-app1", kind: "service" }), undefined);
  assertStringIncludes(
    explainFailure('FATAL:  password authentication failed for user "alice"', t),
    "sudo -k && sudo -v",
  );
  assertStringIncludes(
    explainFailure("could not connect to server: Connection refused", t),
    "firewall",
  );
  assertStringIncludes(explainFailure("no pg_hba.conf entry for host", t), "is it published");
});

Deno.test("043: the external form's values start at the left margin (a copied line pastes as it is)", () => {
  const t = {
    name: "prime",
    host: "pg-prime.alpha.lab.example.net",
    port: 5433,
    database: "postgres",
    user: "alice",
    network: true,
  };
  const lines = renderShow(t, "external").split("\n");
  for (const prefix of ["jdbc:postgresql://", "postgresql://", "host=", "export PG", "[prime]"]) {
    assert(lines.some((l) => l.startsWith(prefix)), `${prefix} at the left margin`);
  }
  assert(!lines.some((l) => /^\s+(jdbc:|postgresql:|host=|export )/.test(l)), "no indented value");
});

Deno.test("043: npgsql, odbc, dotenv, pgadmin: verified TLS each in its own syntax, no password", () => {
  const t = {
    name: "prime",
    host: "pg-prime.alpha.lab.example.net",
    port: 5433,
    database: "postgres",
    user: "alice",
    network: true,
    server: "alpha",
  };
  assertEquals(
    renderShow(t, "npgsql"),
    "Host=pg-prime.alpha.lab.example.net;Port=5433;Database=postgres;Username=alice;SSL Mode=VerifyFull",
  );
  const odbc = renderShow(t, "odbc");
  assertStringIncludes(
    odbc,
    "Driver={PostgreSQL Unicode(x64)};Server=pg-prime.alpha.lab.example.net;Port=5433;Database=postgres;Uid=alice;SSLmode=verify-full",
  );
  assertStringIncludes(odbc, "pqopt={sslrootcert=system}");
  assertStringIncludes(odbc, "%APPDATA%\\postgresql\\root.crt");
  const env = renderShow(t, "dotenv");
  const active = env.split("\n").filter((l) => l.startsWith("DATABASE_URL="));
  assertEquals(active, [
    "DATABASE_URL=postgresql://alice@pg-prime.alpha.lab.example.net:5433/postgres?sslmode=verify-full&sslrootcert=system",
  ]);
  assertStringIncludes(
    env,
    "# DATABASE_URL=postgresql://alice@pg-prime.alpha.lab.example.net:5433/postgres?sslmode=verify-full\n",
  );
  assertStringIncludes(env, "sslaccept=strict");
  const pg = JSON.parse(renderShow(t, "pgadmin"));
  const srv = pg.Servers["1"];
  assertEquals([srv.Host, srv.Port, srv.Username, srv.ConnectionParameters.sslmode], [
    t.host,
    5433,
    "alice",
    "verify-full",
  ]);
  assertEquals(srv.Name, "prime (alpha)");
  for (const f of ["npgsql", "odbc", "dotenv", "pgadmin"] as const) {
    assert(!/password\s*[=:]|"password"/i.test(renderShow(t, f)), `${f}: no password`);
  }
  // On the server itself: the socket, no TLS settings.
  const local = { ...t, host: "/var/run/postgresql", network: false };
  assertEquals(
    renderShow(local, "dotenv"),
    "DATABASE_URL=postgresql://alice@%2Fvar%2Frun%2Fpostgresql:5433/postgres",
  );
  assertEquals(
    renderShow(local, "npgsql"),
    "Host=/var/run/postgresql;Port=5433;Database=postgres;Username=alice",
  );
});

Deno.test("043: ca: the trusted root that signs the server's chain", async () => {
  const has = await new Deno.Command("sh", { args: ["-c", "command -v openssl"] }).output();
  if (has.code !== 0) return;
  const { rootFor } = await import("../src/archon/pg/connections.ts");
  const dir = await Deno.makeTempDir({ prefix: "archon-pki-" });
  const sh = (cmd: string) =>
    new Deno.Command("sh", { args: ["-c", cmd], cwd: dir, stdout: "null", stderr: "null" })
      .output();
  try {
    // A root, an intermediate it signs, a leaf the intermediate signs; and an unrelated root.
    await sh(`
      openssl req -x509 -newkey rsa:2048 -nodes -keyout root.key -out root.pem -days 2 -subj "/CN=Test Root" -addext basicConstraints=critical,CA:true -addext keyUsage=critical,keyCertSign
      openssl req -newkey rsa:2048 -nodes -keyout int.key -out int.csr -subj "/CN=Test Intermediate"
      printf 'basicConstraints=critical,CA:true\nkeyUsage=critical,keyCertSign\n' > ca.ext
      openssl x509 -req -in int.csr -CA root.pem -CAkey root.key -CAcreateserial -out int.pem -days 2 -extfile ca.ext
      openssl req -newkey rsa:2048 -nodes -keyout leaf.key -out leaf.csr -subj "/CN=pg-prime.example.test"
      openssl x509 -req -in leaf.csr -CA int.pem -CAkey int.key -CAcreateserial -out leaf.pem -days 2
      openssl req -x509 -newkey rsa:2048 -nodes -keyout other.key -out other.pem -days 2 -subj "/CN=Test Root"
      mkdir certs
      cp other.pem certs/$(openssl x509 -in other.pem -noout -hash).0
      cp root.pem certs/$(openssl x509 -in root.pem -noout -hash).1
    `);
    const chain = [
      await Deno.readTextFile(`${dir}/leaf.pem`),
      await Deno.readTextFile(`${dir}/int.pem`),
    ];
    const got = await rootFor(chain, `${dir}/certs`);
    assert(typeof got !== "string", String(got));
    if (typeof got === "string") return;
    // Same subject as the unrelated root, but only the real one signs the chain.
    assertEquals(got.pem.trim(), (await Deno.readTextFile(`${dir}/root.pem`)).trim());
    assertStringIncludes(got.subject, "Test Root");
    assert(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/.test(got.fingerprint), got.fingerprint);
    await Deno.remove(`${dir}/certs`, { recursive: true });
    await Deno.mkdir(`${dir}/certs`);
    assertStringIncludes(
      String(await rootFor(chain, `${dir}/certs`)),
      "not among this machine's trusted roots",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
