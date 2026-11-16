/**
 * Spec 039's identities against a stand-in PostgreSQL (tests/host.ts: `ARCHON_ROOT`, `psql` and
 * `runuser` stand-ins): what a converge does to the roles an instance has.
 *
 * @module
 */
import { fs, path, proc, stdio } from "@intellectual-frontiers/commons/ts/runtime";
import {
  assert,
  assertEquals,
  assertStringIncludes,
  proves,
} from "@intellectual-frontiers/commons/ts/runtime/test";
import { resetRoots } from "../src/archon/core/paths.ts";
import { HOST_ROOT_SKIP, type HostRoot, hostRoot } from "./host.ts";
import { fleet, host } from "./fixtures.ts";
import { ENGINE_ROOT, linkEngine } from "./sandbox.ts";

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

// ------------------------------------------------------------- a stand-in PostgreSQL

/** The service account the fleet copy's app runs as, owner of its database. */
const APP = "s-app1";

/**
 * A host root with a fleet copy (the example lab, alpha with ip, PostgreSQL on, prime holding
 * app1 owned by s-app1 and written by alice) and a stateful stand-in PostgreSQL: the clusters
 * (`version name port status`) in /var/lib/postgresql/clusters, each cluster's statements in its
 * data.sql (what psql answers from, what pg_dumpall dumps, what pg_upgradecluster carries over),
 * a version's binaries as /usr/lib/postgresql/<v> (installed by apt-get, seen by dpkg-query).
 */
