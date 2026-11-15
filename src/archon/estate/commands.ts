/**
 * Spec 090: the estate graph's commands.
 *
 * - `stolos estate query "<select>"`: one SELECT across every source.
 * - `stolos estate build`: write the canonical `estate.sql` (the schema and
 *   every row) and `estate.auto.sqlite.db` made from it, in this PC's state
 *   directory. The SQL loads into other databases; the SQLite file is what
 *   osquery reads (spec 093).
 * - `stolos estate diff "<select>" --since <date|commit>`: the rows a query
 *   gains and loses between then and now, from Git.
 * - `stolos estate schema [--docs]`: the schema's SQL, or its docs.
 *
 * @module
 */

import { ui } from "../core/ui.ts";
import { join } from "../core/path.ts";
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
import { gitReader, readSnapshot, seenTimes, type Snapshot } from "./snapshot.ts";

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
  const sources = [];
  for (const src of s.sources) {
    if (!src.commit) continue;
    const prev = await readSnapshot(gitReader(P.repo, `${src.commit}~1`), s.fleet).catch(() =>
      undefined
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

/** `stolos estate query "<sql>"`. */
export async function estateQueryCommand(sql: string, json = false): Promise<number> {
  const why = estateRefusal(sql);
  if (why) {
    ui.phase("Query").fail(
      `refused: ${why}`,
      `for example: deno task stolos estate query "select connector, display_name from user_account where admin = 1 and mfa = 0"`,
    );
    return 1;
  }
  let rows: Array<Record<string, unknown>>;
  try {
    rows = estateQuery(await loadEstate(), sql);
  } catch (e) {
    ui.phase("Query").fail((e as Error).message, `tables and views: ${ESTATE_NAMES}`);
    return 1;
  }
  if (json) console.log(JSON.stringify(rows, null, 2));
  else {
    const { table } = await import("../state/query.ts");
    if (rows.length) console.log(table(rows));
    console.log(`\n${rows.length} row(s)`);
  }
  return 0;
}

/** Where the estate's SQL and SQLite files are on this PC. */
export function estateFiles(): { sql: string; db: string } {
  const dir = join(P.userState, "estate");
  return { sql: join(dir, "estate.sql"), db: join(dir, "estate.auto.sqlite.db") };
}

/** Write estate.sql (canonical) and estate.auto.sqlite.db (made from it). */
export async function writeEstateFiles(e: Estate, files = estateFiles()): Promise<void> {
  const { DatabaseSync } = await import("node:sqlite");
  const sql = estateSql(e);
  await Deno.mkdir(join(files.sql, ".."), { recursive: true });
  await Deno.writeTextFile(files.sql, sql);
  const tmp = `${files.db}.tmp`;
  await Deno.remove(tmp).catch((x) => {
    if (!(x instanceof Deno.errors.NotFound)) throw x;
  });
  const db = new DatabaseSync(tmp);
  try {
    db.exec(sql);
  } finally {
    db.close();
  }
  await Deno.rename(tmp, files.db);
}

/** `stolos estate build`. */
export async function estateBuild(): Promise<number> {
  const p = ui.phase("Estate");
  const e = await loadEstate();
  const { estatePolicies } = await import("./graph.ts");
  estatePolicies(e);
  const files = estateFiles();
  await writeEstateFiles(e, files);
  const n = (t: string) =>
    Number((e.db.prepare(`SELECT count(*) AS n FROM ${t}`).get() as { n: number }).n);
  p.ok(
    `${n("tenant")} tenant(s), ${n("person")} people${
      e.personSource ? ` (from ${e.personSource})` : ""
    }, ${n("node")} node(s), ${n("fixed_asset")} machine(s), ${n("edge")} edge(s), ${
      n("finding")
    } finding(s)`,
  );
  p.done(`${files.sql} (canonical) and ${files.db}`);
  return 0;
}

/** The rows of a query that one estate has and the other lacks. */
export function rowsDiff(
  before: Array<Record<string, unknown>>,
  after: Array<Record<string, unknown>>,
): { added: Array<Record<string, unknown>>; removed: Array<Record<string, unknown>> } {
  const key = (r: Record<string, unknown>) => JSON.stringify(r);
  const b = new Set(before.map(key));
  const a = new Set(after.map(key));
  return {
    added: after.filter((r) => !b.has(key(r))),
    removed: before.filter((r) => !a.has(key(r))),
  };
}

/** `stolos estate diff "<sql>" --since <date|commit>`. */
export async function estateDiff(sql: string, since: string, json = false): Promise<number> {
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
    p.fail((e as Error).message, `tables and views: ${ESTATE_NAMES}`);
    return 1;
  }
  if (json) {
    console.log(JSON.stringify({ since: rev, ...d }, null, 2));
    return 0;
  }
  const { table } = await import("../state/query.ts");
  if (d.added.length) console.log(`Added since ${rev.slice(0, 12)}:\n${table(d.added)}\n`);
  if (d.removed.length) console.log(`Removed since ${rev.slice(0, 12)}:\n${table(d.removed)}\n`);
  p.done(`${d.added.length} added, ${d.removed.length} removed since ${rev.slice(0, 12)}`);
  return 0;
}

/** `stolos estate schema [--docs]`. */
export function estateSchema(docs = false): number {
  console.log(docs ? estateSchemaDoc() : estateSchemaSql());
  return 0;
}
