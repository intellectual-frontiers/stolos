/**
 * 038-pg, 039-pg-identity: make each instance what the model and the host's record say. Run by
 * every apply (its Databases phase, so the reconcile timer keeps instances) and
 * by archon pg ensure. Archon touches only clusters it created (FR-003).
 *
 * @module
 */

import { errors, fs, path as paths } from "@intellectual-frontiers/ifc-ts/runtime";
import { getRecord, putRecord } from "../state/store.ts";
import { onHost, P } from "../core/paths.ts";
import { run, type RunResult } from "../core/exec.ts";
import type { FleetDef, HostDef, PgRecord, PgState } from "../model/types.ts";
import {
  allocatePort,
  ANYWHERE,
  archonConf,
  type Cluster,
  createArgv,
  createDatabaseSql,
  databaseAccessSql,
  desiredMembers,
  extensionSql,
  groupRoleSql,
  hbaConf,
  type Instance,
  membershipSql,
  newPassword,
  ownership,
  parseClusters,
  PG,
  pgdgSource,
  principals,
  publishedName,
  quoteLit,
  roleSql,
  schemaAccessSql,
  scramVerifier,
  systemServices,
} from "./config.ts";
import { ACME_STORE } from "../web/acme.ts";

/** Where converge reports (apply's Runner, or a command's phase). */
export interface Sink {
  /** A read-only check: report what would change, change nothing. */
  check: boolean;
  /** Report a change made (or, in a check, one that would be made). */
  change(msg: string): void;
  /** Report a problem that does not stop converge, with an optional fix to suggest. */
  warn(msg: string, fix?: string): void;
  /** Report a failure, with an optional fix to suggest. */
  fail(msg: string, fix?: string): void;
  /** A read-only check could not read this file as the calling user. */
  unreadable?(path: string): void;
}

/**
 * A host file's text (`path` as the host names it, read through `onHost`), undefined when
 * missing, or null when a read-only check runs as someone who may not read it (pg_hba.conf is
 * postgres-only, as Ubuntu makes it; Traefik's store and private keys too): then it is not compared.
 */
async function readFor(s: Sink, path: string): Promise<string | undefined | null> {
  try {
    return await fs.readTextOr(onHost(path));
  } catch (e) {
    if (e instanceof errors.PermissionDenied && s.check) {
      s.unreadable?.(path);
      return null;
    }
    throw e;
  }
}

/** The host's PostgreSQL clusters, from pg_lsclusters (empty when it fails). */
export async function clusters(): Promise<Cluster[]> {
  const r = await run(["pg_lsclusters", "--no-header"]);
  return r.ok ? parseClusters(r.stdout) : [];
}

const confDir = (v: number, n: string) => `/etc/postgresql/${v}/${n}`;
/** Where a role's password for an instance is kept, under {@link PG}.secrets (as the host names it: read and write it through `onHost`). */
export const secretPath = (inst: string, role: string): string =>
  paths.join(PG.secrets, inst, role);

/** psql as postgres against one cluster (Debian's wrapper picks it by --cluster). */
export function psql(v: number, n: string, sql: string, db = "postgres"): Promise<RunResult> {
  return run(
    ["psql", "--cluster", `${v}/${n}`, "-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-d", db],
    { asUser: "postgres", stdin: sql },
  );
}

// ------------------------------------------------------------- the record

// Spec 048: the record is the opt-in "pg" in this machine's archon.sql.
/** Read the host's pg record (the switch and the instances); no instances when there is none. */
export async function readState(host: string, root = P.state): Promise<PgState> {
  const s = (await getRecord<PgState>(host, "optin", "pg", root))?.body;
  // The switch alone (archon pg on, before any instance exists) is a record too.
  return s && typeof s === "object" ? { ...s, instances: s.instances ?? {} } : { instances: {} };
}

/** Write the whole record (the switch and the instances), sorted. */
export async function writeState(host: string, st: PgState, root = P.state): Promise<void> {
  const sorted: PgState = {
    ...(typeof st.enabled === "boolean"
      ? { enabled: st.enabled, by: st.by, at: st.at, ...(st.data ? { data: st.data } : {}) }
      : {}),
    instances: Object.fromEntries(
      Object.entries(st.instances).sort(([a], [b]) => a.localeCompare(b)),
    ),
  };
  await putRecord(host, "optin", "pg", sorted, root);
}

