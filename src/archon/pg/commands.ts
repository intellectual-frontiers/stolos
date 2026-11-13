// 038-pg: archon pg list | status | ensure | start | stop | restart | reload |
// upgrade | remove | backup | restore | maintain | publish | unpublish | connect.
//
// Every command names an instance (default prime). Failures exit non-zero
// with one plain sentence (the app contract, spec 038 FR-019); --json prints a stable
// document and nothing else on stdout.

import { dirname, join } from "../core/path.ts";
import { ensureDir, exists, readTextOr } from "../core/fsx.ts";
import { P } from "../core/paths.ts";
import { currentUser, homeDir, isRoot, run } from "../core/exec.ts";
import { journal } from "../core/log.ts";
import { loadFleet, loadHosts } from "../model/load.ts";
import type { FleetDef, HostDef, PgRecord } from "../model/types.ts";
import { usersFor } from "../model/load.ts";
import {
  approvedInSpec,
  checkName,
  connectInfo,
  type Instance,
  instancesOf,
  PG,
  pgOn,
  pgpassLine,
  publishedName,
  quoteIdent,
  quoteLit,
  scramMatches,
  scramVerifier,
  serviceBlock,
  SPEC,
  unitOf,
  upsertPgpass,
  upsertSection,
} from "./config.ts";
import {
  clusters,
  convergeInstance,
  ensureVersion,
  psql,
  readState,
  secretPath,
  type Sink,
  writeRecord,
} from "./converge.ts";

/** A plain sentence for the person (or program) that asked. */
export class PgError extends Error {}

/** Who asked: the person behind sudo, else the current user. */
const caller = () => Deno.env.get("SUDO_USER") || currentUser() || "root";

async function server(name: string): Promise<{ fleet: FleetDef; host: HostDef }> {
  const fleet = await loadFleet();
  const host = (await loadHosts()).find((h) => h.name === name);
  if (!host) throw new PgError(`There is no host named ${name} in the model.`);
  if (host.kind === "workstation") {
    throw new PgError("PostgreSQL instances are for servers, not workstations.");
  }
  return { fleet, host };
}

function find(fleet: FleetDef, host: HostDef, name: string): Instance | undefined {
  return instancesOf(host, usersFor(fleet, host), fleet).find((i) => i.name === name);
}

function need(fleet: FleetDef, host: HostDef, name: string): Instance {
  const bad = checkName(name);
  if (bad) throw new PgError(bad);
  const i = find(fleet, host, name);
  if (!i) {
    throw new PgError(
      `There is no instance named ${name} on ${host.name}: create it with archon pg ensure ${name}.`,
    );
  }
  return i;
}

function owned(i: Instance): asserts i is Instance & { record: PgRecord } {
  if (!i.record) {
    throw new PgError(
      `${i.name} is in the model but not created yet: run archon pg ensure ${i.name}.`,
    );
  }
}

/** Run a command body; a PgError becomes one sentence on stderr (and JSON with --json). */
async function guarded(json: boolean, f: () => Promise<number>): Promise<number> {
  try {
    return await f();
  } catch (e) {
    const msg = (e as Error).message;
    if (json) console.log(JSON.stringify({ ok: false, error: msg }));
    else console.error(msg);
    return 1;
  }
}

function collector(
  check = false,
): Sink & { changes: string[]; warnings: string[]; failures: string[] } {
  const c = {
    check,
    changes: [] as string[],
    warnings: [] as string[],
    failures: [] as string[],
    change: (m: string) => c.changes.push(m),
    warn: (m: string) => c.warnings.push(m),
    fail: (m: string, fix?: string) => c.failures.push(fix ? `${m} (${fix})` : m),
  };
  return c;
}

async function notifyOwner(event: string, what: string, key: string) {
  const { notify } = await import("../notify/events.ts");
  await notify({ event, level: "info", what, todo: "Nothing.", key }).catch(() => {});
}

// ------------------------------------------------------------------ read

export interface InstanceView {
  name: string;
  version: number;
  port: number | null;
  status: string;
  unit: string;
  environment: string;
  protected: boolean;
  inModel: boolean;
  owned: boolean;
  published: string | null;
  data: string | null;
}

async function views(
  fleet: FleetDef,
  host: HostDef,
): Promise<{ mine: InstanceView[]; foreign: string[] }> {
  const all = await clusters();
  const mine = instancesOf(host, usersFor(fleet, host), fleet).map((i) => {
    const c = all.find((x) => x.name === i.name && x.version === i.version);
    return {
      name: i.name,
      version: i.version,
      port: c?.port ?? i.port ?? null,
      status: !i.record ? "not created" : c?.status ?? "missing",
      unit: unitOf(i.version, i.name),
      environment: i.environment,
      protected: i.protected,
      inModel: i.inModel,
      owned: !!i.record,
      published: i.published ? publishedName(fleet, host, i.name) ?? host.name : null,
      data: c?.data ?? null,
    };
  });
  const foreign = all.filter((c) =>
    !mine.some((m) => m.owned && m.name === c.name && m.version === c.version)
  )
    .map((c) => `${c.version}/${c.name} (port ${c.port}, ${c.status})`);
  return { mine, foreign };
}

