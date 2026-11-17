/**
 * # What a machine says about itself
 *
 * A machine can say what it is: a person set `DEPLOYMENT=production` in its `/etc/machine-info` (systemd `machine-info(5)`), its firmware
 * says it is a Dell laptop or an Amazon EC2 instance (DMTF DSP0134 SMBIOS), and a person on it added tags of its own with `archon tag add`
 * (spec 112-machine-reported-tags). The fleet reads those as **claims** (`stolos:TagClaim`): never its own tags, always untrusted input.
 * This module is the pure part: it turns the raw text a machine sent into claims, with the tag grammar of spec 108, a cap on each tag and
 * on each machine, and a count of what it dropped. It never evaluates, never builds a pattern or a path from what it reads, and never
 * throws on a machine's words.
 *
 * ```mermaid
 * flowchart LR
 *   raw["the machine's words<br/>machine-info, tags table, SMBIOS"] --> san["sanitizeReport<br/>(bounded, no control characters)"]
 *   san --> cache["the PC's observation cache"]
 *   cache --> claims["claimsFrom<br/>grammar, 64 characters, 64 claims, counted"]
 *   claims --> resolve["resolveTags<br/>fromMachine: accept, hint, ignore"]
 * ```
 *
 * @example Claims from a machine's /etc/machine-info
 * ```ts
 * import { claimsFrom, parseMachineInfo } from "./reported.ts";
 *
 * const machineInfo = parseMachineInfo('DEPLOYMENT=production\nCHASSIS=laptop\nTAGS="role:web pilot"\n');
 * const { claims } = claimsFrom({ at: "2026-11-17T00:00:00Z", machineInfo });
 * console.log(claims.map((c) => c.id).join(" ")); // role:web pilot kind:laptop env:production
 * ```
 *
 * @module
 */
// Spec: 112-machine-reported-tags FR-004, FR-005, FR-006, FR-007

import type { TagSource } from "../ontology.auto.ts";
import {
  CUSTOM_TAG,
  DIMENSION_ID,
  type MachineInfoMap,
  type ReportedClaim,
  VALUE_ID,
} from "./tags.ts";

/** The caps on what a machine says (spec 112-machine-reported-tags FR-004). */
export const REPORT_LIMITS = {
  /** The longest tag, in characters. */
  tagChars: 64,
  /** The most claims read from one machine. */
  perMachine: 64,
  /** The longest raw string kept from a machine. */
  rawChars: 200,
  /** The most rows of a machine's tags table kept. */
  rows: 128,
} as const;

/** One row of a machine's own tags table (`archon tag`, the osquery table `archon_tags`). */
export interface TagRow {
  /** The dimension (`env`), or "" for a free-form tag. */
  dimension: string;
  /** The value (`prod`), or the free-form word. */
  value: string;
  /** `local` (a person on the machine) or `fleet` (what the machine worked out from the fleet repository). */
  source: string;
  /** Who set it. */
  set_by?: string;
  /** When (ISO time). */
  set_at?: string;
}

/** The firmware facts of a machine (DMTF DSP0134 SMBIOS), as raw text. */
export interface Smbios {
  /** The maker (`sys_vendor`, `Manufacturer`). */
  vendor?: string;
  /** The model (`product_name`). */
  model?: string;
  /** The enclosure's chassis type, a number of DSP0134 table 17 (`chassis_type`), as text. */
  chassis?: string;
  /** The BIOS vendor. */
  biosVendor?: string;
}

/** What the PC read from one machine: bounded raw text, kept in its observation cache. */
export interface MachineReport {
  /** When it was read (ISO time). */
  at: string;
  /** `/etc/machine-info`'s DEPLOYMENT, LOCATION, CHASSIS and TAGS, as raw text. */
  machineInfo?: Record<string, string>;
  /** The rows of the machine's own tags table. */
  tags?: TagRow[];
  /** The firmware facts. */
  smbios?: Smbios;
}

/** What `claimsFrom` made of a report. */
export interface ParsedClaims {
  /** The claims, in a fixed order (the machine's own table, then machine-info, then firmware). */
  claims: ReportedClaim[];
  /** How many things it said that were dropped: malformed, too long, or over the cap. */
  dropped: number;
  /** The gaps, in words (what was dropped and why): shown, never an error. */
  gaps: string[];
}

