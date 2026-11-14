/**
 * 043-pg-connections: what this account's libpq would use, and how to reach an
 * instance. Read-only; nothing on the host changes.
 *
 *   archon pg connections   every entry of the password file and every section
 *                           of the service files, matched as libpq matches them
 *   archon pg show NAME     how to reach an instance, as conninfo, URL, PG*
 *                           environment, or a service section
 *
 * A password is never printed, logged, or returned: the password field is
 * dropped the moment a password-file line is split, and a `password` key in a
 * service file is dropped as it is read. Only whether one is there is kept.
 *
 * @module
 */

import { join } from "../core/path.ts";
import { currentUser, homeDir, run } from "../core/exec.ts";
import { loadFleet, loadHosts, usersFor } from "../model/load.ts";
import { defaultDatabase, instancesOf, parseClusters, PG, publishedName } from "./config.ts";

/** Who is asking, as libpq's default user: the account itself, not $USER (which may be unset). */
async function whoAmI(): Promise<string> {
  return currentUser() || (await run(["id", "-un"])).stdout.trim() || "root";
}

/** Ubuntu's libpq: the default socket directory and the system service file's directory. */
export const LIBPQ = {
  socketDir: "/var/run/postgresql",
  sysconfDir: "/etc/postgresql-common",
  port: "5432",
} as const;

// ------------------------------------------------------------------ the password file

/** One password-file line, without its password. */
export interface PgpassEntry {
  /** 1-based line number in the file. */
  line: number;
  /** The host field, as written ("*" matches any); empty when malformed. */
  host: string;
  /** The port field, as written ("*" matches any); empty when malformed. */
  port: string;
  /** The database field, as written ("*" matches any); empty when malformed. */
  database: string;
  /** The user field, as written ("*" matches any); empty when malformed. */
  user: string;
  /** Whether the line has a fifth field (libpq's password); never the field itself. */
  hasPassword: boolean;
  /** Why libpq cannot use the line (it has fewer than five fields). */
  malformed?: string;
}

/**
 * Split one line into libpq's fields (backslash escapes `:` and `\`). The
 * fifth field, the password, is consumed and discarded here: only its presence
 * leaves this function.
 */
export function splitPgpassLine(line: string): { fields: string[]; hasPassword: boolean } {
  const fields: string[] = [];
  let cur = "";
  let i = 0;
  for (; i < line.length && fields.length < 4; i++) {
    const c = line[i];
    if (c === "\\" && i + 1 < line.length) {
      cur += line[++i];
    } else if (c === ":") {
      fields.push(cur);
      cur = "";
    } else cur += c;
  }
  if (fields.length < 4) {
    // Fewer than four separators: no password field at all.
    if (cur.length) fields.push(cur);
    return { fields, hasPassword: false };
  }
  // Four separators: a fifth field follows (the password, which libpq ends at an
  // unescaped ':'). Only that it is there is kept; the rest of the line is not read.
  return { fields, hasPassword: true };
}

/**
 * Parse a password file into its entries, skipping blank lines and comments.
 * A malformed line keeps only its line number and why: none of its fields.
 */
export function parsePgpass(text: string): PgpassEntry[] {
  const out: PgpassEntry[] = [];
  const lines = text.split("\n");
  for (let n = 0; n < lines.length; n++) {
    const raw = lines[n].replace(/\r$/, "");
    if (!raw.length || raw.startsWith("#")) continue;
    const { fields, hasPassword } = splitPgpassLine(raw);
    if (fields.length < 4 || !hasPassword) {
      // A malformed line's fields are not shown: a password may sit in any of them
      // (host:port:database:password, with the user left out).
      out.push({
        line: n + 1,
        host: "",
        port: "",
        database: "",
        user: "",
        hasPassword: false,
        malformed: `it has ${
          fields.length + (hasPassword ? 1 : 0)
        } of the five fields host:port:database:user:password (its fields are not shown)`,
      });
      continue;
    }
    const [host, port, database, user] = fields;
    out.push({ line: n + 1, host, port, database, user, hasPassword });
  }
  return out;
}

// ------------------------------------------------------------------ service files

/** One service-file section, without any password. */
export interface ServiceSection {
  /** The service name: the text between the brackets. */
  name: string;
  /** The service file it was read from. */
  file: string;
  /** The account's own service file, or the system-wide one. */
  source: "user" | "system";
  /** Connection parameters, `password` removed. */
  params: Record<string, string>;
  /** The section holds a password (it belongs in the password file instead). */
  hadPassword: boolean;
}

/**
 * Parse a service file into its sections (keys lowercased, comments skipped).
 * A `password` key is dropped as it is read; only that it was there is kept.
 */
