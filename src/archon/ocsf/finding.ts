/**
 * Spec 089: every check's result as an OCSF Compliance Finding (class 2003).
 * One finding per piece of evidence and SCF control: the compliance object
 * names the standard (SCF, by release), the control, and, when the SCF
 * catalog is on this PC, the framework requirements SCF maps it to. Typed by
 * the generated OCSF types, so a missing required field does not compile.
 *
 * | Stolos result | compliance.status_id | finding status_id |
 * | --- | --- | --- |
 * | pass | 1 Pass | 4 Resolved |
 * | warn | 2 Warning | 1 New |
 * | fail | 3 Fail | 1 New |
 * | accepted | 3 Fail | 3 Suppressed (a risk accepted until its date) |
 * | unknown | 0 Unknown | 1 New |
 *
 * Severity is 0 (Unknown): Stolos does not rate severity on its own.
 *
 * @module
 */

import { SCF_SOURCE, type ScfCatalog } from "../compliance/catalog.ts";
import type { Evidence } from "../compliance/report.ts";
import { FRAMEWORKS } from "../compliance/scf.ts";
import { VERSION } from "../version.ts";
import { OCSF_VERSION, type OcsfComplianceFinding } from "./types.auto.ts";

const STATUS = {
  pass: { compliance: 1, finding: 4, caption: "Pass" },
  warn: { compliance: 2, finding: 1, caption: "Warning" },
  fail: { compliance: 3, finding: 1, caption: "Fail" },
  accepted: { compliance: 3, finding: 3, caption: "Fail" },
  unknown: { compliance: 0, finding: 1, caption: "Unknown" },
} as const;

/** The OCSF Compliance Findings for one piece of evidence (one per SCF control it supports). */
export function complianceFindings(
  e: Evidence,
  o: { now: Date; fleet: string; catalog?: ScfCatalog },
): OcsfComplianceFinding[] {
  const s = STATUS[e.status as keyof typeof STATUS] ?? STATUS.unknown;
  const t = o.now.getTime();
  return e.scf.map((control) => {
    const maps = o.catalog?.controls[control]?.maps;
    const requirements = maps
      ? FRAMEWORKS.flatMap((f) => (maps[f.id] ?? []).map((r) => `${f.short} ${r}`))
      : [];
    const f: OcsfComplianceFinding = {
      class_uid: 2003,
      category_uid: 2,
      activity_id: 1,
      type_uid: 200301,
      severity_id: 0,
      status_id: s.finding,
      time: t,
      metadata: {
        version: OCSF_VERSION,
        product: { name: "Stolos", vendor_name: "Intellectual Frontiers LLC", version: VERSION },
        tenant_uid: o.fleet,
      },
      finding_info: {
        uid: `${o.fleet}:${e.source}:${e.subject}:${e.check}:${control}`,
        title: e.check,
        desc: e.detail,
        types: [e.source],
      },
      compliance: {
        standards: [`${SCF_SOURCE.title} ${SCF_SOURCE.version}`],
        control,
        ...(requirements.length ? { requirements } : {}),
        status: s.caption,
        status_id: s.compliance,
        ...(e.status === "accepted" ? { status_details: [e.detail] } : {}),
      },
      resource: { name: e.subject, type: e.source },
      ...(e.fix && e.status !== "pass" ? { remediation: { desc: e.fix } } : {}),
    };
    return f;
  });
}
