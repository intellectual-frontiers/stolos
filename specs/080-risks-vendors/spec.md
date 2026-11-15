# 080: Risk register and vendor inventory as code

Issue intellectual-frontiers/stolos#21: risks and vendors, typed, discovered, and reviewed through
signed pull requests.

## Why

Every framework asks for a risk register with owners and review dates, and for an inventory of the
third parties the company depends on, with how critical each is and what data it holds. Kept in a
spreadsheet, both drift: reviews lapse unnoticed, accepted risks outlive their reason, and a new
SaaS tool arrives through single sign-on without anyone triaging it. Stolos already reads the
identity provider, the DNS zones, and the connected accounts, and already keeps the fleet's rules as
signed TypeScript. The register and the vendor inventory belong there too: typed files in the fleet
repository, checked like any control, changed only through a reviewed pull request that a fleet
signer merges with a signed merge commit.

## Requirements

- **FR-001** The register is `fleets/<fleet>/risks.ts`, `export const risks = defineRisks([...])`
  (`src/archon/risk/register.ts`). Each risk has an id, a title, a description, a likelihood and an
  impact on NIST SP 800-30 Rev 1's qualitative scale (`very low`, `low`, `moderate`, `high`,
  `very high`; Tables G-5 and H-3), an owner (a person's work email), a treatment (NIST SP 800-39's
  and ISO 31000's risk responses: `accept`, `mitigate`, `transfer`, `avoid`), the SCF controls it
  relates to (typed `ScfId`: a wrong id fails type checking), links to accepted risks, a next review
  date, an optional review interval (90 days by default), and a status (`open` or `closed`). Its
  level of risk is SP 800-30 Rev 1 Table I-2. `defineRisks` refuses a malformed register.
- **FR-002** Accepted risks are the ones Stolos already has (spec 078): `controls/accepted.ts`
  (named `<pack>/<control>`) and each adopted machine's `accepted` (named `<machine>:<policy>`). A
  risk names the ones it stands behind in `accepted`.
- **FR-003** The register, the accepted risks, and the vendors are loaded into the estate graph
  (`src/archon/risk/schema.ts`, spec 089's schema language): `risk` and `poam_item` (OSCAL's terms;
  an accepted risk is a deviation approved until a date) and `data_classification` (OCSF's term: a
  vendor's triage). Vendors are the estate's own UDM parties: an `organization` with the
  `party_role` `supplier`, and an `edge` with the new verb `supplies` to each node or tenant that
  revealed it. `schemaProblems` stays empty.
- **FR-004** Controls, on the control SDK (spec 078), as the pack `risk-register`, over the estate:
  - `review-due` (SCF RSK-14, RSK-13.2): an open risk past its next review fails; an empty register
    warns;
  - `owner-on-roster` (RSK-11): an owner who is not an active person on the roster warns (unknown
    without a roster);
  - `accepted-current` (RSK-16.1): an accepted risk past its date fails; one no risk names, or a
    link that names none, warns;
  - `vendors-triaged` (TPM-08, TPM-09): a discovered vendor not in `vendors.ts`, or still
    `unassessed`, warns.

  A register or triage file that does not load is a failing result (RSK-14). The six SCF ids are
  added to `src/archon/compliance/scf.ts` with the names SCF 2026.3 gives them (checked against the
  pinned workbook).
- **FR-005** Vendors are discovered (`src/archon/risk/vendors.ts`, `discoverVendors`) from:
  - SSO applications: the label `application` (OCSF), read by Okta (`/api/v1/apps`, which its
    Read-Only Administrator may list; Okta's own apps left out) and Microsoft Entra
    (`/servicePrincipals`, which Directory.Read.All covers; Microsoft's own and the tenant's own app
    registrations left out). Their other outputs are unchanged (Okta's posture counts users only);
  - DNS: CNAME and MX records whose target is outside the fleet's own zones;
  - connected accounts: each tenant's connector;
  - billing: `BillingSource`, a hook for a future billing connector (none ships).

  A typed table of well-known vendors (`WELL_KNOWN_VENDORS`: service domains, SSO catalog names,
  connectors) names the organization behind each; `vendors.ts` may claim more (`domains`, `apps`).
  Anything else is an unknown vendor, named by its registrable domain or its app.
- **FR-006** Triage is `fleets/<fleet>/vendors.ts`, `export const vendors = defineVendors([...])`:
  each vendor's criticality (FIPS 199's potential impact: `low`, `moderate`, `high`, or
  `unassessed`) and the data it holds (OCSF data classification categories), with an optional owner
  and notes.
- **FR-007** Review through signed pull requests (`src/archon/risk/review.ts`):
  `stolos risks review <id>` moves a risk's next review on (by its interval, or to `--next`), and
  `stolos vendors triage --write` adds each new vendor to `vendors.ts` as `unassessed`; each, from a
  clean checkout, makes a branch from the main branch on GitHub, one commit signed with the
  reviewer's daily key, a push of the branch, and a pull request (`gh pr create`), then returns to
  the branch it started on. Nothing is merged. Approval is the merge: a fleet signer's signed merge
  commit, checked with `git verify-commit` against `signers.ts` (as servers and spec 072 check
  commits); an unsigned merge (GitHub's website) is approved by the next signed commit on the main
  line. `stolos risks check` names who approved the last change to each file.
- **FR-008** Commands (registered in `registry.ts`, run on the PC): `stolos risks list` (also
  `stolos risks`), `stolos risks check`, `stolos risks review` (terminal only),
  `stolos vendors list` (also `stolos vendors`), and `stolos vendors triage` (terminal only). The
  reading ones are in the Stolos Console's group "Risks and vendors".
- **FR-009** Compliance: the pack's results are in the console facts' control packs, so they show in
  `stolos compliance`, the Compliance tab, the OCSF findings, and the OSCAL documents. The OSCAL
  plan of action and milestones carries each open risk of the register: its SP 800-30 likelihood,
  impact, and level as facets (naming system `https://doi.org/10.6028/NIST.SP.800-30r1`), its
  treatment, owner, and next review as properties, and a POA&M item for it. Accepted and transferred
  risks are `deviation-approved`; mitigated and avoided ones are `remediating`.
- **FR-010** The guide `risks` (`src/archon/risk/mod.ts`), which is also the module a fleet imports
  (`@stolos/archon/risk/mod.ts`); example files in `examples/fleets/lab/` (`risks.ts`,
  `vendors.ts`).

## Success criteria

- **SC-001** `tests/risk080_test.ts`:
  - the register and triage files are typed (wrong SCF ids, scale values, treatments, and data
    categories fail type checking and definition); the example lab's files load; SP 800-30's Table
    I-2 holds;
  - an overdue review fails; an on-time one passes; an empty register warns;
  - an owner not active on the roster warns;
  - an accepted risk past its date fails; an unregistered one warns;
  - vendors are discovered from fixture SSO applications, DNS records, tenants, and billing, and are
    organization parties with the role supplier and `supplies` edges;
  - a new SSO vendor appears for triage, and the triage control warns until vendors.ts assesses it;
  - Okta and Entra list SSO applications, leaving their own out, with their other outputs unchanged;
  - the POA&M carries the register's open risks and validates against OSCAL 1.2.3's schema;
  - `schemaProblems` is empty for the new tables, with the estate's, and for the connector labels;
  - a review edits only its risk, and triage appends entries that still load;
  - a review is a branch, one signed commit, a push, and a pull request, never a merge;
  - approval is a fleet signer's signed merge commit, or the next signed commit after an unsigned
    merge.
- **SC-002** Existing tests pass, with the Okta and Microsoft fixtures given an empty application
  list.

## Out of scope

- A billing connector (the hook is there).
- Reading SSO applications from Google Workspace (its API does not list SAML apps) and JumpCloud
  (not confirmed for its Read Only administrator role).
- Folding the new tables into the estate's REST API and osquery tables (they are added to an estate
  when the register is read).