export function parseServiceFile(
  text: string,
  file: string,
  source: ServiceSection["source"],
): ServiceSection[] {
  const out: ServiceSection[] = [];
  let cur: ServiceSection | undefined;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const head = line.match(/^\[(.+)\]$/);
    if (head) {
      cur = { name: head[1].trim(), file, source, params: {}, hadPassword: false };
      out.push(cur);
      continue;
    }
    const eq = line.indexOf("=");
    if (!cur || eq < 0) continue;
    const key = line.slice(0, eq).trim().toLowerCase();
    if (key === "password") {
      cur.hadPassword = true;
      continue;
    }
    cur.params[key] = line.slice(eq + 1).trim();
  }
  return out;
}

// ------------------------------------------------------------------ matching (libpq's rules)

/** The password-file key libpq would look up for a section: host, port, database, user. */
export function lookupKey(
  s: Pick<ServiceSection, "params">,
  me: string,
): { host: string; port: string; database: string; user: string } {
  const p = s.params;
  let host = p.host ?? p.hostaddr ?? "";
  // 'localhost' matches no host, or the default socket directory.
  if (!host || host === LIBPQ.socketDir || host === "/run/postgresql") host = "localhost";
  const user = p.user ?? me;
  return { host, port: p.port ?? LIBPQ.port, database: p.dbname ?? user, user };
}

const fieldMatches = (pattern: string, value: string) => pattern === "*" || pattern === value;

/** Whether a password-file entry matches a lookup key, as libpq matches it ("*" matches any). */
export function entryServes(e: PgpassEntry, key: ReturnType<typeof lookupKey>): boolean {
  return !e.malformed && fieldMatches(e.host, key.host) && fieldMatches(e.port, key.port) &&
    fieldMatches(e.database, key.database) && fieldMatches(e.user, key.user);
}

// ------------------------------------------------------------------ the report

/** What `archon pg connections` reports: the password file, the service files, and how they match. */
export interface ConnectionsReport {
  /** The password file: where it is, its mode, and whether libpq would use it. */
  passwordFile: {
    path: string;
    exists: boolean;
    /** Octal, as ls shows it (0600). */
    mode: string | null;
    usable: boolean;
    problem: string | null;
  };
  /** The service files libpq reads, and whether each exists. */
  serviceFiles: Array<{ path: string; source: ServiceSection["source"]; exists: boolean }>;
  /** Each password-file entry, the services it serves, and its problems. */
  entries: Array<{
    line: number;
    host: string;
    port: string;
    database: string;
    user: string;
    services: string[];
    usable: boolean;
    problems: string[];
  }>;
  /** Each service section in effect (a user's section hides a system one of the same name). */
  services: Array<{
    name: string;
    file: string;
    source: ServiceSection["source"];
    host: string;
    port: string;
    database: string;
    user: string;
    sslmode: string | null;
    /** The password-file line libpq would use for it (null: none; peer or a prompt). */
    passwordEntry: number | null;
    problems: string[];
  }>;
}

/** What {@link connectionsReport} reads: the account and its files, already loaded (text absent when missing). */
export interface ConnectionsInput {
  /** The account asking: libpq's default user. */
  me: string;
  /** The password file: its path, text, mode bits, and whether it is a plain file. */
  pgpass: { path: string; text?: string; mode?: number; isFile?: boolean };
  /** The user's and the system's service files, in the order libpq reads them. */
  serviceFiles: Array<{ path: string; source: ServiceSection["source"]; text?: string }>;
}

/**
 * Match the password file against the service files as libpq would, and say
 * what is wrong: a file libpq ignores, a password in a service file, network
 * TLS that is not verify-full, an entry no service uses. Pure: no I/O.
 */
