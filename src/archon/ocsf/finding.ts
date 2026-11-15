/**
 * Spec 089: every check's result as an OCSF 1.9.0 Compliance Finding (class 2003), written by IFC
 * TypeScript's kernel (`ocsf.complianceFinding`) from the evidence's GRC findings
 * (`compliance/findings.ts`): one per piece of evidence and SCF control. The compliance object names
 * the standard (SCF, by release), the control, and, when the SCF catalog is on this PC, the
 * framework requirements SCF maps it to (`<framework>:<requirement>`). Typed by the kernel's OCSF
 * types, so a missing required field does not compile.
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

import { ocsf } from "@intellectual-frontiers/ifc-ts/kernel";
import { SCF_SOURCE, type ScfCatalog } from "../compliance/catalog.ts";
import { evidenceFindings, instantOfDate } from "../compliance/findings.ts";
import type { Evidence } from "../compliance/report.ts";
import { VERSION } from "../version.ts";

/** Who writes Stolos's OCSF events. */
export const OCSF_PRODUCT: ocsf.OcsfProduct = {
  name: "Stolos",
  vendor_name: "Intellectual Frontiers LLC",
  version: VERSION,
};

/** The OCSF Compliance Findings for one piece of evidence (one per SCF control it supports). */
export function complianceFindings(
  e: Evidence,
  o: { now: Date; fleet: string; catalog?: ScfCatalog },
): ocsf.ComplianceFindingEvent[] {
  const findings = evidenceFindings(e, {
    at: instantOfDate(o.now),
    ...(o.catalog ? { catalog: o.catalog } : {}),
  });
  return findings.map((f) => ({
    ...ocsf.complianceFinding(f, {
      product: OCSF_PRODUCT,
      standards: () => [`${SCF_SOURCE.title} ${SCF_SOURCE.version}`],
      metadata: {
        tenant_uid: o.fleet,
        uid: `${o.fleet}:${e.source}:${e.subject}:${e.check}:${f.control.id}`,
      },
    }),
    // Stolos does not rate severity: 0 Unknown, not the kernel's informational default.
    severity_id: 0,
    severity: "Unknown",
  }));
}
