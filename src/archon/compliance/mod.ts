/**
 * # Compliance
 *
 * Stolos turns what it already checks into evidence for an auditor (specs 068 and 071). Each check
 * names the Secure Controls Framework (SCF) controls it supports. Each SCF control reaches the
 * requirements of SOC 2, HIPAA, PCI DSS, CMMC 2.0, NIST SP 800-53 Rev 5 and SP 800-171 Rev 3, and
 * FedRAMP (Moderate) through the SCF Council's own mappings, its Set Theory Relationship Mapping
 * (STRM). Stolos writes none of those mappings itself.
 *
 * ```bash
 * deno task stolos compliance catalog
 * deno task stolos compliance
 * deno task stolos compliance --framework hipaa
 * deno task stolos compliance export
 * ```
 *
 * `compliance catalog` downloads, once per PC, the SCF workbook from the SCF Council's repository
 * and NIST's OSCAL catalogs from NIST's, each at a pinned commit, and refuses any whose SHA-256
 * differs. Stolos does not redistribute them.
 *
 * ```mermaid
 * flowchart LR
 *   checks["Checks: verify, policies, posture, signatures"] --> scf["SCF controls"]
 *   scf -- "SCF STRM" --> fw["SOC 2, HIPAA, PCI DSS, CMMC, NIST, FedRAMP"]
 *   scf -- "SCF STRM" --> oscal["OSCAL: component definition, SSP, assessment results, POA&M"]
 * ```
 *
 * In the consoles, the Compliance tab shows the same: each framework's requirements, and under each
 * control SCF's description and the evidence (machine, check, result, what was found), with how to
 * fix what fails. The Stolos Console downloads it all as JSON, and the four OSCAL documents.
 *
 * ## OSCAL
 *
 * `compliance export` writes OSCAL 1.2.3 JSON, to NIST SP 800-53 Rev 5:
 *
 * - a component definition: Stolos, and one component per source of evidence (managed servers,
 *   adopted machines, devices, each connected service, the repository), each with the controls its
 *   checks reach;
 * - a system security plan importing NIST's moderate baseline, with the fleet's machines as its
 *   inventory;
 * - assessment results: every observation, and a finding per control, satisfied or not;
 * - a plan of action and milestones (POA&M): each failing check open; each accepted risk a
 *   deviation approved until its date.
 *
 * UUIDs are derived from what they name: a machine, a control, a risk, or a POA&M item keeps its UUID
 * from one export to the next, so two exports diff cleanly. The tests validate every
 * document against NIST's OSCAL schema. Fill in what Stolos cannot know (the system's
 * categorization, the controls it cannot observe) before you submit an SSP.
 *
 * ## What it is, and is not
 *
 * - It is evidence from machines and accounts: disk encryption, firewalls, updates, MFA, signed
 *   changes, TLS settings, the asset list, who has access.
 * - It is not a policy, training, or a contract: those controls are not shown at all, and need
 *   evidence of their own.
 * - SOC 2 is shown by criterion (CC6.1); SCF's points of focus (CC6.1-POF10) are folded in.
 * - SOC 2 Type 1 asks about one date; Type 2 about a period. Every observation is a commit, so
 *   `git log -p fleets/<fleet>/adopted fleets/<fleet>/estate` is the period's record.
 *
 * @module
 */

export {};