export function connectionsReport(input: ConnectionsInput): ConnectionsReport {
  const pf = input.pgpass;
  const exists = pf.text !== undefined;
  let problem: string | null = null;
  if (exists && pf.isFile === false) problem = "it is not a plain file, so libpq ignores it";
  else if (exists && pf.mode !== undefined && (pf.mode & 0o077)) {
    problem = `group or others can access it (${
      (pf.mode & 0o777).toString(8).padStart(4, "0")
    }), so libpq ignores it: chmod 600 ${pf.path}`;
  }
  const fileUsable = exists && !problem;
  const entries = exists ? parsePgpass(pf.text!) : [];
  const sections = input.serviceFiles.flatMap((f) =>
    f.text === undefined ? [] : parseServiceFile(f.text, f.path, f.source)
  );
  // A user's section hides a system section of the same name (libpq reads the user's file first).
  const effective = sections.filter((s, i) =>
    s.source === "user" ||
    !sections.some((o, j) => j !== i && o.source === "user" && o.name === s.name)
  );
  const report: ConnectionsReport = {
    passwordFile: {
      path: pf.path,
      exists,
      mode: exists && pf.mode !== undefined ? (pf.mode & 0o777).toString(8).padStart(4, "0") : null,
      usable: fileUsable,
      problem,
    },
    serviceFiles: input.serviceFiles.map((f) => ({
      path: f.path,
      source: f.source,
      exists: f.text !== undefined,
    })),
    entries: [],
    services: [],
  };
  const firstMatch = (key: ReturnType<typeof lookupKey>) =>
    entries.find((e) => entryServes(e, key));
  for (const s of effective) {
    const key = lookupKey(s, input.me);
    const used = fileUsable ? firstMatch(key) : undefined;
    const problems: string[] = [];
    if (s.hadPassword) {
      problems.push(`it holds a password; keep passwords in ${pf.path} (0600) instead`);
    }
    const host = s.params.host ?? s.params.hostaddr ?? "";
    const network = !!host && !host.startsWith("/");
    if (network && s.params.sslmode !== "verify-full") {
      problems.push(
        `over the network it uses sslmode=${
          s.params.sslmode ?? "prefer"
        }, which can fall back to plain text or skip the server's identity: use sslmode=verify-full`,
      );
    }
    report.services.push({
      name: s.name,
      file: s.file,
      source: s.source,
      host: host || "(default socket)",
      port: key.port,
      database: key.database,
      user: key.user,
      sslmode: s.params.sslmode ?? null,
      passwordEntry: used?.line ?? null,
      problems,
    });
  }
  for (const e of entries) {
    const problems: string[] = [];
    if (e.malformed) problems.push(`libpq skips it: ${e.malformed}`);
    if (problem) problems.push("the file is ignored (see the password file's problem)");
    const services = effective.filter((s) => entryServes(e, lookupKey(s, input.me))).map((s) =>
      s.name
    );
    if (!e.malformed && !services.length) {
      // A near miss: everything matches but the host, because the service connects through
      // a socket directory other than the default, which libpq looks up as that path.
      const near = effective.filter((sv) => {
        const key = lookupKey(sv, input.me);
        return key.host.startsWith("/") && ["localhost", "127.0.0.1", "::1"].includes(e.host) &&
          fieldMatches(e.port, key.port) && fieldMatches(e.database, key.database) &&
          fieldMatches(e.user, key.user);
      });
      if (!near.length) problems.push("no service in the service files uses it");
      for (const sv of near) {
        problems.push(
          `[${sv.name}] uses the socket directory ${
            lookupKey(sv, input.me).host
          }, which libpq looks up as that path, not ${e.host}: give this line that path as its host, or set host=${e.host} in [${sv.name}] to connect over TCP`,
        );
      }
    }
    report.entries.push({
      line: e.line,
      host: e.host,
      port: e.port,
      database: e.database,
      user: e.user,
      services,
      usable: fileUsable && !e.malformed,
      problems,
    });
  }
  return report;
}

/** The report as text for the terminal (`archon pg connections`). */
export function renderConnections(r: ConnectionsReport): string {
  const L: string[] = [];
  const pf = r.passwordFile;
  L.push(
    `Password file: ${pf.path} ${
      pf.exists ? `(${pf.mode})${pf.usable ? "" : " UNUSABLE"}` : "(none)"
    }`,
  );
  if (pf.problem) L.push(`  problem: ${pf.problem}`);
  for (const e of r.entries) {
    if (!e.host && !e.port && !e.database && !e.user) {
      L.push(`  line ${e.line}: not usable`);
      for (const p of e.problems) L.push(`    problem: ${p}`);
      continue;
    }
    L.push(
      `  line ${e.line}: ${e.host}:${e.port}:${e.database}:${e.user} · ${
        e.services.length ? `serves [${e.services.join("], [")}]` : "serves no service"
      } · ${e.usable ? "usable" : "not usable"}`,
    );
    for (const p of e.problems) L.push(`    problem: ${p}`);
  }
  L.push("Service files:");
  for (const f of r.serviceFiles) L.push(`  ${f.path} (${f.source})${f.exists ? "" : " (none)"}`);
  for (const s of r.services) {
    L.push(
      `  [${s.name}] host=${s.host} port=${s.port} dbname=${s.database} user=${s.user}${
        s.sslmode ? ` sslmode=${s.sslmode}` : ""
      } · ${
        s.passwordEntry
          ? `password: line ${s.passwordEntry}`
          : "no password entry (peer, or libpq asks)"
      } · ${s.source}`,
    );
    for (const p of s.problems) L.push(`    problem: ${p}`);
  }
  if (!r.entries.length && !r.services.length) {
    L.push("Nothing yet: archon pg connect NAME --write adds a service.");
  }
  return L.join("\n");
}

