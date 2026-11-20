/**
 * Spec 048-observe-by-query (Article 25): what this machine recorded about
 * itself (its install, its latest verify, what each run did, the operators'
 * switches) stays on the machine, never in Git.
 *
 *   /var/lib/archon/archon.sql             canonical: readable SQL, one INSERT
 *                                          per record, in a fixed order
 *   /var/lib/archon/archon.auto.sqlite.db  built from archon.sql whenever it
 *                                          changes, for osquery (its tables
 *                                          archon_install, archon_verify, ...)
 *
 * Records are JSON bodies keyed by (host, kind, name); views give each kind
 * its columns. Writers load archon.sql into an in-memory SQLite, change it,
 * and write both files back (atomically, through a rename).
 *
 * ```mermaid
 * flowchart LR
 *   put["putRecord(host, kind, name, body)"] --> sql["archon.sql<br/>(canonical, readable)"]
 *   sql -->|rebuild| db["archon.auto.sqlite.db"]
 *   db --> views["views: archon_install, archon_verify,<br/>archon_prov, archon_optin, archon_inventory"]
 *   views --> osq["osquery (automatic tables)"]
 * ```
 *
 * @module
 */
// Spec: 048-observe-by-query

import { formatDecodeError, object, string } from "@intellectual-frontiers/core";
import { fs, path } from "@intellectual-frontiers/commons/ts/runtime";
import { count } from "../core/telemetry.ts";
import { DatabaseSync } from "node:sqlite";
import { P } from "../core/paths.ts";

/** The canonical state file: readable SQL. */
export const STATE_SQL = "archon.sql";
/** The SQLite database built from it, for osquery. */
export const STATE_DB = "archon.auto.sqlite.db";

/** Where this machine keeps archon.sql (tests pass their own folder). */
export function stateDir(): string {
  return P.state;
}

/** What a record is about. */
export type Kind =
  | "install"
  | "verify"
  | "prov"
  | "optin"
  | "pg"
  | "inventory"
  | "applied"
  | "sync"
  | "control"
  // Spec 095-proposals: what collectors saw, Ubuntu's own install, the latest
  // state, proposals sent, holds, recordings, and security alerts.
  | "observation"
  | "birth"
  | "snapshot"
  | "proposal"
  | "hold"
  | "recording"
  | "alert"
  // Spec 112-machine-reported-tags: a tag of this machine's own table (`archon tag`, the view archon_tags), and,
  // on the PC, what a machine reported about itself (the observation cache).
  | "tag"
  | "reported";

/** One record: a host's fact of one kind, by name. */
export interface StateRecord<T = unknown> {
  /** The host. */
  host: string;
  /** Its kind. */
  kind: Kind;
  /** Its name within the kind. */
  name: string;
  /** When it was written (ISO time). */
  at: string;
  /** Its content. */
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
CREATE VIEW IF NOT EXISTS archon_observation AS SELECT host, name AS id, at,
  json_extract(body, '$.source') AS source, json_extract(body, '$.who') AS who,
  json_extract(body, '$.kind') AS kind, json_extract(body, '$.name') AS subject,
  json_extract(body, '$.change') AS change, json_extract(body, '$.what') AS what
  FROM archon_record WHERE kind = 'observation';
CREATE VIEW IF NOT EXISTS archon_tags AS SELECT host, json_extract(body, '$.dimension') AS dimension,
  json_extract(body, '$.value') AS value, json_extract(body, '$.source') AS source,
  json_extract(body, '$.set_by') AS set_by, json_extract(body, '$.set_at') AS set_at
  FROM archon_record WHERE kind = 'tag';
CREATE VIEW IF NOT EXISTS archon_proposal AS SELECT host, name AS id, at,
  json_extract(body, '$.by') AS by, json_extract(body, '$.reason') AS reason,
  json_extract(body, '$.items') AS items, json_extract(body, '$.sent') AS sent
  FROM archon_record WHERE kind = 'proposal';
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
  archon_observation: ["host", "id", "at", "source", "who", "kind", "subject", "change", "what"],
  archon_proposal: ["host", "id", "at", "by", "reason", "items", "sent"],
  // Spec 112-machine-reported-tags FR-007, FR-009: the machine's own tags (osquery automatic table; no column may be `path`, which ATC reserves).
  archon_tags: ["host", "dimension", "value", "source", "set_by", "set_at"],
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
  const rows = db
    .prepare("SELECT host, kind, name, at, body FROM archon_record ORDER BY host, kind, name")
    .all()
    .map(row);
  return [
    "-- archon.sql (spec 048): this machine's own state. Written by archon; readable; never",
    "-- pushed. archon.auto.sqlite.db is built from it for osquery (archon query).",
    "",
    SCHEMA.trim(),
    "",
    ...rows.map(
      (r) =>
        `INSERT INTO archon_record VALUES (${[r.host, r.kind, r.name, r.at, r.body]
          .map(q)
          .join(", ")});`,
    ),
    "",
  ].join("\n");
}

