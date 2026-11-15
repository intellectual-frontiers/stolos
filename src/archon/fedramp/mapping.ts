/**
 * Spec 076: which Stolos evidence gives evidence for each FedRAMP 20x Key
 * Security Indicator (KSI), and which KSIs Stolos cannot observe, each with
 * its reason in plain words. This is the only mapping here that is Stolos's
 * own: "these checks give evidence for this KSI". The KSIs themselves, their
 * NIST SP 800-53 controls, and which classes they apply to are FedRAMP's
 * (`rules.auto.ts`); the path from a check's SCF control to SP 800-53 is the
 * SCF Council's (its STRM, in the catalog), and `strmLinks` shows it where
 * it exists, so a reviewer can see each claim's footing.
 *
 * ```mermaid
 * flowchart LR
 *   checks["Stolos checks (Evidence, by SCF control)"] -- "this file: a reason per KSI" --> ksi["FedRAMP KSIs (46)"]
 *   checks -- "SCF STRM" --> nist["SP 800-53 controls"]
 *   ksi -- "FedRAMP's own mapping" --> nist
 *   ksi -.-> no["Not observable: a person's process, a document, a contract"]
 * ```
 *
 * Every KSI appears exactly once: the type is a record over FedRAMP's KSI
 * ids, so a KSI FedRAMP adds fails to compile until it is mapped.
 *
 * @module
 */

import type { Evidence } from "../compliance/report.ts";
import type { ScfCatalog } from "../compliance/catalog.ts";
import { oscal80053 } from "../compliance/oscal.ts";
import { type Ksi, type KsiId, KSIS } from "./rules.auto.ts";

export type { Ksi, KsiId } from "./rules.auto.ts";

/** A KSI that Stolos's checks give evidence for. */
export interface KsiCovered {
  /** The SCF controls whose evidence counts (Evidence.scf). */
  scf: string[];
  /** Only evidence from these sources (default: any). */
  sources?: Evidence["source"][];
  /** What the checks show for this KSI, and what they do not, in plain words. */
  reason: string;
}

/** Why Stolos cannot observe a KSI. */
export type NotObservableKind = "process" | "document" | "contract" | "not read";

/** A KSI that Stolos cannot observe: the provider supplies its evidence. */
export interface KsiNotObservable {
  /** What it rests on: a person's process, a document, a contract, or something Stolos does not read. */
  notObservable: NotObservableKind;
  /** Why, in plain words. */
  reason: string;
}

/** One KSI's mapping. */
export type KsiMapping = KsiCovered | KsiNotObservable;

/** Whether a mapping is covered by checks. */
export function covered(m: KsiMapping): m is KsiCovered {
  return "scf" in m;
}

