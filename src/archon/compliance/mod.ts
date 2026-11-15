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
 * deno task stolos compliance drift --since 2026-11-01
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
 * ## Delivering them on a schedule
 *
 * An export job (`estate.exports` in `fleets/<fleet>/fleet.ts`, spec 092) delivers the OSCAL
 * documents, and the other export kinds, without anyone running a command: to the fleet's
 * OpenTelemetry collector when `telemetry.collector` is set, otherwise to a file in this PC's state
 * directory; with recipients, the files are also emailed, send-only, each copy encrypted (S/MIME)
 * to that recipient's own certificate, so an auditor's mail program opens it and nobody else can.
 *
 * ```sh
 * deno task stolos export run auditor        # now
 * deno task stolos export schedule auditor   # on its schedule, by this PC's own scheduler
 * ```
 *
 * See the delivery module (`src/archon/export/deliver.ts`) and its commands
 * (`src/archon/export/delivery-commands.ts`) for the send-only credential and the certificates.
 *
 * ## Freshness
 *
 * Evidence is only as good as its last observation (spec 073). Each source of evidence has a
 * cadence and a service level, modeled on FedRAMP 20x's persistent validation, which expects
 * machine-based validation every 3 to 7 days:
 *
 * | Source                        | Cadence                     | Stale after (service level) |
 * | ----------------------------- | --------------------------- | --------------------------- |
 * | Managed servers (verify)      | every 15 minutes            | 30 minutes                  |
 * | Adopted machines              | daily                       | 2 days                      |
 * | SNMP devices                  | daily                       | 2 days                      |
 * | Connected accounts            | daily, or the connector's   | twice the cadence           |
 * | The repository, estate graph  | read live from Git          | never stale                 |
 *
 * The service level is twice the cadence unless set, and never more than 7 days. A fleet overrides
 * any of them in `fleets/<fleet>/fleet.ts`:
 *
 * ```ts ignore
 * compliance: {
 *   cadence: {
 *     managed: { every: "1h" },
 *     adopted: { every: "1d", staleAfter: "3d" },
 *     connectors: { bamboohr: { every: "7d" } },
 *   },
 * },
 * ```
 *
 * Every piece of evidence carries when it was observed. Evidence older than its service level is
 * stale: it fails its own controls and MON-02 (Continuous Monitoring), and its fix is the command
 * that observes its source again (`stolos fleet status`, `host observe`, `device observe`,
 * `estate observe`). `stolos compliance` prints each control's newest and oldest evidence age and
 * the stale sources; `--json` includes the ages; the Compliance tab shows them with a stale pill.
 *
 * ```mermaid
 * flowchart LR
 *   obs["Observations: verify, host observe, device observe, estate observe"] -- "observedAt" --> ev["Evidence"]
 *   cad["Cadences: defaults, a connector's own, fleet.ts"] --> sl{"Older than its service level?"}
 *   ev --> sl
 *   sl -- "no" --> ctl["Its controls, as observed"]
 *   sl -- "yes: stale" --> fail["Fails its controls and MON-02"]
 *   ctl & fail --> drift["compliance drift: then and now"]
 *   drift -- "--notify" --> mail["fleet.mail.to"]
 * ```
 *
 * ### Drift
 *
 * `stolos compliance drift` compares each control's status now with its status at a past commit
 * (`--since`: a commit, or the last commit before a date; default one day ago), from the
 * observations in Git, each side held to the cadences as of its own time. With `--notify` it mails
 * the changes to the fleet's mailbox through the fleet's notify path: control ids, subjects, checks,
 * and statuses, never what a check found. Run it on a schedule with this PC's own scheduler, from
 * the fleet checkout, for example daily at 07:10:
 *
 * ```sh
 * # Linux or macOS (crontab -e)
 * 10 7 * * * cd ~/fleet && deno task stolos compliance drift --notify
 * # Windows (once, in a terminal)
 * schtasks /Create /SC DAILY /ST 07:10 /TN "Stolos\compliance-drift" /TR "cmd /c cd /d %USERPROFILE%\fleet && deno task stolos compliance drift --notify"
 * ```
 *
 * A change is mailed once an hour at most (the notify path's own deduplication).
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