/** Set one instance's record, or remove it when `rec` is undefined. */
export async function writeRecord(
  host: string,
  name: string,
  rec: PgRecord | undefined,
  root = P.state,
): Promise<void> {
  const s = await readState(host, root);
  if (rec) s.instances[name] = rec;
  else delete s.instances[name];
  await writeState(host, s, root);
}

// ------------------------------------------------------------- packages

async function hasPackage(name: string): Promise<boolean> {
  return (await run(["dpkg-query", "-W", "-f=${db:Status-Abbrev}", name])).stdout.trim() === "ii";
}

/** postgresql-<v>: Ubuntu's for 18, PGDG's (Ubuntu's own key) for the others. */
export async function ensureVersion(
  fleet: FleetDef,
  host: HostDef,
  v: number,
  s: Sink,
): Promise<boolean> {
  if (await hasPackage(`postgresql-${v}`)) return true;
  s.change(`install postgresql-${v}${v === PG.ubuntuVersion ? "" : " (PGDG)"}`);
  if (s.check) return true;
  // Never a `main` cluster Archon does not own (Ubuntu's package makes one on install).
  await fs.ensureDir(paths.dirname(onHost(PG.createclusterConf)));
  await fs.writeTextFile(
    onHost(PG.createclusterConf),
    "# Rendered by archon from spec 038-pg. Do not edit.\ncreate_main_cluster = false\n",
  );
  if (v !== PG.ubuntuVersion) {
    if (!(await fs.exists(onHost(PG.pgdgKey)))) {
      s.fail(
        `PostgreSQL ${v} comes from PGDG, whose key Ubuntu's postgresql-common provides, and it is not installed.`,
        "sudo archon apply",
      );
      return false;
    }
    const src = pgdgSource(fleet.ubuntu.codename, host.arch);
    if ((await fs.readTextOr(onHost(PG.pgdgSource))) !== src) {
      await fs.writeTextFile(onHost(PG.pgdgSource), src);
    }
    const u = await run(["apt-get", "update", "-o", "Acquire::Retries=3"]);
    if (!u.ok) {
      s.fail(
        `apt-get update failed with the PGDG repository: ${u.stderr.trim().split("\n").pop()}`,
      );
      return false;
    }
  }
  const r = await run(["apt-get", "install", "-y", "--no-install-recommends", `postgresql-${v}`], {
    env: { DEBIAN_FRONTEND: "noninteractive" },
  });
  if (!r.ok) {
    s.fail(
      `PostgreSQL ${v} could not be installed: ${
        v === PG.ubuntuVersion
          ? ""
          : `PGDG may not publish it for Ubuntu ${fleet.ubuntu.release} yet. `
      }${r.stderr.trim().split("\n").pop()}`,
    );
    return false;
  }
  return true;
}

// ------------------------------------------------------------- TLS

/**
 * The server's wildcard certificate from Traefik's store (spec 032), for a
 * published instance: libpq clients verify pg-<name>.<host>.<domain> with
 * sslrootcert=system. Undefined when there is none yet.
 */
export function wildcardFrom(
  acme: string,
  fqdn: string,
): { cert: string; key: string } | undefined {
  try {
    const store = JSON.parse(acme) as Record<
      string,
      {
        Certificates?: Array<{
          domain?: { main?: string; sans?: string[] };
          certificate?: string;
          key?: string;
        }>;
      } | null
    >;
    for (const r of Object.values(store ?? {})) {
      for (const c of r?.Certificates ?? []) {
        const names = [c.domain?.main, ...(c.domain?.sans ?? [])];
        if (names.includes(`*.${fqdn}`) && c.certificate && c.key) {
          return { cert: atob(c.certificate), key: atob(c.key) };
        }
      }
    }
  } catch {
    /* no store yet */
  }
  return undefined;
}