/** Read this account's files (as libpq would find them) into a report. */
export async function readConnections(): Promise<ConnectionsReport> {
  const me = await whoAmI();
  const home = Deno.env.get("HOME") ?? await homeDir(me);
  const pgpassPath = Deno.env.get("PGPASSFILE") || join(home, ".pgpass");
  let pgpass: ConnectionsInput["pgpass"] = { path: pgpassPath };
  try {
    const st = await Deno.stat(pgpassPath);
    pgpass = {
      path: pgpassPath,
      isFile: st.isFile,
      mode: st.mode ?? undefined,
      text: st.isFile ? await Deno.readTextFile(pgpassPath) : "",
    };
  } catch { /* none, or unreadable: libpq would ignore it too */ }
  const files: ConnectionsInput["serviceFiles"] = [
    { path: Deno.env.get("PGSERVICEFILE") || join(home, ".pg_service.conf"), source: "user" },
    {
      path: join(Deno.env.get("PGSYSCONFDIR") || LIBPQ.sysconfDir, "pg_service.conf"),
      source: "system",
    },
  ];
  for (const f of files) {
    try {
      f.text = await Deno.readTextFile(f.path);
    } catch { /* none */ }
  }
  return connectionsReport({ me, pgpass, serviceFiles: files });
}

/** `archon pg connections`: print this account's report, as text or JSON; returns the exit code. */
export async function pgConnections(json: boolean): Promise<number> {
  const r = await readConnections();
  if (json) console.log(JSON.stringify(r, null, 2));
  else console.log(renderConnections(r));
  return 0;
}

// ------------------------------------------------------------------ show

/** The forms `archon pg show --form` accepts (conninfo is the default). */
export const FORMS = [
  "conninfo",
  "url",
  "env",
  "service",
  "jdbc",
  "npgsql",
  "odbc",
  "dotenv",
  "pgadmin",
  "ca",
  "external",
] as const;

/** Where libpq looks for the root certificate when sslrootcert is not given. */
export const ROOT_CRT = {
  windows: "%APPDATA%\\postgresql\\root.crt",
  unix: "~/.postgresql/root.crt",
} as const;
/** One of {@link FORMS}. */
export type Form = typeof FORMS[number];

/** Where an instance is, and as whom. Never a password. */
export interface Target {
  /** The instance's, cluster's, or service's name. */
  name: string;
  /** The socket directory, or a host name for a network connection. */
  host: string;
  /** The port it listens on. */
  port: number;
  /** The database to connect to (the role's default). */
  database: string;
  /** The role to connect as. */
  user: string;
  /** Over a network: verify-full against the system's roots. */
  network: boolean;
  /** The server's IP address, for a client without DNS for the name (libpq's hostaddr). */
  address?: string;
  /** A person (their Linux password) or a service account (its generated password). */
  kind?: "human" | "service";
  /** The server it runs on (for the PAM reminder). */
  server?: string;
}

/**
 * The reminder that goes with any external connection for a person: PostgreSQL
 * learns a Linux password only when it is typed on the server (PAM, spec 039).
 */
export function pamReminder(
  t: Pick<Target, "name" | "kind" | "server" | "user">,
): string | undefined {
  if (t.kind === "service") return undefined;
  const on = t.server ?? "the server";
  return `PostgreSQL learns your Linux password only when you type it on ${on} after ${t.name} is published (PAM): once, on ${on}, run sudo -k && sudo -v (or log in with a password, or sign in to Cockpit). Then archon pg test ${t.name} checks it.`;
}

/**
 * Everything a client on another machine needs, labelled, then the four forms
 * filled in for it. TLS checks the server's name even when hostaddr skips DNS.
 */
export function renderExternal(t: Target): string {
  const password = t.kind === "service"
    ? `the service account's own password: archon pg connect ${t.name} --remote --write, run as ${t.user} on the server, puts it in ${t.user}'s ~/.pgpass; copy that line to the client's ~/.pgpass (0600)`
    : `your Linux password on ${
      t.server ?? "the server"
    } (libpq asks for it; or keep it in the client's ~/.pgpass, 0600)`;
  // Values start at the left margin, so a copied line pastes as it is (no stray spaces).
  const indent = (x: string) => x;
  return [
    `# ${t.name}, from another machine (TLS; the server's certificate is verified)`,
    `host:        ${t.host}`,
    ...(t.address
      ? [`hostaddr:    ${t.address}   (optional: connect without DNS; TLS still checks the name)`]
      : []),
    `port:        ${t.port}`,
    `database:    ${t.database}`,
    `user:        ${t.user}`,
    `sslmode:     verify-full`,
    `sslrootcert: system   (libpq 16 or newer; older: /etc/ssl/certs/ca-certificates.crt; not for JDBC, below)`,
    `password:    ${password}`,
    ...(pamReminder(t) ? [`             ${pamReminder(t)}`] : []),
    "",
    "conninfo:",
    indent(renderShow(t, "conninfo")),
    "url:",
    indent(renderShow(t, "url")),
    "env:",
    indent(renderShow(t, "env")),
    "service (~/.pg_service.conf):",
    indent(renderShow(t, "service")),
    "npgsql (.NET, Power BI, Excel's Power Query):",
    indent(renderShow(t, "npgsql")),
    "odbc (Excel, Access, Tableau, LibreOffice):",
    indent(renderShow(t, "odbc")),
    "dotenv (.env for app frameworks):",
    indent(renderShow(t, "dotenv")),
    `pgadmin: archon pg show ${t.name} --form pgadmin --remote > servers.json, then pgAdmin, Tools, Import/Export Servers`,
    `ca: archon pg show ${t.name} --form ca --remote > root.crt (libpq's own file: ${ROOT_CRT.windows} on Windows, ${ROOT_CRT.unix} elsewhere; pgAdmin and psqlODBC on Windows need it)`,
    "jdbc (DBeaver, IntelliJ, Java apps; the password goes in the tool's own password field):",
    indent(renderShow(t, "jdbc")),
    '(If the tool says "PKIX path building failed", its Java does not know the certificate\'s root:',
    "use the system's trust store; DBeaver: Window, Preferences, Connections, Use Windows trust store.)",
  ].join("\n");
}

