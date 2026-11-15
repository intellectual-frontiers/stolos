/**
 * Spec 093: the estate graph as osquery tables, through osquery's Automatic
 * Table Construction (ATC). No extension and no new process: osquery reads
 * `estate.auto.sqlite.db` itself, from a configuration generated here from
 * the schema's declarations (`ESTATE_SCHEMA`), so every estate table and view
 * is an osquery table named `stolos_<name>` with exactly its declared columns.
 *
 * ```mermaid
 * flowchart LR
 *   decl["ESTATE_SCHEMA (schema.ts)"] --> atc["estate.osquery.json: auto_table_construction"]
 *   git["observations in Git"] --> sql["estate.sql (canonical)"] --> db["estate.auto.sqlite.db (written to a temp file, then renamed)"]
 *   atc --> osq["osqueryi or osqueryd"]
 *   db --> osq
 *   osq --> q["select * from stolos_device"]
 * ```
 *
 * What ATC does (osquery's `auto_constructed_tables.cpp`): for each entry it
 * opens the file at `path` read-only, runs `query`, and maps each result
 * column to the declared column of the same name. Every column is TEXT in
 * osquery (integers and booleans arrive as their decimal text; NULL as an
 * empty value). ATC adds an implicit `path` column (the file it read) and
 * treats a declared `path` as reserved, so a schema column named `path` is
 * exposed as `estate_path` here; the estate's own names never change.
 * `platform` is matched by substring, so `darwin,linux,windows` covers all
 * three. A `%` in `path` is a wildcard; the estate's path is literal.
 *
 * ```ts
 * import { atcConfig } from "@stolos/archon/estate/osquery.ts";
 * const c = atcConfig("/home/alice/.local/state/stolos/estate/estate.auto.sqlite.db");
 * console.log(c.auto_table_construction.stolos_device.query);
 * ```
 *
 * @module
 */

import { path } from "@intellectual-frontiers/ifc-ts/runtime";
import type { AnyTable, ViewDef } from "../schema/define.ts";
import { ESTATE_SCHEMA } from "./schema.ts";

/** The prefix of every estate table in osquery. */
export const OSQUERY_PREFIX = "stolos_";

/** The platforms the tables load on (osquery matches `platform` by substring). */
export const ATC_PLATFORM = "darwin,linux,windows";

/** Column names ATC reserves (case-insensitive): it adds `path` itself, the file each row came from. */
export const ATC_RESERVED: readonly string[] = ["path"];

/** One ATC table, with exactly the keys osquery reads. */
export interface AtcTable {
  /** The SELECT osquery runs on the SQLite file. */
  query: string;
  /** The SQLite file's absolute path. */
  path: string;
  /** The osquery table's columns, in order (all TEXT in osquery). */
  columns: string[];
  /** The platforms it loads on. */
  platform: string;
}

/** An osquery configuration carrying only the estate's ATC tables. */
export interface AtcConfig {
  /** osquery's ATC key: table name to its definition. */
  auto_table_construction: Record<string, AtcTable>;
}

/** The osquery table name for an estate table or view. */
export function osqueryTableName(name: string): string {
  return `${OSQUERY_PREFIX}${name}`;
}

/**
 * The osquery column for an estate column: the same name, unless ATC
 * reserves it; then `estate_<name>` (prefixed again until it is free).
 */
export function osqueryColumn(name: string, taken: readonly string[] = []): string {
  if (!ATC_RESERVED.includes(name.toLowerCase())) return name;
  let out = `estate_${name}`;
  while (taken.includes(out) || ATC_RESERVED.includes(out.toLowerCase())) out = `estate_${out}`;
  return out;
}

/** The declared columns of a table or view, in order, with their osquery names. */
export function atcColumns(d: AnyTable | ViewDef): Array<{ estate: string; osquery: string }> {
  const names = Object.keys(d.columns);
  return names.map((n) => ({ estate: n, osquery: osqueryColumn(n, names) }));
}

/** One ATC table for an estate table or view. */
export function atcTable(d: AnyTable | ViewDef, dbPath: string): AtcTable {
  const cols = atcColumns(d);
  return {
    query: `SELECT ${cols
      .map((c) => (c.estate === c.osquery ? c.estate : `${c.estate} AS ${c.osquery}`))
      .join(", ")} FROM ${d.name}`,
    path: path.resolve(dbPath),
    columns: cols.map((c) => c.osquery),
    platform: ATC_PLATFORM,
  };
}

/** The ATC configuration for every estate table and view, reading the SQLite file at `dbPath`. */
export function atcConfig(
  dbPath: string,
  schema: ReadonlyArray<AnyTable | ViewDef> = ESTATE_SCHEMA,
): AtcConfig {
  return {
    auto_table_construction: Object.fromEntries(
      schema.map((d) => [osqueryTableName(d.name), atcTable(d, dbPath)]),
    ),
  };
}

/** The configuration as the JSON file osquery loads. */
export function atcJson(dbPath: string): string {
  return JSON.stringify(atcConfig(dbPath), null, 2) + "\n";
}

/** How to load the configuration: osqueryi, an existing osqueryd, a fleet manager. */
export function osqueryHelp(configPath: string): string {
  return [
    "Try it in the shell:",
    `  osqueryi --config_path "${configPath}"`,
    "  osquery> select uid, hostname, owner_email_addr from stolos_device;",
    "",
    "Add it to an osqueryd that already has a configuration: copy the",
    '"auto_table_construction" object from the file into that configuration',
    "(merge it with any ATC tables already there) and restart osqueryd. A",
    "configuration plugin that serves several sources merges them the same way.",
    "",
    "From a fleet manager: put the same object in the configuration it sends to",
    "this PC's osquery. The path is this PC's, so the tables answer only here.",
    "",
    "Every column is text in osquery; NULL is empty; each table also has osquery's",
    'own "path" column. Run bun run stolos estate build to refresh the data.',
  ].join("\n");
}