/** Each state folder's last write: writes in one process go one after another (see `serially`). */
const writing = new Map<string, Promise<unknown>>();

/**
 * Run a read-modify-write of a state folder after the ones before it: archon.sql is read whole and
 * written whole, so two at once (fleet status asks every server together) would lose one.
 */
function serially<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const key = path.resolve(dir);
  const done = (writing.get(key) ?? Promise.resolve()).then(fn, fn);
  writing.set(
    key,
    done.catch(() => undefined),
  );
  return done;
}

async function load(dir: string): Promise<DatabaseSync> {
  return open((await fs.readTextOr(path.join(dir, STATE_SQL))) ?? "");
}

async function save(dir: string, db: DatabaseSync): Promise<void> {
  await fs.ensureDir(dir);
  const sql = dump(db);
  const file = path.join(dir, STATE_SQL);
  if ((await fs.readTextOr(file)) === sql) return;
  const tmp = `${file}.tmp`;
  await fs.writeTextFile(tmp, sql);
  await fs.rename(tmp, file);
  await rebuild(dir, sql);
}

/** Build archon.auto.sqlite.db from archon.sql (also after a person edited it). */
export async function rebuild(dir: string, sql?: string): Promise<void> {
  const text = sql ?? (await fs.readTextOr(path.join(dir, STATE_SQL))) ?? "";
  const target = path.join(dir, STATE_DB);
  const tmp = `${target}.tmp`;
  await fs.remove(tmp).catch(() => {});
  const db = new DatabaseSync(tmp);
  db.exec(SCHEMA);
  if (text.trim()) db.exec(text);
  db.close();
  await fs.chmod(tmp, 0o644).catch(() => {});
  await fs.rename(tmp, target);
}

/** A row of archon_record, as SQLite gives it. */
const ROW = object({ host: string, kind: string, name: string, at: string, body: string });

/** A row of archon_record, checked (archon writes every one; a hand-edited file may not be). */
function row(r: unknown): { host: string; kind: string; name: string; at: string; body: string } {
  const d = ROW(r);
  if (d.kind === "err")
    throw new Error(`archon.sql: a malformed record: ${formatDecodeError(d.error)}`);
  return d.value;
}

function rec<T>(r: unknown): StateRecord<T> {
  const { host, kind, name, at, body } = row(r);
  // The kind and the body are what putRecord wrote for this kind.
  return { host, kind: kind as Kind, name, at, body: JSON.parse(body) as T };
}

/** One record, or undefined. */
export async function getRecord<T = unknown>(
  host: string,
  kind: Kind,
  name: string,
  dir = stateDir(),
): Promise<StateRecord<T> | undefined> {
  const db = await load(dir);
  const r = db
    .prepare("SELECT * FROM archon_record WHERE host = ? AND kind = ? AND name = ?")
    .get(host, kind, name);
  return r ? rec<T>(r) : undefined;
}

