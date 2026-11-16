/**
 * Spec 090: the estate graph's commands.
 *
 * - `stolos estate query "<select>"`: one SELECT across every source.
 * - `stolos estate build`: write the canonical `estate.sql` (the schema and
 *   every row), `estate.auto.sqlite.db` made from it, and
 *   `estate.osquery.json`, in this PC's state directory. The SQL loads into
 *   other databases; the SQLite file is what osquery reads (spec 093).
 * - `stolos estate osquery [--print]`: write (or print) the osquery
 *   configuration alone, and say how to load it.
 * - `stolos estate diff "<select>" --since <date|commit>`: the rows a query
 *   gains and loses between then and now, from Git.
 * - `stolos estate schema [--docs]`: the schema's SQL, or its docs.
 *
 * ## osquery (spec 093)
 *
 * Every estate table and view is also an osquery table, `stolos_<name>`
 * (`stolos_device`, `stolos_user_account`, `stolos_person`, ...), through
 * osquery's Automatic Table Construction: `estate.osquery.json` tells osquery
 * to read `estate.auto.sqlite.db` itself, so no extension runs. The
 * configuration is generated from the schema's declarations (`osquery.ts`).
 * The SQLite file is written to a temporary file and renamed over the old one,
 * so osquery, which reads it without locks, sees the old file or the new one,
 * never half of either.
 *
 * ```mermaid
 * flowchart LR
 *   build["stolos estate build"] --> sql["estate.sql (canonical)"]
 *   sql --> db["estate.auto.sqlite.db (temp file, then rename)"]
 *   build --> conf["estate.osquery.json (ATC, from ESTATE_SCHEMA)"]
 *   conf --> osq["osqueryi --config_path estate.osquery.json"]
 *   db --> osq
 *   osq --> rows["select * from stolos_device"]
 * ```
 *
 * @module
 */

import { errors, fs, path, stdio } from "@intellectual-frontiers/ifc-ts/runtime";
import { ui } from "../core/ui.ts";
import { P } from "../core/paths.ts";
import { run } from "../core/exec.ts";
import {
  buildGraph,
  type Estate,
  ESTATE_NAMES,
  estateQuery,
  estateRefusal,
  estateSql,
  nodeUids,
} from "./graph.ts";
import { estateSchemaDoc, estateSchemaSql } from "./schema.ts";
import {
  gitReader,
  readSnapshot,
  seenTimes,
  type Snapshot,
  type SourceSnapshot,
} from "./snapshot.ts";

/** Text for a program to read (a query's rows, the schema), on standard output. */
const print = (text: string): void => {
  stdio.stdout.writeSync(`${text}\n`);
};

/** An Error's message, or the thrown value as text. */
const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

async function fleetFacts(): Promise<{ id: string; title: string; personSources?: string[] }> {
  const { loadFleet } = await import("../model/load.ts");
  const f = await loadFleet();
  return {
    id: f.id,
    title: f.title || f.id,
    ...(f.estate?.personSources ? { personSources: f.estate.personSources } : {}),
  };
}

/** A commit for a date (the last one on or before it) or a commit-ish as given. */
async function revFor(since: string): Promise<string | undefined> {
  const asDate = /^\d{4}-\d{2}-\d{2}/.test(since);
  const r = await run([
    "git",
    "-C",
    P.repo,
    ...(asDate
      ? ["rev-list", "-1", `--before=${since}T23:59:59Z`, "HEAD"]
      : ["rev-parse", "--verify", `${since}^{commit}`]),
  ]);
  return r.ok ? r.stdout.trim() || undefined : undefined;
}

/** The previous version of each source (the commit before its last), for what a source could not read now. */
async function previousSnapshot(s: Snapshot): Promise<Snapshot> {
  const sources: SourceSnapshot[] = [];
  for (const src of s.sources) {
    if (!src.commit) continue;
    const prev = await readSnapshot(gitReader(P.repo, `${src.commit}~1`), s.fleet).catch(
      () => undefined,
    );
    const p = prev?.sources.find((x) => x.connector === src.connector);
    if (p) sources.push(p);
  }
  return { ...s, sources };
}

