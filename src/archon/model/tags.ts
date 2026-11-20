/**
 * # Tags
 *
 * A fleet describes its machines with **tags** it defines itself (spec 108-tags), in TypeScript, in
 * `fleets/<fleet>/tags.ts`. A tag belongs to a **dimension** (`env`, `role`, `site`, `owner`,
 * `criticality`, `data`): a one-of dimension (a machine holds at most one value, an environment) or a
 * many-of one (a machine may hold several, its roles). A tag is written `<dimension>:<value>`
 * (`env:prod`) and has a label, a colour (a name of the console's palette) and a description. The
 * tags' ids are a TypeScript union inferred from that file, so a tag the fleet does not define is a
 * type error wherever it is written, and a problem of `stolos build` where it is read.
 *
 * ```mermaid
 * flowchart LR
 *   defs["fleets/&lt;fleet&gt;/tags.ts<br/>dimensions, rules, groups"] --> resolve["resolveTags"]
 *   person["a person: stolos tag add, stolos pair --tag<br/>(decisions.ts, machine.ts)"] --> resolve
 *   facts["what Stolos knows of the machine<br/>(OS, address, kind, name, owner)"] --> resolve
 *   resolve --> tags["the machine's tags, each with its origin:<br/>person, rule, inherited, and custom ones apart"]
 *   tags --> use["tag list, fleet query --tag, the console, compliance --tag"]
 * ```
 *
 * A **free-form** tag is allowed too: a lowercase word with no colon (`pilot`). It is never defined,
 * and it is always shown as custom, apart from the defined ones. A **rule** in `tags.ts` gives a
 * defined tag from what Stolos knows of a machine (`os windows` gives `os:windows`); a **group**
 * (a site network, an address range, named machines) gives its tags to its members. A tag a person
 * gave wins over a rule's, and a rule's over a group's.
 *
 * Choosing machines by tag uses a small typed parser (`env:prod and not role:db`), never code.
 *
 * @example A fleet's tags.ts
 * ```ts
 * import { addressIn, defineTags, type TagIdOf } from "./tags.ts";
 *
 * export const tags = defineTags(
 *   {
 *     env: {
 *       label: "Environment",
 *       description: "Where the machine's work runs.",
 *       cardinality: "one-of",
 *       tags: {
 *         prod: { label: "Production", colour: "red", description: "Real users depend on it." },
 *         lab: { label: "Lab", colour: "green", description: "Safe to break." },
 *       },
 *     },
 *   },
 *   { rules: [{ id: "rack-a", when: addressIn("10.0.1.0/24"), tag: "env:lab" }] },
 * );
 * export type TagId = TagIdOf<typeof tags.dimensions>;
 * ```
 *
 * @module
 */
// Spec: 108-tags FR-001, FR-002, FR-004, FR-005, FR-009, FR-010, FR-011, FR-012
// Spec: 112-machine-reported-tags FR-002, FR-003, FR-005, FR-011
// Spec: 110-network-assets FR-010

import { absurd } from "@intellectual-frontiers/core";
import {
  TAG_CARDINALITIES,
  TAG_COLOURS,
  type TagCardinality,
  TAG_TRUSTS,
  type DeviceClass,
  type DeviceFacet,
  type TagColour,
  type TagOrigin,
  type TagSource,
  type TagTrust,
  type WayOfJoining,
} from "../ontology.auto.ts";
import { inCidr } from "./site.ts";

export {
  TAG_CARDINALITIES,
  TAG_COLOURS,
  TAG_TRUSTS,
  type TagCardinality,
  type TagColour,
  type TagOrigin,
  type TagSource,
  type TagTrust,
};

// ------------------------------------------------------------------------------ the definitions

/** One tag of a dimension: how it is shown and what it means. */
export interface TagValueDef {
  /** Its name for people ("Production"). */
  label: string;
  /** Its colour: a name of the console's palette (`stolos:TagColour`). */
  colour: TagColour;
  /** What it means, in a sentence. */
  description: string;
}

/** One dimension: a family of tags that answer one question about a machine. */
export interface TagDimensionDef {
  /** Its name for people ("Environment"). */
  label: string;
  /** The question it answers, in a sentence. */
  description: string;
  /** `one-of`: a machine holds at most one of its tags; `many-of`: any number (`stolos:TagCardinality`). */
  cardinality: TagCardinality;
  /**
   * What to do with the tags machines report in this dimension (spec 112-machine-reported-tags FR-003, `stolos:TagTrust`): `accept` (used like a
   * rule's tag, below the fleet's own), `hint` (shown, never used to choose machines; the default) or `ignore` (dropped and counted).
   */
  fromMachine?: TagTrust;
  /** Its tags, by value: `prod` in the dimension `env` is the tag `env:prod`. */
  tags: Readonly<Record<string, TagValueDef>>;
}

/** The dimensions of a fleet, by id (`env`, `role`, ...). */
export type TagDimensions = Readonly<Record<string, TagDimensionDef>>;

/** The ids of every tag the dimensions define: `"env:prod" | "env:lab" | ...`. */
export type TagIdOf<D extends TagDimensions> = {
  [K in keyof D & string]: `${K}:${keyof D[K]["tags"] & string}`;
}[keyof D & string];

/** What Stolos knows of a machine, the facts a rule or a group looks at. */
export interface TagFacts {
  /** Its name in the fleet. */
  name: string;
  /**
   * What it is: a managed server or workstation, an adopted machine, the controller PC, or (spec 110-network-assets) a device a router's
   * controller manages and the fleet adopted through the integration.
   */
  kind: "server" | "workstation" | "adopted" | "controller" | "device";
  /** Its operating system family, lowercase (`linux`, `macos`, `windows`), when it was observed. */
  os?: string;
  /** Its operating system as the probe names it ("Ubuntu 26.04"), when observed. */
  osName?: string;
  /** Its address: a managed server's fixed address, an adopted machine's SSH address. */
  address?: string;
  /** The site network a managed host is on, by name. */
  network?: string;
  /** Who it belongs to (an adopted machine's owner). */
  owner?: string;
  /** How it joined the fleet. */
  joined?: WayOfJoining;
  /** Spec 110-network-assets FR-010: what the integration says of a network asset, or of the machine a client matches. */
  net?: NetworkFacts;
}

/**
 * Spec 110-network-assets FR-010: what a rule may look at on the network. A network asset has all of it the integration gave; a
 * machine a client matches (by MAC) has its `uplink` only.
 */
