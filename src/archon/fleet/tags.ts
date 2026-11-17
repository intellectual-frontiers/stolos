/**
 * Spec 108-tags: the fleet's tags at work. Reads `fleets/<fleet>/tags.ts` (the definitions), gathers every machine (the managed
 * servers and workstations, the adopted machines, the controller PC) with the facts rules and groups look at and the tags a person
 * gave it (`decisions.ts` of a managed host, `machine.ts` of an adopted one), and resolves each machine's tags with their origins
 * (`resolveTags`). The commands, the question to every machine, the compliance view and both consoles read tags from here.
 *
 * ```mermaid
 * flowchart LR
 *   t["tags.ts"] --> g["gather: hosts, adopted machines, the controller"]
 *   d["decisions.ts, machine.ts<br/>(a person's tags)"] --> g
 *   o["observed.ts, host.ts<br/>(OS, address, network)"] --> g
 *   g --> r["resolveTags: person, rule, inherited"]
 *   r --> v["tag list · fleet query --tag · compliance --tag · the consoles"]
 *   r --> b["stolos build: what is wrong"]
 * ```
 *
 * @module
 */
// Spec: 108-tags FR-002, FR-004, FR-005, FR-009, FR-010, FR-011, FR-013, FR-014, FR-015, FR-016

import { fs, path } from "@intellectual-frontiers/commons/ts/runtime";
import { P } from "../core/paths.ts";
import type { AdoptedDef } from "../adopt/adopt.ts";
import type { loadFleet, loadHosts } from "../model/load.ts";
export type { ResolvedTag, TagSet } from "../model/tags.ts";
import {
  idSet,
  matches,
  parseSelection,
  type ResolvedTag,
  type ResolvedTags,
  resolveTags,
  type Selection,
  selectionOf,
  SelectionError,
  selectionProblems,
  type TagAssignment,
  type TagFacts,
  type TagSet,
  tagSetProblems,
  tokensOf,
  describeSelection,
} from "../model/tags.ts";

/** One problem of the model: where, what, and the fix (the shape `stolos build` reports). */
export interface TagProblem {
  /** Where it is. */
  where: string;
  /** What is wrong. */
  message: string;
  /** How to fix it. */
  fix: string;
}

/** `fleets/<fleet>/tags.ts`. */
export function tagsFile(): string {
  return path.join(P.fleetDir, "tags.ts");
}