async function pgHost() {
  const h = await hostRoot();
  const saved = new Map<string, string | undefined>();
  const env = (k: string, v: string | undefined): void => {
    if (!saved.has(k)) saved.set(k, proc.env.get(k));
    if (v === undefined) proc.env.delete(k);
    else proc.env.set(k, v);
  };
  try {
    // The fleet copy, checked out where a host has it.
    const repo = h.at("/srv/archon");
    const lab = path.join(repo, "fleets", "lab");
    await fs.ensureDir(path.join(repo, "fleets"));
    await fs.copy(path.join(ENGINE_ROOT, "examples", "fleets", "lab"), lab);
    await linkEngine(repo);
    const edit = async (file: string, from: string, to: string): Promise<void> => {
      const text = await fs.readTextFile(path.join(lab, file));
      assert(text.includes(from), `${file} has ${from}`);
      await fs.writeTextFile(path.join(lab, file), text.replace(from, to));
    };
    await edit(
      "fleet.ts",
      "  admin: {",
      `  services: [{ name: "${APP}", uid: 850, description: "app one" }],\n  admin: {`,
    );
    await edit(
      "hosts/alpha/host.ts",
      `  spec: "004-install",`,
      `  ip: "10.0.30.57",
  pg: {
    instances: [
      { name: "prime", version: 18, databases: [{ name: "app1", owner: "${APP}", write: ["alice"] }] },
    ],
  },
  spec: "004-install",`,
    );
    env("ARCHON_REPO", repo);
    env("SUDO_USER", "alice");
    resetRoots();
    // PostgreSQL is on for alpha (spec 039's switch, in the host's archon.sql).
    const { writeState } = await import("../src/archon/pg/converge.ts");
    await writeState("alpha", { ...ON, data: "durable", instances: {} });

    const R = h.root;
    const C = h.at("/var/lib/postgresql/clusters");
    const has = String.raw`[ -f "${C}" ] && awk -v v="$v" -v n="$n" '$1==v && $2==n {f=1} END {exit !f}' "${C}"`;
    const online = String.raw`[ -f "${C}" ] && awk -v v="$v" -v n="$n" '$1==v && $2==n && $4=="online" {f=1} END {exit !f}' "${C}"`;
    const cluster = String.raw`v=$(echo "$c" | cut -d/ -f1); n=$(echo "$c" | cut -d/ -f2)`;
    await fs.ensureDir(h.at("/var/lib/postgresql"));
    await fs.ensureDir(h.at("/etc/apt/sources.list.d"));
    await h.standIn(
      "pg_lsclusters",
      String.raw`[ -f "${C}" ] || exit 0
while read -r v n p st; do echo "$v $n $p $st postgres /var/lib/postgresql/$v/$n /var/log/postgresql/postgresql-$v-$n.log"; done < "${C}"`,
    );
    await h.standIn(
      "pg_createcluster",
      String.raw`v=$1; n=$2; p=$4
[ -d "${R}/usr/lib/postgresql/$v" ] || { echo "Error: PostgreSQL $v is not installed" >&2; exit 1; }
if ${has}; then echo "Error: cluster configuration already exists" >&2; exit 1; fi
echo "$v $n $p online" >> "${C}"
mkdir -p "${R}/etc/postgresql/$v/$n/conf.d" "${R}/var/lib/postgresql/$v/$n"
printf '%s\n' "local all postgres peer" "host all all 127.0.0.1/32 scram-sha-256" > "${R}/etc/postgresql/$v/$n/pg_hba.conf"
: > "${R}/var/lib/postgresql/$v/$n/data.sql"`,
    );
    await h.standIn(
      "pg_ctlcluster",
      String.raw`v=$1; n=$2
${has} || { echo "Error: specified cluster '$v $n' does not exist" >&2; exit 1; }
case "$3" in start|restart) st=online;; stop) st=down;; *) exit 0;; esac
awk -v v="$v" -v n="$n" -v st="$st" '$1==v && $2==n {$4=st} {print}' "${C}" > "${C}.tmp" && mv "${C}.tmp" "${C}"`,
    );
    await h.standIn(
      "pg_upgradecluster",
      String.raw`N=$2; v=$5; n=$6
[ -d "${R}/usr/lib/postgresql/$N" ] || { echo "Error: PostgreSQL $N is not installed" >&2; exit 1; }
${has} || { echo "Error: specified cluster '$v $n' does not exist" >&2; exit 1; }
port=$(awk -v v="$v" -v n="$n" '$1==v && $2==n {print $3}' "${C}")
max=$(awk '$3>m {m=$3} END {print m}' "${C}")
awk -v v="$v" -v n="$n" -v p=$((max + 1)) '$1==v && $2==n {$3=p; $4="down"} {print}' "${C}" > "${C}.tmp" && mv "${C}.tmp" "${C}"
echo "$N $n $port online" >> "${C}"
mkdir -p "${R}/etc/postgresql/$N/$n" "${R}/var/lib/postgresql/$N/$n"
cp -R "${R}/etc/postgresql/$v/$n/." "${R}/etc/postgresql/$N/$n/"
cp "${R}/var/lib/postgresql/$v/$n/data.sql" "${R}/var/lib/postgresql/$N/$n/data.sql"`,
    );
    await h.standIn(
      "pg_dropcluster",
      String.raw`v=$2; n=$3
${has} || { echo "Error: specified cluster '$v $n' does not exist" >&2; exit 1; }
awk -v v="$v" -v n="$n" '!($1==v && $2==n)' "${C}" > "${C}.tmp" && mv "${C}.tmp" "${C}"
rm -rf "${R}/etc/postgresql/$v/$n" "${R}/var/lib/postgresql/$v/$n"`,
    );
    await h.standIn(
      "pg_dumpall",
      String.raw`c=$2; ${cluster}
${online} || { echo "pg_dumpall: error: connection to server failed" >&2; exit 1; }
echo "-- PostgreSQL database cluster dump of $v/$n ($3 $4)"
cat "${R}/var/lib/postgresql/$v/$n/data.sql"`,
    );
    await h.standIn(
      "pg_isready",
      String.raw`while [ $# -gt 0 ]; do [ "$1" = -p ] && p=$2; shift; done
[ -f "${C}" ] && awk -v p="$p" '$3==p && $4=="online" {f=1} END {exit !f}' "${C}" || exit 2`,
    );
    await h.standIn(
      "psql",
      String.raw`c=$2; ${cluster}
${online} || { echo "psql: error: connection to server on socket \"/var/run/postgresql/.s.PGSQL\" failed: No such file or directory" >&2; exit 2; }
sep='|'; while [ $# -gt 0 ]; do [ "$1" = -F ] && sep=$2; shift; done
D="${R}/var/lib/postgresql/$v/$n/data.sql"
in=$(cat)
who=$(printf '%s\n' "$in" | sed -n "s/.*rolname = '\([^']*\)'.*/\1/p" | head -n 1)
case "$in" in
  *"FROM pg_roles r WHERE"*) awk -v s="$sep" '
    function nm() { match($0, /ROLE "[^"]*"/); return substr($0, RSTART + 6, RLENGTH - 7) }
    /CREATE ROLE "/ { r = nm(); if (!(r in login)) { order[++k] = r; login[r] = ($0 ~ / LOGIN/) ? "t" : "f" } }
    /ALTER ROLE "[^"]*" LOGIN/ { login[nm()] = "t" }
    /ALTER ROLE "[^"]*" NOLOGIN/ { login[nm()] = "f" }
    /COMMENT ON ROLE "/ { r = nm(); c = $0; sub(/^[^'\'']*'\''/, "", c); sub(/'\''.*$/, "", c); comment[r] = c }
    END { for (i = 1; i <= k; i++) print order[i] s login[order[i]] s "f" s comment[order[i]] }' "$D";;
  *"rolpassword IS NOT NULL"*) awk -v w="$who" '
    index($0, "ALTER ROLE \"" w "\" PASSWORD NULL") == 1 { p = 0; next }
    index($0, "ALTER ROLE \"" w "\" PASSWORD '\''") == 1 { p = 1 }
    END { print (p ? "t" : "f") }' "$D";;
  *"FROM pg_auth_members"*) awk -v w="$who" '
    index($0, "GRANT \"" w "\" TO \"") == 1 { m = $0; sub(/^[^"]*"[^"]*" TO "/, "", m); sub(/".*$/, "", m); if (!(m in in_)) { in_[m] = 1; order[++k] = m } }
    index($0, "REVOKE \"" w "\" FROM \"") == 1 { m = $0; sub(/^[^"]*"[^"]*" FROM "/, "", m); sub(/".*$/, "", m); delete in_[m] }
    END { for (i = 1; i <= k; i++) if (order[i] in in_) print order[i] }' "$D";;
  *"FROM pg_database"*) echo postgres; sed -n 's/^CREATE DATABASE "\([^"]*\)".*/\1/p' "$D";;
  *) printf '%s\n' "$in" >> "$D";;
esac`,
    );
    await h.standIn(
      "runuser",
      String.raw`while [ "$1" != "--" ]; do shift; done; shift; exec "$@"`,
    );
    await h.standIn(
      "zstd",
      String.raw`case "$1" in
  -dc) cat "$2";;
  *) while [ $# -gt 1 ]; do [ "$1" = -o ] && o=$2; shift; done; cat > "$o";;
esac`,
    );
    await h.standIn(
      "dpkg-query",
      String.raw`for a in "$@"; do case "$a" in postgresql-[0-9]*) [ -d "${R}/usr/lib/postgresql/$(echo "$a" | cut -d- -f2)" ] && printf 'ii ';; esac; done`,
    );
    await h.standIn(
      "apt-get",
      String.raw`[ "$1" = install ] || exit 0
for a in "$@"; do case "$a" in postgresql-[0-9]*) mkdir -p "${R}/usr/lib/postgresql/$(echo "$a" | cut -d- -f2)";; esac; done`,
    );
    await h.standIn("ss");
    // What an apply's Files phase checks its files with (publish applies files and databases).
    for (const p of ["postfix", "testparm", "sshd", "mandb"]) await h.standIn(p);
    await h.standIn(
      "getent",
      String.raw`case "$1 $2" in
  "passwd alice") echo "alice:x:1000:1000:Alice Example:/home/alice:/bin/bash";;
  "passwd ${APP}") echo "${APP}:x:850:850:app one:/var/lib/${APP}:/usr/sbin/nologin";;
  "passwd ") echo "alice:x:1000:1000:Alice Example:/home/alice:/bin/bash"; echo "${APP}:x:850:850:app one:/var/lib/${APP}:/usr/sbin/nologin";;
  *) exit 2;;
esac`,
    );
    await h.standIn(
      "id",
      String.raw`u=$2; [ -n "$u" ] || u=$USER
case "$u" in alice) echo "alice sudo archon-ops";; *) echo "$u";; esac`,
    );
  } catch (e) {
    await h.restore();
    throw e;
  }
  const C = h.at("/var/lib/postgresql/clusters");
  return {
    h,
    env,
    /** The clusters as pg_lsclusters has them: `version name port status`, sorted. */
    clusters: async (): Promise<string[]> =>
      ((await fs.readTextOr(C)) ?? "")
        .split("\n")
        .filter((l) => l !== "")
        .sort(),
    /** What a cluster was given (its stand-in data). */
    data: async (v: number, n: string): Promise<string> =>
      (await fs.readTextOr(h.at(`/var/lib/postgresql/${v}/${n}/data.sql`))) ?? "",
    /** The fleet copy's spec 038 (where the owner's approve marker goes). */
    approve: async (): Promise<void> => {
      const spec = h.at("/srv/archon/fleets/lab/specs/038-pg/spec.md");
      await fs.ensureDir(path.dirname(spec));
      await fs.writeTextFile(spec, "# 038-pg (this fleet's decisions)\n\napprove: destructive\n");
    },
    restore: async (): Promise<void> => {
      for (const [k, v] of saved) {
        if (v === undefined) proc.env.delete(k);
        else proc.env.set(k, v);
      }
      await h.restore();
    },
  };
}