/** The keys of `/etc/machine-info` this fleet reads. */
export const MACHINE_INFO_KEYS = ["DEPLOYMENT", "LOCATION", "CHASSIS", "TAGS"] as const;

/** The values `CHASSIS=` may have (machine-info(5)). */
export const CHASSIS_VALUES: readonly string[] = [
  "desktop",
  "laptop",
  "convertible",
  "server",
  "tablet",
  "handset",
  "watch",
  "embedded",
  "vm",
  "container",
];

/** The dimension each key of `/etc/machine-info` speaks about. */
export const MACHINE_INFO_DIMENSIONS = {
  deployment: "env",
  location: "site",
  chassis: "kind",
} as const;

/** Whether a character is a control character or a bidirectional mark, which make a string draw differently from what it says. */
function unsafe(code: number): boolean {
  return (
    code <= 0x1f ||
    (code >= 0x7f && code <= 0x9f) ||
    code === 0x200e ||
    code === 0x200f ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069)
  );
}

/** A raw string from a machine: no control or direction characters, trimmed, at most `max` characters. */
export function plain(s: unknown, max: number = REPORT_LIMITS.rawChars): string {
  if (typeof s !== "string") return "";
  let out = "";
  for (const ch of s.slice(0, max * 2)) out += unsafe(ch.codePointAt(0) ?? 0) ? " " : ch;
  return out.trim().slice(0, max);
}

/** A word of the tag grammar made from free text: lowercase letters and digits joined by `-`, at most 30 characters; "" when nothing is left. */
export function slug(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, 30)
    .replace(/-+$/, "");
}

/**
 * One tag as a machine wrote it, read with the grammar of spec 108: `<dimension>:<value>`, or a lowercase word; at most 64 characters.
 * Undefined where it is not one (the caller counts it).
 */
export function claimTag(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const id = raw.trim().toLowerCase();
  if (!id || id.length > REPORT_LIMITS.tagChars) return undefined;
  const colon = id.indexOf(":");
  if (colon >= 0) {
    const dimension = id.slice(0, colon);
    const value = id.slice(colon + 1);
    return DIMENSION_ID.test(dimension) && VALUE_ID.test(value) ? id : undefined;
  }
  return CUSTOM_TAG.test(id) && !["and", "or", "not"].includes(id) ? id : undefined;
}

/**
 * Read `/etc/machine-info` (the format of os-release: `KEY=value`, `#` comments, a value in single or double quotes) as data: nothing
 * is run or expanded. Only DEPLOYMENT, LOCATION, CHASSIS and TAGS are kept, each cut to {@link REPORT_LIMITS.rawChars}.
 */
export function parseMachineInfo(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.slice(0, 64_000).split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!(MACHINE_INFO_KEYS as readonly string[]).includes(key) || key in out) continue;
    let value = line.slice(eq + 1).trim();
    const q = value[0];
    if ((q === '"' || q === "'") && value.endsWith(q) && value.length >= 2) {
      value = value.slice(1, -1).replaceAll(`\\${q}`, q);
    }
    out[key] = plain(value);
  }
  return out;
}

/**
 * A bounded copy of what a machine sent, safe to keep and to read again: unknown keys left out, strings cleaned and cut, at most
 * {@link REPORT_LIMITS.rows} rows. `undefined` where it is not a report at all.
 */