/** The estate graph from the fleet repository: now (the working tree), or at a commit. */
export async function loadEstate(rev?: string): Promise<Estate> {
  const f = await fleetFacts();
  const s = await readSnapshot(gitReader(P.repo, rev), f.id, rev);
  const paths = s.sources.map((x) => `fleets/${f.id}/estate/${x.connector}.ts`);
  const seen = await seenTimes(P.repo, paths, nodeUids);
  return buildGraph(s, {
    fleetTitle: f.title,
    seen,
    previous: await previousSnapshot(s),
    ...(f.personSources ? { personSources: f.personSources } : {}),
    ...(rev ? {} : { now: new Date() }),
  });
}

/**
 * `stolos estate query "<sql>"`. With `--json`, a failure is also an object on standard output
 * (`{"error": ..., "fix": ...}`), so a program reading it never gets nothing.
 */
export async function estateQueryCommand(sql: string, asJson = false): Promise<number> {
  const refuse = (error: string, fix: string): number => {
    ui.phase("Query").fail(error, fix);
    if (asJson) print(JSON.stringify({ error, fix }, null, 2));
    return 1;
  };
  const why = estateRefusal(sql);
  if (why) {
    return refuse(
      `refused: ${why}`,
      `for example: bun run stolos estate query "select connector, display_name from user_account where admin = 1 and mfa = 0"`,
    );
  }
  let rows: Array<Record<string, unknown>>;
  try {
    rows = estateQuery(await loadEstate(), sql);
  } catch (e) {
    return refuse(messageOf(e), `tables and views: ${ESTATE_NAMES}`);
  }
  if (asJson) print(JSON.stringify(rows, null, 2));
  else {
    const { table } = await import("../state/query.ts");
    print(`${rows.length ? `${table(rows)}\n` : ""}\n${rows.length} row(s)`);
  }
  return 0;
}

/** The estate's files: the canonical SQL, the SQLite file made from it, and, optionally, osquery's configuration. */
export interface EstateFiles {
  /** estate.sql: the schema and every row (canonical). */
  sql: string;
  /** estate.auto.sqlite.db: made from estate.sql; osquery reads it. */
  db: string;
  /** estate.osquery.json: osquery's ATC configuration for the SQLite file (spec 093). */
  osquery?: string;
}

/** Where the estate's files are on this PC (absolute: osquery's configuration names the SQLite file). */
export function estateFiles(): Required<EstateFiles> {
  const dir = path.resolve(P.userState, "estate");
  return {
    sql: path.join(dir, "estate.sql"),
    db: path.join(dir, "estate.auto.sqlite.db"),
    osquery: path.join(dir, "estate.osquery.json"),
  };
}

/** Write osquery's configuration (spec 093) for the SQLite file at `db`: to a temporary file, then renamed. */
export async function writeOsqueryConfig(file: string, db: string): Promise<void> {
  const { atcJson } = await import("./osquery.ts");
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await fs.writeTextFile(tmp, atcJson(db));
  await fs.rename(tmp, file);
}

/**
 * Write estate.sql (canonical), estate.auto.sqlite.db (made from it), and,
 * when `files.osquery` is set, osquery's configuration. The SQLite file is
 * built in a temporary file and renamed over the old one (atomic on one file
 * system), so a reader (osquery opens it without locks) never sees it half
 * written.
 */
export async function writeEstateFiles(
  e: Estate,
  files: EstateFiles = estateFiles(),
): Promise<void> {
  const { DatabaseSync } = await import("node:sqlite");
  const sql = estateSql(e);
  await fs.mkdir(path.join(files.sql, ".."), { recursive: true });
  await fs.writeTextFile(files.sql, sql);
  const tmp = `${files.db}.tmp`;
  await fs.remove(tmp).catch((x: unknown) => {
    if (!(x instanceof errors.NotFound)) throw x;
  });
  const db = new DatabaseSync(tmp);
  try {
    db.exec(sql);
  } finally {
    db.close();
  }
  await fs.rename(tmp, files.db);
  if (files.osquery) await writeOsqueryConfig(files.osquery, files.db);
}