const conninfoValue = (v: string) =>
  /^[A-Za-z0-9_./@%+-]+$/.test(v) ? v : `'${v.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;

/** One instance in one form; for a network host, TLS that verifies the server. */
export function renderShow(t: Target, form: Form): string {
  const tls = t.network ? { sslmode: "verify-full", sslrootcert: "system" } : undefined;
  switch (form) {
    case "conninfo":
      return [
        `host=${conninfoValue(t.host)}`,
        `port=${t.port}`,
        `dbname=${conninfoValue(t.database)}`,
        `user=${conninfoValue(t.user)}`,
        ...(tls ? [`sslmode=${tls.sslmode}`, `sslrootcert=${tls.sslrootcert}`] : []),
      ].join(" ");
    case "url": {
      const host = t.host.startsWith("/") ? encodeURIComponent(t.host) : t.host;
      const q = tls ? `?sslmode=${tls.sslmode}&sslrootcert=${tls.sslrootcert}` : "";
      return `postgresql://${encodeURIComponent(t.user)}@${host}:${t.port}/${
        encodeURIComponent(t.database)
      }${q}`;
    }
    case "env":
      return [
        `PGHOST=${t.host}`,
        `PGPORT=${t.port}`,
        `PGDATABASE=${t.database}`,
        `PGUSER=${t.user}`,
        ...(tls ? [`PGSSLMODE=${tls.sslmode}`, `PGSSLROOTCERT=${tls.sslrootcert}`] : []),
      ].map((l) => `export ${l.replace(/=(.*)$/, (_m, v) => `=${conninfoValue(v)}`)}`).join("\n");
    case "external":
      return renderExternal(t);
    case "jdbc":
      // pgJDBC (DBeaver, IntelliJ, Java apps): verify-full against Java's own trust store.
      // libpq's sslrootcert=system means a file named "system" to pgJDBC.
      return `jdbc:postgresql://${t.host}:${t.port}/${
        encodeURIComponent(t.database)
      }?sslmode=verify-full&sslfactory=org.postgresql.ssl.DefaultJavaSSLFactory&user=${
        encodeURIComponent(t.user)
      }`;
    case "npgsql":
      // .NET, Power BI, Excel's Power Query: Npgsql trusts the operating system's store.
      return [
        `Host=${t.host}`,
        `Port=${t.port}`,
        `Database=${t.database}`,
        `Username=${t.user}`,
        ...(t.network ? ["SSL Mode=VerifyFull"] : []),
      ].join(";");
    case "odbc": {
      const base = `Server=${t.host};Port=${t.port};Database=${t.database};Uid=${t.user}`;
      if (!t.network) return `Driver={PostgreSQL Unicode};${base}`;
      return [
        `# Windows (psqlODBC): first save archon pg show ${t.name} --form ca --remote as ${ROOT_CRT.windows}`,
        `Driver={PostgreSQL Unicode(x64)};${base};SSLmode=verify-full`,
        "# Linux (unixODBC with odbc-postgresql):",
        `Driver={PostgreSQL Unicode};${base};SSLmode=verify-full;pqopt={sslrootcert=system}`,
      ].join("\n");
    }
    case "dotenv": {
      const url = (q: string) =>
        `postgresql://${encodeURIComponent(t.user)}@${
          t.host.startsWith("/") ? encodeURIComponent(t.host) : t.host
        }:${t.port}/${encodeURIComponent(t.database)}${q}`;
      if (!t.network) return `DATABASE_URL=${url("")}`;
      return [
        "# libpq-based (Django, Rails, SQLAlchemy, psycopg, Go pgx, PHP):",
        `DATABASE_URL=${url("?sslmode=verify-full&sslrootcert=system")}`,
        "# Node (pg, Drizzle, Knex), which read sslrootcert as a file name:",
        `# DATABASE_URL=${url("?sslmode=verify-full")}`,
        "# Prisma:",
        `# DATABASE_URL=${url("?sslmode=require&sslaccept=strict")}`,
      ].join("\n");
    }
    case "pgadmin":
      // pgAdmin's Import Servers file. Its libpq on Windows has no system store, so the
      // root certificate is libpq's default file (archon pg show NAME --form ca).
      return JSON.stringify(
        {
          Servers: {
            "1": {
              Name: `${t.name}${t.server ? ` (${t.server})` : ""}`,
              Group: "Archon",
              Host: t.host,
              Port: t.port,
              MaintenanceDB: t.database,
              Username: t.user,
              ConnectionParameters: t.network
                ? { sslmode: "verify-full", connect_timeout: 10 }
                : { connect_timeout: 10 },
            },
          },
        },
        null,
        2,
      );
    case "ca":
      // Fetched over the network (pgShow); renderShow has nothing to add.
      return "";
    case "service":
      return [
        `[${t.name}]`,
        `host=${t.host}`,
        `port=${t.port}`,
        `dbname=${t.database}`,
        `user=${t.user}`,
        ...(tls ? [`sslmode=${tls.sslmode}`, `sslrootcert=${tls.sslrootcert}`] : []),
      ].join("\n");
  }
}