/** The fleet's definitions: its tags.ts as `defineTags` made them, none when the fleet has no file, or why it did not load. */
export async function loadTagSet(): Promise<{ set?: TagSet; error?: string }> {
  const file = tagsFile();
  if (!(await fs.exists(file))) return {};
  try {
    const { fleetExport } = await import("../model/load.ts");
    const set = await fleetExport<TagSet>(file, "tags", true);
    if (!set || typeof set !== "object" || typeof set.dimensions !== "object") {
      return { error: "tags.ts does not export `tags` (export const tags = defineTags({...}))" };
    }
    return { set: { ...set, rules: set.rules ?? [], groups: set.groups ?? [] } };
  } catch (e) {
    return { error: `tags.ts does not load: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/** A machine of the fleet as tags see it. */
export interface TagMachine {
  /** Its name. */
  name: string;
  /** What it is. */
  kind: TagFacts["kind"];
  /** What rules and groups look at. */
  facts: TagFacts;
  /** The tags a person gave it. */
  assigned: { tags: string[]; customTags: string[] };
  /** The file a person's tags are written in: decisions.ts of a managed host, machine.ts of an adopted machine. */
  home: { kind: "decisions" | "machine"; file: string };
  /** Its tags, resolved. */
  resolved: ResolvedTags;
}

/** What a caller that has loaded the model already hands on, so that it is not read twice. */
export interface FleetTagsSource {
  /** The fleet's model. */
  fleet?: Awaited<ReturnType<typeof loadFleet>>;
  /** Its managed hosts. */
  hosts?: Awaited<ReturnType<typeof loadHosts>>;
  /** Its adopted machines. */
  adopted?: Array<{
    machine: AdoptedDef;
    observed?: { os: { family: string; name: string; version: string } };
  }>;
}

/** The fleet's tags and machines. */
export interface FleetTags {
  /** The definitions, when the fleet has them. */
  set?: TagSet;
  /** Why tags.ts did not load. */
  error?: string;
  /** Every machine, by name, with its resolved tags. */
  machines: TagMachine[];
  /** The site's networks (name to prefix), for groups. */
  networks: Record<string, string>;
}

/** The first word of the operating system family a probe reported, lowercase (`macos`, `windows`, `linux`). */
const familyOf = (f: string): string => f.toLowerCase().split(" ")[0] ?? "";

/**
 * Every machine of the fleet with its tags resolved: the managed servers and workstations (`host.ts` and `decisions.ts`) and the
 * adopted machines, the controller among them (`machine.ts` and `observed.ts`). Machines are sorted by name.
 */
export async function loadFleetTags(src: FleetTagsSource = {}): Promise<FleetTags> {
  const { loadFleet, loadHosts } = await import("../model/load.ts");
  const { loadAdopted, adoptedDir } = await import("../adopt/adopt.ts");
  const { decisionsFile } = await import("./decisions.ts");
  const { set, error } = await loadTagSet();
  const fleet = src.fleet ?? (await loadFleet().catch(() => undefined));
  const networks: Record<string, string> = {};
  for (const n of fleet?.site?.networks ?? []) networks[n.name] = n.cidr;
  const machines: TagMachine[] = [];
  const add = (m: Omit<TagMachine, "resolved">): void => {
    machines.push({ ...m, resolved: resolveTags(set, m.facts, m.assigned, networks) });
  };
  for (const h of src.hosts ?? (await loadHosts().catch(() => []))) {
    const kind = h.kind === "workstation" ? "workstation" : "server";
    add({
      name: h.name,
      kind,
      facts: {
        name: h.name,
        kind,
        os: "linux",
        osName: "Ubuntu",
        joined: "managed",
        ...(h.ip ? { address: h.ip } : {}),
        ...(h.network ? { network: h.network } : {}),
      },
      assigned: { tags: [...(h.tags ?? [])], customTags: [...(h.customTags ?? [])] },
      home: { kind: "decisions", file: decisionsFile(h.name) },
    });
  }
  for (const a of src.adopted ?? (await loadAdopted().catch(() => []))) {
    const m = a.machine;
    const kind = m.role === "controller" ? "controller" : "adopted";
    add({
      name: m.name,
      kind,
      facts: {
        name: m.name,
        kind,
        joined: m.role === "controller" ? "auto-adopted" : (m.joined ?? "integrated"),
        address: m.ssh.address,
        ...(a.observed
          ? {
              os: familyOf(a.observed.os.family),
              osName: `${a.observed.os.name} ${a.observed.os.version}`.trim(),
            }
          : {}),
        ...(m.owner ? { owner: m.owner } : {}),
      },
      assigned: { tags: [...(m.tags ?? [])], customTags: [...(m.customTags ?? [])] },
      home: { kind: "machine", file: path.join(adoptedDir(m.name), "machine.ts") },
    });
  }
  machines.sort((a, b) => a.name.localeCompare(b.name));
  return { ...(set ? { set } : {}), ...(error ? { error } : {}), machines, networks };
}

/** What stolos build reports about tags (spec 108-tags FR-002): the definitions, and every machine's tags. */
export async function tagProblems(): Promise<TagProblem[]> {
  const out: TagProblem[] = [];
  const { set, error, machines } = await loadFleetTags();
  if (error) out.push({ where: "tags.ts", message: error, fix: "fix fleets/<fleet>/tags.ts" });
  if (set) out.push(...tagSetProblems(set));
  const held = machines.filter((m) => m.assigned.tags.length || m.assigned.customTags.length);
  if (!set && !error && held.length) {
    out.push({
      where: "tags.ts",
      message: `${held.map((m) => m.name).join(", ")} hold tags but the fleet has no tags.ts`,
      fix: "write fleets/<fleet>/tags.ts (stolos tag list says how), or remove the tags",
    });
  }
  for (const m of machines) {
    for (const p of m.resolved.problems) {
      out.push({
        where: `${m.home.kind === "decisions" ? "hosts" : "adopted"}/${m.name}`,
        message: p.replace(`${m.name}: `, ""),
        fix:
          m.assigned.tags.length || p.includes("rule") || p.includes("one-of")
            ? "stolos tag remove <machine> <tag>, or change tags.ts"
            : "change tags.ts",
      });
    }
    for (const c of m.assigned.customTags) {
      if (c.includes(":") || !/^[a-z0-9][a-z0-9._-]{0,38}$/.test(c)) {
        out.push({
          where: `${m.home.kind === "decisions" ? "hosts" : "adopted"}/${m.name}`,
          message: `'${c}' is not a free-form tag (a lowercase word, no colon)`,
          fix: "stolos tag remove <machine> <tag>",
        });
      }
    }
  }
  return out;
}

// ------------------------------------------------------------------------------ showing tags

/** A tag for a line of text: a defined tag as its id, a free-form one marked (custom), an undefined one marked. */
export function tagWord(t: Pick<ResolvedTag, "id" | "standing">): string {
  return t.standing === "custom"
    ? `${t.id} (custom)`
    : t.standing === "unknown"
      ? `${t.id} (not defined)`
      : t.id;
}

/** A machine's tags for one line: the defined ones, then the custom ones apart (`env:lab role:nas · custom: pilot`). */
export function tagLine(tags: ReadonlyArray<Pick<ResolvedTag, "id" | "standing">>): string {
  const defined = tags.filter((t) => t.standing !== "custom").map((t) => tagWord(t));
  const custom = tags.filter((t) => t.standing === "custom").map((t) => t.id);
  return [defined.join(" "), custom.length ? `custom: ${custom.join(", ")}` : ""]
    .filter(Boolean)
    .join(" · ");
}

/** A tag's origin in words (`person`, `rule windows`, `inherited from servers-net`). */
export function originWords(t: Pick<ResolvedTag, "origin" | "from">): string {
  return t.origin === "person"
    ? "person"
    : t.origin === "rule"
      ? `rule ${t.from ?? ""}`.trim()
      : `inherited from ${t.from ?? "a group"}`;
}

/** A tag as a record for JSON, a CSV or evidence: always says whether it is custom, and where it came from. */
export function tagRecord(t: ResolvedTag): Record<string, unknown> {
  return {
    id: t.id,
    custom: t.standing === "custom",
    ...(t.standing === "unknown" ? { defined: false } : {}),
    label: t.label,
    ...(t.dimension ? { dimension: t.dimension } : {}),
    ...(t.colour ? { colour: t.colour } : {}),
    origin: t.origin,
    ...(t.from ? { from: t.from } : {}),
  };
}

// ------------------------------------------------------------------------------ choosing machines

/** What `--tag`, `--any-tag` and `--select` came to: the selection, or why they could not be read. */
export function selectionFromArgs(
  a: { tag?: unknown; "any-tag"?: unknown; select?: unknown },
  set: Pick<TagSet, "dimensions"> | undefined,
): { selection?: Selection; error?: string } {
  const all = tokensOf(a.tag as string | undefined);
  const any = tokensOf(a["any-tag"] as string | undefined);
  const select = typeof a.select === "string" ? a.select : undefined;
  if (!all.length && !any.length && !select?.trim()) return {};
  try {
    const selection = selectionOf({
      all,
      any,
      ...(select === undefined ? {} : { select }),
    });
    if (!selection) return {};
    const problems = selectionProblems(selection, set);
    return problems.length ? { error: problems.join("; ") } : { selection };
  } catch (e) {
    if (e instanceof SelectionError) return { error: e.message };
    throw e;
  }
}

/** The machines a selection chooses (all of them for none). */
export function chosen<M extends Pick<TagMachine, "resolved">>(
  machines: readonly M[],
  selection: Selection | undefined,
): M[] {
  return selection ? machines.filter((m) => matches(selection, idSet(m.resolved))) : [...machines];
}

/** A selection written for people ("env:prod and not role:db"). */
export const selectionText = describeSelection;

/** Read an expression; its message where it cannot be (the console's form uses this). */
export function readSelection(
  text: string,
  set: Pick<TagSet, "dimensions"> | undefined,
): { selection?: Selection; error?: string } {
  if (!text.trim()) return {};
  try {
    const selection = parseSelection(text);
    const problems = selectionProblems(selection, set);
    return problems.length ? { error: problems.join("; ") } : { selection };
  } catch (e) {
    if (e instanceof SelectionError) return { error: e.message };
    throw e;
  }
}

/** An expression a person typed in a form, read against this fleet's own tags (a typo in a tag is an error). */
export async function readSelectionFor(
  text: string,
): Promise<{ selection?: Selection; error?: string }> {
  const { set } = await loadTagSet();
  return readSelection(text, set);
}

/**
 * The same facts with only the chosen machines' evidence: the managed machines, adopted machines and devices that are not chosen
 * are left out (a cloud account's and the estate's evidence is not about a machine, and stays). Compliance scoping (FR-016).
 */
export function scopeFacts<
  F extends {
    machines: Array<{ name: string; kind: string }>;
    adopted: Array<{ machine: { name: string } }>;
    devices?: Array<{ device: { name: string } }>;
  },
>(facts: F, keep: ReadonlySet<string>): F {
  const scoped: F = {
    ...facts,
    machines: facts.machines.filter((m) => m.kind === "cloud" || keep.has(m.name)),
    adopted: facts.adopted.filter((a) => keep.has(a.machine.name)),
  };
  if (facts.devices) scoped.devices = facts.devices.filter((d) => keep.has(d.device.name));
  return scoped;
}

// ------------------------------------------------------------------------------ the console's view

/** One tag of the fleet's definitions, with how many machines hold it. */
export interface TagFacet {
  /** `env:prod`. */
  id: string;
  /** Its label. */
  label: string;
  /** Its colour. */
  colour: string;
  /** Its description. */
  description: string;
  /** How many machines hold it. */
  count: number;
}

/** What the consoles draw of the fleet's tags: the dimensions with counts, and the free-form tags apart. */
export interface TaggingView {
  /** The fleet has a tags.ts that loads. */
  configured: boolean;
  /** Why tags.ts did not load. */
  error?: string;
  /** The dimensions, in order, with each tag's count. */
  dimensions: Array<{
    id: string;
    label: string;
    description: string;
    cardinality: string;
    tags: TagFacet[];
  }>;
  /** The free-form tags in use, with their counts (always apart from the defined ones). */
  custom: Array<{ id: string; count: number }>;
  /** What is wrong with the tags (the build reports the same). */
  problems: string[];
}

/** The consoles' view of the fleet's tags, over the machines (their names and resolved tags). */
export function taggingView(
  set: Pick<TagSet, "dimensions"> | undefined,
  error: string | undefined,
  machines: ReadonlyArray<{ tags?: readonly ResolvedTag[] }>,
): TaggingView {
  const count = new Map<string, number>();
  for (const m of machines)
    for (const t of m.tags ?? []) count.set(t.id, (count.get(t.id) ?? 0) + 1);
  return {
    configured: set !== undefined,
    ...(error ? { error } : {}),
    dimensions: Object.entries(set?.dimensions ?? {}).map(([id, d]) => ({
      id,
      label: d.label,
      description: d.description,
      cardinality: d.cardinality,
      tags: Object.entries(d.tags).map(([v, t]) => ({
        id: `${id}:${v}`,
        label: t.label,
        colour: t.colour,
        description: t.description,
        count: count.get(`${id}:${v}`) ?? 0,
      })),
    })),
    custom: [...count.entries()]
      .filter(([id]) => !id.includes(":"))
      .map(([id, n]) => ({ id, count: n }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    problems: [],
  };
}

// ------------------------------------------------------------------------------ writing a person's tags

/** Write a person's tags into a machine's own file (decisions.ts or machine.ts), in the form Stolos writes. */
export async function writeAssignment(m: TagMachine, a: TagAssignment): Promise<void> {
  const tags = [...(a.tags ?? [])];
  const customTags = [...(a.customTags ?? [])];
  if (m.home.kind === "decisions") {
    const { decisionsSource, loadDecisions } = await import("./decisions.ts");
    const d = await loadDecisions(m.name);
    const next: Parameters<typeof decisionsSource>[0] = {
      ...(d.optIns ? { optIns: d.optIns } : {}),
      ...(tags.length ? { tags } : {}),
      ...(customTags.length ? { customTags } : {}),
    };
    await fs.mkdir(path.dirname(m.home.file), { recursive: true });
    await fs.writeTextFile(m.home.file, decisionsSource(next));
    return;
  }
  const { loadAdopted, machineSource } = await import("../adopt/adopt.ts");
  const was = (await loadAdopted()).find((x) => x.machine.name === m.name)?.machine;
  if (!was) throw new Error(`${m.name} is not an adopted machine of this fleet`);
  const { tags: _t, customTags: _c, ...rest } = was;
  const next: AdoptedDef = {
    ...rest,
    ...(tags.length ? { tags } : {}),
    ...(customTags.length ? { customTags } : {}),
  };
  await fs.writeTextFile(m.home.file, machineSource(next));
}
