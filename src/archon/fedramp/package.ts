/**
 * Spec 076: the FedRAMP 20x validation package for Class A or Class B, from
 * the evidence Stolos already has. It is a Security Decision Record (SDR) in
 * FedRAMP's own JSON format (`SDR-CSX-KSI` names the schema
 * `fedramp-security-decision-record-schema-2026-06-24.json`): for each KSI
 * the class asks for, the measures (Stolos's checks), their cycle, the
 * automated validations with their results and observation times, and for
 * a KSI Stolos cannot observe, why, so the provider writes its own.
 *
 * ```mermaid
 * flowchart LR
 *   facts["PcFacts: what this PC last observed"] --> ev["Evidence, with when each was observed"]
 *   ev --> map["KSI_MAP: checks per KSI"] --> ksi["Each KSI: status, tests, evidence, age"]
 *   rules["rules.auto.ts: Class A list, cadences (FedRAMP)"] --> ksi
 *   ksi --> sdr["Security Decision Record (FedRAMP JSON schema)"]
 * ```
 *
 * The classes differ as the rules say: Class A addresses the seven KSIs of
 * `FRC-CLA-MFR`, automation is optional (`FRC-CSX-VVK`: MAY), machines are
 * validated at least monthly (`VDR-TFR-MVX`: SHOULD), and the package is kept
 * current every 3 months (`CPO-CSX-CPM`: SHOULD); Class B addresses every KSI
 * (five marked "Optional" for it), with at least one automated method each
 * (SHOULD), machines validated at least every 7 days (MUST), and the package
 * kept current every month (MUST).
 *
 * When each piece of evidence was observed comes from `Evidence.observedAt`
 * when it has one (spec 073 may add it), else from the observation times
 * the Stolos Console already knows (`evidenceObservedAt`): an adopted
 * machine's or device's last probe, a cloud's last observation, a managed
 * server's last pull or install, the repository's newest commit.
 *
 * @module
 */
// Spec: 076-fedramp-20x
// Spec: 111-network-posture FR-014

import { absurd } from "@intellectual-frontiers/commons/ts/kernel";
import type { PcFacts } from "../console/pc.ts";
import type { ScfCatalog } from "../compliance/catalog.ts";
import { combine, type Coverage, type Evidence, fleetEvidence } from "../compliance/report.ts";
import { covered, KSI_MAP, ksiEvidence, type KsiMapping, strmLinks } from "./mapping.ts";
import {
  CLASS_A_KSIS,
  CLASS_RULES,
  type ClassCadence,
  type ClassRule,
  FEDRAMP_RULES,
  type FedrampClass,
  type Ksi,
  KSIS,
} from "./rules.auto.ts";

export type { ClassCadence, ClassRule, FedrampClass, Ksi, KsiId } from "./rules.auto.ts";

/** An implementation status, as FedRAMP's schema spells it. */
export type SdrStatus = "Implemented" | "Not Implemented" | "Partially Implemented";

/** One piece of evidence in an SDR (the schema's `$defs/evidence`). */
export interface SdrEvidence {
  /** Log, Report, Screenshot, Configuration, Policy, Procedure, or Audit Record. */
  evidenceType:
    "Log" | "Report" | "Screenshot" | "Configuration" | "Policy" | "Procedure" | "Audit Record";
  /** What it is. */
  evidenceDescription?: string;
  /** Where it is (a URI). */
  evidenceLocation?: string;
  /** The result, as text. */
  evidenceText?: string;
  /** When it was last updated (YYYY-MM-DD). */
  lastUpdated?: string;
}

/** One KSI in an SDR (the schema's `keySecurityIndicators` item). */
export interface SdrKsi {
  /** The KSI's id. */
  ksiId: string;
  /** Its status (left out when Stolos cannot observe it: the provider states it). */
  ksiImplementationStatus?: SdrStatus;
  /** The measures and their objectives, and their cycle (SDR-CSX-KSI). */
  ksiImplementation: string[];
  /** How the provider validates them (Stolos's automated validations). */
  ksiValidation: string[];
  /** The independent assessor's statements (left for the assessor). */
  ksiAssessment: string[];
  /** The automated tests. */
  ksiTests: string[];
  /** Their results. */
  ksiEvidence: SdrEvidence[];
}