/** A command's exit code and what it wrote to standard output and standard error. */
async function outOf(
  f: () => Promise<number>,
): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const [o, e] = [
    stdio.stdout.writeSync.bind(stdio.stdout),
    stdio.stderr.writeSync.bind(stdio.stderr),
  ];
  const take =
    (into: string[]) =>
    (d: Uint8Array | string): number => {
      into.push(typeof d === "string" ? d : new TextDecoder().decode(d));
      return d.length;
    };
  stdio.stdout.writeSync = take(out);
  stdio.stderr.writeSync = take(err);
  try {
    const code = await f();
    return { code, out: out.join(""), err: err.join("") };
  } finally {
    stdio.stdout.writeSync = o;
    stdio.stderr.writeSync = e;
  }
}

/** A JSON document's field, decoded: tests read the stable JSON the commands print. */
function doc(text: string): Record<string, unknown> {
  const v: unknown = JSON.parse(text);
  assert(typeof v === "object" && v !== null && !Array.isArray(v), text);
  return v as Record<string, unknown>;
}

/** The calls recorded since `from`, as `name arg ...`. */
async function callsSince(h: HostRoot, from: number): Promise<string[]> {
  return (await h.calls()).slice(from);
}

proves(
  ["038-pg FR-007", "038-pg FR-005"],
  "038: ensure creates and configures each instance as the model says, is idempotent, records one not in the model, refuses another version, and answers without elevating once online",
  async () => {
    const t = await pgHost();
    const { h } = t;
    try {
      const pg = await import("../src/archon/pg/commands.ts");
      const cfg = await import("../src/archon/pg/config.ts");
      const { readState } = await import("../src/archon/pg/converge.ts");
      const { loadFleet, loadHosts, usersFor } = await import("../src/archon/model/load.ts");

      // prime, as the model says: PostgreSQL 18 from Ubuntu, the first free port, created once.
      let r = await outOf(() => pg.pgEnsure("alpha", "prime", undefined, true));
      assertEquals(r.code, 0, r.out + r.err);
      const first = doc(r.out);
      assertEquals(
        [first["ok"], first["name"], first["version"], first["port"], first["status"]],
        [true, "prime", 18, 5432, "online"],
      );
      assertEquals([first["unit"], first["created"]], ["postgresql@18-prime.service", true]);
      assertEquals(await t.clusters(), ["18 prime 5432 online"]);
      const calls = await h.calls();
      assert(
        calls.includes(
          "pg_createcluster 18 prime --port 5432 --start -- --auth-local=peer --auth-host=scram-sha-256 --data-checksums",
        ),
        calls.join("\n"),
      );
      // Ubuntu's own package (no PGDG for 18), never a main cluster.
      assert(calls.includes("apt-get install -y --no-install-recommends postgresql-18"));
      assert(!calls.some((c) => c.startsWith("apt-get update")), "no PGDG for Ubuntu's 18");
      assertStringIncludes(
        await fs.readTextFile(h.at(cfg.PG.createclusterConf)),
        "create_main_cluster = false",
      );
      assert(!(await fs.exists(h.at(cfg.PG.pgdgSource))), "no PGDG source for 18");
      // Archon's configuration and pg_hba.conf, exactly as rendered from the model.
      const fleet = await loadFleet();
      const alpha = (await loadHosts()).find((x) => x.name === "alpha");
      assert(alpha !== undefined);
      const prime = cfg
        .instancesOf(alpha, usersFor(fleet, alpha), fleet)
        .find((i) => i.name === "prime");
      assert(prime !== undefined);
      assertEquals(
        await fs.readTextFile(h.at("/etc/postgresql/18/prime/conf.d/50-archon.conf")),
        cfg.archonConf(prime, { address: alpha.ip, tls: undefined }),
      );
      assertEquals(
        await fs.readTextFile(h.at("/etc/postgresql/18/prime/pg_hba.conf")),
        cfg.hbaConf(false, cfg.ANYWHERE),
      );
      assert(calls.includes("pg_ctlcluster 18 prime restart"), "listen_addresses: a restart");
      // Its roles, its database owned by the service, alice writing, the service's password.
      const sql = await t.data(18, "prime");
      assertStringIncludes(sql, `CREATE ROLE "alice" LOGIN NOSUPERUSER CREATEDB`);
      assertStringIncludes(sql, `CREATE ROLE "${APP}" LOGIN NOSUPERUSER NOCREATEDB`);
      assertStringIncludes(sql, `CREATE DATABASE "app1" OWNER "${APP}"`);
      assertStringIncludes(sql, `GRANT "app1_rw" TO "alice";`);
      assertStringIncludes(sql, `ALTER ROLE "${APP}" PASSWORD 'SCRAM-SHA-256$4096:`);
      const secret = h.at(`/var/lib/archon-keys/pg/prime/${APP}`);
      assertEquals(((await fs.stat(secret)).mode ?? 0) & 0o777, 0o400);
      assert(calls.includes(`chown ${APP}:root ${secret}`), "owned by the service account");
      // Recorded on the host (version, port, when, by whom).
      const rec = (await readState("alpha")).instances["prime"];
      assertEquals([rec?.version, rec?.port, rec?.by], [18, 5432, "alice"]);
      assertEquals(typeof rec?.created, "string");

      // Idempotent: again, nothing created, nothing changed, no restart.
      let from = (await h.calls()).length;
      r = await outOf(() => pg.pgEnsure("alpha", "prime", undefined, true));
      assertEquals(r.code, 0, r.out + r.err);
      const again = doc(r.out);
      assertEquals([again["created"], again["changes"], again["port"]], [false, [], 5432]);
      const later = await callsSince(h, from);
      assert(
        !later.some((c) => /^(pg_createcluster|pg_ctlcluster|apt-get)\b/.test(c)),
        later.join("\n"),
      );
      assertEquals(await t.clusters(), ["18 prime 5432 online"]);

      // Another --version than the instance has: refused, with the upgrade command.
      from = (await h.calls()).length;
      r = await outOf(() => pg.pgEnsure("alpha", "prime", "17", true));
      assertEquals(r.code, 1);
      assertEquals(doc(r.out), {
        ok: false,
        error: "prime is PostgreSQL 18; to move it to 17, run archon pg upgrade prime --to 17.",
      });
      assertEquals(await callsSince(h, from), [], "refused before anything ran");

      // Not in the model: the operator's ensure creates it (PGDG for 17, Ubuntu's key) and
      // records it, so it is an instance of the host from then on.
      await fs.ensureDir(path.dirname(h.at(cfg.PG.pgdgKey)));
      await fs.writeTextFile(h.at(cfg.PG.pgdgKey), "-----BEGIN PGP PUBLIC KEY BLOCK-----\n");
      r = await outOf(() => pg.pgEnsure("alpha", "lab", "17", true));
      assertEquals(r.code, 0, r.out + r.err);
      const lab = doc(r.out);
      assertEquals([lab["version"], lab["port"], lab["created"]], [17, 5433, true]);
      assertEquals(await t.clusters(), ["17 lab 5433 online", "18 prime 5432 online"]);
      assertEquals(
        await fs.readTextFile(h.at(cfg.PG.pgdgSource)),
        cfg.pgdgSource(fleet.ubuntu.codename, alpha.arch),
      );
      const st = await readState("alpha");
      assertEquals([st.instances["lab"]?.version, st.instances["lab"]?.by], [17, "alice"]);
      const hosts = await loadHosts();
      const alpha2 = hosts.find((x) => x.name === "alpha");
      assert(alpha2 !== undefined);
      const kept = cfg.instancesOf(alpha2, usersFor(fleet, alpha2), fleet);
      assertEquals(
        kept.map((i) => [i.name, i.version, i.port, i.inModel]),
        [
          ["lab", 17, 5433, false],
          ["prime", 18, 5432, true],
        ],
      );

      // The precheck: Archon's and online, so ensure answers without elevating (no sudo, no
      // change), as an ordinary account.
      const { COMMANDS } = await import("../src/archon/commands/registry.ts");
      const ensure = COMMANDS.find((c) => c.name === "pg ensure");
      assert(ensure?.precheck !== undefined, "pg ensure has a precheck");
      t.env("USER", APP);
      t.env("SUDO_USER", undefined);
      from = (await h.calls()).length;
      r = await outOf(async () => {
        const done = await ensure.precheck?.(
          { name: "prime" },
          { hostName: "alpha", json: true, verbose: false },
        );
        return done ?? -1;
      });
      assertEquals(r.code, 0, r.out + r.err);
      assertEquals(doc(r.out)["status"], "online");
      assertEquals(
        (await callsSince(h, from)).filter((c) => !c.startsWith("pg_lsclusters")),
        [],
        "the precheck only reads",
      );
    } finally {
      await t.restore();
    }
  },
  { skip: HOST_ROOT_SKIP, timeout: 180_000 },
);

