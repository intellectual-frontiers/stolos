/**
 * Spec 073: evidence freshness as a control. Every source of evidence has a
 * validation cadence (how often it is observed) and a service level (how late
 * an observation may be before it no longer counts): managed servers verify
 * every 15 minutes (the reconcile timer); adopted machines, devices, and
 * connected accounts are observed daily; a connector may declare its own
 * cadence; and a fleet may override any of them in `fleet.ts`
 * (`compliance.cadence`). The cadences are modeled on FedRAMP 20x's
 * persistent (continuous) validation, which expects machine-based validation
 * every 3 to 7 days ({@link FEDRAMP_20X_VALIDATION}): no service level here is
 * ever longer than 7 days.
 *
 * Evidence older than its service level is stale (IFC TypeScript's
 * `assess.freshness`, the service level as its cadence). Stale evidence is a failing
 * check: it fails its own controls and SCF MON-02 (Continuous Monitoring),
 * and its fix is the command that observes the source again. Each control
 * shows the age of its newest and oldest evidence.
 *
 * ```mermaid
 * flowchart LR
 *   obs["An observation: verify, host observe, device observe, estate observe"] -- "observedAt" --> ev["Evidence"]
 *   cad["Cadence and service level: default, connector, fleet.ts"] --> age{"older than its service level?"}
 *   ev --> age
 *   age -- "no" --> ctl["Its SCF controls, as observed"]
 *   age -- "yes: stale" --> fail["A failing check: its controls and MON-02"]
 *   fail --> fix["Fix: observe it again"]
 * ```
 *
 * @module
 */
// Spec: 073-freshness
// Spec: 111-network-posture FR-014

import { absurd } from "@intellectual-frontiers/core";
import { assess, grc } from "@intellectual-frontiers/commons/ts/kernel";
import type { PcFacts } from "../console/pc.ts";
import type { ScfCatalog } from "./catalog.ts";
import {
  type ComplianceView,
  complianceView,
  type ControlStatus,
  type Evidence,
  fleetEvidence,
} from "./report.ts";

/** A length of time: minutes, hours, or days ("15m", "6h", "1d"). */
export type Duration = `${number}${"m" | "h" | "d"}`;

/** How often a source is observed, and how late an observation may be. */
export interface CadenceDef {
  /** How often it is observed ("15m", "1d"). */
  every: Duration;
  /**
   * The service level: past this age its evidence is stale. Default: twice
   * `every`. Never more than 7 days (FedRAMP 20x's longest validation
   * interval): a longer one is capped.
   */
  staleAfter?: Duration;
}

/** The sources of evidence that are observed on a schedule (the others are read live from Git). */
export type CadenceSource = "managed" | "adopted" | "device" | "cloud";

/**
 * A fleet's own cadences (`compliance.cadence` in `fleets/<fleet>/fleet.ts`):
 * per source, and per connector by its id.
 *
 * @example Verify servers hourly, and read the HR system weekly
 * ```ts
 * import type { CadenceOverrides } from "@intellectual-frontiers/stolos/archon/compliance/freshness";
 *
 * export const cadence: CadenceOverrides = {
 *   managed: { every: "1h" },
 *   connectors: { bamboohr: { every: "7d", staleAfter: "7d" } },
 * };
 * ```
 */
export interface CadenceOverrides {
  /** Managed servers and workstations (their verify). */
  managed?: CadenceDef;
  /** Adopted machines (`stolos host observe`). */
  adopted?: CadenceDef;
  /** SNMP devices (`stolos device observe`). */
  device?: CadenceDef;
  /** Every connected account without a cadence of its own (`stolos estate observe`). */
  cloud?: CadenceDef;
  /** One connector, by its id: wins over the connector's own cadence and over `cloud`. */
  connectors?: Record<string, CadenceDef>;
}

/**
 * FedRAMP 20x's persistent validation: cloud service providers validate their
 * key security indicators with machines, continuously, at least every 3 to 7
 * days by impact level. Stolos's service levels are never longer than the
 * longest of these.
 */
export const FEDRAMP_20X_VALIDATION: {
  minDays: number;
  maxDays: number;
  title: string;
  url: string;
} = {
  minDays: 3,
  maxDays: 7,
  title: "FedRAMP 20x: Persistent Validation and Assessment",
  url: "https://www.fedramp.gov/20x/",
};

