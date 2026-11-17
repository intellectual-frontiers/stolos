/**
 * Spec 112-machine-reported-tags FR-007, FR-008, FR-009: a machine's own **tags table**. The tags a machine says about itself live in
 * its state database (`archon.sql`, the view `archon_tags`, so osquery reads them like any other table): one row per tag with its
 * `dimension` ("" for a free-form tag), `value`, `source` (`local`, set by a person on the machine with `archon tag add`, or `fleet`,
 * what the machine worked out from the fleet repository it holds at its last apply), `set_by` and `set_at`. None of it changes the
 * machine's configuration.
 *
 * ```mermaid
 * flowchart LR
 *   add["archon tag add / remove<br/>(root)"] -->|"source local"| rec["archon_record, kind tag"]
 *   apply["archon apply: the fleet's tags for this machine<br/>(tags.ts rules and groups, decisions.ts)"] -->|"source fleet:<br/>replaces the previous fleet rows"| rec
 *   rec --> view["view archon_tags"] --> osq["osquery: select * from archon_tags"]
 *   view --> st["archon state: the PC reads it over SSH"]
 * ```
 *
 * @module
 */
// Spec: 112-machine-reported-tags FR-007, FR-008, FR-009

import type { TagRow } from "../model/reported.ts";
import { listRecords, putRecords, removeRecords, replaceRecords, stateDir } from "./store.ts";

/** The row of one tag, as its record body keeps it. */
export type TagBody = TagRow & { source: "local" | "fleet"; set_by: string; set_at: string };

/** The record name of a tag: its source and its id (`local:env:prod`, `fleet:pilot`). */
export const tagRecordName = (source: "local" | "fleet", id: string): string => `${source}:${id}`;

/** The id of a row (`env:prod`, or the word of a free-form tag). */
export const rowId = (r: Pick<TagRow, "dimension" | "value">): string =>
  r.dimension ? `${r.dimension}:${r.value}` : r.value;

/** The tags table of a machine, in order (fleet rows and local rows, by id). */
export async function listTagRows(host: string, dir = stateDir()): Promise<TagBody[]> {
  const rows = (await listRecords<TagBody>(host, "tag", dir)).map((r) => r.body);
  return rows.sort((a, b) => rowId(a).localeCompare(rowId(b)) || a.source.localeCompare(b.source));
}

/** Write tags the machine's own people set (source `local`), replacing a row of the same tag. */
export async function putLocalTags(
  host: string,
  rows: ReadonlyArray<Pick<TagBody, "dimension" | "value" | "set_by">>,
  dir = stateDir(),
  at = new Date().toISOString(),
): Promise<void> {
  await putRecords(
    host,
    "tag",
    rows.map((r) => ({
      name: tagRecordName("local", rowId(r)),
      body: {
        dimension: r.dimension,
        value: r.value,
        source: "local",
        set_by: r.set_by,
        set_at: at,
      },
      at,
    })),
    dir,
  );
}

/** Take tags a person set on the machine off (source `local` only); the ids that were not there are returned. */
export async function removeLocalTags(
  host: string,
  ids: readonly string[],
  dir = stateDir(),
): Promise<string[]> {
  const have = new Set(
    (await listTagRows(host, dir)).filter((r) => r.source === "local").map(rowId),
  );
  for (const id of ids)
    if (have.has(id)) await removeRecords(host, "tag", tagRecordName("local", id), dir);
  return ids.filter((id) => !have.has(id));
}

/**
 * The tags the fleet knows for this machine, as it worked them out at its last apply (source `fleet`): they replace the previous
 * `fleet` rows, and the machine's own `local` rows stay. Returns whether the set of rows changed.
 */
export async function replaceFleetTags(
  host: string,
  rows: ReadonlyArray<Pick<TagBody, "dimension" | "value" | "set_by">>,
  dir = stateDir(),
  at = new Date().toISOString(),
): Promise<boolean> {
  const was = (await listTagRows(host, dir))
    .filter((r) => r.source === "fleet")
    .map((r) => `${rowId(r)}|${r.set_by}`)
    .sort()
    .join("\n");
  const next = rows
    .map((r) => `${rowId(r)}|${r.set_by}`)
    .sort()
    .join("\n");
  if (was === next) return false;
  await replaceRecords(
    host,
    "tag",
    "fleet:",
    rows.map((r) => ({
      name: tagRecordName("fleet", rowId(r)),
      body: {
        dimension: r.dimension,
        value: r.value,
        source: "fleet",
        set_by: r.set_by,
        set_at: at,
      },
      at,
    })),
    dir,
  );
  return true;
}