proves(
  ["038-pg FR-008", "038-pg FR-009", "038-pg FR-020", "038-pg FR-021"],
  "038: upgrade dumps, installs, runs pg_upgradecluster and keeps the old cluster retired; remove dumps, drops, and forgets; both only with the owner's marker and the name repeated; every create, publish, unpublish, upgrade, and remove journaled and mailed",
  async () => {
    const t = await pgHost();
    const { h } = t;
    try {
      const pg = await import("../src/archon/pg/commands.ts");
      const cfg = await import("../src/archon/pg/config.ts");
      const { readState } = await import("../src/archon/pg/converge.ts");
      const { localSite } = await import("../src/archon/notify/events.ts");
      await fs.ensureDir(path.dirname(h.at(cfg.PG.pgdgKey)));
      await fs.writeTextFile(h.at(cfg.PG.pgdgKey), "-----BEGIN PGP PUBLIC KEY BLOCK-----\n");
      // The journal (tag archon-pg) and the fleet's mailbox (the host's spool, to its address).
      assertEquals((await localSite())?.to, "fleet@example.net");
      const journaled = async (line: string): Promise<boolean> =>
        (await h.calls()).includes(`logger -t archon-pg -p user.info ${line}`);
      const mailed = async (event: string): Promise<string> => {
        const m = (await h.spool()).filter((q) => q.subject === `[Archon] alpha: ${event}`);
        assertEquals(m.length, 1, `one message: ${event}`);
        return m[0]?.text ?? "";
      };

      // Create: prime (the model's) and lab (PostgreSQL 16, recorded by the operator).
      assertEquals((await outOf(() => pg.pgEnsure("alpha", "prime", undefined, true))).code, 0);
      assertEquals((await outOf(() => pg.pgEnsure("alpha", "lab", "16", true))).code, 0);
      assert(await journaled("instance prime (PostgreSQL 18, port 5432) created by alice"));
      assert(await journaled("instance lab (PostgreSQL 16, port 5433) created by alice"));
      assertEquals(
        (await h.spool()).filter((q) => q.subject === "[Archon] alpha: PostgreSQL instance created")
          .length,
        2,
      );
      assertEquals(await t.clusters(), ["16 lab 5433 online", "18 prime 5432 online"]);

      // Publish and unpublish: recorded, applied, journaled, mailed.
      const { ui } = await import("../src/archon/core/ui.ts");
      let r = await outOf(() => pg.pgPublish("alpha", "prime", true));
      assertEquals(r.code, 0, r.out + r.err + JSON.stringify(ui.problems));
      assert((await readState("alpha")).instances["prime"]?.published !== undefined);
      assertStringIncludes(
        await fs.readTextFile(h.at("/etc/postgresql/18/prime/pg_hba.conf")),
        "hostssl",
      );
      assert(await journaled("publish prime by alice"));
      assertStringIncludes(
        await mailed("PostgreSQL instance published"),
        "published prime on alpha at pg-prime.alpha.lab.example.net, port 5432",
      );
      r = await outOf(() => pg.pgPublish("alpha", "prime", false));
      assertEquals(r.code, 0, r.out + r.err);
      assertEquals((await readState("alpha")).instances["prime"]?.published, undefined);
      assert(await journaled("unpublish prime by alice"));
      assertStringIncludes(await mailed("PostgreSQL instance made private"), "private again");

      // The guard (FR-020): no marker in the fleet's spec 038, or the name not repeated: refused,
      // and nothing runs.
      const untouched = async (what: () => Promise<number>, says: string): Promise<void> => {
        const from = (await h.calls()).length;
        const before = await t.clusters();
        const res = await outOf(what);
        assertEquals(res.code, 1, res.out);
        assertStringIncludes(res.err, says);
        const ran = await callsSince(h, from);
        assert(
          !ran.some((c) => /pg_dumpall|pg_upgradecluster|pg_dropcluster|apt-get/.test(c)),
          ran.join("\n"),
        );
        assertEquals(await t.clusters(), before);
      };
      const noMarker = `has no "approve: destructive" line`;
      await untouched(() => pg.pgUpgrade("alpha", "lab", "17", "lab"), noMarker);
      await untouched(() => pg.pgRemove("alpha", "lab", undefined, "lab"), noMarker);
      await untouched(() => pg.pgRestore("alpha", "lab", undefined, "lab"), noMarker);
      await t.approve();
      const repeat = "repeat the instance's name with --confirm-destroy lab";
      await untouched(() => pg.pgUpgrade("alpha", "lab", "17", undefined), repeat);
      await untouched(() => pg.pgUpgrade("alpha", "lab", "17", "prime"), repeat);
      await untouched(() => pg.pgRemove("alpha", "lab", undefined, undefined), repeat);
      await untouched(
        () => pg.pgUpgrade("alpha", "lab", "16", "lab"),
        "lab is already PostgreSQL 16; --to must be newer.",
      );

      // Upgrade (FR-008): a dump first, then PostgreSQL 17 installed, then pg_upgradecluster.
      let from = (await h.calls()).length;
      r = await outOf(() => pg.pgUpgrade("alpha", "lab", "17", "lab"));
      assertEquals(r.code, 0, r.out + r.err);
      const ran = await callsSince(h, from);
      const at = (p: RegExp): number => ran.findIndex((c) => p.test(c));
      const dumped = at(
        /^runuser -u postgres -- pg_dumpall --cluster 16\/lab --clean --if-exists$/,
      );
      const installed = at(/^apt-get install -y --no-install-recommends postgresql-17$/);
      const upgraded = at(/^pg_upgradecluster -v 17 -m upgrade 16 lab$/);
      assert(dumped >= 0 && dumped < installed && installed < upgraded, ran.join("\n"));
      const dumps = await fs.listFiles(h.at("/var/backups/archon/pg/lab"), ".sql.zst");
      assertEquals(dumps.length, 1);
      const dump = h.at(`/var/backups/archon/pg/lab/${dumps[0] ?? ""}`);
      assertEquals(((await fs.stat(dump)).mode ?? 0) & 0o777, 0o600);
      assertStringIncludes(
        await fs.readTextFile(dump),
        "-- PostgreSQL database cluster dump of 16/lab (--clean --if-exists)",
      );
      assertStringIncludes(r.out, `lab: backed up to /var/backups/archon/pg/lab/${dumps[0] ?? ""}`);
      // The new version and port recorded; the old cluster kept, stopped, retired.
      let rec = (await readState("alpha")).instances["lab"];
      assertEquals([rec?.version, rec?.port, rec?.retired], [17, 5433, [16]]);
      assertEquals(await t.clusters(), [
        "16 lab 5434 down",
        "17 lab 5433 online",
        "18 prime 5432 online",
      ]);
      assert(await journaled("upgrade lab 16 -> 17 by alice"));
      assertStringIncludes(
        await mailed("PostgreSQL instance upgraded"),
        "The old cluster is kept, stopped, until archon pg remove lab --version 16.",
      );

      // Remove (FR-009): an instance still in the model is refused; --version takes only a
      // retired cluster.
      await untouched(
        () => pg.pgRemove("alpha", "prime", undefined, "prime"),
        "prime is in the model",
      );
      await untouched(
        () => pg.pgRemove("alpha", "lab", "15", "lab"),
        "lab has no PostgreSQL 15 cluster that Archon made.",
      );
      r = await outOf(() => pg.pgRemove("alpha", "lab", "16", "lab"));
      assertEquals(r.code, 0, r.out + r.err);
      assertEquals(await t.clusters(), ["17 lab 5433 online", "18 prime 5432 online"]);
      rec = (await readState("alpha")).instances["lab"];
      assertEquals([rec?.version, rec?.retired], [17, []]);
      assert(await journaled("remove 16/lab by alice"));
      await mailed("PostgreSQL instance removed");
      // The whole instance: a dump first, pg_dropcluster --stop, the record and passwords gone.
      const secrets = h.at("/var/lib/archon-keys/pg/lab");
      await fs.ensureDir(secrets);
      await fs.writeTextFile(path.join(secrets, "s-old"), "not a real password\n");
      from = (await h.calls()).length;
      r = await outOf(() => pg.pgRemove("alpha", "lab", undefined, "lab"));
      assertEquals(r.code, 0, r.out + r.err);
      const gone = await callsSince(h, from);
      const d = gone.findIndex((c) => c.includes("pg_dumpall --cluster 17/lab"));
      const drop = gone.indexOf("pg_dropcluster --stop 17 lab");
      assert(d >= 0 && d < drop, gone.join("\n"));
      assertEquals(await t.clusters(), ["18 prime 5432 online"]);
      assertEquals((await readState("alpha")).instances["lab"], undefined);
      assert(!(await fs.exists(secrets)), "its passwords are gone");
      assertEquals(
        (await fs.listFiles(h.at("/var/backups/archon/pg/lab"), ".sql.zst")).length,
        2,
        "the last dump is kept",
      );
      assert(await journaled("remove 17/lab by alice"));
      const removed = (await h.spool()).filter(
        (q) => q.subject === "[Archon] alpha: PostgreSQL instance removed",
      );
      assertEquals(removed.length, 2);
      assertStringIncludes(removed[1]?.text ?? "", "removed 17/lab on alpha. Its last dump:");
    } finally {
      await t.restore();
    }
  },
  { skip: HOST_ROOT_SKIP, timeout: 180_000 },
);

