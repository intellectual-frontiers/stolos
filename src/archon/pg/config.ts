/**
 * 038-pg: PostgreSQL instances as data. Pure functions only (tested without a
 * server): which instances a host keeps, their ports, configuration, client
 * authentication, roles, the libpq service block, and the SCRAM verifier that
 * sets a password without the password ever reaching PostgreSQL or its logs.
 *
 * @module
 */

import type {
  FleetDef,
  HostDef,
  PgDatabaseDef,
  PgInstanceDef,
  PgRecord,
  ServiceDef,
  UserDef,
} from "../model/types.ts";
import { fqdn } from "../web/config.ts";
import { LOCAL_NETWORKS, localNetworks } from "../capabilities/ssh.ts";

export const SPEC = "038-pg" as const;
/** Linux identities are PostgreSQL identities (spec 039). */
export const IDENTITY_SPEC = "039-pg-identity" as const;

export const PG = {
  /** Ubuntu 26.04's PostgreSQL; other versions come from PGDG (FR-002). */
  ubuntuVersion: 18,
  defaultName: "prime",
  firstPort: 5432,
  /** Passwords, root-only except the role's own account (FR-012). */
  secrets: "/var/lib/archon-keys/pg",
  /** Dumps (spec 016 archives them nightly with the rest of the target). */
  dumps: "/var/backups/archon/pg",
  keepDumps: 7,
  /** Stops Ubuntu's package from creating a `main` cluster Archon does not own. */
  createclusterConf: "/etc/postgresql-common/createcluster.d/50-archon.conf",
  pgdgSource: "/etc/apt/sources.list.d/archon-pgdg.sources",
  /** The PGDG signing key as Ubuntu's own postgresql-common ships it (Article 12). */
  pgdgKey: "/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc",
  /** The operator's record: the host's own archon.sql (opt-in pg). */
  stateFile: "pg.json",
  /** libpq's system-wide services (Debian's PGSYSCONFDIR): every instance, no secrets. */
  systemServices: "/etc/postgresql-common/pg_service.conf",
  sudoers: "/etc/sudoers.d/archon-pg",
  socketDir: "/var/run/postgresql",
  /** PBKDF2 rounds for a person's synced Linux password (services' random passwords use 4096). */
  humanIterations: 100_000,
} as const;

/** Names: lowercase letters, digits, and dashes; a DNS label and a cluster name. */
export const NAME_RE = /^[a-z][a-z0-9-]{0,30}$/;
export const ROLE_RE = /^[a-z_][a-z0-9_]{0,62}$/;

export function checkName(name: string): string | undefined {
  return NAME_RE.test(name)
    ? undefined
    : `"${name}" is not a valid instance name: use lowercase letters, digits, and dashes, starting with a letter.`;
}

/** The default instance: PostgreSQL 18 named prime (a host's model adds its databases). */
export const PRIME: PgInstanceDef = { name: "prime", version: 18 };

/** Service account names: s-<app> (spec 039). */
export const SERVICE_RE = /^s-[a-z0-9][a-z0-9-]{0,28}$/;
export const SERVICE_UIDS = { min: 800, max: 899 } as const;

/** A login role: a person in the model, or a service account (spec 039). */
export interface Role {
  name: string;
  kind: "human" | "service";
  /** A fleet admin: may create databases and watch and signal sessions; never a superuser. */
  admin: boolean;
}

export interface Instance {
  name: string;
  version: number;
  /** undefined until allocated (first ensure). */
  port?: number;
  environment: string;
  protected: boolean;
  databases: PgDatabaseDef[];
  /** Login roles: every person on the host, and each service a database names. */
  roles: Role[];
  /** In the host's model file (else only recorded by an operator's ensure). */
  inModel: boolean;
  record?: PgRecord;
  published: boolean;
  /** Published for the local networks only (archon pg publish --local-only). */
  localOnly: boolean;
}

/** Whether an operator turned PostgreSQL on for this host (an opt-in service, spec 040). */
export const pgOn = (host: HostDef) => host.optIn?.pg?.enabled === true;
/** postgresql-common's umbrella unit: every cluster is PartOf it; the opt-in switch masks it. */
export const PG_UNIT = "postgresql.service";