/** Write a host file (`path` as the host names it, written through `onHost`), with its mode and owner. */
async function writeOwned(path: string, content: string, mode: number, owner = "postgres") {
  const at = onHost(path);
  await fs.ensureDir(paths.dirname(at));
  await fs.writeTextFile(at, content, { mode });
  await fs.chmod(at, mode);
  await run(["chown", `${owner}:${owner === "root" ? "root" : "postgres"}`, at]);
}

// ------------------------------------------------------------- converge

/**
 * Make one instance right. Returns false on a failure (reported to the sink).
 * by: who asked (recorded when the cluster is created).
 */
export async function convergeInstance(
  fleet: FleetDef,
  host: HostDef,
  inst: Instance,
  s: Sink,
  by: string,
): Promise<boolean> {
  const all = await clusters();
  const own = ownership(inst, all);
  if (own.kind === "foreign") {
    s.fail(
      `A cluster named ${inst.name} (PostgreSQL ${own.cluster.version}, port ${own.cluster.port}) exists but Archon did not create it, so Archon leaves it alone.`,
      "pick another name: Archon never takes over a cluster it did not create (spec 038 FR-003)",
    );
    return false;
  }
  let v = inst.version;
  let port = inst.port;
  if (own.kind === "absent" || !own.cluster) {
    if (!(await ensureVersion(fleet, host, v, s))) return false;
    if (!port) {
      const recorded = Object.values(host.pgState?.instances ?? {}).map((r) => r.port);
      const listening = (await run(["ss", "-Hltn"])).stdout
        .split("\n")
        .map((l) =>
          Number(
            l
              .trim()
              .split(/\s+/)[3]
              ?.match(/:(\d+)$/)?.[1],
          ),
        )
        .filter(Boolean);
      port = allocatePort([...all.map((c) => c.port), ...recorded, ...listening]);
    }
    s.change(
      own.kind === "owned"
        ? `create ${v}/${inst.name} on port ${port} (empty: archon pg restore ${inst.name} loads its last dump)`
        : `create ${v}/${inst.name} on port ${port}`,
    );
    if (s.check) return true;
    const c = await run(createArgv(v, inst.name, port));
    if (!c.ok) {
      s.fail(`pg_createcluster ${v} ${inst.name}: ${c.stderr.trim().split("\n").pop()}`);
      return false;
    }
    const rec: PgRecord = {
      ...(inst.record ?? {}),
      version: v,
      port,
      created: inst.record?.created ?? new Date().toISOString(),
      by: inst.record?.by ?? by,
      environment: inst.environment,
      protected: inst.protected,
    };
    await writeRecord(host.name, inst.name, rec);
    inst = { ...inst, port, record: rec };
  } else {
    v = own.cluster.version;
    port = own.cluster.port;
    inst = { ...inst, port };
  }

  // Configuration: conf.d (Ubuntu's postgresql.conf includes it) and pg_hba.conf.
  const dir = confDir(v, inst.name);
  let tls: { cert: string; key: string } | undefined;
  const name = publishedName(fleet, host, inst.name);
  if (inst.published) {
    if (!host.ip) {
      s.fail(`${inst.name} is published, but ${host.name} has no address in the model (ip).`);
      return false;
    }
    const fq = name?.split(".").slice(1).join(".");
    const store = fq ? await readFor(s, ACME_STORE) : undefined;
    const w = fq && store !== null ? wildcardFrom(store ?? "", fq) : undefined;
    if (w) {
      tls = { cert: `${dir}/archon-tls/fullchain.pem`, key: `${dir}/archon-tls/privkey.pem` };
      const [cert, key] = [await readFor(s, tls.cert), await readFor(s, tls.key)];
      if ((cert !== null && cert !== w.cert) || (key !== null && key !== w.key)) {
        s.change(`TLS certificate for ${name}`);
        if (!s.check) {
          await writeOwned(tls.cert, w.cert, 0o644);
          await writeOwned(tls.key, w.key, 0o600);
        }
      }
    } else if (store !== null) {
      s.warn(
        `no certificate for ${name} yet: ${inst.name} uses Ubuntu's self-signed one, so clients need sslmode=require until Traefik has the server's wildcard certificate`,
        "archon web status",
      );
    }
  }
  const conf = archonConf(inst, { address: host.ip, tls });
  const hba = hbaConf(inst.published, ANYWHERE);
  const oldConf = await readFor(s, `${dir}/conf.d/50-archon.conf`);
  const oldHba = await readFor(s, `${dir}/pg_hba.conf`);
  const listenChanged =
    oldConf?.match(/^listen_addresses.*$/m)?.[0] !== conf.match(/^listen_addresses.*$/m)?.[0];
  let restart = false,
    reload = false;
  if (oldConf !== null && oldConf !== conf) {
    s.change(`${dir}/conf.d/50-archon.conf`);
    if (!s.check) await writeOwned(`${dir}/conf.d/50-archon.conf`, conf, 0o644);
    // listen_addresses needs a restart; everything else (TLS files included) a reload.
    if (listenChanged) restart = true;
    else reload = true;
  }
  if (oldHba !== null && oldHba !== hba) {
    s.change(`${dir}/pg_hba.conf`);
    if (!s.check) await writeOwned(`${dir}/pg_hba.conf`, hba, 0o640);
    reload = true;
  }
  if (s.check) return true;

  // Running, as postgresql-common runs it (postgresql@<v>-<name>.service).
  const now = (await clusters()).find((c) => c.version === v && c.name === inst.name);
  if (now?.status !== "online") {
    s.change(`start ${v}/${inst.name}`);
    const r = await run(["pg_ctlcluster", String(v), inst.name, "start"]);
    if (!r.ok) {
      s.fail(
        `${v}/${inst.name} does not start: ${
          r.stderr
            .trim()
            .split("\n")
            .filter((l) => /FATAL|ERROR/.test(l))
            .pop() ?? r.stderr.trim().split("\n").pop()
        }`,
        `less /var/log/postgresql/postgresql-${v}-${inst.name}.log`,
      );
      return false;
    }
  } else if (restart || reload) {
    const how = restart ? "restart" : "reload";
    s.change(`${how} ${v}/${inst.name}`);
    const r = await run(["pg_ctlcluster", String(v), inst.name, how]);
    if (!r.ok) {
      s.fail(
        `${v}/${inst.name} did not ${how}: ${
          r.stderr
            .trim()
            .split("\n")
            .filter((l) => /FATAL|ERROR/.test(l))
            .pop() ?? r.stderr.trim().split("\n").pop()
        }`,
        `less /var/log/postgresql/postgresql-${v}-${inst.name}.log`,
      );
      return false;
    }
  }

  // Spec 039: roles are Linux identities; access is per database; only services have passwords.
  return await convergeIdentities(v, inst, s);
}