export interface NetworkFacts {
  /** A network asset's class (`stolos:DeviceClass`). */
  class?: DeviceClass;
  /** Its facets (`stolos:DeviceFacet`). */
  facets?: readonly DeviceFacet[];
  /** Its model. */
  model?: string;
  /** The name of the device it is connected through (its uplink, or a client's device). */
  uplink?: string;
  /** The Wi-Fi networks (SSIDs) it broadcasts. */
  ssids?: readonly string[];
  /** The networks (VLANs), by name and by id, that the Wi-Fi networks it broadcasts carry: the API gives no VLAN to a client or a port. */
  vlans?: readonly string[];
}

/** A rule: a defined tag a machine gets whenever `when` holds (pure and quick; it runs wherever tags are resolved). */
export interface TagRuleDef<T extends string = string> {
  /** Its id, shown as the tag's origin (`windows`). */
  id: string;
  /** What it does, for people (optional). */
  description?: string;
  /** Whether a machine gets the tag. */
  when: (m: TagFacts) => boolean;
  /** The defined tag it gives. */
  tag: T;
}

/** A group: its members inherit its tags. A machine is a member by network, address range or name (any of them). */
export interface TagGroupDef<T extends string = string> {
  /** Its id, shown as the tag's origin (`servers-vlan`). */
  id: string;
  /** What it is, for people (optional). */
  description?: string;
  /** A network of the site (`fleet.site.networks`), by name: a managed host on it, or a machine whose address is in its prefix. */
  network?: string;
  /** An IPv4 prefix (`10.0.1.0/24`). */
  cidr?: string;
  /** Machines by name. */
  names?: readonly string[];
  /** The defined tags the members inherit. */
  tags: readonly T[];
}

/**
 * What a fleet says a machine's `/etc/machine-info` means in its own tags (spec 112-machine-reported-tags FR-005): each map is from what the
 * machine writes (`production`, a place's name, `laptop`) to a tag the fleet defines; typed by the fleet's own tag ids. What it does not
 * name is read as the plain claim (`env:production`, `site:<the text, as a word>`, `kind:laptop`).
 */
export interface MachineInfoMap<T extends string = string> {
  /** `DEPLOYMENT=` (`production`, `staging`, ...) to a tag: `production: "env:prod"`. */
  readonly deployment?: Readonly<Record<string, T>>;
  /** `LOCATION=` (free text, matched without case and surrounding space) to a tag: `"berlin office": "site:main"`. */
  readonly location?: Readonly<Record<string, T>>;
  /** `CHASSIS=` (`laptop`, `server`, ...) to a tag. */
  readonly chassis?: Readonly<Record<string, T>>;
}

/** A fleet's tags: its dimensions, rules and groups, as `defineTags` makes them. */
export interface TagSet<D extends TagDimensions = TagDimensions, T extends string = string> {
  /** The dimensions, in the order the console shows them. */
  readonly dimensions: D;
  /** The rules, in order. */
  readonly rules: readonly TagRuleDef<T>[];
  /** The groups, in order. */
  readonly groups: readonly TagGroupDef<T>[];
  /** What `/etc/machine-info` values mean here (spec 112-machine-reported-tags FR-005), when the fleet says. */
  readonly machineInfoMap?: MachineInfoMap<T>;
}

/** What a fleet does with what machines report in a dimension (`hint` where it does not say). */
export function fromMachineOf(
  set: Pick<TagSet, "dimensions"> | undefined,
  dimension: string,
): TagTrust {
  return set?.dimensions[dimension]?.fromMachine ?? "hint";
}

/** The lowercase id of a dimension. */
export const DIMENSION_ID = /^[a-z][a-z0-9-]{0,19}$/;
/** The lowercase id of a tag's value within its dimension. */
export const VALUE_ID = /^[a-z0-9][a-z0-9-]{0,29}$/;
/** A free-form tag: a lowercase word, no colon. */
export const CUSTOM_TAG = /^[a-z0-9][a-z0-9._-]{0,38}$/;
/** The ids of rules and groups. */
const PART_ID = /^[a-z][a-z0-9-]{0,39}$/;
/** Words of the selection language, which a free-form tag may not be. */
const RESERVED = new Set(["and", "or", "not"]);

/** Every tag a set defines, in order. */
export function definedIds(set: Pick<TagSet, "dimensions">): string[] {
  return Object.entries(set.dimensions).flatMap(([d, def]) =>
    Object.keys(def.tags).map((v) => `${d}:${v}`),
  );
}

/** The dimension of a defined tag id (`env:prod` gives `env`). */
export const dimensionOf = (id: string): string => id.slice(0, Math.max(0, id.indexOf(":")));

/** What is wrong with a set of definitions: where, what, and the fix. Empty when sound. */
export function tagSetProblems(
  set: Pick<TagSet, "dimensions" | "rules" | "groups" | "machineInfoMap">,
): Array<{ where: string; message: string; fix: string }> {
  const out: Array<{ where: string; message: string; fix: string }> = [];
  const add = (where: string, message: string, fix: string) => out.push({ where, message, fix });
  const entries = Object.entries(set.dimensions);
  if (entries.length === 0) {
    add("tags.ts", "no dimension is defined", "define at least one, for example env");
  }
  for (const [d, def] of entries) {
    const w = `tags.ts dimension ${d}`;
    if (!DIMENSION_ID.test(d)) {
      add(w, `'${d}' is not a dimension id`, "lowercase letters, digits and -, from a letter");
    }
    if (!def.label.trim()) add(w, "it has no label", "say its name for people");
    if (!def.description.trim()) add(w, "it has no description", "say what question it answers");
    if (!TAG_CARDINALITIES.includes(def.cardinality)) {
      add(w, `cardinality '${String(def.cardinality)}' is not known`, "one-of or many-of");
    }
    if (def.fromMachine !== undefined && !TAG_TRUSTS.includes(def.fromMachine)) {
      add(
        w,
        `fromMachine '${String(def.fromMachine)}' is not known`,
        `${TAG_TRUSTS.join(", ")} (what to do with the tags machines report; hint where left out)`,
      );
    }
    const values = Object.entries(def.tags);
    if (values.length === 0) add(w, "it has no tags", "define at least one tag in it");
    for (const [v, t] of values) {
      const tw = `tags.ts tag ${d}:${v}`;
      if (!VALUE_ID.test(v)) {
        add(tw, `'${v}' is not a tag value`, "lowercase letters, digits and -, no colon");
      }
      if (!t.label.trim()) add(tw, "it has no label", "say its name for people");
      if (!t.description.trim()) add(tw, "it has no description", "say what it means");
      if (!TAG_COLOURS.includes(t.colour)) {
        add(tw, `colour '${String(t.colour)}' is not in the palette`, TAG_COLOURS.join(", "));
      }
    }
  }
  const ids = new Set(definedIds(set));
  const seen = new Set<string>();
  for (const r of set.rules) {
    const w = `tags.ts rule ${r.id}`;
    if (!PART_ID.test(r.id))
      add(w, `'${r.id}' is not a rule id`, "lowercase letters, digits and -");
    if (seen.has(`rule:${r.id}`)) add(w, "two rules have this id", "give each its own");
    seen.add(`rule:${r.id}`);
    if (typeof r.when !== "function") add(w, "`when` is not a function", "when: (m) => boolean");
    if (!ids.has(r.tag)) add(w, `it gives ${r.tag}, which is not defined`, nearest(set, r.tag));
  }
  for (const g of set.groups) {
    const w = `tags.ts group ${g.id}`;
    if (!PART_ID.test(g.id))
      add(w, `'${g.id}' is not a group id`, "lowercase letters, digits and -");
    if (seen.has(`group:${g.id}`)) add(w, "two groups have this id", "give each its own");
    seen.add(`group:${g.id}`);
    if (g.network === undefined && g.cidr === undefined && !(g.names ?? []).length) {
      add(w, "it has no members", "give it a network, a cidr, or names");
    }
    if (g.cidr !== undefined && !/^(\d{1,3}\.){3}\d{1,3}\/\d{1,2}$/.test(g.cidr)) {
      add(w, `cidr '${g.cidr}' is not an IPv4 prefix`, "for example 10.0.1.0/24");
    }
    if (!g.tags.length) add(w, "it gives no tag", "list the tags its members inherit");
    for (const t of g.tags) {
      if (!ids.has(t)) add(w, `it gives ${t}, which is not defined`, nearest(set, t));
    }
  }
  // Spec 112-machine-reported-tags FR-005: what /etc/machine-info values mean must name defined tags.
  const maps: Array<[string, Readonly<Record<string, string>> | undefined]> = [
    ["deployment", set.machineInfoMap?.deployment],
    ["location", set.machineInfoMap?.location],
    ["chassis", set.machineInfoMap?.chassis],
  ];
  for (const [what, map] of maps) {
    for (const [from, to] of Object.entries(map ?? {})) {
      const w = `tags.ts machineInfoMap.${what}`;
      if (from.length > 64)
        add(w, `'${from.slice(0, 20)}...' is longer than 64 characters`, "shorten it");
      if (!ids.has(String(to))) {
        add(w, `'${from}' gives ${String(to)}, which is not defined`, nearest(set, String(to)));
      }
    }
  }
  return out;
}