/** Every KSI, exactly once: the checks that give evidence for it, or why none can. */
export const KSI_MAP: Record<KsiId, KsiMapping> = {
  "KSI-CED-RAT": {
    notObservable: "process",
    reason:
      "Training and the review of its effectiveness are people's activities, recorded in a training system or HR records that Stolos does not read.",
  },
  "KSI-CMT-LMC": {
    scf: ["CHG-03", "CFG-04"],
    reason:
      "Every change to the fleet is a signed Git commit, servers apply only commits a fleet signer signed, protected branches require review, and each server verifies itself against its model, so every modification is logged and a change outside Git shows as a failing check.",
  },
  "KSI-CMT-RMV": {
    scf: ["CHG-03", "CFG-04"],
    reason:
      "Managed servers are converged from the version-controlled model by the reconcile timer rather than edited by hand; verify flags any drift from it.",
  },
  "KSI-CMT-RVP": {
    notObservable: "process",
    reason:
      "Reviewing whether the documented change procedures work is a people's review; Stolos enforces its own change path but cannot judge the review.",
  },
  "KSI-CMT-VTD": {
    scf: ["CFG-04", "CHG-03"],
    reason:
      "Each change is type-checked and rendered before it is committed, the code host requires an approving review, and each server verifies itself after applying it, all automatically.",
  },
  "KSI-CNA-DFP": {
    scf: ["CFG-04", "IAC-30"],
    reason:
      "Each managed server's services, users, and packages are defined in its TypeScript model and verified against it; administrator counts are checked on machines and accounts.",
  },
  "KSI-CNA-EIS": {
    scf: ["CFG-04", "MON-02"],
    reason:
      "The reconcile timer applies each server's intended state every 15 minutes and verifies it; adopted machines are checked against the policy pack on every observation.",
  },
  "KSI-CNA-IBP": {
    scf: ["CFG-04", "CRY-05", "NET-13", "DCH-02", "IAC-10"],
    sources: ["cloud"],
    reason:
      "The connected clouds and services are checked against their makers' own guidance: IMDSv2 on EC2, S3 Block Public Access, no AWS root access keys, Cloudflare Full (strict) TLS and DNSSEC.",
  },
  "KSI-CNA-MAT": {
    scf: ["NET-02", "END-07"],
    reason:
      "A firewall stands in front of every machine (the router, a cloud firewall, the workstation's own); Stolos checks it is on. It does not measure lateral movement.",
  },
  "KSI-CNA-OFA": {
    scf: ["BCD-24", "BCD-02"],
    reason:
      "Partly: cloud servers have backups and deletion protection, which recovery depends on. Whether the design is highly available is an architecture decision Stolos does not judge.",
  },
  "KSI-CNA-RNT": {
    scf: ["NET-02", "END-07"],
    reason:
      "Inbound traffic is limited by a firewall on or in front of every machine (the router's rules from the model, each cloud firewall, each workstation's own); Stolos checks each is present and on.",
  },
  "KSI-CNA-RVP": {
    notObservable: "not read",
    reason:
      "Stolos does not read denial-of-service protections or measure their effectiveness; reviewing them is a person's task.",
  },
  "KSI-CNA-ULN": {
    scf: ["NET-02"],
    reason:
      "Traffic flow is enforced by the router's and the clouds' firewalls, which the model defines and Stolos checks; deeper segmentation is not observed.",
  },
  "KSI-IAM-AAM": {
    scf: ["IAC-04", "IAC-08"],
    reason:
      "Accounts are compared automatically with the HR roster across the identity provider, code host, and clouds: people who left have no active account, and every active account belongs to a person or a known service.",
  },
  "KSI-IAM-APM": {
    scf: ["IAC-37", "IAC-14"],
    reason:
      "MFA is checked as enforced and registered in each identity provider and code host, and SSH accepts keys, not passwords. Stolos sees that a second factor is in place, not whether it is phishing-resistant.",
  },
  "KSI-IAM-ELP": {
    scf: ["IAC-30", "IAC-10"],
    reason:
      "Administrators are few on each machine and in each service (two to four), and the AWS root user has no access keys.",
  },
  "KSI-IAM-JIT": {
    notObservable: "not read",
    reason:
      "Stolos counts administrators but does not read role, attribute, or just-in-time elevation policies, so it cannot show the authorization model.",
  },
  "KSI-IAM-SNU": {
    scf: ["IAC-14", "IAC-10", "IAC-08"],
    reason:
      "Machines authenticate with keys (SSH host and deploy keys, per-person signing keys), the AWS root user has no access keys, and every non-person account is a known service account.",
  },
  "KSI-IAM-SUS": {
    notObservable: "process",
    reason:
      "Disabling a privileged account on suspicious activity is incident response by people or an identity provider's own automation; Stolos does not read sign-in risk events.",
  },
  "KSI-INR-AAR": {
    notObservable: "document",
    reason: "After action reports and lessons learned are documents people write.",
  },
  "KSI-INR-RIR": {
    notObservable: "process",
    reason: "Reviewing the incident response procedures is a people's review of a document.",
  },
  "KSI-INR-RPI": {
    notObservable: "process",
    reason: "Reviewing past incidents for patterns is analysis by people.",
  },
  "KSI-MLA-ALA": {
    notObservable: "not read",
    reason: "Stolos does not read who may access log data, or how that access is granted.",
  },
  "KSI-MLA-EVC": {
    scf: ["CFG-04", "CHG-03"],
    reason:
      "The fleet is infrastructure as code: every change is type-checked and rendered before commit, and each server verifies its configuration against the model on every reconcile.",
  },
  "KSI-MLA-LET": {
    notObservable: "document",
    reason:
      "The list of resources and event types to log is a document the provider keeps and reviews; Stolos can deliver telemetry but does not check that list.",
  },
  "KSI-MLA-OSM": {
    notObservable: "not read",
    reason:
      "Stolos can send telemetry to a collector but does not read the SIEM, its retention, or its tamper resistance.",
  },
  "KSI-MLA-RVL": {
    notObservable: "process",
    reason: "Reviewing and auditing logs is done by people.",
  },
  "KSI-PIY-GIV": {
    scf: ["AST-04", "AST-07.1"],
    reason:
      "The inventory is generated from authoritative sources (the fleet model, each machine's own probe, each cloud's API), recorded in Git, and checked as observed in the last 7 days, each machine with an owner.",
  },
  "KSI-PIY-RES": {
    notObservable: "process",
    reason: "Executive support is shown by people and decisions, not by machines.",
  },
  "KSI-PIY-RIS": {
    notObservable: "process",
    reason: "Reviewing the effectiveness of security investments is a business review.",
  },
  "KSI-PIY-RSD": {
    scf: ["VPM-12", "CHG-03"],
    sources: ["cloud", "estate", "repository"],
    reason:
      "Partly: private repositories scan for secrets, protect their default branches, and require an approving review. Reviewing the effectiveness of the SDLC against Secure by Design is a person's task.",
  },
  "KSI-PIY-RVD": {
    notObservable: "process",
    reason: "A vulnerability disclosure program, and its review, are run by people.",
  },
  "KSI-RPL-ABO": {
    scf: ["BCD-24"],
    reason:
      "Partly: Stolos checks that cloud servers have backups and the vault is backed up off the PC. Whether they meet the recovery objectives is a person's review.",
  },
  "KSI-RPL-ARP": {
    notObservable: "document",
    reason: "A recovery plan, and its alignment with the objectives, are documents people review.",
  },
  "KSI-RPL-RRO": {
    notObservable: "document",
    reason: "Recovery time and point objectives are decisions people write down.",
  },
  "KSI-RPL-TRC": {
    notObservable: "process",
    reason: "Recovery tests are exercises people run; Stolos does not record them as evidence yet.",
  },
  "KSI-SCR-MIT": {
    notObservable: "contract",
    reason:
      "Identifying and mitigating supply chain risk rests on supplier reviews and contracts, which Stolos does not read.",
  },
  "KSI-SCR-MON": {
    scf: ["VPM-08", "VPM-12", "AST-39"],
    reason:
      "Upstream fixes are watched for and installed automatically (security updates, few waiting), repositories scan code, and every operating system is still supported by its maker.",
  },
  "KSI-SVC-ACM": {
    scf: ["CFG-04", "MON-02", "CHG-03"],
    reason:
      "Configuration is managed by the model and applied automatically; each server verifies it on every reconcile, so drift shows as a failing check.",
  },
  "KSI-SVC-ASM": {
    scf: ["IAC-14"],
    reason:
      "Partly: signing keys are one per person with an offline recovery key, and secrets live only in the vault. Rotation itself is not checked.",
  },
  "KSI-SVC-EIS": {
    scf: ["MON-02", "VPM-08", "AST-39"],
    reason:
      "Machines are observed and verified on a schedule, security updates install by themselves, and unsupported systems are flagged; choosing further improvements is a person's task.",
  },
  "KSI-SVC-PRR": {
    notObservable: "process",
    reason:
      "Reviewing plans and resources after a change for unwanted residual elements is a people's review.",
  },
  "KSI-SVC-RUD": {
    notObservable: "contract",
    reason:
      "Removing an agency's data on request follows the customer agreement and is done by people; Stolos does not see customer data.",
  },
  "KSI-SVC-SIN": {
    scf: ["CRY-05", "CRY-07", "NET-37", "DCH-02", "NET-13"],
    reason:
      "Information is encrypted in transit (TLS 1.2 or later, certificates verified end to end, SNMPv3 authPriv) and at rest (disk encryption checked on machines and devices), storage is not public, and DNS is signed.",
  },
  "KSI-SVC-VCM": {
    scf: ["CRY-05", "NET-37"],
    reason:
      "Machine-to-machine traffic is authenticated and protected: the edge verifies the origin's certificate, HTTP is redirected to HTTPS, and devices are read over SNMPv3 with authentication and privacy.",
  },
  "KSI-SVC-VRI": {
    scf: ["CHG-03", "IAC-14"],
    reason:
      "Servers apply only commits signed by a fleet signer, so the configuration they run is validated cryptographically; signing keys are per person.",
  },
};