/** A command line the user got wrong (for example an unknown form). */
export class UsageError extends Error {}

/** The form a --form value names (conninfo when absent); throws {@link UsageError} for an unknown one. */
export function parseForm(form: string | undefined): Form {
  const f = (form ?? "conninfo") as Form;
  if (!FORMS.includes(f)) {
    throw new UsageError(
      `unknown form "${form}": use ${FORMS.slice(0, -1).join(", ")}, or ${FORMS.at(-1)}`,
    );
  }
  return f;
}

/**
 * Find NAME: an instance Archon keeps, then any cluster on this host
 * (pg_lsclusters, Archon's or not), then a section of the service files.
 */
export async function findTarget(
  hostName: string,
  name: string,
  remote: boolean,
): Promise<Target | string> {
  const me = await whoAmI();
  const fleet = await loadFleet();
  const host = (await loadHosts()).find((h) => h.name === hostName);
  if (host) {
    const i = instancesOf(host, usersFor(fleet, host), fleet).find((x) => x.name === name);
    const port = i?.record?.port ?? i?.port;
    if (i && port) {
      const mine = new Set((await run(["id", "-nG", me])).stdout.trim().split(/\s+/));
      const database = defaultDatabase(i, me, (g) => mine.has(g));
      if (remote) {
        const pub = publishedName(fleet, host, name);
        if (!i.published || !pub) {
          return `${name} is private: an operator publishes it with archon pg publish ${name}.`;
        }
        const kind = i.roles.find((x) => x.name === me)?.kind;
        return {
          name,
          host: pub,
          port,
          database,
          user: me,
          network: true,
          address: host.ip,
          kind,
          server: host.name,
        };
      }
      return { name, host: PG.socketDir, port, database, user: me, network: false };
    }
  }
  const clusters = parseClusters((await run(["pg_lsclusters", "--no-header"])).stdout);
  const c = clusters.find((x) => x.name === name || `${x.version}/${x.name}` === name);
  if (c && !remote) {
    return {
      name: c.name,
      host: PG.socketDir,
      port: c.port,
      database: "postgres",
      user: me,
      network: false,
    };
  }
  const r = await readConnectionsSections();
  const s = r.find((x) => x.name === name);
  if (s) {
    const key = lookupKey(s, me);
    const h = s.params.host ?? s.params.hostaddr ?? LIBPQ.socketDir;
    return {
      name,
      host: h,
      port: Number(key.port),
      database: key.database,
      user: key.user,
      network: !h.startsWith("/"),
    };
  }
  return `There is no instance, cluster, or service named ${name} here: archon pg list and archon pg connections show what there is.`;
}

async function readConnectionsSections(): Promise<ServiceSection[]> {
  const me = await whoAmI();
  const home = Deno.env.get("HOME") ?? await homeDir(me);
  const out: ServiceSection[] = [];
  for (
    const [path, source] of [
      [Deno.env.get("PGSERVICEFILE") || join(home, ".pg_service.conf"), "user"],
      [join(Deno.env.get("PGSYSCONFDIR") || LIBPQ.sysconfDir, "pg_service.conf"), "system"],
    ] as Array<[string, ServiceSection["source"]]>
  ) {
    try {
      out.push(...parseServiceFile(await Deno.readTextFile(path), path, source));
    } catch { /* none */ }
  }
  return out;
}

/**
 * `archon pg show NAME`: how to reach an instance, in one form. Prints the text
 * (or JSON) and returns the exit code: 0 on success, 1 when NAME cannot be
 * shown that way, 2 for an unknown form.
 */
