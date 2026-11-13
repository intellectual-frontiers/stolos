// Spec 048-observe-by-query (Article 25): what this machine recorded about
// itself (its install, its latest verify, what each run did, the operators'
// switches) stays on the machine, never in Git.
//
//   /var/lib/archon/archon.sql             canonical: readable SQL, one INSERT
//                                          per record, in a fixed order
//   /var/lib/archon/archon.auto.sqlite.db  built from archon.sql whenever it
//                                          changes, for osquery (its tables
//                                          archon_install, archon_verify, ...)
//
// Records are JSON bodies keyed by (host, kind, name); views give each kind
// its columns. Writers load archon.sql into an in-memory SQLite, change it,
// and write both files back (atomically, through a rename).

import { count } from "../core/telemetry.ts";
import { DatabaseSync } from "node:sqlite";
import { join } from "../core/path.ts";
import { ensureDir, readTextOr } from "../core/fsx.ts";
import { P } from "../core/paths.ts";

export const STATE_SQL = "archon.sql";
export const STATE_DB = "archon.auto.sqlite.db";

/** Where this machine keeps archon.sql (tests pass their own folder). */
export function stateDir(): string {
  return P.state;
}

export type Kind = "install" | "verify" | "prov" | "optin" | "pg" | "inventory";

export interface StateRecord<T = unknown> {
  host: string;
  kind: Kind;
  name: string;
  at: string;
  body: T;
}

/** The schema: one table, and a view per kind with its columns (osquery reads the views). */
export const SCHEMA = `CREATE TABLE IF NOT EXISTS archon_record (
  host TEXT NOT NULL,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  at TEXT NOT NULL,
  body TEXT NOT NULL,
  PRIMARY KEY (host, kind, name)
);
CREATE VIEW IF NOT EXISTS archon_install AS SELECT host, at AS installed,
  json_extract(body, '$.ubuntu') AS ubuntu, json_extract(body, '$.archon') AS archon_commit,
  json_extract(body, '$.ok') AS ok, json_extract(body, '$.checks.passed') AS passed,
  json_extract(body, '$.checks.total') AS total, json_extract(body, '$.problems') AS problems
  FROM archon_record WHERE kind = 'install';
CREATE VIEW IF NOT EXISTS archon_verify AS SELECT host, at, json_extract(body, '$.passed') AS passed,
  json_extract(body, '$.total') AS total, json_extract(body, '$.failed') AS failed,
  json_extract(body, '$.warned') AS warned
  FROM archon_record WHERE kind = 'verify';
CREATE VIEW IF NOT EXISTS archon_prov AS SELECT host, name AS run, at,
  json_extract(body, '$.command') AS command, json_extract(body, '$.ok') AS ok,
  json_extract(body, '$.changes') AS changes, json_extract(body, '$.trace') AS trace_id, body
  FROM archon_record WHERE kind = 'prov';
CREATE VIEW IF NOT EXISTS archon_optin AS SELECT host, name, at,
  json_extract(body, '$.enabled') AS enabled, json_extract(body, '$.by') AS by,
  json_extract(body, '$.data') AS data
  FROM archon_record WHERE kind = 'optin';
CREATE VIEW IF NOT EXISTS archon_inventory AS SELECT host, at,
  json_extract(body, '$.vendor') AS vendor, json_extract(body, '$.model') AS model,
  json_extract(body, '$.serial') AS serial, json_extract(body, '$.cpus') AS cpus,
  json_extract(body, '$.memMiB') AS mem_mib, json_extract(body, '$.disks') AS disks,
  json_extract(body, '$.macs') AS macs
  FROM archon_record WHERE kind = 'inventory';
`;

/** The views osquery exposes, and their columns (automatic table construction). */
export const VIEWS: Record<string, string[]> = {
  archon_install: [
    "host",
    "installed",
    "ubuntu",
    "archon_commit",
    "ok",
    "passed",
    "total",
    "problems",
  ],
  archon_verify: ["host", "at", "passed", "total", "failed", "warned"],
  archon_prov: ["host", "run", "at", "command", "ok", "changes", "trace_id", "body"],
  archon_optin: ["host", "name", "at", "enabled", "by", "data"],
  archon_inventory: ["host", "at", "vendor", "model", "serial", "cpus", "mem_mib", "disks", "macs"],
};

/** How many provenance records a host keeps (the oldest go first). */
export const PROV_KEEP = 500;

const q = (s: string) => `'${s.replaceAll("'", "''")}'`;

function open(text: string): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(SCHEMA);
  // archon.sql carries the schema too; IF NOT EXISTS makes that harmless.
  if (text.trim()) db.exec(text);
  return db;
}

