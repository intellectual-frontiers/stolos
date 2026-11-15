/**
 * # Risks and vendors
 *
 * The risk register and the vendor inventory are code in the fleet repository (spec 080): a risk
 * is a typed entry in `fleets/<fleet>/risks.ts`, a vendor's triage is a typed entry in
 * `fleets/<fleet>/vendors.ts`, and both change only through a reviewed pull request that a fleet
 * signer merges with a signed merge commit. Stolos checks them like any other control (overdue
 * reviews fail, accepted risks past their date fail, owners not on the roster and vendors not
 * triaged warn), and shows them in `stolos compliance` and the OSCAL plan of action and
 * milestones.
 *
 * ```mermaid
 * flowchart LR
 *   risks["fleets/&lt;fleet&gt;/risks.ts"] --> pack["risk-register controls (SQL over the estate)"]
 *   accepted["controls/accepted.ts, adopted machines' accepted risks"] --> pack
 *   sso["SSO applications (Okta, Entra)"] & dns["DNS: CNAME and MX targets"] & tenants["connected accounts"] & billing["billing (future)"] --> discover["vendor discovery"]
 *   discover --> pack
 *   vendors["fleets/&lt;fleet&gt;/vendors.ts: criticality, data"] --> pack
 *   pack --> compliance["stolos compliance: RSK-11, RSK-13.2, RSK-14, RSK-16.1, TPM-08, TPM-09"]
 *   risks --> poam["OSCAL POA&M: risks"]
 *   review["stolos risks review, stolos vendors triage --write"] --> pr["a pull request: one signed commit"]
 *   pr -- "a signer's signed merge" --> risks & vendors
 * ```
 *
 * ## The register
 *
 * Each risk has an id, a title and description, its likelihood and impact on the qualitative scale
 * of NIST SP 800-30 Rev 1 (`very low`, `low`, `moderate`, `high`, `very high`; the level of risk is
 * that publication's Table I-2), an owner (a person's work email, on the roster), a treatment (the
 * standard risk responses of NIST SP 800-39 and ISO 31000: `accept`, `mitigate`, `transfer`,
 * `avoid`), the SCF controls it relates to (typed: a wrong id fails type checking), the accepted
 * risks it stands behind, and its next review date.
 *
 * ```ts
 * // fleets/<fleet>/risks.ts
 * import { defineRisks } from "@stolos/archon/risk/mod.ts";
 *
 * export const risks = defineRisks([
 *   {
 *     id: "laptop-theft",
 *     title: "A laptop with customer data is stolen",
 *     description: "Laptops travel; a stolen one could expose the customer list.",
 *     likelihood: "moderate",
 *     impact: "high",
 *     owner: "alice@example.org",
 *     treatment: "mitigate",
 *     scf: ["CRY-07", "AST-04"],
 *     accepted: ["baseline/few-admins"],
 *     nextReview: "2027-02-15",
 *   },
 * ]);
 * ```
 *
 * `accepted` names accepted risks: a control pack's result as `<pack>/<control>` (from
 * `controls/accepted.ts`), or an adopted machine's as `<machine>:<policy>` (from its `accepted`).
 * An accepted risk that no risk names is listed as not in the register.
 *
 * ## Vendors
 *
 * Vendors are discovered from what Stolos already reads:
 *
 * | Source                | What reveals a vendor                                                       |
 * | --------------------- | --------------------------------------------------------------------------- |
 * | SSO applications      | Okta's app integrations, Entra's enterprise applications                    |
 * | DNS                   | a CNAME or MX record whose target is outside the fleet's own zones          |
 * | Connected accounts    | each connector's tenant (the identity provider, the cloud, the code host)   |
 * | Billing               | a hook for a future billing connector (`BillingSource`)                     |
 *
 * A small table of well-known service domains and app names maps each to the organization behind
 * it; anything else is an unknown vendor, named by its domain or app. Each vendor becomes an
 * `organization` party in the estate graph with the `party_role` supplier (the Universal Data
 * Model's terms), joined by a `supplies` edge to what revealed it, so `stolos estate query` can ask
 * about them.
 *
 * Triage is `fleets/<fleet>/vendors.ts`: each vendor's criticality (FIPS 199's potential impact:
 * `low`, `moderate`, `high`) and the data it holds (OCSF's data classification categories). A
 * vendor discovered and not triaged waits in `stolos vendors triage`, and a control warns until it
 * is.
 *
 * ```ts
 * // fleets/<fleet>/vendors.ts
 * import { defineVendors } from "@stolos/archon/risk/mod.ts";
 *
 * export const vendors = defineVendors([
 *   { id: "okta", name: "Okta", criticality: "high", data: ["Personal", "Security"] },
 *   { id: "mailhost", name: "Mailhost", criticality: "moderate", data: ["Business"], domains: ["mailhost.example"] },
 * ]);
 * ```
 *
 * `domains` and `apps` claim an unknown vendor's service domains or SSO applications for this
 * entry.
 *
 * ## Commands
 *
 * | Command                                  | What it does                                                          |
 * | ---------------------------------------- | --------------------------------------------------------------------- |
 * | `stolos risks list`                      | the register, highest level first                                     |
 * | `stolos risks check`                     | the controls below, and who approved risks.ts and vendors.ts           |
 * | `stolos risks review <id> [--next day]`  | moves a risk's next review on, in a pull request                      |
 * | `stolos vendors list`                    | every vendor, with its triage and what revealed it                    |
 * | `stolos vendors triage [--write]`        | the vendors waiting for triage; `--write` opens a pull request        |
 *
 * The controls (pack `risk-register`, shown in `stolos compliance` as a control pack):
 *
 * | Control                          | Result                                                                         | SCF              |
 * | -------------------------------- | ------------------------------------------------------------------------------ | ---------------- |
 * | `risk-register/review-due`       | fails when an open risk is past its next review; warns when the register is empty | RSK-14, RSK-13.2 |
 * | `risk-register/owner-on-roster`  | warns when an owner is not an active person on the roster                      | RSK-11           |
 * | `risk-register/accepted-current` | fails when an accepted risk is past its date; warns when one is not in the register | RSK-16.1         |
 * | `risk-register/vendors-triaged`  | warns while a discovered vendor is not triaged                                 | TPM-08, TPM-09   |
 *
 * ## Review through signed pull requests
 *
 * `stolos risks review` and `stolos vendors triage --write` make a branch from the main branch on
 * GitHub, change the file, make one commit signed with your daily key, push the branch, and open a
 * pull request with `gh`. Nothing is merged for you. The approval is the merge: a fleet signer
 * merges with a signed merge commit (`git merge --no-ff -S <branch>`, then `stolos apply`), and
 * `stolos risks check` names the signer of the last change to each file, checked with
 * `git verify-commit` against the fleet's `signers.ts`, as servers and evidence bundles check
 * commits. A merge made on GitHub's website is signed by GitHub, not by a fleet signer: the next
 * signed commit on the main branch approves it, and `risks check` says which one.
 *
 * Every OSCAL export (`stolos compliance export`) carries the open risks in its plan of action and
 * milestones: each with its likelihood and impact (as SP 800-30 facets), its treatment, owner, and
 * next review.
 *
 * @module
 */

export {
  addDays,
  defineRisks,
  isDay,
  type Level,
  LEVELS,
  loadRisks,
  type Risk,
  RISK_MATRIX,
  type RiskDef,
  riskLevel,
  riskProblems,
  risksFile,
  today,
  type Treatment,
  TREATMENTS,
} from "./register.ts";
export {
  type BilledVendor,
  BILLING_SOURCES,
  type BillingSource,
  CRITICALITIES,
  type Criticality,
  DATA_CATEGORIES,
  type DataCategory,
  defineVendors,
  discoverVendors,
  type KnownVendor,
  loadVendors,
  needsTriage,
  type Vendor,
  type VendorDef,
  vendorProblems,
  vendorsFile,
  WELL_KNOWN_VENDORS,
} from "./vendors.ts";
export { addRiskData, RISK_PACK, runRiskPack } from "./controls.ts";
export { RISK_SCHEMA } from "./schema.ts";