/** The fix for a tag that is not defined: what is near it. */
function nearest(set: Pick<TagSet, "dimensions">, id: string): string {
  const d = dimensionOf(id);
  const dim = set.dimensions[d];
  if (dim)
    return `${d} defines ${Object.keys(dim.tags).join(", ")}: add the tag in tags.ts, or use one of those`;
  return `the dimensions are ${Object.keys(set.dimensions).join(", ") || "none"}: define the tag in tags.ts`;
}

/**
 * Define a fleet's tags (`export const tags = defineTags({...})` in `fleets/<fleet>/tags.ts`). The dimensions are inferred as
 * constants, so `TagIdOf<typeof tags.dimensions>` is the union of every tag the fleet defines, and the rules and groups, given
 * as the second argument, may name only those. A malformed definition throws, naming each problem with its fix.
 */
export function defineTags<const D extends TagDimensions>(
  dimensions: D,
  extra: {
    rules?: readonly TagRuleDef<TagIdOf<D>>[];
    groups?: readonly TagGroupDef<TagIdOf<D>>[];
    machineInfoMap?: MachineInfoMap<TagIdOf<D>>;
  } = {},
): TagSet<D, TagIdOf<D>> {
  const set: TagSet<D, TagIdOf<D>> = {
    dimensions,
    rules: extra.rules ?? [],
    groups: extra.groups ?? [],
    ...(extra.machineInfoMap ? { machineInfoMap: extra.machineInfoMap } : {}),
  };
  const problems = tagSetProblems(set);
  if (problems.length) {
    throw new Error(
      `tags.ts: ${problems.map((p) => `${p.where}: ${p.message} (${p.fix})`).join("; ")}`,
    );
  }
  return set;
}

// ------------------------------------------------------------------------------ rule helpers

/** A rule's condition: the machine's operating system family is one of these (`linux`, `macos`, `windows`). */
export const osIs =
  (...families: string[]): ((m: TagFacts) => boolean) =>
  (m) =>
    m.os !== undefined && families.map((f) => f.toLowerCase()).includes(m.os.toLowerCase());

/** A rule's condition: the machine's address is in one of these IPv4 prefixes. */
export const addressIn =
  (...prefixes: string[]): ((m: TagFacts) => boolean) =>
  (m) =>
    m.address !== undefined &&
    /^(\d{1,3}\.){3}\d{1,3}$/.test(m.address) &&
    prefixes.some((p) => inCidr(m.address ?? "", p));

/** A rule's condition: the machine's name matches. */
export const nameMatches =
  (re: RegExp): ((m: TagFacts) => boolean) =>
  (m) =>
    new RegExp(re.source, re.flags.replace(/[gy]/g, "")).test(m.name);

/** A rule's condition: the machine is of one of these kinds. */
export const kindIs =
  (...kinds: TagFacts["kind"][]): ((m: TagFacts) => boolean) =>
  (m) =>
    kinds.includes(m.kind);

/** A rule's condition: the machine's owner is one of these. */
export const ownerIs =
  (...owners: string[]): ((m: TagFacts) => boolean) =>
  (m) =>
    m.owner !== undefined && owners.includes(m.owner);

/** Spec 110-network-assets FR-010: a rule's condition: the machine is a network asset of one of these classes (`switch`, `access-point`, ...). */
export const ofClass =
  (...classes: DeviceClass[]): ((m: TagFacts) => boolean) =>
  (m) =>
    m.net?.class !== undefined && classes.includes(m.net.class);

/** Spec 110-network-assets FR-010: a rule's condition: the machine is a network asset with this facet (`routing`, `wireless`, ...), of any vendor. */
export const withFacet =
  (facet: DeviceFacet): ((m: TagFacts) => boolean) =>
  (m) =>
    m.net?.facets?.includes(facet) === true;

/**
 * Spec 110-network-assets FR-010: a rule's condition: the machine is in this VLAN, by its name or its id at the controller. The official
 * API gives a VLAN to a network and to a Wi-Fi network, and none to a client or a port: so a network asset is "in" the VLANs that the
 * Wi-Fi networks it broadcasts carry, and nothing else is.
 */
export const inVlan =
  (vlan: string): ((m: TagFacts) => boolean) =>
  (m) =>
    m.net?.vlans?.some((v) => v.toLowerCase() === vlan.toLowerCase()) === true;