export function pgList(hostName: string, json: boolean): Promise<number> {
  return guarded(json, async () => {
    const { fleet, host } = await server(hostName);
    const { mine, foreign } = await views(fleet, host);
    if (json) {
      console.log(
        JSON.stringify({ host: host.name, instances: mine, notArchons: foreign }, null, 2),
      );
      return 0;
    }
    if (!mine.length) {
      console.log(`No PostgreSQL instances on ${host.name}. Create one: archon pg ensure prime`);
    }
    for (const m of mine) {
      console.log(
        `${m.name.padEnd(12)} PostgreSQL ${m.version}  port ${String(m.port ?? "-").padEnd(5)}  ${
          m.status.padEnd(12)
        } ${m.environment}${m.protected ? " (protected)" : ""}${
          m.published ? `  published at ${m.published}` : "  private"
        }`,
      );
    }
    if (foreign.length) console.log(`Not Archon's (left alone): ${foreign.join(", ")}`);
    return 0;
  });
}

export function pgStatus(hostName: string, name: string, json: boolean): Promise<number> {
  return guarded(json, async () => {
    const { fleet, host } = await server(hostName);
    need(fleet, host, name);
    const { mine } = await views(fleet, host);
    const v = mine.find((m) => m.name === name)!;
    const ready = v.port
      ? (await run(["pg_isready", "-q", "-h", "/var/run/postgresql", "-p", String(v.port)])).ok
      : false;
    const out = { ...v, accepting: ready };
    if (json) console.log(JSON.stringify(out, null, 2));
    else {
      for (const [k, val] of Object.entries(out)) console.log(`${k.padEnd(12)} ${val ?? "-"}`);
      if (!v.published) {
        console.log(
          "Private: only this server reaches it (archon pg publish " + name + " to change that).",
        );
      }
    }
    return v.status === "online" && ready ? 0 : 1;
  });
}

// ------------------------------------------------------------------ ensure

/** The ensure document (stable; apps read it). */
export interface EnsureResult {
  ok: true;
  name: string;
  version: number;
  port: number;
  status: string;
  unit: string;
  created: boolean;
  changes: string[];
}

/**
 * Unprivileged first look (an app's path): when the instance exists, is
 * Archon's, and is online, there is nothing to do and nothing to elevate for.
 */
export async function pgEnsureReady(
  hostName: string,
  name: string,
  version: string | undefined,
  json: boolean,
): Promise<number | undefined> {
  try {
    const { fleet, host } = await server(hostName);
    const i = find(fleet, host, name);
    if (!pgOn(host) || !i?.record || (version && Number(version) !== i.version)) {
      return await cannotElevate(json, host.name, name, pgOn(host));
    }
    const c = (await clusters()).find((x) => x.name === name && x.version === i.version);
    if (c?.status !== "online") return await cannotElevate(json, host.name, name, pgOn(host));
    print(json, {
      ok: true,
      name,
      version: i.version,
      port: c.port,
      status: c.status,
      unit: unitOf(i.version, name),
      created: false,
      changes: [],
    });
    return 0;
  } catch {
    return undefined;
  }
}

/**
 * An account that cannot become root (a service account such as s-app1) gets one plain
 * sentence instead of a sudo prompt; an operator's ensure elevates as usual.
 */
async function cannotElevate(
  json: boolean,
  host: string,
  name: string,
  on: boolean,
): Promise<number | undefined> {
  const groups = (await run(["id", "-nG"])).stdout.trim().split(/\s+/);
  if (groups.includes("sudo") || groups.includes("archon-ops")) return undefined;
  const msg = on
    ? `${name} is not running on ${host} yet: an operator runs archon pg ensure ${name}.`
    : `PostgreSQL is off on ${host}: an operator turns it on with archon pg on.`;
  if (json) console.log(JSON.stringify({ ok: false, error: msg }));
  else console.error(msg);
  return 1;
}

function print(json: boolean, r: EnsureResult) {
  if (json) console.log(JSON.stringify(r, null, 2));
  else {
    for (const c of r.changes) console.log(`  ${c}`);
    console.log(
      `${r.name}: PostgreSQL ${r.version} on port ${r.port}, ${r.status}${
        r.created ? " (created)" : ""
      }.`,
    );
  }
}