export function sanitizeReport(
  raw: unknown,
  at = new Date().toISOString(),
): MachineReport | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  const out: MachineReport = { at: plain(r["at"], 40) || at };
  const mi = r["machineInfo"];
  if (typeof mi === "object" && mi !== null) {
    const kept: Record<string, string> = {};
    for (const k of MACHINE_INFO_KEYS) {
      const v = plain((mi as Record<string, unknown>)[k]);
      if (v) kept[k] = v;
    }
    if (Object.keys(kept).length) out.machineInfo = kept;
  }
  if (Array.isArray(r["tags"])) {
    const rows: TagRow[] = [];
    for (const row of r["tags"].slice(0, REPORT_LIMITS.rows)) {
      if (typeof row !== "object" || row === null) continue;
      const x = row as Record<string, unknown>;
      rows.push({
        dimension: plain(x["dimension"], 40),
        value: plain(x["value"], 80),
        source: plain(x["source"], 20),
        ...(plain(x["set_by"], 80) ? { set_by: plain(x["set_by"], 80) } : {}),
        ...(plain(x["set_at"], 40) ? { set_at: plain(x["set_at"], 40) } : {}),
      });
    }
    if (rows.length) out.tags = rows;
  }
  const sm = r["smbios"];
  if (typeof sm === "object" && sm !== null) {
    const s = sm as Record<string, unknown>;
    const kept: Smbios = {
      ...(plain(s["vendor"]) ? { vendor: plain(s["vendor"]) } : {}),
      ...(plain(s["model"]) ? { model: plain(s["model"]) } : {}),
      ...(plain(s["chassis"], 8) ? { chassis: plain(s["chassis"], 8) } : {}),
      ...(plain(s["biosVendor"]) ? { biosVendor: plain(s["biosVendor"]) } : {}),
    };
    if (Object.keys(kept).length) out.smbios = kept;
  }
  return out.machineInfo || out.tags || out.smbios ? out : { at: out.at };
}

/** The probe's `@reported` section as a report (`machine_info_*` and `smbios_*` keys, as the POSIX and PowerShell probes write them). */
export function reportFromProbe(
  section: Readonly<Record<string, string>> | undefined,
  at?: string,
): MachineReport | undefined {
  if (!section) return undefined;
  const machineInfo: Record<string, string> = {};
  for (const k of MACHINE_INFO_KEYS) {
    const v = plain(section[`machine_info_${k.toLowerCase()}`]);
    if (v) machineInfo[k] = v;
  }
  return sanitizeReport(
    {
      machineInfo,
      smbios: {
        vendor: section["smbios_vendor"],
        model: section["smbios_model"],
        chassis: section["smbios_chassis_type"],
        biosVendor: section["smbios_bios_vendor"],
      },
    },
    at,
  );
}

/** DMTF DSP0134 System Enclosure chassis types (table 17) as the kinds of machine-info(5) CHASSIS=; others make no claim. */
const CHASSIS_OF_TYPE: Readonly<Record<number, string>> = {
  3: "desktop",
  4: "desktop",
  5: "server",
  6: "desktop",
  7: "desktop",
  8: "laptop",
  9: "laptop",
  10: "laptop",
  11: "handset",
  13: "desktop",
  14: "laptop",
  15: "desktop",
  17: "server",
  23: "server",
  24: "desktop",
  25: "server",
  28: "server",
  29: "server",
  30: "tablet",
  31: "convertible",
  32: "tablet",
  33: "embedded",
  34: "embedded",
  35: "desktop",
  36: "desktop",
};

/** The kind a chassis type of DSP0134 means (`9` is a laptop), or undefined. */
export function kindOfChassisType(code: string | undefined): string | undefined {
  const n = Number(code);
  return Number.isInteger(n) ? CHASSIS_OF_TYPE[n] : undefined;
}

/** A cloud provider named by the firmware's maker and model (`Amazon EC2`, `Google Compute Engine`), as a word; undefined where none is. */
export function cloudOf(s: Smbios): string | undefined {
  const text = `${s.vendor ?? ""} ${s.model ?? ""} ${s.biosVendor ?? ""}`.toLowerCase();
  if (/\bamazon ec2\b|\bec2\b/.test(text)) return "aws";
  if (/google compute engine/.test(text)) return "gcp";
  if (/digitalocean/.test(text)) return "digitalocean";
  if (/hetzner/.test(text)) return "hetzner";
  if (/openstack/.test(text)) return "openstack";
  return undefined;
}

/** The order the sources are read in, and so shown in. */
const SOURCE_ORDER: readonly TagSource[] = [
  "archon-local",
  "archon-fleet",
  "machine-info",
  "smbios",
];

/**
 * The claims a report makes (spec 112-machine-reported-tags FR-004 to FR-008): its own tags table, `/etc/machine-info` (through the
 * fleet's `machineInfoMap` where it says what a value means), and its firmware. A thing that is not a tag of the grammar, or over the
 * caps, is dropped and counted: what a machine says never makes this fail.
 */