/** The default cadences: verify every 15 minutes, everything else daily. */
export const DEFAULT_CADENCES: Record<CadenceSource, CadenceDef> = {
  managed: { every: "15m" },
  adopted: { every: "1d" },
  device: { every: "1d" },
  cloud: { every: "1d" },
};

const UNIT = { m: 60_000, h: 3_600_000, d: 86_400_000 } as const;
const isUnit = (u: string): u is keyof typeof UNIT => u === "m" || u === "h" || u === "d";
const MAX_MS = FEDRAMP_20X_VALIDATION.maxDays * UNIT.d;

/** A duration in milliseconds; throws on anything but `<number><m|h|d>`. */
export function durationMs(d: string): number {
  const [, n = "", unit = ""] = /^(\d+(?:\.\d+)?)([mhd])$/.exec(d.trim()) ?? [];
  if (!isUnit(unit) || Number(n) <= 0) {
    throw new Error(`${d}: not a duration (a number and m, h, or d: "15m", "1d")`);
  }
  return Number(n) * UNIT[unit];
}

/** A length of time in milliseconds as an ISO 8601 duration, whole seconds (kernel `grc.Duration`). */
export function isoDuration(ms: number): grc.Duration {
  return grc.duration(`PT${Math.max(1, Math.round(ms / 1000))}S`);
}