/** One FedRAMP rule in an SDR (the schema's `fedRampRequirements` item). */
export interface SdrRequirement {
  /** The rule's id. */
  frrID: string;
  /** Its status. */
  frrImplementationStatus?: SdrStatus;
  /** How it is followed. */
  frrImplementation: string[];
  /** How that is validated. */
  frrValidation?: string[];
  /** The independent assessor's statements. */
  frrAssessment?: string[];
}

/** A Security Decision Record, as FedRAMP's JSON schema defines it (the parts Stolos writes). */
export interface SecurityDecisionRecord {
  /** The provider's Certification Package Overview (a URI). */
  certificationPackageOverviewUri: string;
  /** SDR-CSO-MTD: version, last update, source of update. */
  metadata: { version: string; lastUpdated: string; updateSource: string };
  /** The FedRAMP rules this record speaks to. */
  fedRampRequirements: SdrRequirement[];
  /** The KSIs. */
  keySecurityIndicators: SdrKsi[];
}

/** Evidence with when it was observed. */
export type TimedEvidence = Evidence & { observedAt?: string };

/** One KSI's place in the package. */
export interface KsiResult {
  /** The KSI, as FedRAMP writes it. */
  ksi: Ksi;
  /** Whether the class requires it, or FedRAMP marks it optional for the class. */
  applies: "required" | "optional";
  /** Stolos's mapping for it. */
  mapping: KsiMapping;
  /** Its status from the evidence, or "not observable". */
  status: Coverage | "not observable";
  /** The evidence it counts. */
  evidence: TimedEvidence[];
  /** The automated tests (distinct checks) behind it. */
  tests: string[];
  /** The SCF STRM links to its SP 800-53 controls (with the catalog). */
  strm: Record<string, string[]>;
  /** The oldest and newest observation of its evidence. */
  observed?: { oldest: string; newest: string };
  /** Whether all its evidence is within the class's machine validation cadence (undefined: no times). */
  fresh?: boolean;
}

/** The package: what Stolos found, and the SDR it writes. */
export interface FedrampPackage {
  /** The class. */
  class: FedrampClass;
  /** When it was made (ISO). */
  generatedAt: string;
  /** The FedRAMP rules release. */
  rules: { version: string; url: string; sha256: string; schema: string };
  /** What the rules ask of this class, and how often. */
  cadence: ClassCadence;
  /** Each KSI the class asks for. */
  ksis: KsiResult[];
  /** How many are covered by checks, and how many Stolos cannot observe. */
  counts: { ksis: number; covered: number; notObservable: number; withAutomation: number };
  /** The Security Decision Record, valid against FedRAMP's schema. */
  sdr: SecurityDecisionRecord;
}

/** How long a rule's cadence is, in milliseconds (a month counted as 31 days). */
export function cadenceMs(r: ClassRule): number | undefined {
  if (!r.every) return undefined;
  const unit: Record<string, number | undefined> = {
    hours: 3_600_000,
    days: 86_400_000,
    weeks: 7 * 86_400_000,
    months: 31 * 86_400_000,
  };
  const ms = unit[r.every.unit];
  return ms === undefined ? undefined : ms * r.every.count;
}

const every = (r: ClassRule) =>
  r.every
    ? `${r.every.count === 1 ? "every" : `every ${r.every.count}`} ${
        r.every.count === 1 ? r.every.unit.replace(/s$/, "") : r.every.unit
      }`
    : "";

/**
 * When a piece of evidence was observed: its own `observedAt` when it has one
 * (the hook for spec 073), else the time this PC knows for its subject.
 */