/** Every record of a kind, by name. */
export async function listRecords<T = unknown>(
  host: string,
  kind: Kind,
  dir = stateDir(),
): Promise<StateRecord<T>[]> {
  const db = await load(dir);
  return db
    .prepare("SELECT * FROM archon_record WHERE host = ? AND kind = ? ORDER BY name")
    .all(host, kind)
    .map((r) => rec<T>(r));
}

/** The record of one name of a kind, for every host that has one (one load of the file: the PC's cache of what machines reported). */
export async function recordsNamed<T = unknown>(
  kind: Kind,
  name: string,
  dir = stateDir(),
): Promise<StateRecord<T>[]> {
  const db = await load(dir);
  return db
    .prepare("SELECT * FROM archon_record WHERE kind = ? AND name = ? ORDER BY host")
    .all(kind, name)
    .map((r) => rec<T>(r));
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
  return serially(dir, async () => {
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
  });
}

/** How many observations a host keeps (the oldest go first, spec 095). */
export const OBSERVATION_KEEP = 5000;

/**
 * Write many records of one kind in one load and save (spec 095: a collector's
 * observations). Each replaces the record with the same key; observations are
 * kept to {@link OBSERVATION_KEEP}, newest first.
 */
export async function putRecords(
  host: string,
  kind: Kind,
  items: Array<{ name: string; body: unknown; at?: string }>,
  dir = stateDir(),
): Promise<void> {
  return serially(dir, async () => {
    if (!items.length) return;
    const db = await load(dir);
    const ins = db.prepare("INSERT OR REPLACE INTO archon_record VALUES (?, ?, ?, ?, ?)");
    const now = new Date().toISOString();
    for (const i of items) ins.run(host, kind, i.name, i.at ?? now, JSON.stringify(i.body));
    count("archon.state.writes", items.length, { "archon.kind": kind });
    if (kind === "observation") {
      db.prepare(
        `DELETE FROM archon_record WHERE host = ? AND kind = 'observation' AND name NOT IN
          (SELECT name FROM archon_record WHERE host = ? AND kind = 'observation' ORDER BY at DESC LIMIT ?)`,
      ).run(host, host, OBSERVATION_KEEP);
    }
    await save(dir, db);
  });
}

/**
 * Replace the records of one kind whose names start with `prefix` by these (spec 112-machine-reported-tags FR-008: the tags the machine
 * works out from the fleet at each apply replace the previous ones and leave its own alone), in one load and save.
 */
export async function replaceRecords(
  host: string,
  kind: Kind,
  prefix: string,
  items: Array<{ name: string; body: unknown; at?: string }>,
  dir = stateDir(),
): Promise<void> {
  return serially(dir, async () => {
    const db = await load(dir);
    db.prepare(
      "DELETE FROM archon_record WHERE host = ? AND kind = ? AND substr(name, 1, ?) = ?",
    ).run(host, kind, prefix.length, prefix);
    const ins = db.prepare("INSERT OR REPLACE INTO archon_record VALUES (?, ?, ?, ?, ?)");
    const now = new Date().toISOString();
    for (const i of items) ins.run(host, kind, i.name, i.at ?? now, JSON.stringify(i.body));
    count("archon.state.writes", items.length, { "archon.kind": kind });
    await save(dir, db);
  });
}

/** Remove one record, or every record of a host (retire). */
export async function removeRecords(
  host: string,
  kind?: Kind,
  name?: string,
  dir = stateDir(),
): Promise<void> {
  return serially(dir, async () => {
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
  });
}

/** For tests and `archon state`: every record. */
export async function allRecords(dir = stateDir()): Promise<StateRecord[]> {
  const db = await load(dir);
  return (
    db.prepare("SELECT * FROM archon_record ORDER BY host, kind, name").all() as unknown as Array<
      Record<string, string>
    >
  ).map((r) => rec(r));
}