/** A Linux account's existence (every login role must be one). */
export async function accountExists(name: string): Promise<boolean> {
  return (await run(["getent", "passwd", name])).ok;
}

/** A Linux group's members: listed members and those whose primary group it is. */
export async function groupMembers(group: string): Promise<string[]> {
  const g = await run(["getent", "group", group]);
  if (!g.ok) return [];
  const [, , gid, list] = g.stdout.trim().split(":");
  const listed = (list ?? "").split(",").filter(Boolean);
  const primary = (await run(["getent", "passwd"])).stdout
    .split("\n")
    .map((l) => l.split(":"))
    .filter((f) => f[3] === gid)
    .map((f) => f[0] ?? "");
  return [...new Set([...listed, ...primary])];
}

/** Rows of a query, one per line, fields split by the unit separator. */
async function rows(v: number, n: string, sql: string, db = "postgres"): Promise<string[][]> {
  const r = await run(
    [
      "psql",
      "--cluster",
      `${v}/${n}`,
      "-X",
      "-q",
      "-A",
      "-t",
      "-F",
      "\x1f",
      "-v",
      "ON_ERROR_STOP=1",
      "-d",
      db,
    ],
    { asUser: "postgres", stdin: sql },
  );
  if (!r.ok) throw new Error(r.stderr.trim());
  return r.stdout
    .split("\n")
    .filter(Boolean)
    .map((l) => l.split("\x1f"));
}