/** Spec 110-network-assets FR-010: a rule's condition: the machine broadcasts this Wi-Fi network (an SSID). */
export const onSsid =
  (ssid: string): ((m: TagFacts) => boolean) =>
  (m) =>
    m.net?.ssids?.includes(ssid) === true;

/** Spec 110-network-assets FR-010: a rule's condition: the machine is connected through this network device (a switch or an access point, by name). */
export const uplinkedTo =
  (device: string): ((m: TagFacts) => boolean) =>
  (m) =>
    m.net?.uplink !== undefined && m.net.uplink.toLowerCase() === device.toLowerCase();

/** A rule's condition: all of these hold. */
export const allOf =
  (...conds: Array<(m: TagFacts) => boolean>): ((m: TagFacts) => boolean) =>
  (m) =>
    conds.every((c) => c(m));

/** A rule's condition: any of these holds. */
export const anyOf =
  (...conds: Array<(m: TagFacts) => boolean>): ((m: TagFacts) => boolean) =>
  (m) =>
    conds.some((c) => c(m));

// ------------------------------------------------------------------------------ what a person gave

/** The tags a person gave a machine: defined ones, and free-form (custom) ones, kept apart. */
export interface TagAssignment {
  /** Defined tags (`env:prod`). */
  tags?: readonly string[];
  /** Free-form tags (`pilot`): always shown as custom. */
  customTags?: readonly string[];
}

/** What a token a person typed is: a defined tag, a free-form one, or neither (with why, and the fix). */
export type TagToken =
  | { kind: "defined"; id: string }
  | { kind: "custom"; id: string }
  | { kind: "bad"; id: string; why: string; fix: string };

/**
 * Read one token of `stolos tag add` or `stolos pair --tag`. A tag with a colon must be defined; a word without one is free-form,
 * unless it is a dimension's or a tag's own name (`prod`), which is almost surely a forgotten `env:`: that is refused, with the
 * fix, unless `custom` says the person means it.
 */
export function classifyTag(
  set: Pick<TagSet, "dimensions"> | undefined,
  token: string,
  custom = false,
): TagToken {
  const id = token.trim().toLowerCase();
  if (id.includes(":")) {
    if (custom) {
      return {
        kind: "bad",
        id,
        why: "a free-form tag has no colon",
        fix: "leave the colon out, or define the tag in tags.ts",
      };
    }
    if (!set) {
      return {
        kind: "bad",
        id,
        why: "this fleet defines no tags (there is no tags.ts)",
        fix: "write fleets/<fleet>/tags.ts (stolos tag list says where and how)",
      };
    }
    return definedIds(set).includes(id)
      ? { kind: "defined", id }
      : { kind: "bad", id, why: `${id} is not defined`, fix: nearest(set, id) };
  }
  if (!CUSTOM_TAG.test(id) || RESERVED.has(id)) {
    return {
      kind: "bad",
      id,
      why: `'${token}' is not a tag (lowercase letters, digits, . _ -, from a letter or digit; not and, or, not)`,
      fix: "for a defined tag write <dimension>:<value>, for a free-form one a plain lowercase word",
    };
  }
  if (!custom && set) {
    const dim = set.dimensions[id];
    const hit = Object.entries(set.dimensions).find(([, d]) => id in d.tags);
    if (dim || hit) {
      return {
        kind: "bad",
        id,
        why: dim
          ? `${id} is a dimension of this fleet's tags`
          : `${id} is a value of the dimension ${hit?.[0]}`,
        fix: dim
          ? `write ${id}:<value> (${Object.keys(dim.tags).join(", ")}), or --custom for a free-form tag called ${id}`
          : `write ${hit?.[0]}:${id}, or --custom for a free-form tag called ${id}`,
      };
    }
  }
  return { kind: "custom", id };
}

/** The new assignment after tags are added, and what each one replaced (a one-of dimension holds one value). */
export function addAssigned(
  set: Pick<TagSet, "dimensions">,
  was: TagAssignment,
  add: readonly TagToken[],
): {
  assigned: { tags: string[]; customTags: string[] };
  replaced: Array<{ was: string; by: string }>;
} {
  let tags = [...(was.tags ?? [])];
  const customTags = [...(was.customTags ?? [])];
  const replaced: Array<{ was: string; by: string }> = [];
  for (const t of add) {
    if (t.kind === "custom") {
      if (!customTags.includes(t.id)) customTags.push(t.id);
    } else if (t.kind === "defined") {
      const dim = set.dimensions[dimensionOf(t.id)];
      if (dim?.cardinality === "one-of") {
        for (const old of tags.filter((x) => dimensionOf(x) === dimensionOf(t.id) && x !== t.id)) {
          replaced.push({ was: old, by: t.id });
        }
        tags = tags.filter((x) => dimensionOf(x) !== dimensionOf(t.id));
      }
      if (!tags.includes(t.id)) tags.push(t.id);
    }
  }
  return { assigned: { tags: sortTags(set, tags), customTags: customTags.sort() }, replaced };
}

/** The new assignment after tags are removed (a tag the machine does not hold by a person's hand is listed as missing). */
export function removeAssigned(
  was: TagAssignment,
  remove: readonly string[],
): { assigned: { tags: string[]; customTags: string[] }; missing: string[] } {
  const gone = new Set(remove.map((t) => t.trim().toLowerCase()));
  const have = new Set([...(was.tags ?? []), ...(was.customTags ?? [])]);
  const missing = [...gone].filter((t) => !have.has(t));
  return {
    assigned: {
      tags: (was.tags ?? []).filter((t) => !gone.has(t)),
      customTags: (was.customTags ?? []).filter((t) => !gone.has(t)),
    },
    missing,
  };
}

/** Defined tags in the order of the definitions (the same way every time, so a file is stable). */
export function sortTags(set: Pick<TagSet, "dimensions">, ids: readonly string[]): string[] {
  const order = definedIds(set);
  return [...new Set(ids)].sort((a, b) => {
    const ia = order.indexOf(a);
    const ib = order.indexOf(b);
    return (ia < 0 ? 1e9 : ia) - (ib < 0 ? 1e9 : ib) || a.localeCompare(b);
  });
}

// ------------------------------------------------------------------------------ resolving a machine's tags

/** One tag a machine holds, resolved. */
export interface ResolvedTag {
  /** `env:prod`, or a free-form word. */
  id: string;
  /** Defined in tags.ts, free-form (custom: always shown apart), or written but not defined (a problem). */
  standing: "defined" | "custom" | "unknown";
  /** Its label (its id where it has none). */
  label: string;
  /** Its colour, when defined. */
  colour?: TagColour;
  /** Its description, when defined. */
  description?: string;
  /** Its dimension, when defined. */
  dimension?: string;
  /** Where it came from (`stolos:TagOrigin`). */
  origin: TagOrigin;
  /** The rule or the group it came from (not a person's), or, for a reported tag, the source on the machine (`stolos:TagSource`). */
  from?: string;
  /** For a reported or announced tag: what the fleet does with it (`hint`: shown, never used to choose machines; `accept`: used). */
  trust?: TagTrust;
}