/**
 * Every instance this host keeps: the model's and the ones operators recorded
 * (FR-004). A record's version and port win: they are what the cluster is.
 */
export function instancesOf(host: HostDef, users: UserDef[], fleet: FleetDef): Instance[] {
  const recorded = host.pgState?.instances ?? {};
  const fromModel = host.pg?.instances ?? [];
  const names = [...new Set([...fromModel.map((i) => i.name), ...Object.keys(recorded)])];
  return names.sort().map((name) => {
    const m = fromModel.find((i) => i.name === name);
    const r = recorded[name];
    const environment = m?.environment ?? r?.environment ?? "production";
    const databases = m?.databases ?? [];
    return {
      name,
      version: r?.version ?? m?.version ?? PG.ubuntuVersion,
      port: r?.port ?? m?.port,
      environment,
      protected: m?.protected ?? r?.protected ?? environment === "production",
      databases,
      roles: rolesFor(databases, users, fleet.services ?? []),
      inModel: !!m,
      record: r,
      published: !!r?.published,
      localOnly: r?.published?.localOnly === true,
    };
  });
}

/** Every principal a database names (owner, write, read), groups as @name. */
export function principals(d: PgDatabaseDef): string[] {
  return [d.owner, ...(d.write ?? []), ...(d.read ?? [])];
}

/**
 * Login roles: every person on the host (not ops, which serves agents and is
 * no database user), then each service account a database names. Groups are
 * not roles: their members are.
 */
export function rolesFor(dbs: PgDatabaseDef[], users: UserDef[], services: ServiceDef[]): Role[] {
  const out: Role[] = users.filter((u) => u.name !== "ops").map((u) => ({
    name: u.name,
    kind: "human" as const,
    admin: u.admin,
  }));
  for (const p of dbs.flatMap(principals)) {
    if (p.startsWith("@") || out.some((r) => r.name === p)) continue;
    if (services.some((s) => s.name === p)) out.push({ name: p, kind: "service", admin: false });
  }
  return out;
}

/** The first free port from 5432, skipping those in use by any cluster or listener. */
export function allocatePort(used: Iterable<number>, from: number = PG.firstPort): number {
  const taken = new Set(used);
  let p = from;
  while (taken.has(p)) p++;
  return p;
}

/** The published name: pg-<name>.<host>.<domain> (FR-014). */
export function publishedName(fleet: FleetDef, host: HostDef, name: string): string | undefined {
  const n = fqdn(fleet, host);
  return n ? `pg-${name}.${n}` : undefined;
}

/** Every address: a published instance is open to whatever the router lets through. */
export const ANYWHERE = ["0.0.0.0/0", "::/0"];

/**
 * Who may reach a published instance: anyone the router lets through (TLS and
 * scram-sha-256 always), or the local networks only with --local-only.
 */
export function publishFrom(fleet: FleetDef, localOnly = false): string[] {
  if (!localOnly) return ANYWHERE;
  const n = localNetworks(fleet);
  return n.length ? n : LOCAL_NETWORKS;
}

/** conf.d/50-archon.conf: everything Archon sets; the rest is Ubuntu's (Article 2). */
export function archonConf(
  i: Pick<Instance, "name" | "version" | "environment" | "protected" | "published">,
  opts: { address?: string; tls?: { cert: string; key: string } } = {},
): string {
  const listen = i.published && opts.address ? `localhost,${opts.address}` : "localhost";
  const lines = [
    `# Rendered by archon from spec 038-pg. Do not edit: archon pg ${
      i.published ? "unpublish" : "publish"
    } ${i.name}, or the model.`,
    `listen_addresses = '${listen}'`,
    `password_encryption = 'scram-sha-256'`,
    `ssl = on`,
    ...(opts.tls ? [`ssl_cert_file = '${opts.tls.cert}'`, `ssl_key_file = '${opts.tls.key}'`] : []),
    `ssl_min_protocol_version = 'TLSv1.3'`,
    // Read by the psql prompt (home/dot_psqlrc): which instance, which environment, protected or not.
    `archon.instance = '${i.name}'`,
    `archon.environment = '${i.environment}'`,
    `archon.protected = '${i.protected ? "on" : "off"}'`,
    // PostgreSQL 18 logs connections by stage; older versions take a boolean.
    i.version >= 18 ? `log_connections = 'authorization'` : `log_connections = on`,
    `log_disconnections = on`,
    "",
  ];
  return lines.join("\n");
}