/** `stolos estate build`. */
export async function estateBuild(): Promise<number> {
  const p = ui.phase("Estate");
  const e = await loadEstate();
  const { estatePolicies } = await import("./graph.ts");
  estatePolicies(e);
  const files = estateFiles();
  await writeEstateFiles(e, files);
  const n = (t: string): number => {
    const row = e.db.prepare(`SELECT count(*) AS n FROM ${t}`).get();
    return typeof row?.["n"] === "number" ? row["n"] : Number(row?.["n"] ?? 0);
  };
  p.ok(
    `${n("tenant")} tenant(s), ${n("person")} people${
      e.personSource ? ` (from ${e.personSource})` : ""
    }, ${n("node")} node(s), ${n("fixed_asset")} machine(s), ${n("edge")} edge(s), ${n(
      "finding",
    )} finding(s)`,
  );
  p.done(`${files.sql} (canonical), ${files.db}, and ${files.osquery} (for osquery)`);
  return 0;
}

/** `stolos estate osquery [--print]`: write (or print) osquery's configuration for the estate. */
export async function estateOsquery(printOnly = false): Promise<number> {
  const { atcJson, osqueryHelp } = await import("./osquery.ts");
  const files = estateFiles();
  if (printOnly) {
    print(atcJson(files.db).trimEnd());
    return 0;
  }
  const p = ui.phase("osquery");
  await writeOsqueryConfig(files.osquery, files.db);
  const built = await fs.stat(files.db).then(
    () => true,
    () => false,
  );
  if (!built) {
    p.warn(
      `${files.db} is not built yet: the tables answer nothing until it is`,
      "bun run stolos estate build",
    );
  }
  const { ESTATE_SCHEMA } = await import("./schema.ts");
  p.ok(
    `${ESTATE_SCHEMA.length} tables: ${ESTATE_SCHEMA.map((d) => `stolos_${d.name}`).join(", ")}`,
  );
  p.done(files.osquery);
  for (const line of osqueryHelp(files.osquery).split("\n")) ui.say(line);
  return 0;
}

/** The rows of a query that one estate has and the other lacks. */
export function rowsDiff(
  before: Array<Record<string, unknown>>,
  after: Array<Record<string, unknown>>,
): { added: Array<Record<string, unknown>>; removed: Array<Record<string, unknown>> } {
  const key = (r: Record<string, unknown>): string => JSON.stringify(r);
  const b = new Set(before.map(key));
  const a = new Set(after.map(key));
  return {
    added: after.filter((r) => !b.has(key(r))),
    removed: before.filter((r) => !a.has(key(r))),
  };
}

/** `stolos estate diff "<sql>" --since <date|commit>`. */
export async function estateDiff(sql: string, since: string, asJson = false): Promise<number> {
  const p = ui.phase("Estate diff");
  const why = estateRefusal(sql);
  if (why) {
    p.fail(`refused: ${why}`);
    return 1;
  }
  const rev = await revFor(since);
  if (!rev) {
    const first = await run(["git", "-C", P.repo, "log", "--reverse", "--format=%cs", "HEAD"]);
    const start = first.stdout.split("\n")[0];
    p.fail(
      `no commit for ${since}`,
      start
        ? `the fleet repository's history starts ${start}: use that date or later, or a commit`
        : "a date (YYYY-MM-DD) or a commit in the fleet repository",
    );
    return 1;
  }
  let d: ReturnType<typeof rowsDiff>;
  try {
    d = rowsDiff(estateQuery(await loadEstate(rev), sql), estateQuery(await loadEstate(), sql));
  } catch (e) {
    p.fail(messageOf(e), `tables and views: ${ESTATE_NAMES}`);
    return 1;
  }
  if (asJson) {
    print(JSON.stringify({ since: rev, ...d }, null, 2));
    return 0;
  }
  const { table } = await import("../state/query.ts");
  if (d.added.length) print(`Added since ${rev.slice(0, 12)}:\n${table(d.added)}\n`);
  if (d.removed.length) print(`Removed since ${rev.slice(0, 12)}:\n${table(d.removed)}\n`);
  p.done(`${d.added.length} added, ${d.removed.length} removed since ${rev.slice(0, 12)}`);
  return 0;
}

/** `stolos estate schema [--docs]`. */
export function estateSchema(docs = false): number {
  print(docs ? estateSchemaDoc() : estateSchemaSql());
  return 0;
}