/** A tag a machine would hold, and what beat it. */
export interface DroppedTag {
  /** The tag that was not kept. */
  id: string;
  /** Where it would have come from. */
  origin: TagOrigin;
  /** The rule or group. */
  from?: string;
  /** The tag of the same one-of dimension that was kept instead. */
  by: string;
}

/** A claim a machine made about itself (`stolos:TagClaim`), read and checked, before the fleet decides what to do with it. */
export interface ReportedClaim {
  /** `env:prod`, or a free-form word: already read with the tag grammar. */
  id: string;
  /** `reported` (read over the authenticated channel) or `announced` (heard on the network: a hint only). */
  origin: Extract<TagOrigin, "reported" | "announced">;
  /** Where on the machine it was read (`stolos:TagSource`). */
  source: TagSource;
  /** Who set it, where the machine says (a row of its tags table). */
  setBy?: string;
  /** When it was set, where the machine says. */
  setAt?: string;
}

/** What became of a claim (spec 112-machine-reported-tags FR-002, FR-003, FR-014). */
export type ClaimStatus =
  /** It is a tag the machine holds now, with the origin `reported`. */
  | "held"
  /** The fleet holds the same tag: the stronger origin shows. */
  | "agrees"
  /** The fleet holds another tag of the same one-of dimension: the fleet wins (a finding). */
  | "disagrees"
  /** Another claim of the same one-of dimension is held instead. */
  | "overridden"
  /** The fleet's `tags.ts` does not define it: listed, never held, never accepted. */
  | "undefined"
  /** The dimension says `fromMachine: "ignore"`: dropped and counted. */
  | "ignored";

/** One claim, with what the fleet did with it. */
export interface ClaimView extends ReportedClaim {
  /** What became of it. */
  status: ClaimStatus;
  /** What the fleet does with the tags of its dimension. */
  trust: TagTrust;
  /** For a disagreement, the fleet's own tag it lost to. */
  against?: string;
  /** Its label, when it is a defined tag. */
  label?: string;
  /** Its colour, when it is a defined tag. */
  colour?: TagColour;
}

/** A machine that says one thing where the fleet says another, in a one-of dimension: a finding of inventory accuracy (NIST SP 800-53 CM-8). */
export interface TagDisagreement {
  /** The machine. */
  machine: string;
  /** The dimension. */
  dimension: string;
  /** What the machine reports. */
  reported: string;
  /** What the fleet says. */
  fleet: string;
  /** Where on the machine it said so. */
  source: TagSource;
  /** `alpha reports env:prod; the fleet says env:lab`. */
  text: string;
}

/** A machine's resolved tags. */
export interface ResolvedTags {
  /** The tags it holds: the defined ones in the order of the definitions, then the free-form ones. */
  tags: ResolvedTag[];
  /** Tags that lost to a stronger origin in a one-of dimension. */
  dropped: DroppedTag[];
  /** What is wrong: an unknown tag, two values in a one-of dimension, a rule that threw. */
  problems: string[];
  /** Every claim the machine made, with what became of it (spec 112-machine-reported-tags). */
  claims: ClaimView[];
  /** Where a claim disagrees with the fleet's tag in a one-of dimension: the fleet wins, and this is the finding. */
  disagreements: TagDisagreement[];
  /** How many claims a dimension's `fromMachine: "ignore"` dropped. */
  ignored: number;
}

const STRENGTH: Record<TagOrigin, number> = {
  person: 5,
  rule: 4,
  inherited: 3,
  reported: 2,
  announced: 1,
};

/** Whether an origin is a claim of the machine (reported or announced), not the fleet's own. */
export const isClaimOrigin = (o: TagOrigin): boolean => o === "reported" || o === "announced";

/** Whether a machine is a member of a group. */
export function inGroup(
  g: TagGroupDef,
  m: TagFacts,
  networks: Readonly<Record<string, string>> = {},
): boolean {
  if (g.names?.includes(m.name)) return true;
  if (g.network !== undefined) {
    if (m.network === g.network) return true;
    const net = networks[g.network];
    if (net && m.address && /^(\d{1,3}\.){3}\d{1,3}$/.test(m.address) && inCidr(m.address, net)) {
      return true;
    }
  }
  return (
    g.cidr !== undefined &&
    m.address !== undefined &&
    /^(\d{1,3}\.){3}\d{1,3}$/.test(m.address) &&
    inCidr(m.address, g.cidr)
  );
}

/**
 * The tags a machine holds: the ones a person gave, then the rules' (run over `facts`), then its groups', each with its origin. A
 * one-of dimension holds one value: the strongest origin's (person, then rule, then inherited) is kept and the other is listed as
 * dropped; two values of the same strength are a problem, and the first stays. Free-form tags come last, always as custom.
 *
 * Spec 112-machine-reported-tags: then the machine's own claims, reported before announced, below everything the fleet says. A claim
 * in a dimension that says `fromMachine: "ignore"` is dropped and counted; one the fleet does not define is listed and never held; one
 * of a one-of dimension where the fleet holds another value is dropped and is a disagreement (the fleet wins, and says so); the rest
 * are held with the origin `reported` (or `announced`), with the trust of their dimension (`hint` or `accept`).
 */
