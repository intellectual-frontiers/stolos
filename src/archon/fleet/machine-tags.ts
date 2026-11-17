/**
 * Spec 112-machine-reported-tags FR-007, FR-008: the machine's side of tags. `archon tag add | remove | list` keep the tags a person on
 * the machine says about it in the machine's own state database (`archon.sql`, the view `archon_tags`, which osquery reads), and each
 * `archon apply` also writes the tags the fleet knows for the machine, worked out from the fleet repository the machine already holds.
 * None of it changes the machine's configuration: it is what the machine says about itself, which the PC reads as claims and the fleet
 * decides about (`fromMachine` in `tags.ts`).
 *
 * ```mermaid
 * flowchart LR
 *   add["archon tag add env:prod pilot<br/>(root; run log and journal)"] -->|"source local"| t["archon.sql: tags"]
 *   apply["archon apply"] -->|"tags.ts rules and groups,<br/>decisions.ts: source fleet"| t
 *   t --> osq["osquery: select * from archon_tags"]
 *   t --> st["archon state"] --> pc["the PC: a claim, never the fleet's own tag"]
 * ```
 *
 * @module
 */
// Spec: 112-machine-reported-tags FR-004, FR-007, FR-008

import { stdio } from "@intellectual-frontiers/commons/ts/runtime";
import { journal } from "../core/log.ts";
import { asRoot, P } from "../core/paths.ts";
import { ui } from "../core/ui.ts";
import { claimTag, REPORT_LIMITS } from "../model/reported.ts";
import { classifyTag, dimensionOf, type TagSet, tokensOf } from "../model/tags.ts";
import { caller } from "../optin/optin.ts";
import {
  listTagRows,
  putLocalTags,
  removeLocalTags,
  replaceFleetTags,
  rowId,
  type TagBody,
} from "../state/tags.ts";
import { type FleetTagsSource, loadFleetTags, originWords, tagWord } from "./tags.ts";

/** A managed host of the model, as the tags read it. */
type HostDef = NonNullable<FleetTagsSource["hosts"]>[number];

/** The words a person typed (a list, or the command line's values joined by newlines or commas). */
const wordsOf = (t: string | readonly string[]): string[] =>
  typeof t === "string" ? tokensOf(t) : t.flatMap((x) => tokensOf(x));

/** A tag as a row of the table: its dimension ("" for a free-form tag) and value. */
function rowOf(id: string): { dimension: string; value: string } {
  const d = dimensionOf(id);
  return d ? { dimension: d, value: id.slice(d.length + 1) } : { dimension: "", value: id };
}

/** The machine's own changes need root (the registry elevates through sudo; a test sets a host root). */
function needRoot(): void {
  if (!asRoot()) {
    throw new Error(
      "archon tag add and remove must run as root (they elevate through sudo automatically)",
    );
  }
}

/** The fleet's definitions, when this machine's checkout holds a `tags.ts` that loads. */
async function fleetSet(): Promise<TagSet | undefined> {
  const { loadTagSet } = await import("./tags.ts");
  return (await loadTagSet()).set;
}

/**
 * `archon tag add <tag...>` (spec 112-machine-reported-tags FR-007): say a tag about this machine, in its own table. Read with the tag
 * grammar and its caps; a new value of a one-of dimension replaces this machine's own old one; a tag the fleet's `tags.ts` does not
 * define is written, and said to be one the PC cannot accept.
 */
export async function tagAddLocal(
  hostName: string,
  tags: string | readonly string[],
  o: { custom?: boolean } = {},
  dir = P.state,
): Promise<number> {
  needRoot();
  const c = ui.phase("Tags");
  const words = wordsOf(tags);
  if (!words.length) {
    c.fail(
      "no tag given",
      "archon tag add env:prod pilot (archon tag list shows this machine's tags)",
    );
    return 1;
  }
  const set = await fleetSet();
  const rows = await listTagRows(hostName, dir);
  const own = rows.filter((r) => r.source === "local");
  if (own.length + words.length > REPORT_LIMITS.perMachine) {
    c.fail(
      `this machine may say at most ${REPORT_LIMITS.perMachine} tags`,
      "archon tag remove the ones it no longer needs",
    );
    return 1;
  }
  const add: Array<{ dimension: string; value: string; set_by: string }> = [];
  const replaced: string[] = [];
  const undefinedHere: string[] = [];
  for (const w of words) {
    const id = claimTag(w);
    if (id === undefined) {
      c.fail(
        `'${w.slice(0, 40)}' is not a tag (at most ${REPORT_LIMITS.tagChars} characters; lowercase letters, digits, - and one colon)`,
        "for a defined tag write <dimension>:<value> (env:prod), for a free-form one a plain word (pilot)",
      );
      return 1;
    }
    if (set) {
      const t = classifyTag(set, id, o.custom);
      // A tag with a colon that the fleet does not define is still this machine's to say; a forgotten dimension is not.
      if (t.kind === "bad" && !(id.includes(":") && t.why.endsWith("is not defined"))) {
        c.fail(t.why, t.fix);
        return 1;
      }
      if (t.kind === "bad") undefinedHere.push(id);
    }
    const dim = dimensionOf(id);
    if (dim && set?.dimensions[dim]?.cardinality === "one-of") {
      for (const old of own) {
        if (old.dimension === dim && rowId(old) !== id) replaced.push(rowId(old));
      }
    }
    add.push({ ...rowOf(id), set_by: caller() });
  }
  for (const old of replaced) await removeLocalTags(hostName, [old], dir);
  await putLocalTags(hostName, add, dir);
  const said = add.map((r) => rowId(r)).join(", ");
  for (const r of replaced)
    c.note(`${r} replaced (this machine says one value of a one-of dimension)`);
  if (undefinedHere.length) {
    c.warn(
      `${undefinedHere.join(", ")} ${undefinedHere.length === 1 ? "is" : "are"} not defined in the fleet's tags.ts: the PC will list ${undefinedHere.length === 1 ? "it" : "them"} as a claim it cannot accept`,
      "define it in fleets/<fleet>/tags.ts (the spec loop), or say a tag the fleet defines",
    );
  }
  c.done(`${hostName} says: ${said}`);
  await journal("archon-tag", `${caller()} added ${said} to ${hostName}'s own tags`);
  return 0;
}