/** archon.sql for these records: a header, the schema, and one INSERT per record, in order. */
export function dump(db: DatabaseSync): string {
  const rows = db.prepare(
    "SELECT host, kind, name, at, body FROM archon_record ORDER BY host, kind, name",
  ).all() as unknown as Array<Record<string, string>>;
  return [
    "-- archon.sql (spec 048): this machine's own state. Written by archon; readable; never",
    "-- pushed. archon.auto.sqlite.db is built from it for osquery (archon query).",
    "",
    SCHEMA.trim(),
    "",
    ...rows.map((r) =>
      `INSERT INTO archon_record VALUES (${
        [r.host, r.kind, r.name, r.at, r.body].map(q).join(", ")
      });`
    ),
    "",
  ].join("\n");
}

async function load(dir: string): Promise<DatabaseSync> {
  return open((await readTextOr(join(dir, STATE_SQL))) ?? "");
}

async function save(dir: string, db: DatabaseSync): Promise<void> {
  await ensureDir(dir);
  const sql = dump(db);
  const file = join(dir, STATE_SQL);
  if ((await readTextOr(file)) === sql) return;
  const tmp = `${file}.tmp`;
  await Deno.writeTextFile(tmp, sql);
  await Deno.rename(tmp, file);
  await rebuild(dir, sql);
}

/** Build archon.auto.sqlite.db from archon.sql (also after a person edited it). */
export async function rebuild(dir: string, sql?: string): Promise<void> {
  const text = sql ?? (await readTextOr(join(dir, STATE_SQL))) ?? "";
  const target = join(dir, STATE_DB);
  const tmp = `${target}.tmp`;
  await Deno.remove(tmp).catch(() => {});
  const db = new DatabaseSync(tmp);
  db.exec(SCHEMA);
  if (text.trim()) db.exec(text);
  db.close();
  await Deno.chmod(tmp, 0o644).catch(() => {});
  await Deno.rename(tmp, target);
}

function rec<T>(r: Record<string, string>): StateRecord<T> {
  return { host: r.host, kind: r.kind as Kind, name: r.name, at: r.at, body: JSON.parse(r.body) };
}

export async function getRecord<T = unknown>(
  host: string,
  kind: Kind,
  name: string,
  dir = stateDir(),
): Promise<StateRecord<T> | undefined> {
  const db = await load(dir);
  const r = db.prepare(
    "SELECT * FROM archon_record WHERE host = ? AND kind = ? AND name = ?",
  ).get(host, kind, name) as Record<string, string> | undefined;
  return r ? rec<T>(r) : undefined;
}

export async function listRecords<T = unknown>(
  host: string,
  kind: Kind,
  dir = stateDir(),
): Promise<StateRecord<T>[]> {
  const db = await load(dir);
  return (db.prepare(
    "SELECT * FROM archon_record WHERE host = ? AND kind = ? ORDER BY name",
  ).all(host, kind) as unknown as Array<Record<string, string>>).map((r) => rec<T>(r));
}

/** Write one record (replacing the one with the same key). */
export async function putRecord(
  host: string,
  kind: Kind,
  name: string,
  body: unknown,
  dir = stateDir(),
  at = new Date().toISOString(),
): Promise<void> {
  const db = await load(dir);
  db.prepare("INSERT OR REPLACE INTO archon_record VALUES (?, ?, ?, ?, ?)").run(
    host,
    kind,
    name,
    at,
    JSON.stringify(body),
  );
  count("archon.state.writes", 1, { "archon.kind": kind });
  if (kind === "prov") {
    db.prepare(
      `DELETE FROM archon_record WHERE host = ? AND kind = 'prov' AND name NOT IN
        (SELECT name FROM archon_record WHERE host = ? AND kind = 'prov' ORDER BY name DESC LIMIT ?)`,
    ).run(host, host, PROV_KEEP);
  }
  await save(dir, db);
}

/** Remove one record, or every record of a host (retire). */
export async function removeRecords(
  host: string,
  kind?: Kind,
  name?: string,
  dir = stateDir(),
): Promise<void> {
  const db = await load(dir);
  if (kind && name) {
    db.prepare("DELETE FROM archon_record WHERE host = ? AND kind = ? AND name = ?").run(
      host,
      kind,
      name,
    );
  } else if (kind) {
    db.prepare("DELETE FROM archon_record WHERE host = ? AND kind = ?").run(host, kind);
  } else db.prepare("DELETE FROM archon_record WHERE host = ?").run(host);
  await save(dir, db);
}

/** For tests and `archon state`: every record. */
export async function allRecords(dir = stateDir()): Promise<StateRecord[]> {
  const db = await load(dir);
  return (db.prepare("SELECT * FROM archon_record ORDER BY host, kind, name")
    .all() as unknown as Array<
      Record<string, string>
    >).map((r) => rec(r));
}