export async function pgShow(
  hostName: string,
  name: string,
  form: string | undefined,
  remote: boolean,
  json: boolean,
): Promise<number> {
  let f: Form;
  try {
    f = parseForm(form);
  } catch (e) {
    console.error((e as Error).message);
    return 2;
  }
  // The external form is the published instance, whatever --remote says.
  const t = await findTarget(hostName, name, remote || f === "external");
  if (typeof t === "string") {
    if (json) console.log(JSON.stringify({ ok: false, error: t }));
    else console.error(t);
    return 1;
  }
  if (f === "ca") {
    if (!t.network) {
      const msg =
        `${name} is reached through its socket on this server, without TLS: the root certificate is for a published instance (archon pg show ${name} --form ca --remote).`;
      if (json) console.log(JSON.stringify({ ok: false, error: msg }));
      else console.error(msg);
      return 1;
    }
    const got = await rootCertificate(t.host, t.port);
    if (typeof got === "string") {
      if (json) console.log(JSON.stringify({ ok: false, error: got }));
      else console.error(got);
      return 1;
    }
    if (json) console.log(JSON.stringify({ ok: true, form: f, ...t, ...got }, null, 2));
    else {
      console.log(got.pem.trim());
      console.error(
        `# ${got.subject} (SHA-256 ${got.fingerprint}), the root behind ${t.host}. Save it as ${ROOT_CRT.windows} on Windows, or ${ROOT_CRT.unix} elsewhere, for clients without a system store.`,
      );
    }
    return 0;
  }
  if (f === "jdbc" && !t.network) {
    const msg =
      `JDBC connects over TCP with a password, and on this server ${name} takes neither: an operator publishes it (archon pg publish ${name}, or --local-only), then archon pg show ${name} --form jdbc --remote.`;
    if (json) console.log(JSON.stringify({ ok: false, error: msg }));
    else console.error(msg);
    return 1;
  }
  if (f === "external" && !t.network) {
    const msg =
      `${name} is reached through its socket on this server: from another machine, an operator publishes it first (archon pg publish ${name}).`;
    if (json) console.log(JSON.stringify({ ok: false, error: msg }));
    else console.error(msg);
    return 1;
  }
  const text = renderShow(t, f);
  const note = t.network ? pamReminder(t) : undefined;
  if (json) {
    console.log(
      JSON.stringify({ ok: true, form: f, ...t, text, ...(note ? { note } : {}) }, null, 2),
    );
  } else {
    console.log(text);
    // On stderr, so psql "$(archon pg show ...)" and eval still take stdout as it is.
    if (note && f !== "external") console.error(`# ${note}`);
  }
  return 0;
}

// ------------------------------------------------------------------ test