/** `archon tag remove <tag...>` (spec 112-machine-reported-tags FR-007): take tags a person said off this machine's table (never the fleet's rows). */
export async function tagRemoveLocal(
  hostName: string,
  tags: string | readonly string[],
  dir = P.state,
): Promise<number> {
  needRoot();
  const c = ui.phase("Tags");
  const words = wordsOf(tags).map((w) => w.trim().toLowerCase());
  if (!words.length) {
    c.fail("no tag given", "archon tag remove env:prod pilot");
    return 1;
  }
  const rows = await listTagRows(hostName, dir);
  const fleetOnly = words.filter(
    (w) =>
      rows.some((r) => r.source === "fleet" && rowId(r) === w) &&
      !rows.some((r) => r.source === "local" && rowId(r) === w),
  );
  const missing = await removeLocalTags(
    hostName,
    words.filter((w) => !fleetOnly.includes(w)),
    dir,
  );
  for (const w of fleetOnly) {
    c.fail(
      `${w} is what the fleet says of this machine, not something said here`,
      "change it in the fleet repository (stolos tag remove), not on the machine",
    );
  }
  for (const w of missing.filter((m) => !fleetOnly.includes(m))) {
    c.fail(`this machine does not say ${w}`, "archon tag list");
  }
  const gone = words.filter((w) => !fleetOnly.includes(w) && !missing.includes(w));
  if (gone.length) {
    c.done(`${hostName} no longer says: ${gone.join(", ")}`);
    await journal(
      "archon-tag",
      `${caller()} removed ${gone.join(", ")} from ${hostName}'s own tags`,
    );
  }
  return fleetOnly.length || missing.length ? 1 : 0;
}

/** `archon tag list` (spec 112-machine-reported-tags FR-007): this machine's own table, each row with its source. */
export async function tagListLocal(
  hostName: string,
  json: boolean,
  dir = P.state,
): Promise<number> {
  const rows = await listTagRows(hostName, dir);
  if (json) {
    stdio.stdout.writeSync(`${JSON.stringify(rows, null, 2)}\n`);
    return 0;
  }
  const c = ui.phase("Tags");
  if (!rows.length) {
    c.done(`${hostName} says no tags yet (archon tag add env:prod)`);
    return 0;
  }
  const { table } = await import("../state/query.ts");
  stdio.stdout.writeSync(
    `${table(rows.map((r) => ({ tag: rowId(r), source: r.source, set_by: r.set_by, set_at: r.set_at })))}\n`,
  );
  c.done(
    `${rows.filter((r) => r.source === "local").length} said here, ${rows.filter((r) => r.source === "fleet").length} the fleet knows (select * from archon_tags)`,
  );
  return 0;
}

/**
 * The tags the fleet knows for this machine, from the fleet repository it already holds: a person's tags in its `decisions.ts`, then the
 * rules and groups of `tags.ts` (spec 108-tags). Not what the machine says: the same resolution the PC does, without any claim.
 */
export async function fleetTagRows(host: HostDef): Promise<{
  rows: Array<Pick<TagBody, "dimension" | "value" | "set_by">>;
  error?: string;
}> {
  const ft = await loadFleetTags({ hosts: [host], adopted: [], reports: {} });
  const me = ft.machines.find((m) => m.name === host.name);
  return {
    rows: (me?.resolved.tags ?? [])
      .filter((t) => t.standing !== "unknown")
      .map((t) => ({ ...rowOf(t.id), set_by: originWords(t) })),
    ...(ft.error ? { error: ft.error } : {}),
  };
}

/**
 * At each apply (spec 112-machine-reported-tags FR-008): write the tags the fleet knows for this machine with the source `fleet`,
 * replacing the previous ones and leaving the machine's own alone. Never fails an apply: a fleet whose `tags.ts` does not load leaves the
 * rows as they were.
 */
export async function refreshFleetTags(
  host: HostDef,
  dir = P.state,
): Promise<{ changed: boolean; count: number; why?: string }> {
  try {
    const { rows, error } = await fleetTagRows(host);
    if (error) return { changed: false, count: 0, why: error };
    const changed = await replaceFleetTags(host.name, rows, dir);
    if (changed) {
      ui.phase("Tags").done(
        `${rows.length} tag(s) the fleet knows for ${host.name}: ${rows.map((r) => tagWord({ id: r.dimension ? `${r.dimension}:${r.value}` : r.value, standing: "defined" })).join(" ") || "none"}`,
      );
    }
    return { changed, count: rows.length };
  } catch (e) {
    return { changed: false, count: 0, why: e instanceof Error ? e.message : String(e) };
  }
}
