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
 * deno task stolos compliance impact
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
 * ## FedRAMP 20x
 *
 * FedRAMP 20x measures a cloud service by Key Security Indicators (KSI), not by a list of controls,
 * and publishes them as machine-readable rules: the Consolidated Rules for 2026, from FedRAMP's
 * own repository (`FedRAMP/rules`, vendored at a pinned commit with its SHA-256 in
 * `vendor/fedramp/`). `deno task fedramp` generates `src/archon/fedramp/rules.auto.ts` from them:
 * every KSI with the NIST SP 800-53 controls FedRAMP maps it to, which KSIs Class A must address
 * (`FRC-CLA-MFR`), and each class's cadences.
 *
 * ```sh
 * deno task stolos compliance fedramp --class A
 * deno task stolos compliance fedramp --class B --out sdr-class-b.json --overview https://trust.example.com/fedramp/cpo.json
 * ```
 *
 * ```mermaid
 * flowchart LR
 *   checks["Stolos checks (by SCF control)"] -- "a reason per KSI (Stolos's own)" --> ksi["46 KSIs (FedRAMP's)"]
 *   checks -- "SCF STRM" --> nist["SP 800-53"]
 *   ksi -- "FedRAMP's mapping" --> nist
 *   ksi --> a["Class A: 7 KSIs, monthly validation (SHOULD)"]
 *   ksi --> b["Class B: every KSI, validation every 7 days (MUST)"]
 *   a & b --> sdr["Security Decision Record (FedRAMP's JSON schema)"]
 * ```
 *
 * Each KSI is either covered by Stolos's checks, with the reason in plain words and, where the
 * SCF Council's STRM reaches the KSI's own SP 800-53 controls, those links; or listed as not
 * observable, with why (a person's process, a document, a contract, or something Stolos does not
 * read). Those the provider supplies itself. The package is the Security Decision Record that
 * `SDR-CSX-KSI` asks for, valid against FedRAMP's schema: each KSI's measures and their cycle,
 * the automated tests and their results with when each was observed, and the rules on automation
 * (`FRC-CSX-VVK`), machine validation (`VDR-TFR-MVX`), and package upkeep (`CPO-CSX-CPM`) with
 * how the fleet's evidence meets them for the class. The independent assessment and historical
 * metrics (`SDR-CSX-KMT`) are not Stolos's to write yet.
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
 * ## Compliance impact at the point of change
 *
 * Drift says what changed after the fact; impact says it before (spec 074). `stolos apply` shows a
 * "Compliance impact" phase before it commits, `stolos compliance impact` prints the same, and
 * every pull request to the fleet repository gets it as one comment:
 *
 * ```sh
 * deno task stolos compliance impact                                   # the working tree vs GitHub's main
 * deno task stolos compliance impact --base main --head my-branch --markdown
 * ```
 *
 * It compares the fleet at a base commit with a head commit (or the working tree). Each side's
 * model is loaded and every host's plan resolved, then held against Stolos's declarations of which
 * model setting implements which SCF control, and which direction weakens it. These are Stolos's
 * own statements, typed data in `impact.ts` (`IMPLEMENTATIONS`), each tested:
 *
 * | Setting (declaration)                                     | SCF control | Weakens it                              |
 * | --------------------------------------------------------- | ----------- | --------------------------------------- |
 * | unattended upgrades, `updates()` (`updates`)              | VPM-08      | turned off                              |
 * | `fleet.ssh.passwordFrom`, sshd (`ssh-passwords`)          | IAC-14      | passwords from more networks            |
 * | the host firewall, `firewall()` (`firewall`)              | NET-02      | turned off                              |
 * | the ports each capability opens (`firewall-ports`)        | NET-02      | a port opened                           |
 * | the daily backup, `backup()` (`backup`)                   | BCD-24      | the host removed from backups           |
 * | `host.backup`, durable guests (`backup-scope`)            | BCD-24      | less held, fewer archives kept          |
 * | osquery, `osquery()` (`osquery`)                          | MON-02      | removed                                 |
 * | `compliance.cadence` (`cadence`)                          | MON-02      | observed less often, or stale later     |
 * | etckeeper, `etckeeper()` (`etckeeper`)                    | CHG-03      | /etc changes no longer recorded         |
 * | `host.users[].admin` (`admins`)                           | IAC-30      | more administrators                     |
 * | `fleet.mcp.maxTier` (`agent-tier`)                        | IAC-30      | a higher tier for agents                |
 *
 * It also compares the evidence Git records (adopted machines, devices, connected accounts) and the
 * fleet's control packs on both sides, per control, as drift does. Each affected control is listed
 * with its SCF name and, when the SCF catalog is cached on the machine that runs it, the framework
 * requirements the SCF Council maps it to; without the catalog, it says so.
 *
 * ```mermaid
 * flowchart LR
 *   change["a change: the working tree, or a pull request"] --> sides["the fleet at the base and at the head"]
 *   sides --> model["each host's plan: Stolos's declarations"] & ev["observations and control packs"]
 *   model & ev --> ctl["affected SCF controls: weakened or strengthened"]
 *   ctl -- "SCF STRM" --> fw["framework requirements"]
 *   ctl --> apply["stolos apply: the Compliance impact phase"]
 *   ctl --> pr["the pull request: one comment, a check"]
 *   ctl --> gate{"compliance.gate (the base's)"}
 *   gate -- "allow, accepted risk, signed approval" --> go["committed, merged"]
 *   gate -- "none" --> stop["refused"]
 * ```
 *
 * ### The gate
 *
 * By default impact only shows. A fleet that wants weakenings stopped sets the gate in
 * `fleets/<fleet>/fleet.ts`:
 *
 * ```ts ignore
 * compliance: {
 *   gate: {
 *     block: "weakens",            // default "never"
 *     allow: ["firewall-ports"],   // never blocks: a declaration, "<declaration>/<host>", or an SCF id
 *     evidence: false,             // true: observed evidence turning a control to fail blocks too
 *   },
 * },
 * ```
 *
 * The gate is read from the base, so a change cannot turn off the gate that judges it. A weakening
 * the gate blocks is let through by one of:
 *
 * - an accepted risk in `fleets/<fleet>/controls/accepted.ts` (spec 078), with the policy
 *   `impact/<key>` (`impact/updates/beta`, `impact/VPM-08`), who, why, and until when; after the
 *   date it blocks again. Evidence from an adopted machine whose own `accepted` list covers the
 *   failing policy is accepted, not failing, so it does not block either;
 * - an approval: a commit in the change whose message carries the trailer
 *   `Compliance-Approved: <keys>` (or `all`) and a good signature by one of the base's signers
 *   (`signers.ts` at the base, so a change cannot add the signer that approves it). `stolos apply
 *   --approve updates/beta` writes the trailer into the commit it signs.
 *
 * A weakening's keys are its declaration (`updates`), the declaration on its host (`updates/beta`),
 * and its SCF control (`VPM-08`).
 *
 * ### On pull requests
 *
 * `stolos fleet init` writes `.github/workflows/compliance-impact.yml` into a new fleet repository,
 * and `stolos fleet upgrade` writes it again when it changes. On each pull request it downloads the
 * SCF catalog (pinned, SHA-256 checked), runs `stolos compliance impact --base <base> --head <head>
 * --markdown` for each fleet, and posts one comment (created once, then updated) when a control is
 * affected; its check fails when the gate blocks. It uses GitHub's own `GITHUB_TOKEN`, limited to
 * `contents: read` and `pull-requests: write` and given only to the step that comments, and two
 * actions, each pinned to a commit: `actions/checkout` and `denoland/setup-deno`. A pull request
 * from a fork gets a read-only token: its check still runs, and the impact is in the run's summary.
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