export function claimsFrom(
  report: MachineReport | undefined,
  map?: MachineInfoMap,
  channel: ReportedClaim["origin"] = "reported",
): ParsedClaims {
  const gaps: string[] = [];
  let dropped = 0;
  const found: ReportedClaim[] = [];
  const drop = (why: string): void => {
    dropped++;
    if (gaps.length < 8) gaps.push(why);
  };
  const add = (raw: unknown, source: TagSource, extra: Partial<ReportedClaim> = {}): void => {
    const id = claimTag(raw);
    if (id === undefined) {
      drop(`${source}: '${plain(raw, 30)}' is not a tag`);
      return;
    }
    found.push({ id, origin: channel, source, ...extra });
  };
  if (!report) return { claims: [], dropped: 0, gaps };
  for (const r of report.tags ?? []) {
    const source: TagSource | undefined =
      r.source === "local" ? "archon-local" : r.source === "fleet" ? "archon-fleet" : undefined;
    if (!source) {
      drop(`tags table: the source '${plain(r.source, 20)}' is not local or fleet`);
      continue;
    }
    const dim = plain(r.dimension, 40);
    add(dim ? `${dim}:${plain(r.value, 80)}` : plain(r.value, 80), source, {
      ...(r.set_by ? { setBy: r.set_by } : {}),
      ...(r.set_at ? { setAt: r.set_at } : {}),
    });
  }
  const mi = report.machineInfo ?? {};
  const deployment = plain(mi["DEPLOYMENT"]).toLowerCase();
  if (deployment) {
    const mapped = map?.deployment?.[deployment];
    add(mapped ?? `${MACHINE_INFO_DIMENSIONS.deployment}:${deployment}`, "machine-info");
  }
  const location = plain(mi["LOCATION"]);
  if (location) {
    const mapped = map?.location?.[location.toLowerCase()];
    const word = slug(location);
    if (mapped) add(mapped, "machine-info");
    else if (word) add(`${MACHINE_INFO_DIMENSIONS.location}:${word}`, "machine-info");
    else drop("machine-info: LOCATION makes no tag");
  }
  const chassis = plain(mi["CHASSIS"]).toLowerCase();
  if (chassis) {
    if (!CHASSIS_VALUES.includes(chassis))
      drop(`machine-info: CHASSIS '${plain(chassis, 30)}' is not a chassis`);
    else
      add(
        map?.chassis?.[chassis] ?? `${MACHINE_INFO_DIMENSIONS.chassis}:${chassis}`,
        "machine-info",
      );
  }
  const tags = plain(mi["TAGS"], REPORT_LIMITS.rawChars * 4);
  if (tags) for (const t of tags.split(/\s+/).filter(Boolean)) add(t, "machine-info");
  const sm = report.smbios;
  if (sm) {
    for (const [what, value] of [
      ["maker", sm.vendor],
      ["model", sm.model],
    ] as const) {
      const word = slug(plain(value));
      if (plain(value) && !word) drop(`smbios: the ${what} makes no tag`);
      else if (word) add(`hardware:${word}`, "smbios");
    }
    const cloud = cloudOf(sm);
    if (cloud) add(`hardware:cloud-${cloud}`, "smbios");
    const kind = kindOfChassisType(sm.chassis);
    if (kind) add(`${MACHINE_INFO_DIMENSIONS.chassis}:${kind}`, "smbios");
  }
  // One claim once per source; a fixed order; at most 64 a machine.
  const seen = new Set<string>();
  const unique = found
    .filter((c) =>
      seen.has(`${c.source}\n${c.id}`) ? false : (seen.add(`${c.source}\n${c.id}`), true),
    )
    .sort((a, b) => SOURCE_ORDER.indexOf(a.source) - SOURCE_ORDER.indexOf(b.source));
  if (unique.length > REPORT_LIMITS.perMachine) {
    const over = unique.length - REPORT_LIMITS.perMachine;
    dropped += over;
    gaps.push(`${over} more claim(s) than the ${REPORT_LIMITS.perMachine} read from one machine`);
  }
  return { claims: unique.slice(0, REPORT_LIMITS.perMachine), dropped, gaps };
}