async function exec(v: number, n: string, sql: string, s: Sink, what: string, db = "postgres") {
  const r = await psql(v, n, sql, db);
  if (!r.ok) s.fail(`${what} in ${n}: ${r.stderr.trim().split("\n").pop()}`);
  return r.ok;
}

/**
 * An instance's identities (spec 039): every login role it wants (a superuser among them made
 * `NOSUPERUSER`); a login role that is Archon's but not wanted, or has no Linux account of its
 * name, made `NOLOGIN` (never dropped); passwords only for services; then each database's roles,
 * members, rights, and extensions. False when a step failed.
 */
export async function convergeIdentities(v: number, inst: Instance, s: Sink): Promise<boolean> {
  const n = inst.name;
  const before: Array<[string, boolean, boolean, string | null]> = (
    await rows(
      v,
      n,
      `SELECT r.rolname, r.rolcanlogin, r.rolsuper, shobj_description(r.oid, 'pg_authid')
       FROM pg_roles r WHERE r.rolname NOT LIKE 'pg\\_%' AND r.rolname <> 'postgres'`,
    )
  ).map((f) => [f[0] ?? "", f[1] === "t", f[2] === "t", f[3] || null]);
  const wanted = new Set(inst.roles.map((r) => r.name));

  // 1. Login roles: every person on the host, each service a database names.
  for (const role of inst.roles) {
    const had = before.find((b) => b[0] === role.name);
    if (!had) s.change(`role ${role.name} (${role.kind}) in ${n}`);
    else if (had[2]) {
      s.change(`${role.name}: NOSUPERUSER in ${n} (the superuser is postgres, through sudo)`);
    }
    if (!(await exec(v, n, roleSql(role), s, `role ${role.name}`))) return false;
  }
  // 2. What is not wanted any more cannot log in (never dropped: ownership would move).
  for (const [name, login, , comment] of before) {
    if (!login || wanted.has(name)) continue;
    const ours = comment?.startsWith("archon:") ?? false;
    if (ours || !(await accountExists(name))) {
      s.change(
        `${name} cannot log in to ${n} (${
          ours ? "not in the model" : "no Linux account of that name"
        })`,
      );
      await exec(v, n, `ALTER ROLE ${quote(name)} NOLOGIN`, s, `role ${name}`);
    }
  }

  // 3. Passwords: services only, for clients elsewhere (people use their Linux password,
  // synced by PAM, and only while the instance is published; on the server, nobody needs one).
  if (!inst.published) {
    for (const role of inst.roles.filter((r) => r.kind === "human")) {
      const has =
        (
          await rows(
            v,
            n,
            `SELECT rolpassword IS NOT NULL FROM pg_authid WHERE rolname = ${quoteLit(role.name)}`,
          )
        )[0]?.[0] === "t";
      if (!has) continue;
      s.change(`${role.name}'s password in ${n} removed (private: peer needs none)`);
      await exec(
        v,
        n,
        `ALTER ROLE ${quote(role.name)} PASSWORD NULL`,
        s,
        `${role.name}'s password`,
      );
    }
  }
  const dir = paths.join(PG.secrets, n);
  for (const role of inst.roles.filter((r) => r.kind === "service")) {
    if (!(await servicePassword(v, n, role.name, s))) return false;
  }
  if (await fs.exists(onHost(dir))) {
    for await (const e of fs.readDir(onHost(dir))) {
      const base = e.name.replace(/\.set$/, "");
      if (inst.roles.some((r) => r.kind === "service" && r.name === base)) continue;
      s.change(`remove ${paths.join(dir, e.name)} (only services have generated passwords)`);
      await fs.remove(onHost(paths.join(dir, e.name)));
    }
  }

  // 4. Databases, their two access roles, members, rights, extensions.
  const existing = new Set((await rows(v, n, `SELECT datname FROM pg_database`)).map((f) => f[0]));
  for (const d of inst.databases) {
    const a = { write: `${d.name}_rw`, read: `${d.name}_ro` };
    for (const g of [a.write, a.read]) {
      if (!(await exec(v, n, groupRoleSql(g), s, `role ${g}`))) return false;
    }
    if (!existing.has(d.name)) {
      s.change(`database ${d.name} in ${n}, owned by ${d.owner}`);
      if (!(await exec(v, n, createDatabaseSql(d), s, `database ${d.name}`))) return false;
    }
    if (!(await exec(v, n, databaseAccessSql(d), s, `access to ${d.name}`))) return false;
    if (!(await exec(v, n, schemaAccessSql(d), s, `rights in ${d.name}`, d.name))) return false;
    const groups = new Map<string, string[]>();
    for (const p of principals(d).filter((x) => x.startsWith("@"))) {
      groups.set(p.slice(1), await groupMembers(p.slice(1)));
    }
    const want = desiredMembers(d, (g) => groups.get(g) ?? [], inst.roles);
    for (const [group, list] of [
      [a.write, want.write],
      [a.read, want.read],
    ] as const) {
      const have = (
        await rows(
          v,
          n,
          `SELECT m.rolname FROM pg_auth_members am JOIN pg_roles g ON g.oid = am.roleid
           JOIN pg_roles m ON m.oid = am.member WHERE g.rolname = ${quoteLit(group)}`,
        )
      ).map((f) => f[0] ?? "");
      const sql = membershipSql(group, [...list], have);
      if (sql.length) {
        s.change(`${group} in ${n}: ${[...list].join(", ") || "nobody"}`);
        if (!(await exec(v, n, sql.join("\n"), s, `members of ${group}`))) return false;
      }
    }
    for (const e of d.extensions ?? []) {
      await exec(v, n, extensionSql(e), s, `extension ${e} in ${d.name}`, d.name);
    }
  }
  return true;
}