/** An age for people: "40s", "12m", "5h", "3d". */
export function formatAge(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86_400 * 2) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86_400)}d`;
}

const asDuration = (ms: number): Duration =>
  ms % UNIT.d === 0
    ? `${ms / UNIT.d}d`
    : ms % UNIT.h === 0
      ? `${ms / UNIT.h}h`
      : `${Math.round(ms / UNIT.m)}m`;

/** A cadence, resolved: its service level in milliseconds, and where it came from. */
export interface Cadence {
  /** How often it is observed. */
  every: Duration;
  /** Its service level: past this age, its evidence is stale. */
  staleAfter: Duration;
  /** `every` in milliseconds. */
  everyMs: number;
  /** `staleAfter` in milliseconds. */
  staleAfterMs: number;
  /** Where it came from. */
  from: "default" | "connector" | "fleet";
  /** The service level asked for was longer than 7 days, and was capped. */
  capped: boolean;
}

/** Resolve one cadence: the service level defaults to twice the cadence, capped at 7 days. */
export function cadence(def: CadenceDef, from: Cadence["from"] = "default"): Cadence {
  const everyMs = durationMs(def.every);
  const want = def.staleAfter ? durationMs(def.staleAfter) : 2 * everyMs;
  const staleAfterMs = Math.min(Math.max(want, everyMs), MAX_MS);
  return {
    every: def.every,
    staleAfter: asDuration(staleAfterMs),
    everyMs,
    staleAfterMs,
    from,
    capped: want > MAX_MS,
  };
}

/** Every cadence, resolved: one per source, and one per connector. */
export interface Cadences {
  /** Per source of evidence. */
  sources: Record<CadenceSource, Cadence>;
  /** Per connector id (a connector not listed takes `sources.cloud`). */
  connectors: Record<string, Cadence>;
}

/**
 * The cadences in force: the defaults, then each connector's own, then the
 * fleet's overrides (a fleet's `connectors.<id>` wins over everything for that
 * connector; its `cloud` applies to connectors without a cadence of their own).
 */
export function resolveCadences(
  o: {
    fleet?: CadenceOverrides;
    connectors?: Array<{ id: string; cadence?: CadenceDef }>;
  } = {},
): Cadences {
  const pick = (s: CadenceSource): Cadence =>
    ((def) => (def ? cadence(def, "fleet") : cadence(DEFAULT_CADENCES[s])))(o.fleet?.[s]);
  const sources = {
    managed: pick("managed"),
    adopted: pick("adopted"),
    device: pick("device"),
    cloud: pick("cloud"),
  };
  const connectors: Record<string, Cadence> = {};
  for (const c of o.connectors ?? []) {
    if (c.cadence) connectors[c.id] = cadence(c.cadence, "connector");
  }
  for (const [id, def] of Object.entries(o.fleet?.connectors ?? {})) {
    connectors[id] = cadence(def, "fleet");
  }
  return { sources, connectors };
}

/** The cadences for this fleet: its `fleet.ts` and the connectors' own (defaults when unreadable). */
export async function loadCadences(o: { connectors?: boolean } = {}): Promise<Cadences> {
  let fleet: CadenceOverrides | undefined;
  try {
    const { loadFleet } = await import("../model/load.ts");
    fleet = (await loadFleet()).compliance?.cadence;
  } catch {
    // No fleet.ts here (or a broken one): the defaults.
  }
  const connectors =
    o.connectors === false ? [] : await (await import("../connect/commands.ts")).allConnectors();
  return resolveCadences({ ...(fleet ? { fleet } : {}), connectors });
}

/** The cadence a piece of evidence is held to, or undefined (read live: the repository, the estate graph). */
export function cadenceFor(e: Evidence, c: Cadences): Cadence | undefined {
  if (e.source === "cloud" || e.source === "network") {
    // Spec 111-network-posture FR-014: the network's evidence is a router's observation, held to its account's cadence.
    return (e.connector && c.connectors[e.connector]) || c.sources.cloud;
  }
  if (e.source === "managed" || e.source === "adopted" || e.source === "device") {
    return c.sources[e.source];
  }
  return undefined;
}

/** The command that observes a piece of evidence's source again. */
export function refreshCommand(e: Evidence): string | undefined {
  switch (e.source) {
    case "managed":
      return "bun run stolos fleet status";
    case "adopted":
      return `bun run stolos host observe ${e.subject}`;
    case "device":
      return `bun run stolos device observe ${e.subject}`;
    case "cloud":
      return `bun run stolos estate observe${e.connector ? ` ${e.connector}` : ""}`;
    case "network":
      return `bun run stolos estate observe${e.connector ? ` ${e.connector}` : ""}`;
    case "estate":
    case "repository":
    case "control pack":
      return undefined;
    default:
      return absurd(e.source);
  }
}

/**
 * When each piece of the fleet's evidence was observed, from what the Stolos
 * Console knows: a managed machine's last pull (its reconcile run, which
 * verifies) else its install; an adopted machine's or device's observation;
 * a connector's observation (and the connector's id).
 */
export function stampEvidence(ev: Evidence[], f: PcFacts): Evidence[] {
  const at = new Map<string, { at?: string | undefined; connector?: string }>();
  const key = (source: string, subject: string) => `${source}\u0000${subject}`;
  for (const m of f.machines) {
    if (m.kind !== "server" && m.kind !== "workstation") continue;
    at.set(key("managed", m.name), { at: m.sync?.at ?? m.seen });
  }
  for (const a of f.adopted) at.set(key("adopted", a.machine.name), { at: a.observed?.at });
  for (const d of f.devices ?? []) at.set(key("device", d.device.name), { at: d.observed?.at });
  for (const c of f.clouds) {
    if (!c.observed) continue;
    at.set(key("cloud", `${c.title} (${c.observed.account})`), {
      at: c.observed.at,
      connector: c.id,
    });
  }
  return ev.map((e) => {
    if (e.observedAt) return e;
    const s = at.get(key(e.source, e.subject));
    return {
      ...e,
      ...(s?.at ? { observedAt: s.at } : {}),
      ...(s?.connector && !e.connector ? { connector: s.connector } : {}),
    };
  });
}

/**
 * Hold each piece of evidence to its service level: one older than it is
 * stale, and becomes a failing check of its own controls and of MON-02
 * (Continuous Monitoring), with what it said kept in `stale.was` and the
 * command that observes it again as its fix. Evidence without a result
 * ("unknown": nothing was observed) and evidence read live is left as it is.
 */
export function applyFreshness(ev: Evidence[], c: Cadences, now = Date.now()): Evidence[] {
  return ev.map((e) => {
    const cad = cadenceFor(e, c);
    if (!cad || !e.observedAt || e.status === "unknown") return e;
    const observed = grc.instantOf(e.observedAt);
    const asOf = grc.instantFromEpochMs(now);
    if (observed === undefined || asOf === undefined) return e;
    // Held to its service level by the kernel (assess.freshness): stale past it.
    const f = assess.freshness(isoDuration(cad.staleAfterMs), [observed], asOf);
    if (f.status !== "stale") return e;
    const ageMs = now - Date.parse(e.observedAt);
    const fix = refreshCommand(e) ?? e.fix;
    return {
      ...e,
      scf: e.scf.includes("MON-02") ? e.scf : [...e.scf, "MON-02"],
      status: "fail",
      detail: `${e.detail} (stale: observed ${formatAge(
        ageMs,
      )} ago; its service level is ${cad.staleAfter})`,
      ...(fix ? { fix } : {}),
      stale: { was: e.status, ageMs, staleAfter: cad.staleAfter },
    };
  });
}

/** How old a control's evidence is. */
export interface ControlFreshness {
  /** When its newest evidence was observed (undefined: none has a time). */
  newest?: string;
  /** When its oldest evidence was observed. */
  oldest?: string;
  /** The newest evidence's age, in milliseconds. */
  newestAgeMs?: number;
  /** The oldest evidence's age, in milliseconds. */
  oldestAgeMs?: number;
  /** How many pieces of its evidence have an observation time. */
  timed: number;
  /** How many are read live (the repository, the estate graph) or were never observed. */
  untimed: number;
  /** How many are stale. */
  stale: number;
}

/** The age of one control's evidence, as of `now`. */
export function controlFreshness(c: ControlStatus, now = Date.now()): ControlFreshness {
  const times = c.evidence
    .map((e) => e.observedAt)
    .filter((x): x is string => !!x)
    .sort();
  const newest = times.at(-1);
  const oldest = times[0];
  return {
    ...(newest ? { newest, newestAgeMs: Math.max(0, now - Date.parse(newest)) } : {}),
    ...(oldest ? { oldest, oldestAgeMs: Math.max(0, now - Date.parse(oldest)) } : {}),
    timed: times.length,
    untimed: c.evidence.length - times.length,
    stale: c.evidence.filter((e) => e.stale).length,
  };
}

/** A compliance view held to the cadences: each control with its evidence's age. */
export interface FreshView extends ComplianceView {
  /** When the ages were measured (ISO). */
  asOf: string;
  /** The cadences in force. */
  cadences: Cadences;
  /** Every control, with its evidence and its evidence's age. */
  controls: Array<ControlStatus & { freshness: ControlFreshness }>;
}

/** The compliance view of `evidence` (stamped), held to `cadences` as of `now`. */
export function freshView(
  evidence: Evidence[],
  catalog: ScfCatalog | undefined,
  o: { cadences?: Cadences; now?: number } = {},
): FreshView {
  const now = o.now ?? Date.now();
  const cadences = o.cadences ?? resolveCadences();
  const v = complianceView(applyFreshness(evidence, cadences, now), catalog);
  return {
    ...v,
    asOf: new Date(now).toISOString(),
    cadences,
    controls: v.controls.map((c) => ({ ...c, freshness: controlFreshness(c, now) })),
  };
}

/** The fleet's compliance view from what the Stolos Console gathers, with freshness. */
export function fleetFreshView(
  f: PcFacts,
  catalog: ScfCatalog | undefined,
  o: { cadences?: Cadences; now?: number } = {},
): FreshView {
  const now = o.now ?? Date.now();
  return freshView(stampEvidence(fleetEvidence(f, now), f), catalog, { ...o, now });
}

/** The stale evidence of a view, once per source and subject, oldest first. */
export function staleSubjects(v: ComplianceView): Array<{
  source: Evidence["source"];
  subject: string;
  observedAt: string;
  ageMs: number;
  staleAfter: string;
  checks: number;
  fix?: string;
}> {
  const by = new Map<string, ReturnType<typeof staleSubjects>[number]>();
  const seen = new Set<Evidence>();
  for (const c of v.controls) {
    for (const e of c.evidence) {
      if (!e.stale || !e.observedAt || seen.has(e)) continue;
      seen.add(e);
      const k = `${e.source}\u0000${e.subject}`;
      const s = by.get(k);
      if (s) s.checks++;
      else {
        by.set(k, {
          source: e.source,
          subject: e.subject,
          observedAt: e.observedAt,
          ageMs: e.stale.ageMs,
          staleAfter: e.stale.staleAfter,
          checks: 1,
          ...(e.fix ? { fix: e.fix } : {}),
        });
      }
    }
  }
  return [...by.values()].sort((a, b) => b.ageMs - a.ageMs);
}