/** Each KSI with its mapping, in FedRAMP's order. */
export function ksiMappings(): Array<{ ksi: Ksi; mapping: KsiMapping }> {
  return KSIS.map((ksi) => ({ ksi, mapping: KSI_MAP[ksi.id] }));
}

/** The evidence a covered KSI counts (none for a KSI Stolos cannot observe). */
export function ksiEvidence<E extends Evidence>(m: KsiMapping, evidence: E[]): E[] {
  if (!covered(m)) return [];
  return evidence.filter(
    (e) => e.scf.some((s) => m.scf.includes(s)) && (!m.sources || m.sources.includes(e.source)),
  );
}

/**
 * Where the SCF Council's STRM reaches the KSI's own SP 800-53 controls: for
 * each SCF control the mapping cites, the KSI's controls it shares. Empty
 * without the catalog, or where the claim rests on the reason alone.
 */
export function strmLinks(ksi: Ksi, m: KsiMapping, catalog?: ScfCatalog): Record<string, string[]> {
  if (!catalog || !covered(m)) return {};
  const out: Record<string, string[]> = {};
  for (const id of m.scf) {
    const nist = (catalog.controls[id]?.maps.nist80053 ?? []).map(oscal80053);
    const shared = ksi.controls.filter((c) => nist.includes(c));
    if (shared.length) out[id] = shared;
  }
  return out;
}