export function resolveTags(
  set: Pick<TagSet, "dimensions" | "rules" | "groups"> | undefined,
  facts: TagFacts,
  assigned: TagAssignment = {},
  networks: Readonly<Record<string, string>> = {},
  claims: readonly ReportedClaim[] = [],
): ResolvedTags {
  const problems: string[] = [];
  const dropped: DroppedTag[] = [];
  const held = new Map<string, ResolvedTag>();
  const put = (id: string, origin: TagOrigin, from?: string): void => {
    const def = set?.dimensions[dimensionOf(id)];
    const value = def?.tags[id.slice(id.indexOf(":") + 1)];
    if (!def || !value) {
      if (origin === "person") {
        held.set(id, { id, standing: "unknown", label: id, origin });
        problems.push(
          `${facts.name}: ${id} is not defined in tags.ts${set ? ` (${nearest(set, id)})` : ""}`,
        );
      }
      return;
    }
    const dim = dimensionOf(id);
    const tag: ResolvedTag = {
      id,
      standing: "defined",
      label: value.label,
      colour: value.colour,
      description: value.description,
      dimension: dim,
      origin,
      ...(from === undefined ? {} : { from }),
    };
    const have = held.get(id);
    if (have) {
      // The same tag from two origins: the stronger shows.
      if (STRENGTH[origin] > STRENGTH[have.origin]) held.set(id, tag);
      return;
    }
    if (def.cardinality === "one-of") {
      const other = [...held.values()].find((h) => h.standing === "defined" && h.dimension === dim);
      if (other) {
        const a = STRENGTH[origin];
        const b = STRENGTH[other.origin];
        if (a > b) {
          dropped.push({
            id: other.id,
            origin: other.origin,
            ...(other.from === undefined ? {} : { from: other.from }),
            by: id,
          });
          held.delete(other.id);
          held.set(id, tag);
        } else {
          dropped.push({ id, origin, ...(from === undefined ? {} : { from }), by: other.id });
          if (a === b) {
            problems.push(
              `${facts.name}: two values of the one-of dimension ${dim} (${other.id} and ${id}, both ${origin === "person" ? "from a person" : `from ${origin}s`}): ${other.id} is kept`,
            );
          }
        }
        return;
      }
    }
    held.set(id, tag);
  };
  for (const id of assigned.tags ?? []) put(id, "person");
  for (const r of set?.rules ?? []) {
    let hit = false;
    try {
      hit = r.when(facts) === true;
    } catch (e) {
      problems.push(
        `${facts.name}: rule ${r.id} failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    if (hit) put(r.tag, "rule", r.id);
  }
  for (const g of set?.groups ?? []) {
    if (inGroup(g, facts, networks)) for (const t of g.tags) put(t, "inherited", g.id);
  }
  const claimViews: ClaimView[] = [];
  const disagreements: TagDisagreement[] = [];
  let ignored = 0;
  const byStrength = [...claims].sort(
    (a, b) => STRENGTH[b.origin] - STRENGTH[a.origin] || a.id.localeCompare(b.id),
  );
  const customHeld = new Map<string, ResolvedTag>();
  for (const c of byStrength) {
    const dim = dimensionOf(c.id);
    const def = c.id.includes(":") ? set?.dimensions[dim] : undefined;
    const value = def?.tags[c.id.slice(c.id.indexOf(":") + 1)];
    const trust: TagTrust = c.id.includes(":") ? fromMachineOf(set, dim) : "hint";
    const view: ClaimView = { ...c, status: "held", trust };
    claimViews.push(view);
    if (!c.id.includes(":")) {
      // A free-form word: always a hint, always custom.
      if (!customHeld.has(c.id) && !(assigned.customTags ?? []).includes(c.id)) {
        customHeld.set(c.id, {
          id: c.id,
          standing: "custom",
          label: c.id,
          origin: c.origin,
          from: c.source,
          trust: "hint",
        });
      } else view.status = "agrees";
      continue;
    }
    if (!def || !value) {
      view.status = "undefined";
      continue;
    }
    view.label = value.label;
    view.colour = value.colour;
    if (trust === "ignore") {
      view.status = "ignored";
      ignored++;
      continue;
    }
    const have = held.get(c.id);
    if (have) {
      view.status = "agrees";
      continue;
    }
    if (def.cardinality === "one-of") {
      const other = [...held.values()].find((h) => h.standing === "defined" && h.dimension === dim);
      if (other) {
        view.against = other.id;
        if (isClaimOrigin(other.origin)) view.status = "overridden";
        else {
          view.status = "disagrees";
          disagreements.push({
            machine: facts.name,
            dimension: dim,
            reported: c.id,
            fleet: other.id,
            source: c.source,
            text: `${facts.name} ${c.origin === "reported" ? "reports" : "announces"} ${c.id}; the fleet says ${other.id}`,
          });
        }
        continue;
      }
    }
    held.set(c.id, {
      id: c.id,
      standing: "defined",
      label: value.label,
      colour: value.colour,
      description: value.description,
      dimension: dim,
      origin: c.origin,
      from: c.source,
      trust,
    });
  }
  const order = set ? definedIds(set) : [];
  const defined = [...held.values()]
    .filter((t) => t.standing !== "custom")
    .sort((a, b) => {
      const ia = order.indexOf(a.id);
      const ib = order.indexOf(b.id);
      return (ia < 0 ? 1e9 : ia) - (ib < 0 ? 1e9 : ib) || a.id.localeCompare(b.id);
    });
  const custom: ResolvedTag[] = [
    ...[...new Set(assigned.customTags ?? [])].sort().map((id) => ({
      id,
      standing: "custom" as const,
      label: id,
      origin: "person" as const,
    })),
    ...[...customHeld.values()].sort((a, b) => a.id.localeCompare(b.id)),
  ];
  return {
    tags: [...defined, ...custom],
    dropped,
    problems,
    claims: claimViews,
    disagreements,
    ignored,
  };
}

/** Whether a resolved tag is one the fleet uses: its own, or a claim of a dimension that says `accept` (never a hint). */
export const isUsed = (t: Pick<ResolvedTag, "origin" | "trust">): boolean =>
  !isClaimOrigin(t.origin) || t.trust === "accept";

/**
 * The ids a machine holds, as a set (what a selection is matched against): the fleet's own tags and the claims of dimensions that say
 * `accept`; the hints only with `reported` (spec 112-machine-reported-tags FR-011).
 */
export const idSet = (r: Pick<ResolvedTags, "tags">, reported = false): ReadonlySet<string> =>
  new Set(r.tags.filter((t) => reported || isUsed(t)).map((t) => t.id));

// ------------------------------------------------------------------------------ choosing machines by tag

/** A choice of machines by their tags (`stolos:TagSelection`). */
export type Selection =
  | { op: "tag"; id: string }
  | { op: "dimension"; dimension: string }
  | { op: "and" | "or"; of: Selection[] }
  | { op: "not"; of: Selection };

/** An expression that cannot be read: what is wrong and where (a position in the text, from 0). */
export class SelectionError extends Error {
  /** Where in the text it went wrong. */
  readonly at: number;
  /** Make the error. */
  constructor(message: string, at: number) {
    super(`${message} (at ${at + 1} of the expression)`);
    this.name = "SelectionError";
    this.at = at;
  }
}

/** The longest expression read, and the deepest nesting. */
export const SELECT_LIMITS = { chars: 500, depth: 16 } as const;

const TOKEN = /^[a-z0-9._:*-]+$/;

/** An expression's tokens: words, parentheses; each with where it starts. */
function tokens(text: string): Array<{ t: string; at: number }> {
  const out: Array<{ t: string; at: number }> = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i] ?? "";
    if (/\s/.test(c)) {
      i++;
    } else if (c === "(" || c === ")") {
      out.push({ t: c, at: i++ });
    } else {
      let j = i;
      while (j < text.length && !/[\s()]/.test(text[j] ?? "")) j++;
      out.push({ t: text.slice(i, j).toLowerCase(), at: i });
      i = j;
    }
  }
  return out;
}

/**
 * Read an expression: tags, `dimension:*` (any value of a dimension), `and`, `or`, `not`, and parentheses (`env:prod and not role:db`).
 * `not` binds tighter than `and`, `and` tighter than `or`. The text is data, never evaluated: it is cut into tokens and read by
 * recursive descent, at most {@link SELECT_LIMITS} long and deep. Throws a {@link SelectionError} naming where it went wrong.
 */
export function parseSelection(text: string): Selection {
  if (text.length > SELECT_LIMITS.chars) {
    throw new SelectionError(`the expression is longer than ${SELECT_LIMITS.chars} characters`, 0);
  }
  const ts = tokens(text);
  if (!ts.length) throw new SelectionError("the expression is empty", 0);
  let p = 0;
  const peek = () => ts[p];
  const fail = (msg: string, at?: number): never => {
    throw new SelectionError(msg, at ?? peek()?.at ?? text.length);
  };
  const orExpr = (depth: number): Selection => {
    if (depth > SELECT_LIMITS.depth) fail(`nested more than ${SELECT_LIMITS.depth} deep`);
    const parts = [andExpr(depth)];
    while (peek()?.t === "or") {
      p++;
      parts.push(andExpr(depth));
    }
    return parts.length === 1 ? (parts[0] as Selection) : { op: "or", of: parts };
  };
  const andExpr = (depth: number): Selection => {
    const parts = [notExpr(depth)];
    while (peek()?.t === "and") {
      p++;
      parts.push(notExpr(depth));
    }
    return parts.length === 1 ? (parts[0] as Selection) : { op: "and", of: parts };
  };
  const notExpr = (depth: number): Selection => {
    if (peek()?.t === "not") {
      p++;
      return { op: "not", of: notExpr(depth + 1) };
    }
    return atom(depth);
  };
  const atom = (depth: number): Selection => {
    const t = peek();
    if (!t) return fail("a tag is missing at the end", text.length);
    if (t.t === "(") {
      p++;
      const e = orExpr(depth + 1);
      if (peek()?.t !== ")") fail("a closing parenthesis is missing");
      p++;
      return e;
    }
    if (t.t === ")" || t.t === "and" || t.t === "or") {
      return fail(`a tag was expected, not '${t.t}'`);
    }
    if (!TOKEN.test(t.t)) return fail(`'${t.t}' is not a tag`);
    p++;
    if (t.t.endsWith(":*")) {
      const dimension = t.t.slice(0, -2);
      if (!DIMENSION_ID.test(dimension)) return fail(`'${t.t}' is not a dimension`, t.at);
      return { op: "dimension", dimension };
    }
    if (t.t.includes("*")) return fail(`'${t.t}': only dimension:* is a pattern`, t.at);
    return { op: "tag", id: t.t };
  };
  const e = orExpr(0);
  if (p < ts.length) fail(`'${peek()?.t}' was not expected here`);
  return e;
}

/** Whether a machine holding these tags is chosen. */
export function matches(s: Selection, held: ReadonlySet<string>): boolean {
  switch (s.op) {
    case "tag":
      return held.has(s.id);
    case "dimension":
      return [...held].some((t) => t.startsWith(`${s.dimension}:`));
    case "and":
      return s.of.every((x) => matches(x, held));
    case "or":
      return s.of.some((x) => matches(x, held));
    case "not":
      return !matches(s.of, held);
    default:
      return absurd(s);
  }
}

/** The tags and dimensions an expression names. */
export function namedIn(s: Selection): { tags: string[]; dimensions: string[] } {
  switch (s.op) {
    case "tag":
      return { tags: [s.id], dimensions: [] };
    case "dimension":
      return { tags: [], dimensions: [s.dimension] };
    case "and":
    case "or": {
      const parts = s.of.map(namedIn);
      return {
        tags: parts.flatMap((x) => x.tags),
        dimensions: parts.flatMap((x) => x.dimensions),
      };
    }
    case "not":
      return namedIn(s.of);
    default:
      return absurd(s);
  }
}

/**
 * What is wrong with the tags a selection names: a tag with a colon that the fleet does not define, or a dimension it does not
 * have, is a typo, and is refused with what is near it (a free-form word is allowed: nothing may hold it). Empty when sound.
 */
export function selectionProblems(
  s: Selection,
  set: Pick<TagSet, "dimensions"> | undefined,
): string[] {
  const named = namedIn(s);
  const out: string[] = [];
  const defined = new Set(set ? definedIds(set) : []);
  for (const t of new Set(named.tags)) {
    if (t.includes(":") && !defined.has(t)) {
      out.push(
        set
          ? `${t} is not defined: ${nearest(set, t)}`
          : `${t} is not defined: this fleet has no tags.ts`,
      );
    }
  }
  for (const d of new Set(named.dimensions)) {
    if (!set?.dimensions[d]) {
      out.push(
        `${d}:* names a dimension this fleet does not have (${Object.keys(set?.dimensions ?? {}).join(", ") || "none"})`,
      );
    }
  }
  return out;
}

/** The expression written back, fully parenthesised where it needs to be (for a line that says what was chosen). */
export function describeSelection(s: Selection, top = true): string {
  switch (s.op) {
    case "tag":
      return s.id;
    case "dimension":
      return `${s.dimension}:*`;
    case "not":
      return `not ${describeSelection(s.of, false)}`;
    case "and":
    case "or": {
      const text = s.of.map((x) => describeSelection(x, false)).join(` ${s.op} `);
      return top ? text : `(${text})`;
    }
    default:
      return absurd(s);
  }
}

/** What a person asked for on a command line or in a form: all of these tags, any of these, and an expression. */
export interface SelectionInput {
  /** Tags that must all hold (`--tag`). */
  all?: readonly string[];
  /** Tags of which at least one must hold (`--any-tag`). */
  any?: readonly string[];
  /** An expression (`--select`). */
  select?: string;
}

/** Everything asked for must hold: the tags, one of the any-tags, and the expression. Undefined where nothing was asked. */
export function selectionOf(i: SelectionInput): Selection | undefined {
  const parts: Selection[] = [];
  for (const t of i.all ?? []) parts.push(tagLeaf(t));
  if (i.any?.length) {
    const of = i.any.map(tagLeaf);
    parts.push(of.length === 1 ? (of[0] as Selection) : { op: "or", of });
  }
  if (i.select?.trim()) parts.push(parseSelection(i.select));
  if (!parts.length) return undefined;
  return parts.length === 1 ? parts[0] : { op: "and", of: parts };
}

/** One `--tag` value as a selection: a tag, or `dimension:*`. */
function tagLeaf(token: string): Selection {
  const s = parseSelection(token);
  if (s.op !== "tag" && s.op !== "dimension") {
    throw new SelectionError(`'${token}' is one tag; use --select for an expression`, 0);
  }
  return s;
}

/** Split a repeatable option's value (its values are joined with newlines, and a person may use commas) into tokens. */
export function tokensOf(value: string | boolean | undefined): string[] {
  return typeof value === "string"
    ? value
        .split(/[\n,]+/)
        .map((x) => x.trim())
        .filter(Boolean)
    : [];
}

// ------------------------------------------------------------------------------ the starter kit

/** The starter kit a new fleet's tags.ts comes with (spec 108-tags FR-003): the dimensions most fleets want, to edit freely. */
export const STARTER_DIMENSIONS = {
  env: {
    label: "Environment",
    description: "Where the machine's work runs.",
    cardinality: "one-of",
    fromMachine: "accept",
    tags: {
      prod: {
        label: "Production",
        colour: "red",
        description: "Real users or the business depend on it.",
      },
      staging: {
        label: "Staging",
        colour: "orange",
        description: "A copy of production to try changes on.",
      },
      lab: { label: "Lab", colour: "green", description: "Safe to break and to rebuild." },
    },
  },
  role: {
    label: "Role",
    description: "What the machine is for.",
    cardinality: "many-of",
    fromMachine: "hint",
    tags: {
      server: { label: "Server", colour: "blue", description: "Serves other machines or people." },
      workstation: { label: "Workstation", colour: "teal", description: "A person works on it." },
      nas: { label: "NAS", colour: "violet", description: "Keeps files for others." },
      database: { label: "Database", colour: "orange", description: "Holds a database." },
      web: { label: "Web", colour: "blue", description: "Serves web pages or an API." },
      network: {
        label: "Network",
        colour: "grey",
        description: "Routes, switches or reaches the network.",
      },
    },
  },
  site: {
    label: "Site",
    description: "Where the machine is.",
    cardinality: "one-of",
    fromMachine: "accept",
    tags: {
      main: { label: "Main site", colour: "blue", description: "The fleet's own premises." },
      remote: {
        label: "Remote",
        colour: "teal",
        description: "Away from the main site (a home, a branch).",
      },
      cloud: { label: "Cloud", colour: "violet", description: "In a cloud account." },
    },
  },
  owner: {
    label: "Owner",
    description: "The team accountable for the machine.",
    cardinality: "one-of",
    fromMachine: "hint",
    tags: {
      it: { label: "IT", colour: "violet", description: "Run by the people who run IT." },
      engineering: {
        label: "Engineering",
        colour: "blue",
        description: "Run by the engineering team.",
      },
      office: {
        label: "Office",
        colour: "pink",
        description: "Belongs to the office and its staff.",
      },
    },
  },
  criticality: {
    label: "Criticality",
    description: "How much the business suffers if it is lost (FIPS 199's impact levels).",
    cardinality: "one-of",
    fromMachine: "ignore",
    tags: {
      low: { label: "Low", colour: "green", description: "Its loss has a limited effect." },
      moderate: {
        label: "Moderate",
        colour: "yellow",
        description: "Its loss has a serious effect.",
      },
      high: { label: "High", colour: "red", description: "Its loss has a severe effect." },
    },
  },
  data: {
    label: "Data class",
    description: "The most sensitive class of data the machine holds.",
    cardinality: "one-of",
    fromMachine: "ignore",
    tags: {
      public: { label: "Public", colour: "green", description: "Anyone may see it." },
      internal: { label: "Internal", colour: "yellow", description: "For the organization only." },
      confidential: {
        label: "Confidential",
        colour: "orange",
        description: "Its disclosure would harm the organization.",
      },
      regulated: {
        label: "Regulated",
        colour: "red",
        description: "A law or contract governs it.",
      },
    },
  },
} as const satisfies TagDimensions;

/** The text of the starter kit as the dimensions of a `tags.ts`: what a new fleet gets. */
export function dimensionsSource(dims: TagDimensions = STARTER_DIMENSIONS): string {
  const q = (s: string) => JSON.stringify(s);
  const lines: string[] = [];
  for (const [d, def] of Object.entries(dims)) {
    lines.push(
      `    ${d}: {`,
      `      label: ${q(def.label)},`,
      `      description: ${q(def.description)},`,
      `      cardinality: ${q(def.cardinality)},`,
      ...(def.fromMachine === undefined ? [] : [`      fromMachine: ${q(def.fromMachine)},`]),
      `      tags: {`,
    );
    for (const [v, t] of Object.entries(def.tags)) {
      lines.push(
        `        ${/^[a-z]\w*$/.test(v) ? v : q(v)}: {`,
        `          label: ${q(t.label)},`,
        `          colour: ${q(t.colour)},`,
        `          description: ${q(t.description)},`,
        `        },`,
      );
    }
    lines.push(`      },`, `    },`);
  }
  return lines.join("\n");
}

/** A new fleet's `tags.ts` (spec 108-tags FR-003): the starter kit, with where to edit it. */
export function starterTagsSource(): string {
  return `/**
 * This fleet's tags (spec 108-tags): the labels its machines wear, defined here and nowhere else.
 * A tag is \`<dimension>:<value>\`; a one-of dimension holds one value per machine, a many-of one any
 * number. Edit this file like any other (add a dimension, a tag, a rule, a group), then run
 * \`stolos build\`: a tag that is not defined here is a type error and a problem of the build.
 * Give a machine tags with \`stolos tag add <machine> env:lab\` or \`stolos pair --tag env:lab\`.
 *
 * @module
 */

import { defineTags, type TagIdOf } from "@intellectual-frontiers/stolos/archon/model/tags";

export const tags = defineTags(
  {
${dimensionsSource()}
  },
  {
    // Rules give a tag from what Stolos knows of a machine, for example:
    //   rules: [{ id: "windows", when: osIs("windows"), tag: "role:workstation" }],
    // Groups give their tags to a site network, an address range, or named machines, for example:
    //   groups: [{ id: "servers-net", network: "Servers", tags: ["site:main"] }],
    rules: [],
    groups: [],
    // What a machine's /etc/machine-info means here (spec 112-machine-reported-tags): DEPLOYMENT= becomes an environment.
    // \`fromMachine\` on a dimension says what to do with what machines report: accept, hint (the default) or ignore.
    machineInfoMap: {
      deployment: { production: "env:prod", staging: "env:staging", development: "env:lab" },
    },
  },
);

/** Every tag of this fleet: what a typed file (decisions.ts, machine.ts) may hold. */
export type TagId = TagIdOf<typeof tags.dimensions>;
`;
}