export function evidenceObservedAt(e: Evidence, f: PcFacts): string | undefined {
  const own = (e as TimedEvidence).observedAt;
  if (own) return own;
  const newest = (xs: Array<string | undefined>) =>
    xs
      .filter((x): x is string => !!x)
      .sort()
      .pop();
  switch (e.source) {
    case "adopted":
      return f.adopted.find((a) => a.machine.name === e.subject)?.observed?.at;
    case "device":
      return f.devices.find((d) => d.device.name === e.subject)?.observed?.at;
    case "cloud":
      return f.clouds.find((c) => c.observed && `${c.title} (${c.observed.account})` === e.subject)
        ?.observed?.at;
    case "estate":
      // The estate graph is built from the clouds' observations: the newest of them.
      return newest(f.clouds.map((c) => c.observed?.at));
    case "managed": {
      const m = f.machines.find((x) => x.name === e.subject);
      return m ? newest([m.seen, m.sync?.at, m.applied?.at]) : undefined;
    }
    case "repository":
      return f.git.log[0]?.at;
    case "network":
      return f.networkPosture?.at;
    case "control pack":
      return undefined;
    default:
      return absurd(e.source);
  }
}

/** The fleet's evidence, each with when it was observed. */
export function timedEvidence(f: PcFacts, now = Date.now()): TimedEvidence[] {
  return fleetEvidence(f, now).map((e) => {
    const at = evidenceObservedAt(e, f);
    return at ? { ...e, observedAt: at } : e;
  });
}

const sdrStatus = (ev: TimedEvidence[]): SdrStatus | undefined => {
  if (!ev.length) return undefined;
  const c = combine(ev.map((e) => e.status));
  if (c === "pass") return "Implemented";
  if (ev.some((e) => e.status === "pass" || e.status === "warn" || e.status === "accepted")) {
    return "Partially Implemented";
  }
  return "Not Implemented";
};

/** Which KSIs a class asks for, and whether FedRAMP marks each optional for it. */
export function classKsis(
  cls: FedrampClass,
): Array<{ ksi: Ksi; applies: "required" | "optional" }> {
  return KSIS.filter((k) => (cls === "B" ? !!k.classes.B : CLASS_A_KSIS.includes(k.id))).map(
    (ksi) => ({ ksi, applies: ksi.optionalIn.includes(cls) ? "optional" : "required" }),
  );
}

/** Everything the package needs besides the facts. */
export interface PackageOptions {
  /** Now (for observation ages and the record's time). */
  now?: Date;
  /** The SCF catalog, for the STRM links to SP 800-53. */
  catalog?: ScfCatalog;
  /** The provider's Certification Package Overview URI. */
  overviewUri?: string;
  /** Stolos's version, for the record's source of update. */
  stolosVersion?: string;
}

/** A placeholder overview URI for a fleet, until the provider names its own. */
export function placeholderOverview(fleet: string): string {
  return `urn:stolos:fleet:${encodeURIComponent(fleet || "fleet")}:certification-package-overview`;
}