export function pgEnsure(
  hostName: string,
  name: string,
  version: string | undefined,
  json: boolean,
): Promise<number> {
  return guarded(json, async () => {
    const bad = checkName(name);
    if (bad) throw new PgError(bad);
    if (version !== undefined && !/^\d{2}$/.test(version)) {
      throw new PgError(`--version must be a major version such as 18, not "${version}".`);
    }
    const { fleet, host } = await server(hostName);
    if (!pgOn(host)) {
      throw new PgError(
        `PostgreSQL is off on ${host.name}: an operator turns it on with archon pg on (spec 039).`,
      );
    }
    let i = find(fleet, host, name);
    if (i && version && Number(version) !== i.version) {
      throw new PgError(
        `${name} is PostgreSQL ${i.version}; to move it to ${version}, run archon pg upgrade ${name} --to ${version}.`,
      );
    }
    if (!i) {
      // Not in the model: the operator's ensure records it (the host's own archon.sql (opt-in pg)).
      const v = version ? Number(version) : PG.ubuntuVersion;
      i = instancesOf(
        {
          ...host,
          pg: { instances: [...(host.pg?.instances ?? []), { name, version: v }] },
        },
        usersFor(fleet, host),
        fleet,
      )
        .find((x) => x.name === name)!;
    }
    const created = !i.record;
    const s = collector();
    const ok = await convergeInstance(fleet, host, i, s, caller());
    if (!ok) throw new PgError(s.failures.join(" "));
    const rec = (await readState(host.name)).instances[name];
    const c = (await clusters()).find((x) => x.name === name && x.version === rec?.version);
    if (created) {
      await journal(
        "archon-pg",
        `instance ${name} (PostgreSQL ${rec.version}, port ${rec.port}) created by ${caller()}`,
      );
      await notifyOwner(
        "PostgreSQL instance created",
        `${caller()} created the PostgreSQL ${rec.version} instance ${name} on ${host.name}, port ${rec.port}, private to the server. It is recorded in archon.sql (opt-in pg);`,
        `pg:${host.name}:${name}:created`,
      );
    }
    print(json, {
      ok: true,
      name,
      version: rec.version,
      port: rec.port,
      status: c?.status ?? "unknown",
      unit: unitOf(rec.version, name),
      created,
      changes: s.changes,
    });
    for (const w of s.warnings) console.error(`warning: ${w}`);
    return c?.status === "online" ? 0 : 1;
  });
}

// ------------------------------------------------------------------ lifecycle

export function pgControl(
  hostName: string,
  name: string,
  action: "start" | "stop" | "restart" | "reload",
): Promise<number> {
  return guarded(false, async () => {
    const { fleet, host } = await server(hostName);
    const i = need(fleet, host, name);
    owned(i);
    const r = await run(["pg_ctlcluster", String(i.version), name, action]);
    if (!r.ok) throw new PgError(`${action} ${name} failed: ${r.stderr.trim().split("\n").pop()}`);
    await journal("archon-pg", `${action} ${name} by ${caller()}`);
    console.log(
      `${name}: ${action} done.${
        action === "stop"
          ? " The next apply starts it again; archon pg remove takes it away for good."
          : ""
      }`,
    );
    return 0;
  });
}

// ------------------------------------------------------------------ destructive guard

// The owner's approval is the fleet's, so it is in the fleet's own copy of the
// spec's decisions: fleets/<id>/specs/038-pg/spec.md (spec 046-engine-instance).
const SPEC_FILE = () => join(P.fleetDir, "specs", SPEC, "spec.md");

/** Destructive operations: the owner's approve marker in spec 038 and --confirm-destroy NAME. */
export async function guardDestructive(
  op: string,
  name: string,
  confirm: string | undefined,
): Promise<void> {
  const spec = (await readTextOr(SPEC_FILE())) ?? "";
  if (!approvedInSpec(spec)) {
    throw new PgError(
      `${op} ${name} is destructive and specs/${SPEC}/spec.md has no "approve: destructive" line: the owner adds it (and asks for this) before it runs.`,
    );
  }
  if (confirm !== name) {
    throw new PgError(
      `${op} ${name} is destructive: repeat the instance's name with --confirm-destroy ${name}.`,
    );
  }
}

// ------------------------------------------------------------------ backup / restore