/**
 * pg_hba.conf (spec 039): every login is a Linux account. On the socket, peer:
 * the kernel says who is connecting, and that is the role (no password). On
 * loopback, scram-sha-256. When published, TLS with scram-sha-256 from `from`
 * (every address, or the local networks with --local-only). postgres never over a
 * network. Nothing weaker anywhere.
 */
export function hbaConf(published: boolean, from: string[]): string {
  const rows = [
    "# Rendered by archon from specs 038-pg and 039-pg-identity. Do not edit.",
    "# TYPE   DATABASE  USER      ADDRESS          METHOD",
    "local    all       postgres                   peer",
    "local    all       all                        peer",
    "host     all       postgres  127.0.0.1/32     reject",
    "host     all       postgres  ::1/128          reject",
    "host     all       all       127.0.0.1/32     scram-sha-256",
    "host     all       all       ::1/128          scram-sha-256",
    ...(published
      ? [
        "hostssl  all       postgres  0.0.0.0/0        reject",
        "hostssl  all       postgres  ::/0             reject",
        ...from.map((n) => `hostssl  all       all       ${n.padEnd(16)} scram-sha-256`),
      ]
      : []),
    "",
  ];
  return rows.join("\n");
}

export const quoteIdent = (s: string) => `"${s.replace(/"/g, '""')}"`;
export const quoteLit = (s: string) => `'${s.replace(/'/g, "''")}'`;

/** The comment that marks a role as Archon's (spec 039), and its kind. */
export const roleComment = (kind: Role["kind"] | "group") => `archon: ${kind} (spec 039)`;

/**
 * SQL that makes a login role what the model says (idempotent; never a
 * password). Nobody but postgres is a superuser; admins may create databases
 * and watch and signal sessions.
 */
export function roleSql(r: Role): string {
  const attrs = [
    "LOGIN",
    "NOSUPERUSER",
    r.admin ? "CREATEDB" : "NOCREATEDB",
    "NOCREATEROLE",
    "NOREPLICATION",
    "NOBYPASSRLS",
  ].join(" ");
  return [
    `DO $$ BEGIN`,
    `  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = ${quoteLit(r.name)}) THEN`,
    `    CREATE ROLE ${quoteIdent(r.name)} ${attrs};`,
    `  ELSE`,
    `    ALTER ROLE ${quoteIdent(r.name)} ${attrs};`,
    `  END IF;`,
    `END $$;`,
    `COMMENT ON ROLE ${quoteIdent(r.name)} IS ${quoteLit(roleComment(r.kind))};`,
    ...(r.admin ? [`GRANT pg_monitor, pg_signal_backend TO ${quoteIdent(r.name)};`] : []),
  ].join("\n");
}

/** A database's two group roles: read-write and read-only (NOLOGIN). */
export const accessRoles = (db: string) => ({ write: `${db}_rw`, read: `${db}_ro` });

export function groupRoleSql(name: string): string {
  return [
    `DO $$ BEGIN`,
    `  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = ${quoteLit(name)}) THEN`,
    `    CREATE ROLE ${quoteIdent(name)} NOLOGIN;`,
    `  END IF;`,
    `END $$;`,
    `COMMENT ON ROLE ${quoteIdent(name)} IS ${quoteLit(roleComment("group"))};`,
  ].join("\n");
}

/** CREATE DATABASE (its own statement: it cannot run inside a transaction block). */
export const createDatabaseSql = (d: PgDatabaseDef) =>
  `CREATE DATABASE ${quoteIdent(d.name)} OWNER ${quoteIdent(d.owner)}`;