/** Read a password from the terminal without echoing it (or one line from a pipe). */
export async function readSecret(prompt: string): Promise<string> {
  const enc = new TextEncoder();
  if (!Deno.stdin.isTerminal()) {
    const text = new TextDecoder().decode(await new Response(Deno.stdin.readable).arrayBuffer());
    return text.split("\n")[0].replace(/\r$/, "");
  }
  await Deno.stderr.write(enc.encode(prompt));
  Deno.stdin.setRaw(true);
  const buf = new Uint8Array(1);
  const bytes: number[] = [];
  try {
    while (true) {
      const n = await Deno.stdin.read(buf);
      if (n === null) break;
      const c = buf[0];
      if (c === 3) throw new Error("cancelled");
      if (c === 13 || c === 10) break;
      if (c === 127 || c === 8) bytes.pop();
      else bytes.push(c);
    }
  } finally {
    Deno.stdin.setRaw(false);
    await Deno.stderr.write(enc.encode("\n"));
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

/** What a failed external connection most likely means, and what to do. */
export function explainFailure(stderr: string, t: Target): string {
  const e = stderr.toLowerCase();
  if (e.includes("password authentication failed")) {
    return pamReminder(t) ??
      `${t.user}'s password did not match: it is in ${t.user}'s ~/.pgpass on the server.`;
  }
  if (e.includes("certificate") || e.includes("ssl")) {
    return `TLS did not verify ${t.host}: archon web status shows the server's certificate; until Traefik has the wildcard certificate, the instance uses a self-signed one.`;
  }
  if (e.includes("no pg_hba.conf entry")) {
    return `${t.name} does not admit this connection: is it published (archon pg publish ${t.name})? postgres itself never connects over a network.`;
  }
  if (e.includes("could not translate host name")) {
    return `${t.host} does not resolve here: the server's DNS record (archon web dns) or this machine's DNS.`;
  }
  if (
    e.includes("timeout") || e.includes("could not connect") || e.includes("connection refused")
  ) {
    return `Nothing answered on ${t.host}:${t.port}: is ${t.name} published (archon pg list), and do the firewall and the router let this machine through?`;
  }
  return "See the message above.";
}

/**
 * archon pg test NAME: connect as a client from elsewhere would, to the
 * published name (never localhost), over TLS with the server verified,
 * with a password typed now. Nothing is stored; the password goes to psql
 * through a private, temporary password file that is removed at once.
 */
export async function pgTest(hostName: string, name: string, user?: string): Promise<number> {
  const t = await findTarget(hostName, name, true);
  if (typeof t === "string") {
    console.error(t);
    return 1;
  }
  if (user) t.user = user;
  if (!(await run(["sh", "-c", "command -v psql"])).ok) {
    console.error("psql is not installed here (Ubuntu's postgresql-client).");
    return 1;
  }
  console.error(
    `Testing ${t.user}@${t.host}:${t.port}/${t.database} over TLS (verify-full), not through localhost.`,
  );
  const pw = await readSecret(`Password for ${t.user}: `);
  if (!pw) {
    console.error("No password given.");
    return 2;
  }
  const dir = await Deno.makeTempDir({ prefix: "archon-pg-test-" });
  await Deno.chmod(dir, 0o700);
  const passfile = join(dir, "pgpass");
  try {
    const esc = (v: string) => v.replace(/\\/g, "\\\\").replace(/:/g, "\\:");
    await Deno.writeTextFile(passfile, `${esc(t.host)}:${t.port}:*:${esc(t.user)}:${esc(pw)}\n`, {
      mode: 0o600,
    });
    await Deno.chmod(passfile, 0o600);
    const conninfo = `${renderShow(t, "conninfo")} connect_timeout=10`;
    const r = await run(
      [
        "psql",
        conninfo,
        "-X",
        "-A",
        "-t",
        "-F",
        "|",
        "-c",
        "SELECT current_user, inet_server_addr(), inet_client_addr(), s.version, s.cipher FROM pg_stat_ssl s WHERE s.pid = pg_backend_pid()",
      ],
      { env: { PGPASSFILE: passfile, PGCONNECT_TIMEOUT: "10" } },
    );
    if (!r.ok) {
      console.log(`FAILED: ${r.stderr.trim().split("\n").pop()}`);
      console.log(explainFailure(r.stderr, t));
      return 1;
    }
    const [who, server, client, tls, cipher] = r.stdout.trim().split("|");
    console.log(
      `OK: connected to ${t.host} (${server}) from ${client} as ${who}, ${tls} ${cipher}, the server's certificate verified.`,
    );
    if (client === server) {
      console.log(
        "This ran on the server itself, so the firewall was not crossed: run it from another machine to test the firewall and the router too.",
      );
    }
    return 0;
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

// ------------------------------------------------------------------ the root certificate

/**
 * The root certificate behind a server's chain: the chain the server presents
 * (PostgreSQL's own STARTTLS, so it works from any machine), its last
 * certificate's issuer looked up among the system's trusted roots, and
 * checked to really sign that certificate.
 */
export async function rootCertificate(
  host: string,
  port: number,
  certsDir = "/etc/ssl/certs",
): Promise<{ pem: string; subject: string; fingerprint: string } | string> {
  const s = await run([
    "sh",
    "-c",
    `timeout 15 openssl s_client -starttls postgres -connect "$1:$2" -servername "$1" -showcerts </dev/null 2>/dev/null`,
    "sh",
    host,
    String(port),
  ]);
  const chain = s.stdout.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) ??
    [];
  if (!chain.length) {
    return `Could not read ${host}:${port}'s certificate (is it published and reachable?).`;
  }
  return await rootFor(chain, certsDir);
}

/** Find, among the trusted roots, the one that signs the last certificate of a chain. */
export async function rootFor(
  chain: string[],
  certsDir = "/etc/ssl/certs",
): Promise<{ pem: string; subject: string; fingerprint: string } | string> {
  const last = chain[chain.length - 1];
  const dir = await Deno.makeTempDir({ prefix: "archon-pg-ca-" });
  try {
    await Deno.writeTextFile(join(dir, "last.pem"), last + "\n");
    const hash =
      (await run(["openssl", "x509", "-in", join(dir, "last.pem"), "-noout", "-issuer_hash"]))
        .stdout.trim();
    if (!hash) return "Could not read the chain's last certificate.";
    for (let i = 0; i < 10; i++) {
      const candidate = join(certsDir, `${hash}.${i}`);
      const pem = await Deno.readTextFile(candidate).catch(() => undefined);
      if (pem === undefined) break;
      // The candidate must really sign the chain's last certificate.
      const v = await run([
        "openssl",
        "verify",
        "-CAfile",
        candidate,
        "-partial_chain",
        join(dir, "last.pem"),
      ]);
      if (!v.ok) continue;
      const info = await run([
        "openssl",
        "x509",
        "-in",
        candidate,
        "-noout",
        "-subject",
        "-fingerprint",
        "-sha256",
      ]);
      const subject = info.stdout.match(/^subject=\s*(.*)$/m)?.[1]?.trim() ?? "";
      const fingerprint = info.stdout.match(/Fingerprint=(.*)$/m)?.[1]?.trim() ?? "";
      const body = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/)?.[0] ??
        pem;
      return { pem: body + "\n", subject, fingerprint };
    }
    return "The chain's root is not among this machine's trusted roots (ca-certificates).";
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}
