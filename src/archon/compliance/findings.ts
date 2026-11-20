/**
 * Specs 068, 089 and 092: Stolos's evidence as IFC TypeScript's GRC findings (kernel `grc`), the one
 * model every export is written from. A piece of evidence (spec 068: a check's result on a subject,
 * citing SCF controls) becomes one finding per SCF control it cites: the control is the SCF control,
 * implementing the framework requirements the SCF Council maps it to (its STRM, when the catalog is
 * on this PC); the subject is the source and what it is about; the check is the finding's title.
 *
 * | Evidence status | Finding status | Outcome |
 * | --- | --- | --- |
 * | pass, warn, fail | the same | the same |
 * | accepted (a risk accepted until a date) | fail | accepted |
 * | unknown (nothing to judge by) | error | error |
 *
 * @example
 * ```ts
 * import { evidenceFindings } from "./findings.ts";
 * import { grc } from "@intellectual-frontiers/grc";
 * const at = grc.instantOf("2026-11-15T12:00:00Z");
 * if (at !== undefined) {
 *   evidenceFindings({ scf: ["CRY-07"], subject: "alpha", source: "managed", check: "The disk is encrypted",
 *     status: "pass", detail: "LUKS" }, { at }).length; // 1
 * }
 * ```
 *
 * @module
 */

import { absurd } from "@intellectual-frontiers/core";
import { grc } from "@intellectual-frontiers/grc";
import type { ScfCatalog } from "./catalog.ts";
import { allEvidence } from "./oscal.ts";
import type { ComplianceView, Evidence } from "./report.ts";
import { FRAMEWORKS, scf } from "./scf.ts";

/** The catalog id of SCF controls in findings and their exports. */
export const SCF_CATALOG_ID = "SCF";

/** How often a source of evidence is assessed, as the finding's control cadence (daily). */
const CADENCE = "P1D";

/** A piece of evidence's status as a GRC status and outcome. */
export function evidenceOutcome(status: Evidence["status"]): {
  readonly status: grc.Status;
  readonly outcome: grc.Outcome;
} {
  switch (status) {
    case "pass":
    case "warn":
    case "fail":
      return { status, outcome: status };
    case "accepted":
      return { status: "fail", outcome: "accepted" };
    case "unknown":
      return { status: "error", outcome: "error" };
    default:
      return absurd(status);
  }
}

/** The framework requirements an SCF control implements, by the catalog's STRM (none without it). */
export function requirementRefs(control: string, catalog?: ScfCatalog): readonly grc.ControlRef[] {
  const maps = catalog?.controls[control]?.maps;
  if (maps === undefined) return [];
  return FRAMEWORKS.flatMap((f) => maps[f.id].map((id) => ({ catalog: f.short, id })));
}

/** What a piece of evidence is judged at, and with what catalog. */
export interface FindingOptions {
  /** The instant of findings whose evidence has no observation time. */
  at: grc.Instant;
  /** The SCF catalog: the framework requirements each SCF control implements. */
  catalog?: ScfCatalog;
}

/** One piece of evidence as findings: one per SCF control it cites. */
export function evidenceFindings(e: Evidence, o: FindingOptions): grc.Finding[] {
  const { status, outcome } = evidenceOutcome(e.status);
  const at = (e.observedAt === undefined ? undefined : grc.instantOf(e.observedAt)) ?? o.at;
  return e.scf.map((id): grc.Finding => {
    const name = o.catalog?.controls[id]?.name ?? scf(id)?.name ?? id;
    return {
      control: {
        id,
        title: name,
        implements: requirementRefs(id, o.catalog),
        severity: "info",
        cadence: CADENCE,
      },
      subject: { kind: e.source, id: e.subject },
      status,
      outcome,
      severity: "info",
      title: e.check,
      detail: e.detail,
      evidence: [],
      ...(e.fix === undefined ? {} : { remediation: e.fix }),
      ...(outcome === "accepted" ? { waiver: "accepted risk" } : {}),
      at,
    };
  });
}

/** A compliance view as one GRC assessment of the fleet at an instant. */
export function viewAssessment(
  view: ComplianceView,
  o: FindingOptions & { fleet: string },
): grc.Assessment {
  const findings = allEvidence(view).flatMap((e) => evidenceFindings(e, o));
  const controls = new Map<string, grc.ControlSummary>();
  for (const f of findings) if (!controls.has(f.control.id)) controls.set(f.control.id, f.control);
  const subjects = new Map<string, grc.SubjectRef>();
  for (const f of findings) subjects.set(JSON.stringify([f.subject.kind, f.subject.id]), f.subject);
  return {
    pack: { id: `stolos-${o.fleet}`, title: `The fleet ${o.fleet}'s evidence` },
    at: o.at,
    controls: [...controls.values()],
    subjects: [...subjects.values()],
    findings,
  };
}

/** A date as an instant; an invalid date is a mistake in the code, and throws. */
export function instantOfDate(d: Date): grc.Instant {
  const at = grc.instantFromEpochMs(d.getTime());
  if (at === undefined) throw new Error(`${String(d)} is not a time`);
  return at;
}