/** Dump an instance (pg_dumpall, zstd) into /var/backups/archon/pg/<name>/; keep the last 7. */
export async function dumpInstance(i: Instance & { record: PgRecord }): Promise<string> {
  const dir = join(PG.dumps, i.name);
  await ensureDir(dir);
  await Deno.chmod(dir, 0o700);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 23);
  const file = join(dir, `${i.name}-pg${i.record.version}-${stamp}.sql.zst`);
  const dump = new Deno.Command("runuser", {
    args: [
      "-u",
      "postgres",
      "--",
      "pg_dumpall",
      "--cluster",
      `${i.record.version}/${i.name}`,
      "--clean",
      "--if-exists",
    ],
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const zstd = new Deno.Command("zstd", {
    args: ["-q", "-T0", "-o", file],
    stdin: "piped",
    stderr: "piped",
  }).spawn();
  await dump.stdout.pipeTo(zstd.stdin);
  const [d, z] = await Promise.all([dump.output(), zstd.output()]);
  if (!d.success || !z.success) {
    await Deno.remove(file).catch(() => {});
    throw new PgError(
      `The dump of ${i.name} failed: ${
        new TextDecoder().decode(d.success ? z.stderr : d.stderr).trim().split("\n").pop() ||
        "no reason given"
      }`,
    );
  }
  await Deno.chmod(file, 0o600);
  const all = [];
  for await (const e of Deno.readDir(dir)) if (e.name.endsWith(".sql.zst")) all.push(e.name);
  for (const old of all.sort().slice(0, -PG.keepDumps)) {
    await Deno.remove(join(dir, old)).catch(() => {});
  }
  return file;
}

export function pgBackup(
  hostName: string,
  name: string,
  allInstances: boolean,
  json: boolean,
): Promise<number> {
  return guarded(json, async () => {
    const { fleet, host } = await server(hostName);
    const targets = allInstances
      ? instancesOf(host, usersFor(fleet, host), fleet).filter((i) => i.record)
      : [need(fleet, host, name)];
    const out: Array<{ name: string; file: string }> = [];
    for (const i of targets) {
      owned(i);
      out.push({ name: i.name, file: await dumpInstance(i) });
    }
    if (json) console.log(JSON.stringify({ ok: true, dumps: out }, null, 2));
    else {for (const o of out) {
        console.log(
          `${o.name}: ${o.file} (archived nightly with the rest of ${dirname(PG.dumps)}, spec 016)`,
        );
      }}
    return 0;
  });
}

export function pgRestore(
  hostName: string,
  name: string,
  from: string | undefined,
  confirm: string | undefined,
): Promise<number> {
  return guarded(false, async () => {
    const { fleet, host } = await server(hostName);
    const i = need(fleet, host, name);
    owned(i);
    await guardDestructive("restore", name, confirm);
    let file = from;
    if (!file) {
      const dir = join(PG.dumps, name);
      const all: string[] = [];
      if (await exists(dir)) {
        for await (const e of Deno.readDir(dir)) {
          if (e.name.endsWith(".sql.zst")) all.push(e.name);
        }
      }
      if (!all.length) {
        throw new PgError(`There is no dump of ${name} in ${dir}: give one with --from.`);
      }
      file = join(dir, all.sort().pop()!);
    }
    if (!(await exists(file))) throw new PgError(`${file} does not exist.`);
    // What is there now is dumped first, so a restore can itself be undone.
    const before = await dumpInstance(i);
    const unz = new Deno.Command("zstd", { args: ["-dc", file], stdout: "piped" }).spawn();
    const load = new Deno.Command("runuser", {
      args: [
        "-u",
        "postgres",
        "--",
        "psql",
        "--cluster",
        `${i.record.version}/${name}`,
        "-X",
        "-q",
        "-d",
        "postgres",
      ],
      stdin: "piped",
      stdout: "null",
      stderr: "piped",
    }).spawn();
    await unz.stdout.pipeTo(load.stdin);
    const l = await load.output();
    await unz.status;
    // The dump carries the roles' old verifiers: Archon's passwords are set again.
    for (const r of i.roles) await Deno.remove(secretPath(name, r.name) + ".set").catch(() => {});
    await convergeInstance(fleet, host, i, collector(), caller());
    await journal("archon-pg", `restore ${name} from ${file} by ${caller()} (before: ${before})`);
    console.log(`${name}: restored from ${file}. What was there before is in ${before}.`);
    if (!l.success) {
      console.error(new TextDecoder().decode(l.stderr).trim().split("\n").slice(-3).join("\n"));
    }
    return l.success ? 0 : 1;
  });
}

// ------------------------------------------------------------------ upgrade / remove

export function pgUpgrade(
  hostName: string,
  name: string,
  to: string | undefined,
  confirm: string | undefined,
): Promise<number> {
  return guarded(false, async () => {
    if (!to || !/^\d{2}$/.test(to)) {
      throw new PgError("Say which major version to upgrade to: --to 18.");
    }
    const { fleet, host } = await server(hostName);
    const i = need(fleet, host, name);
    owned(i);
    if (Number(to) <= i.record.version) {
      throw new PgError(`${name} is already PostgreSQL ${i.record.version}; --to must be newer.`);
    }
    await guardDestructive("upgrade", name, confirm);
    // Never in place without a backup (FR-008).
    const dump = await dumpInstance(i);
    console.log(`${name}: backed up to ${dump}`);
    // The new version's packages, the same way ensure gets them (PGDG for non-Ubuntu versions).
    const s = collector();
    if (!(await ensureVersion(fleet, host, Number(to), s))) throw new PgError(s.failures.join(" "));
    const r = await run([
      "pg_upgradecluster",
      "-v",
      to,
      "-m",
      "upgrade",
      String(i.record.version),
      name,
    ], { inherit: true });
    if (!r.ok) {
      throw new PgError(
        `pg_upgradecluster failed; ${name} is still PostgreSQL ${i.record.version}, and the backup is ${dump}.`,
      );
    }
    const now = (await clusters()).find((c) => c.name === name && c.version === Number(to));
    await writeRecord(host.name, name, {
      ...i.record,
      version: Number(to),
      port: now?.port ?? i.record.port,
      retired: [...(i.record.retired ?? []), i.record.version],
    });
    const fresh = (await loadHosts()).find((h) => h.name === host.name)!;
    await convergeInstance(fleet, fresh, find(fleet, fresh, name)!, collector(), caller());
    await journal("archon-pg", `upgrade ${name} ${i.record.version} -> ${to} by ${caller()}`);
    await notifyOwner(
      "PostgreSQL instance upgraded",
      `${caller()} upgraded ${name} on ${host.name} from PostgreSQL ${i.record.version} to ${to}. The old cluster is kept, stopped, until archon pg remove ${name} --version ${i.record.version}. Backup: ${dump}.`,
      `pg:${host.name}:${name}:upgrade:${to}`,
    );
    console.log(
      `${name}: now PostgreSQL ${to}. The old ${i.record.version} cluster is kept, stopped; remove it with archon pg remove ${name} --version ${i.record.version} --confirm-destroy ${name}.`,
    );
    return 0;
  });
}

export function pgRemove(
  hostName: string,
  name: string,
  version: string | undefined,
  confirm: string | undefined,
): Promise<number> {
  return guarded(false, async () => {
    const { fleet, host } = await server(hostName);
    const i = need(fleet, host, name);
    owned(i);
    await guardDestructive("remove", name, confirm);
    const v = version ? Number(version) : i.record.version;
    const retiredOnly = v !== i.record.version;
    if (retiredOnly && !(i.record.retired ?? []).includes(v)) {
      throw new PgError(`${name} has no PostgreSQL ${v} cluster that Archon made.`);
    }
    if (!retiredOnly && i.inModel) {
      throw new PgError(
        `${name} is in the model (fleets/<fleet>/hosts/${host.name}/host.ts): take it out there first, or the next apply makes it again.`,
      );
    }
    const dump = retiredOnly ? undefined : await dumpInstance(i);
    const r = await run(["pg_dropcluster", "--stop", String(v), name]);
    if (!r.ok) {
      throw new PgError(`pg_dropcluster ${v} ${name} failed: ${r.stderr.trim().split("\n").pop()}`);
    }
    if (retiredOnly) {
      await writeRecord(host.name, name, {
        ...i.record,
        retired: (i.record.retired ?? []).filter((x) => x !== v),
      });
    } else {
      await writeRecord(host.name, name, undefined);
      await Deno.remove(join(PG.secrets, name), { recursive: true }).catch(() => {});
    }
    await journal("archon-pg", `remove ${v}/${name} by ${caller()}`);
    await notifyOwner(
      "PostgreSQL instance removed",
      `${caller()} removed ${v}/${name} on ${host.name}.${dump ? ` Its last dump: ${dump}.` : ""}`,
      `pg:${host.name}:${name}:remove:${v}`,
    );
    console.log(`${v}/${name} removed.${dump ? ` Its last dump is ${dump}.` : ""}`);
    return 0;
  });
}

// ------------------------------------------------------------------ maintain

export const MAINTAIN_SQL = {
  connections:
    `SELECT coalesce(datname, '-') || ' ' || coalesce(state, 'background') || ' ' || count(*) FROM pg_stat_activity GROUP BY datname, state ORDER BY 1`,
  max: `SHOW max_connections`,
  sizes:
    `SELECT datname || ' ' || pg_size_pretty(pg_database_size(datname)) FROM pg_database WHERE NOT datistemplate ORDER BY pg_database_size(datname) DESC`,
  bloat:
    `SELECT schemaname || '.' || relname || ' ' || n_dead_tup || ' dead of ' || (n_live_tup + n_dead_tup) || ' (' || round(100.0 * n_dead_tup / greatest(n_live_tup + n_dead_tup, 1)) || '%)' FROM pg_stat_user_tables WHERE n_dead_tup > 1000 ORDER BY n_dead_tup DESC LIMIT 10`,
};

export function pgMaintain(hostName: string, name: string, json: boolean): Promise<number> {
  return guarded(json, async () => {
    if (!isRoot()) throw new PgError("archon pg maintain runs as root (sudo archon pg maintain).");
    const { fleet, host } = await server(hostName);
    const i = need(fleet, host, name);
    owned(i);
    const v = i.record.version;
    const vac = await run([
      "vacuumdb",
      "--cluster",
      `${v}/${name}`,
      "--all",
      "--analyze",
      "--quiet",
    ], { asUser: "postgres" });
    const q = async (sql: string, db = "postgres") =>
      (await psql(v, name, sql, db)).stdout.trim().split("\n").filter(Boolean);
    const dbs = await q(`SELECT datname FROM pg_database WHERE datallowconn AND NOT datistemplate`);
    const bloat: Record<string, string[]> = {};
    for (const d of dbs) bloat[d] = await q(MAINTAIN_SQL.bloat, d);
    const report = {
      name,
      vacuumAnalyze: vac.ok ? "done" : vac.stderr.trim(),
      maxConnections: Number((await q(MAINTAIN_SQL.max))[0]),
      connections: await q(MAINTAIN_SQL.connections),
      sizes: await q(MAINTAIN_SQL.sizes),
      bloat,
    };
    if (json) console.log(JSON.stringify(report, null, 2));
    else {
      console.log(`${name}: VACUUM ANALYZE ${report.vacuumAnalyze}`);
      console.log(`Connections (of ${report.maxConnections}):`);
      for (const c of report.connections) console.log(`  ${c}`);
      console.log("Databases:");
      for (const s of report.sizes) console.log(`  ${s}`);
      console.log("Tables with the most dead rows:");
      for (const [d, rows] of Object.entries(bloat)) {
        for (const r of rows) console.log(`  ${d}: ${r}`);
      }
    }
    return vac.ok ? 0 : 1;
  });
}

// ------------------------------------------------------------------ publish

export function pgPublish(
  hostName: string,
  name: string,
  on: boolean,
  localOnly = false,
): Promise<number> {
  return guarded(false, async () => {
    const { fleet, host } = await server(hostName);
    const i = need(fleet, host, name);
    owned(i);
    if (on && !host.ip) {
      throw new PgError(
        `${host.name} has no address in the model (ip), so ${name} cannot be published.`,
      );
    }
    const pub = publishedName(fleet, host, name);
    if (on && !pub) {
      throw new PgError(
        `The fleet has no web domain (fleet.web), so ${name} has no name to publish at.`,
      );
    }
    const scope = localOnly ? "the local networks only" : "every address the router lets through";
    if (on === i.published && (!on || localOnly === i.localOnly)) {
      console.log(
        on
          ? `${name} is already published at ${pub}:${i.record.port}, for ${scope}.`
          : `${name} is already private.`,
      );
      return 0;
    }
    await writeRecord(host.name, name, {
      ...i.record,
      published: on
        ? { at: new Date().toISOString(), by: caller(), ...(localOnly ? { localOnly: true } : {}) }
        : undefined,
    });
    // Apply it now: the firewall rule, listen_addresses, pg_hba.conf, TLS.
    const { apply } = await import("../apply/apply.ts");
    const fresh = (await loadHosts()).find((h) => h.name === host.name)!;
    const res = await apply(fresh, { check: false, only: ["files", "databases"] });
    if (res.failed) {
      throw new PgError(
        `The change is recorded but did not apply cleanly: sudo archon apply shows why.`,
      );
    }
    await journal("archon-pg", `${on ? "publish" : "unpublish"} ${name} by ${caller()}`);
    await notifyOwner(
      on ? "PostgreSQL instance published" : "PostgreSQL instance made private",
      on
        ? `${caller()} published ${name} on ${host.name} at ${pub}, port ${i.record.port}, for ${scope} (TLS 1.3, scram-sha-256; postgres is refused over any network).`
        : `${caller()} made ${name} on ${host.name} private again: only the server itself reaches it.`,
      `pg:${host.name}:${name}:${on ? "publish" : "unpublish"}`,
    );
    console.log(
      on
        ? `${name} is published at ${pub}, port ${i.record.port}, for ${scope}${
          localOnly ? "" : " (the router decides what reaches the server from outside)"
        }. Clients: archon pg show ${name} --form external. People sign in with their Linux password, which PostgreSQL learns when they type it on ${host.name} from now on (sudo -k && sudo -v); archon pg test ${name} checks it. Undo: archon pg unpublish ${name}.`
        : `${name} is private again (localhost only; the firewall rule is gone).`,
    );
    return 0;
  });
}

// ------------------------------------------------------------------ connect

/**
 * Your libpq service (spec 039): on the server, your own role over the socket,
 * no password (peer). --remote: the published name with TLS; a person types
 * their Linux password (libpq asks), a service gets its generated one in its
 * own ~/.pgpass.
 */
export function pgConnect(
  hostName: string,
  name: string,
  write: boolean,
  remote: boolean,
  json: boolean,
): Promise<number> {
  return guarded(json, async () => {
    const { fleet, host } = await server(hostName);
    const i = need(fleet, host, name);
    owned(i);
    const me = currentUser();
    const role = i.roles.find((r) => r.name === me);
    if (!role) {
      throw new PgError(
        `${me} has no role in ${name}: roles are the people in the model and the service accounts its databases name (spec 039).`,
      );
    }
    const pub = publishedName(fleet, host, name);
    if (remote && !i.published) {
      throw new PgError(
        `${name} is private: an operator publishes it with archon pg publish ${name}.`,
      );
    }
    const mine = new Set(
      (await run(["id", "-nG", me])).stdout.trim().split(/\s+/).filter(Boolean),
    );
    const info = connectInfo({ ...i, port: i.record.port }, me, {
      publishedHost: pub,
      remote,
      inGroup: (g) => mine.has(g),
    });
    // A service's password for clients elsewhere; people use their Linux password.
    let pw: string | undefined;
    if (remote && role.kind === "service") {
      try {
        pw = (await Deno.readTextFile(secretPath(name, me))).trim();
      } catch {
        throw new PgError(
          `${me}'s password for ${name} is not there yet: an operator runs archon apply.`,
        );
      }
    }
    if (!write) {
      if (json) console.log(JSON.stringify({ ok: true, ...info }, null, 2));
      else console.log(`# ~/.pg_service.conf\n${serviceBlock(info)}`);
      return 0;
    }
    const home = Deno.env.get("HOME") ?? await homeDir(me);
    const files: { service: string; pgpass?: string } = { service: join(home, ".pg_service.conf") };
    const write0600 = async (path: string, content: string) => {
      const tmp = `${path}.archon-${Deno.pid}`;
      await Deno.writeTextFile(tmp, content, { mode: 0o600 });
      await Deno.chmod(tmp, 0o600);
      await Deno.rename(tmp, path);
    };
    await write0600(
      files.service,
      upsertSection((await readTextOr(files.service)) ?? "", info.service, serviceBlock(info)),
    );
    if (pw) {
      files.pgpass = join(home, ".pgpass");
      await write0600(
        files.pgpass,
        upsertPgpass((await readTextOr(files.pgpass)) ?? "", pgpassLine(info, pw)),
      );
    }
    if (json) console.log(JSON.stringify({ ok: true, ...info, files }, null, 2));
    else {
      console.log(
        `Wrote the [${info.service}] service to ${files.service}${
          files.pgpass ? ` and your password to ${files.pgpass}` : ""
        } (0600). Connect: psql service=${info.service}${
          remote && role.kind === "human" ? " (it asks for your Linux password)" : ""
        }`,
      );
    }
    return 0;
  });
}

// ------------------------------------------------------------------ who

export interface RoleView {
  role: string;
  kind: string;
  linuxAccount: boolean;
  login: boolean;
  superuser: boolean;
  /** null when not root (only the superuser may see whether a password is set). */
  password: boolean | null;
  memberOf: string[];
}

/** Roles and their Linux identities; exit 1 when one breaks spec 039's rules. */
export function pgWho(hostName: string, name: string, json: boolean): Promise<number> {
  return guarded(json, async () => {
    const { fleet, host } = await server(hostName);
    const i = need(fleet, host, name);
    owned(i);
    const root = isRoot();
    const sql =
      `SELECT r.rolname, coalesce(shobj_description(r.oid, 'pg_authid'), ''), r.rolcanlogin, r.rolsuper,
        ${root ? "(SELECT rolpassword IS NOT NULL FROM pg_authid a WHERE a.oid = r.oid)" : "NULL"},
        coalesce((SELECT string_agg(g.rolname, ',' ORDER BY g.rolname) FROM pg_auth_members m
          JOIN pg_roles g ON g.oid = m.roleid WHERE m.member = r.oid), '')
       FROM pg_roles r WHERE r.rolname NOT LIKE 'pg\\_%' ORDER BY 1`;
    const r = await run(
      [
        "psql",
        "--cluster",
        `${i.record.version}/${name}`,
        "-X",
        "-q",
        "-A",
        "-t",
        "-F",
        "\x1f",
        "-d",
        "postgres",
      ],
      { asUser: root ? "postgres" : undefined, stdin: sql },
    );
    if (!r.ok) {
      throw new PgError(`Could not read ${name}'s roles: ${r.stderr.trim().split("\n").pop()}`);
    }
    const views: RoleView[] = [];
    for (const f of r.stdout.split("\n").filter(Boolean).map((l) => l.split("\x1f"))) {
      views.push({
        role: f[0],
        kind: f[0] === "postgres"
          ? "superuser"
          : f[1].replace(/^archon: (\w+).*$/, "$1") || "unmanaged",
        linuxAccount: (await run(["getent", "passwd", f[0]])).ok,
        login: f[2] === "t",
        superuser: f[3] === "t",
        password: f[4] === "" ? null : f[4] === "t",
        memberOf: f[5] ? f[5].split(",") : [],
      });
    }
    const problems = whoProblems(views, i.published);
    if (json) {
      console.log(
        JSON.stringify(
          { ok: problems.length === 0, instance: name, roles: views, problems },
          null,
          2,
        ),
      );
    } else {
      for (const v of views) {
        console.log(
          `${v.role.padEnd(16)} ${v.kind.padEnd(10)} ${v.login ? "login" : "no login"}${
            v.superuser ? " · superuser" : ""
          }${v.linuxAccount ? "" : " · no Linux account"}${
            v.password === true ? " · password" : ""
          }${v.memberOf.length ? ` · ${v.memberOf.join(", ")}` : ""}`,
        );
      }
      for (const p of problems) console.log(`problem: ${p}`);
      if (!root) console.log("(passwords are visible to root only: sudo archon pg who)");
    }
    return problems.length ? 1 : 0;
  });
}

/** Spec 039's rules, as sentences: every login is a Linux account; postgres is the only superuser. */
export function whoProblems(views: RoleView[], published: boolean): string[] {
  const out: string[] = [];
  for (const v of views) {
    if (v.role === "postgres") continue;
    if (v.login && !v.linuxAccount) out.push(`${v.role} can log in but has no Linux account.`);
    if (v.superuser) out.push(`${v.role} is a superuser; only postgres should be (through sudo).`);
    if (v.kind === "human" && v.password === true && !published) {
      out.push(`${v.role} has a password, but the instance is private (peer needs none).`);
    }
  }
  return out;
}

// ------------------------------------------------------------------ passwords from PAM

/**
 * Run by the PAM hook (spec 039) with a person's password on stdin, after
 * Linux accepted or changed it: each instance where they have a role gets a
 * SCRAM verifier of that same password, so a published instance takes their
 * Linux password. Nothing is printed or stored but the verifier.
 */
export async function pgPasswdSync(hostName: string, user: string): Promise<number> {
  // Every outcome is journaled (journalctl -t archon-pg), never the password.
  const say = (m: string) => journal("archon-pg", `password sync for ${user}: ${m}`);
  if (!isRoot()) {
    await say(`not run as root (uid ${Deno.uid?.()}), so nothing was synced`);
    return 1;
  }
  const pw = new TextDecoder().decode(await new Response(Deno.stdin.readable).arrayBuffer())
    .replace(/\0+$/, "").replace(/\n$/, "");
  if (!pw) return 0;
  const fleet = await loadFleet();
  const host = (await loadHosts()).find((h) => h.name === hostName);
  if (!host) return await say(`no host ${hostName} in the model`), 0;
  if (!pgOn(host)) return await say("PostgreSQL is off"), 0;
  let any = false;
  for (const i of instancesOf(host, usersFor(fleet, host), fleet)) {
    const role = i.roles.find((r) => r.name === user && r.kind === "human");
    if (!role || !i.record) continue;
    // Only a published instance takes a password; on the server, peer needs none.
    if (!i.published) continue;
    any = true;
    const cur = await psql(
      i.record.version,
      i.name,
      `SELECT coalesce(rolpassword, '') FROM pg_authid WHERE rolname = ${quoteLit(user)}`,
    );
    if (!cur.ok) {
      await say(`could not read the role in ${i.name} (psql exit ${cur.code})`);
      continue;
    }
    if (await scramMatches(cur.stdout.trim(), pw)) {
      await say(`${i.name} already has it`);
      continue;
    }
    const v = await scramVerifier(pw, undefined, PG.humanIterations);
    const r = await psql(
      i.record.version,
      i.name,
      `ALTER ROLE ${quoteIdent(user)} PASSWORD '${v}'`,
    );
    await say(
      r.ok
        ? `${i.name} now takes the Linux password`
        : `could not set it in ${i.name} (psql exit ${r.code})`,
    );
  }
  if (!any) await say("no published instance where this account has a role");
  return 0;
}