/** Ownership and CONNECT, run in the postgres database. */
export function databaseAccessSql(d: PgDatabaseDef): string {
  const a = accessRoles(d.name);
  const db = quoteIdent(d.name);
  return [
    `ALTER DATABASE ${db} OWNER TO ${quoteIdent(d.owner)};`,
    `REVOKE CONNECT, TEMPORARY ON DATABASE ${db} FROM PUBLIC;`,
    `GRANT CONNECT, TEMPORARY ON DATABASE ${db} TO ${quoteIdent(a.write)}, ${quoteIdent(a.read)};`,
  ].join("\n");
}

/** Table and sequence rights, now and for what the owner creates later; run in the database. */
export function schemaAccessSql(d: PgDatabaseDef): string {
  const a = accessRoles(d.name);
  const [rw, ro, owner] = [quoteIdent(a.write), quoteIdent(a.read), quoteIdent(d.owner)];
  const later = `ALTER DEFAULT PRIVILEGES FOR ROLE ${owner} IN SCHEMA public GRANT`;
  return [
    `GRANT USAGE ON SCHEMA public TO ${rw}, ${ro};`,
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${rw};`,
    `GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO ${rw};`,
    `GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${ro};`,
    `GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO ${ro};`,
    `${later} SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${rw};`,
    `${later} USAGE, SELECT, UPDATE ON SEQUENCES TO ${rw};`,
    `${later} SELECT ON TABLES TO ${ro};`,
    `${later} SELECT ON SEQUENCES TO ${ro};`,
  ].join("\n");
}

/**
 * Who belongs in each group role, with @groups expanded to their Linux members
 * (members(group) answers from the account database). Only roles Archon keeps
 * count; the owner is in neither (it owns).
 */
export function desiredMembers(
  d: PgDatabaseDef,
  members: (group: string) => string[],
  roles: Role[],
): { write: string[]; read: string[] } {
  const known = new Set(roles.map((r) => r.name));
  const expand = (xs: string[] = []) =>
    [...new Set(xs.flatMap((x) => x.startsWith("@") ? members(x.slice(1)) : [x]))]
      .filter((x) => known.has(x) && x !== d.owner).sort();
  const write = expand(d.write);
  return { write, read: expand(d.read).filter((x) => !write.includes(x)) };
}

/** GRANT and REVOKE so a group role's members are exactly `want`. */
export function membershipSql(group: string, want: string[], have: string[]): string[] {
  return [
    ...want.filter((m) => !have.includes(m)).map((m) =>
      `GRANT ${quoteIdent(group)} TO ${quoteIdent(m)};`
    ),
    ...have.filter((m) => !want.includes(m)).map((m) =>
      `REVOKE ${quoteIdent(group)} FROM ${quoteIdent(m)};`
    ),
  ];
}

export function extensionSql(ext: string): string {
  return `CREATE EXTENSION IF NOT EXISTS ${quoteIdent(ext)}`;
}

/** A SCRAM password verifier as PostgreSQL stores it (RFC 5802, RFC 7677). */
export async function scramVerifier(
  password: string,
  salt: Uint8Array = crypto.getRandomValues(new Uint8Array(16)),
  iterations = 4096,
): Promise<string> {
  const enc = new TextEncoder();
  const base = await crypto.subtle.importKey(
    "raw",
    enc.encode(password.normalize("NFKC")),
    "PBKDF2",
    false,
    [
      "deriveBits",
    ],
  );
  const salted = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "PBKDF2", hash: "SHA-256", salt: salt as BufferSource, iterations },
      base,
      256,
    ),
  );
  const hmacKey = await crypto.subtle.importKey(
    "raw",
    salted,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const clientKey = new Uint8Array(
    await crypto.subtle.sign("HMAC", hmacKey, enc.encode("Client Key")),
  );
  const storedKey = new Uint8Array(await crypto.subtle.digest("SHA-256", clientKey));
  const serverKey = new Uint8Array(
    await crypto.subtle.sign("HMAC", hmacKey, enc.encode("Server Key")),
  );
  const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
  return `SCRAM-SHA-256$${iterations}:${b64(salt)}$${b64(storedKey)}:${b64(serverKey)}`;
}

/** Whether a stored SCRAM verifier was made from this password (its own salt and rounds). */
export async function scramMatches(verifier: string, password: string): Promise<boolean> {
  const m = verifier.match(/^SCRAM-SHA-256\$(\d+):([^$]+)\$/);
  if (!m) return false;
  const salt = Uint8Array.from(atob(m[2]), (c) => c.charCodeAt(0));
  return (await scramVerifier(password, salt, Number(m[1]))) === verifier;
}

/** A new password: 32 random bytes, URL-safe, no characters .pgpass would need escaped. */
export function newPassword(): string {
  const b = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** The app contract's JSON (spec 038 FR-019, spec 039): stable keys, nothing secret. */
export interface ConnectInfo {
  service: string;
  /** The socket directory (peer: no password), or the published name with --remote. */
  host: string;
  port: number;
  user: string;
  database: string;
  sslmode: string;
  /** Present when the instance is published on the local networks. */
  published?: { host: string; port: number; sslmode: "verify-full" };
  files?: { service: string; pgpass?: string };
}

/** The database a role gets by default: the first it owns, may write, or may read. */
export function defaultDatabase(
  i: Pick<Instance, "databases">,
  role: string,
  inGroup: (group: string) => boolean = () => false,
): string {
  const has = (xs: string[] = []) =>
    xs.some((x) => x === role || (x.startsWith("@") && inGroup(x.slice(1))));
  const d = i.databases.find((d) => d.owner === role) ??
    i.databases.find((d) => has(d.write)) ?? i.databases.find((d) => has(d.read));
  return d?.name ?? "postgres";
}

export function connectInfo(
  i: Pick<Instance, "name" | "port" | "published" | "databases">,
  role: string,
  o: { publishedHost?: string; remote?: boolean; inGroup?: (g: string) => boolean } = {},
): ConnectInfo {
  const remote = !!o.remote && i.published && !!o.publishedHost;
  return {
    service: i.name,
    host: remote ? o.publishedHost! : PG.socketDir,
    port: i.port!,
    user: role,
    database: defaultDatabase(i, role, o.inGroup),
    sslmode: remote ? "verify-full" : "disable",
    ...(i.published && o.publishedHost
      ? { published: { host: o.publishedHost, port: i.port!, sslmode: "verify-full" as const } }
      : {}),
  };
}

/** The libpq service block for ~/.pg_service.conf. */
export function serviceBlock(c: ConnectInfo): string {
  return [
    `[${c.service}]`,
    `host=${c.host}`,
    `port=${c.port}`,
    `dbname=${c.database}`,
    `user=${c.user}`,
    `sslmode=${c.sslmode}`,
    ...(c.sslmode === "verify-full" ? ["sslrootcert=system"] : []),
    `application_name=psql-${c.service}`,
    "",
  ].join("\n");
}

/**
 * libpq's system-wide service file: every instance on its socket, no user and
 * no secret, so psql service=prime works for everyone (their own role, peer).
 */
export function systemServices(instances: Array<Pick<Instance, "name" | "port">>): string {
  return [
    "# Rendered by archon from spec 039-pg-identity. Do not edit.",
    "# psql service=<instance>: your own role over the socket (peer, no password).",
    ...instances.filter((i) => i.port).flatMap((i) => [
      "",
      `[${i.name}]`,
      `host=${PG.socketDir}`,
      `port=${i.port}`,
      "dbname=postgres",
    ]),
    "",
  ].join("\n");
}

/**
 * sudoers: operators become postgres (the only superuser) or an app's account,
 * for psql, with their own password; every use is in sudo's log. Admins are in
 * Ubuntu's sudo group already.
 */
export function sudoersPg(services: string[]): string {
  return [
    "# Rendered by archon from spec 039-pg-identity. Do not edit.",
    "# The PostgreSQL superuser is postgres, reached only through sudo (attributable).",
    "%archon-ops ALL=(postgres) /usr/bin/psql, /usr/bin/psql *",
    ...(services.length
      ? [
        "# Act as an app's own account to see exactly what it sees.",
        `%archon-ops ALL=(${services.join(", ")}) /usr/bin/psql, /usr/bin/psql *`,
      ]
      : []),
    "",
  ].join("\n");
}

/** The ~/.pgpass line (host:port:database:user:password; database is * so \c works). */
export function pgpassLine(
  c: Pick<ConnectInfo, "host" | "port" | "user">,
  password: string,
): string {
  const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/:/g, "\\:");
  return `${esc(c.host)}:${c.port}:*:${esc(c.user)}:${esc(password)}`;
}

/**
 * Replace (or add) one [section] of an ini-like file, leaving every other
 * line the user wrote alone.
 */
export function upsertSection(file: string, name: string, block: string): string {
  const lines = file.split("\n");
  const start = lines.findIndex((l) => l.trim() === `[${name}]`);
  if (start < 0) {
    const base = file.replace(/\n*$/, "");
    return (base ? base + "\n\n" : "") + block;
  }
  let end = start + 1;
  while (end < lines.length && !/^\s*\[.+\]\s*$/.test(lines[end])) end++;
  const before = lines.slice(0, start).join("\n");
  const after = lines.slice(end).join("\n").replace(/^\n+/, "");
  return [before.replace(/\n*$/, ""), block.replace(/\n*$/, ""), after]
    .filter((x) => x.length).join("\n\n") + "\n";
}

/** Replace (or add) the .pgpass line for host:port:*:user. */
export function upsertPgpass(file: string, line: string): string {
  const key = line.split(":").slice(0, 4).join(":");
  const kept = file.split("\n").filter((l) => l && l.split(":").slice(0, 4).join(":") !== key);
  return [...kept, line].join("\n") + "\n";
}

/** A row of `pg_lsclusters --no-header`: version, name, port, status, owner, data, log. */
export interface Cluster {
  version: number;
  name: string;
  port: number;
  status: string;
  owner: string;
  data: string;
  log: string;
}

export function parseClusters(out: string): Cluster[] {
  return out.split("\n").map((l) => l.trim().split(/\s+/)).filter((f) =>
    f.length >= 6 && /^\d+$/.test(f[0])
  )
    .map((f) => ({
      version: Number(f[0]),
      name: f[1],
      port: Number(f[2]),
      status: f[3],
      owner: f[4],
      data: f[5],
      log: f[6] ?? "",
    }));
}

/**
 * Archon owns a cluster only when the host's record says Archon created it
 * (FR-003). Anything else with the same name is refused, never touched.
 */
export function ownership(
  i: Pick<Instance, "name" | "record">,
  clusters: Cluster[],
): { kind: "owned"; cluster?: Cluster } | { kind: "absent" } | {
  kind: "foreign";
  cluster: Cluster;
} {
  const same = clusters.filter((c) => c.name === i.name);
  if (i.record) {
    return { kind: "owned", cluster: same.find((c) => c.version === i.record!.version) };
  }
  if (same.length) return { kind: "foreign", cluster: same[0] };
  return { kind: "absent" };
}

/** pg_createcluster's arguments for a new instance (peer locally, scram over TCP). */
export function createArgv(version: number, name: string, port: number): string[] {
  return [
    "pg_createcluster",
    String(version),
    name,
    "--port",
    String(port),
    "--start",
    "--",
    "--auth-local=peer",
    "--auth-host=scram-sha-256",
    "--data-checksums",
  ];
}

/** The PGDG source, for versions Ubuntu does not ship (FR-002). */
export function pgdgSource(codename: string, arch: string): string {
  return [
    "# Archon (038-pg): PostgreSQL's own apt repository (PGDG), for versions other than Ubuntu's.",
    "# The signing key is the one Ubuntu's postgresql-common ships.",
    "Types: deb",
    "URIs: https://apt.postgresql.org/pub/repos/apt",
    `Suites: ${codename}-pgdg`,
    "Components: main",
    `Architectures: ${arch}`,
    `Signed-By: ${PG.pgdgKey}`,
    "",
  ].join("\n");
}

/** Whether the owner approved destructive pg operations in the governing spec (Article: Never). */
export function approvedInSpec(spec: string): boolean {
  return /^approve: destructive\b/m.test(spec);
}

/** The unit of a cluster, from postgresql-common. */
export const unitOf = (version: number, name: string) => `postgresql@${version}-${name}.service`;