/** The validation package for a class, from what this PC knows. */
export function fedrampPackage(
  f: PcFacts,
  cls: FedrampClass,
  o: PackageOptions = {},
): FedrampPackage {
  const now = o.now ?? new Date();
  const cadence = CLASS_RULES[cls];
  const window = cadenceMs(cadence.machineValidation);
  const evidence = timedEvidence(f, now.getTime());
  const ksis: KsiResult[] = classKsis(cls).map(({ ksi, applies }) => {
    const mapping = KSI_MAP[ksi.id];
    const ev = ksiEvidence(mapping, evidence);
    const times = ev
      .map((e) => e.observedAt)
      .filter((x): x is string => !!x)
      .sort();
    const tests = [...new Set(ev.map((e) => `${e.source}: ${e.check}`))].sort();
    const oldest = times[0];
    const newest = times.at(-1);
    return {
      ksi,
      applies,
      mapping,
      status: covered(mapping) ? combine(ev.map((e) => e.status)) : "not observable",
      evidence: ev,
      tests,
      strm: strmLinks(ksi, mapping, o.catalog),
      ...(oldest !== undefined && newest !== undefined ? { observed: { oldest, newest } } : {}),
      ...(oldest !== undefined && window !== undefined
        ? { fresh: times.length === ev.length && now.getTime() - Date.parse(oldest) <= window }
        : {}),
    };
  });
  const sdrKsis = ksis.map((r) => sdrKsi(r, cls, cadence));
  const coveredN = ksis.filter((r) => covered(r.mapping)).length;
  const withAutomation = ksis.filter(
    (r) => r.tests.length >= Math.max(1, cadence.automation.minMethods),
  ).length;
  return {
    class: cls,
    generatedAt: now.toISOString(),
    rules: {
      version: FEDRAMP_RULES.version,
      url: FEDRAMP_RULES.url,
      sha256: FEDRAMP_RULES.sha256,
      schema: FEDRAMP_RULES.sdrSchema,
    },
    cadence,
    ksis,
    counts: {
      ksis: ksis.length,
      covered: coveredN,
      notObservable: ksis.length - coveredN,
      withAutomation,
    },
    sdr: {
      certificationPackageOverviewUri: o.overviewUri ?? placeholderOverview(f.fleet.id),
      metadata: {
        version: `class-${cls.toLowerCase()}+${f.git.log[0]?.sha ?? "uncommitted"}`,
        lastUpdated: now.toISOString(),
        updateSource: `Stolos${
          o.stolosVersion ? ` ${o.stolosVersion}` : ""
        } (stolos compliance fedramp --class ${cls}), automated, from the fleet's last observations`,
      },
      fedRampRequirements: requirements(ksis, cls, cadence, evidence, now),
      keySecurityIndicators: sdrKsis,
    },
  };
}

function sdrKsi(r: KsiResult, cls: FedrampClass, cadence: ClassCadence): SdrKsi {
  const m = r.mapping;
  const optional =
    r.applies === "optional" ? [`FedRAMP marks this KSI optional for Class ${cls}.`] : [];
  if (!covered(m)) {
    return {
      ksiId: r.ksi.id,
      ksiImplementation: [
        ...optional,
        `Stolos cannot observe this KSI (${m.notObservable}): ${m.reason}`,
        "The provider supplies the explanation of its measures and their objectives, or the reason and resulting risk to customers for not having them (SDR-CSX-KSI).",
      ],
      ksiValidation: [
        "No automated validation by Stolos; the provider states how the measures are verified and validated.",
      ],
      ksiAssessment: [],
      ksiTests: [],
      ksiEvidence: [],
    };
  }
  const status = sdrStatus(r.evidence);
  const strm = Object.entries(r.strm).map(([s, cs]) => `${s} (${cs.join(", ")})`);
  const mv = cadence.machineValidation;
  return {
    ksiId: r.ksi.id,
    ...(status ? { ksiImplementationStatus: status } : {}),
    ksiImplementation: [
      ...optional,
      `Measures: ${m.reason}`,
      `Stolos checks, by Secure Controls Framework control: ${m.scf.join(", ")}${
        m.sources ? ` (from ${m.sources.join(", ")} evidence)` : ""
      }.${
        strm.length
          ? ` Through the SCF Council's STRM these reach the KSI's NIST SP 800-53 controls: ${strm.join(
              "; ",
            )}.`
          : ""
      }`,
      "Cycle: managed servers reconcile and verify every 15 minutes; adopted machines, devices, and clouds are checked on each observation; Stolos rebuilds this record from the newest results each time it runs.",
    ],
    ksiValidation: [
      r.evidence.length
        ? `${r.evidence.length} automated result(s) from ${r.tests.length} check(s): ${[
            "pass",
            "fail",
            "warn",
            "unknown",
            "accepted",
          ]
            .map((s) => [s, r.evidence.filter((e) => e.status === s).length] as const)
            .filter(([, n]) => n)
            .map(([s, n]) => `${n} ${s}`)
            .join(", ")}.`
        : "No results yet: nothing this KSI's checks look at has been observed on this PC.",
      ...(r.observed
        ? [
            `Observed between ${r.observed.oldest} and ${r.observed.newest}; ${mv.rule} asks Class ${cls} to validate machine-based resources ${every(
              mv,
            )} (${mv.force}): ${
              r.fresh === undefined
                ? "not every result has a time"
                : r.fresh
                  ? "every result is within it"
                  : "some results are older, or have no time"
            }.`,
          ]
        : []),
    ],
    ksiAssessment: [],
    ksiTests: r.tests,
    ksiEvidence: r.evidence.map((e) => ({
      evidenceType: e.source === "repository" ? "Audit Record" : "Configuration",
      evidenceDescription: `${e.subject}: ${e.check}: ${e.status}`,
      evidenceText: `${e.detail}${e.observedAt ? ` (observed ${e.observedAt})` : ""}`,
      ...(e.observedAt ? { lastUpdated: e.observedAt.slice(0, 10) } : {}),
    })),
  };
}