proves(
  ["039-pg-identity FR-013"],
  "039: the app contract as the app's service account: ensure --json answers without sudo while prime runs; connect --write --json writes the socket service, no password; then service=prime",
  async () => {
    const t = await pgHost();
    const { h } = t;
    try {
      const pg = await import("../src/archon/pg/commands.ts");
      const cfg = await import("../src/archon/pg/config.ts");
      // An operator made prime (the model's, with app1 owned by the service).
      assertEquals((await outOf(() => pg.pgEnsure("alpha", "prime", undefined, true))).code, 0);
      // From here on the app's own account: not root's, not in sudo, its own home.
      const home = h.at(`/var/lib/${APP}`);
      await fs.ensureDir(home);
      t.env("USER", APP);
      t.env("LOGNAME", APP);
      t.env("HOME", home);
      t.env("SUDO_USER", undefined);
      const { COMMANDS } = await import("../src/archon/commands/registry.ts");
      const ensure = COMMANDS.find((c) => c.name === "pg ensure");
      assert(ensure?.precheck !== undefined);
      const precheck = (): Promise<number> =>
        ensure
          .precheck?.({ name: "prime" }, { hostName: "alpha", json: true, verbose: false })
          .then((c) => c ?? -1) ?? Promise.resolve(-1);

      // 1. archon pg ensure prime --json: exit 0, the documented document, no sudo, nothing run
      // but a look at the clusters.
      let from = (await h.calls()).length;
      let r = await outOf(precheck);
      assertEquals(r.code, 0, r.out + r.err);
      assertEquals(doc(r.out), {
        ok: true,
        name: "prime",
        version: 18,
        port: 5432,
        status: "online",
        unit: "postgresql@18-prime.service",
        created: false,
        changes: [],
      });
      assertEquals(await callsSince(h, from), ["pg_lsclusters --no-header"]);

      // 2. archon pg connect prime --write --json: the socket service as itself, no password.
      from = (await h.calls()).length;
      r = await outOf(() => pg.pgConnect("alpha", "prime", true, false, true));
      assertEquals(r.code, 0, r.out + r.err);
      const service = path.join(home, ".pg_service.conf");
      assertEquals(doc(r.out), {
        ok: true,
        service: "prime",
        host: "/var/run/postgresql",
        port: 5432,
        user: APP,
        database: "app1",
        sslmode: "disable",
        files: { service },
      });
      const ran = await callsSince(h, from);
      assert(!ran.some((c) => /^(sudo|runuser|psql)\b/.test(c)), ran.join("\n"));
      assertEquals(((await fs.stat(service)).mode ?? 0) & 0o777, 0o600);
      const text = await fs.readTextFile(service);
      assertEquals(
        text.trim(),
        cfg
          .serviceBlock({
            service: "prime",
            host: "/var/run/postgresql",
            port: 5432,
            user: APP,
            database: "app1",
            sslmode: "disable",
          })
          .trim(),
      );
      assert(!(await fs.exists(path.join(home, ".pgpass"))), "no password on the server");
      const secret = (await fs.readTextFile(h.at(`/var/lib/archon-keys/pg/prime/${APP}`))).trim();
      assert(!r.out.includes(secret) && !text.includes(secret), "the password is never printed");

      // 3. service=prime: the block libpq reads names this account, its database, the socket.
      for (const line of ["[prime]", "host=/var/run/postgresql", "port=5432", "dbname=app1"]) {
        assert(text.split("\n").includes(line), `${line} in\n${text}`);
      }
      assert(text.split("\n").includes(`user=${APP}`));

      // Stopped: one plain sentence (as JSON), exit 1, never a sudo prompt.
      await h.standIn("sudo", "exit 1");
      t.env("SUDO_USER", "alice"); // an operator stops it
      assertEquals((await outOf(() => pg.pgControl("alpha", "prime", "stop"))).code, 0);
      t.env("SUDO_USER", undefined);
      from = (await h.calls()).length;
      r = await outOf(precheck);
      assertEquals(r.code, 1);
      assertEquals(doc(r.out), {
        ok: false,
        error: "prime is not running on alpha yet: an operator runs archon pg ensure prime.",
      });
      assert(!(await callsSince(h, from)).some((c) => c.startsWith("sudo")));
    } finally {
      await t.restore();
    }
  },
  { skip: HOST_ROOT_SKIP, timeout: 180_000 },
);