const quote = (s: string) => `"${s.replace(/"/g, '""')}"`;

/**
 * A service's password for clients on other machines: 32 random bytes, kept
 * where only the service's own account (and root) reads it, set as a SCRAM
 * verifier so the password itself never reaches PostgreSQL or its logs.
 */
async function servicePassword(v: number, n: string, role: string, s: Sink): Promise<boolean> {
  const path = secretPath(n, role);
  const at = onHost(path);
  let pw = (await fs.readTextOr(at))?.trim();
  const has =
    (
      await psql(
        v,
        n,
        `SELECT rolpassword IS NOT NULL FROM pg_authid WHERE rolname = ${quoteLit(role)}`,
      )
    ).stdout.trim() === "t";
  const owner = (await accountExists(role)) ? role : "root";
  if (!pw) {
    pw = newPassword();
    await fs.ensureDir(paths.dirname(at));
    await fs.chmod(onHost(PG.secrets), 0o711).catch(() => {});
    await fs.chmod(paths.dirname(at), 0o711).catch(() => {});
    await writeOwned(path, pw + "\n", 0o400, owner);
    s.change(`password for ${role} in ${n} (readable by ${role} only, in ${path})`);
  }
  if (!has || !(await fs.exists(at + ".set"))) {
    if (
      !(await exec(
        v,
        n,
        `ALTER ROLE ${quote(role)} PASSWORD '${await scramVerifier(pw)}'`,
        s,
        `${role}'s password`,
      ))
    ) {
      return false;
    }
    await fs.writeTextFile(at + ".set", new Date().toISOString() + "\n", { mode: 0o600 });
  }
  await run(["chown", `${owner}:root`, at]);
  return true;
}

/**
 * libpq's system-wide service file (spec 039), written after the instances
 * exist: a new one's port is known only once it is created.
 */
export async function writeSystemServices(host: string, s: Sink): Promise<void> {
  const st = await readState(host);
  const content = systemServices(
    Object.entries(st.instances).map(([name, r]) => ({ name, port: r.port })),
  );
  const have = await readFor(s, PG.systemServices);
  if (have === null || have === content) return;
  s.change(`${PG.systemServices} (psql service=<instance> for everyone)`);
  if (s.check) return;
  await fs.ensureDir(paths.dirname(onHost(PG.systemServices)));
  await fs.writeTextFile(onHost(PG.systemServices), content);
  await fs.chmod(onHost(PG.systemServices), 0o644);
}