function requirements(
  ksis: KsiResult[],
  cls: FedrampClass,
  cadence: ClassCadence,
  evidence: TimedEvidence[],
  now: Date,
): SdrRequirement[] {
  const auto = cadence.automation;
  const automated = ksis.filter((r) => r.tests.length >= Math.max(1, auto.minMethods)).length;
  const machines = evidence.filter((e) => e.source !== "repository" && e.source !== "estate");
  const mv = cadence.machineValidation;
  const window = cadenceMs(mv);
  const inWindow = machines.filter(
    (e) =>
      e.observedAt && window !== undefined && now.getTime() - Date.parse(e.observedAt) <= window,
  ).length;
  const unobservable = ksis.filter((r) => !covered(r.mapping)).length;
  const pm = cadence.packageMaintenance;
  const kmt = cadence.metrics;
  return [
    {
      frrID: "SDR-CSX-KSI",
      frrImplementationStatus: unobservable ? "Partially Implemented" : "Implemented",
      frrImplementation: [
        `This record summarizes each of the ${ksis.length} KSI(s) Class ${cls} asks for: Stolos's measures, their cycle, and their automated validation for ${
          ksis.length - unobservable
        }; ${unobservable} rest on processes, documents, or contracts Stolos cannot observe, and the provider supplies those summaries.`,
      ],
    },
    {
      frrID: auto.rule,
      frrImplementationStatus:
        automated === ksis.length
          ? "Implemented"
          : automated
            ? "Partially Implemented"
            : "Not Implemented",
      frrImplementation: [
        `${auto.statement} (${auto.force})`,
        `${automated} of ${ksis.length} KSI(s) have at least ${Math.max(
          1,
          auto.minMethods,
        )} automated method(s) in Stolos (its checks, run on every observation).`,
      ],
    },
    {
      frrID: mv.rule,
      frrImplementationStatus: !machines.length
        ? "Not Implemented"
        : inWindow === machines.length
          ? "Implemented"
          : "Partially Implemented",
      frrImplementation: [
        `${mv.statement} (${mv.force})`,
        `Managed servers verify themselves every 15 minutes; Stolos observes adopted machines, devices, and clouds when asked or on schedule. ${inWindow} of ${machines.length} machine result(s) were observed within the last ${every(
          mv,
        ).replace(/^every /, "")}.`,
      ],
    },
    {
      frrID: pm.rule,
      frrImplementation: [
        `${pm.statement} (${pm.force})`,
        `Stolos rebuilds this package from current evidence whenever it runs (stolos compliance fedramp --class ${cls}); run it, or an export job, at least ${every(
          pm,
        )}.`,
      ],
    },
    {
      frrID: kmt.rule,
      frrImplementationStatus: "Not Implemented",
      frrImplementation: [
        `${kmt.statement} (${kmt.force})`,
        "Historical metrics are not in this record yet: the observations are commits in the fleet repository, so they can be summarized over 30 days and a year (spec 073).",
      ],
    },
  ];
}
