/**
 * # Adopted machines
 *
 * Stolos manages the servers it installs. Every other machine you are responsible for (your laptop, a
 * colleague's desktop, a WSL distribution, a server someone else installed) can be **adopted**: Stolos
 * observes it and checks it, and never changes it (spec 067).
 *
 * ```mermaid
 * flowchart LR
 *   pc["Your PC: bun run stolos"] -- "probe key (vault)" --> sshd["sshd on the machine"]
 *   sshd -- "forced command" --> probe["~/.local/bin/stolos-probe: read-only"]
 *   probe -- "facts" --> pc
 *   pc -- "observed.ts" --> git["Fleet repository"]
 * ```
 *
 * ## The easy way: pair with a short code
 *
 * On the PC, in the fleet repository:
 *
 * ```bash
 * bun run stolos pair
 * ```
 *
 * It shows one short line and a code (spec 098):
 *
 * ```text
 *   On the machine, run:
 *     Linux, macOS, WSL:   curl -fsSL http://10.0.0.5:7457 | sh
 *     Windows (admin):     irm http://10.0.0.5:7457/w | iex
 *
 *   Then type this code:   WDJB-MJHT      (expires in 10 minutes)
 * ```
 *
 * On the machine, the line says what it will do, asks for the code, asks once about osquery, and
 * sends its check-in back. On the PC you see its name, OS, address and SSH host key, and approve it;
 * it is then adopted, with nothing copied by hand. The code signs every message both ways
 * (HMAC-SHA256), so a machine without it cannot join and no one else can answer in the PC's place.
 * One machine per code; 5 wrong codes end it. `--name` names it (default: its hostname), `--owner`
 * says whose it is.
 *
 * ### Networks: the LAN, or a zero trust mesh
 *
 * Pairing is plain HTTP on purpose (constitution Article 28): it runs on a network the fleet trusts,
 * like PXE and HTTP Boot. A machine that is not on the LAN joins over a zero trust mesh network
 * (Tailscale, Headscale, NetBird, ZeroTier, Nebula, or WireGuard by hand: encrypted end to end, each
 * device known by its identity, access by policy). Stolos installs none of them; `bun run stolos mesh`
 * lists the choices and this PC's mesh addresses. Give the PC's mesh address, `bun run stolos pair --address 100.64.0.5`. Never open the port to the internet.
 *
 * ## One line on the machine, without pairing
 *
 * In the Stolos Console, **Add a machine** asks what it is (a laptop, a device, a cloud account, a
 * server to manage, a workstation) and gives you one line to run on it, or to send to its owner. The
 * same from the command line:
 *
 * ```bash
 * bun run stolos host integrate alice-laptop --as adopt
 * ```
 *
 * On the machine, the line (`bin/integrate.sh` on Linux and macOS, `bin/integrate.windows.ps1` on
 * Windows) lists every change it will make and asks once. It ends by printing a **check-in code**
 * (`stolos1:...`): paste it into the console, or:
 *
 * ```bash
 * bun run stolos host adopt alice-laptop --check-in stolos1:...
 * ```
 *
 * The code carries the machine's public SSH keys, so they are pinned without trusting the first
 * connection. `--as discover` changes nothing on the machine: `discover --import <code>` records it.
 *
 * | `--as`        | On the machine                                                   |
 * | ------------- | ---------------------------------------------------------------- |
 * | `discover`    | nothing: it only reads its facts                                 |
 * | `adopt`       | SSH on, the read-only probe, the probe key's forced-command line |
 * | `osquery`     | with adopt: osquery, for `fleet query`                           |
 * | `server`      | an Ubuntu installed by hand, ready for `host bootstrap`          |
 * | `workstation` | Ubuntu or WSL as a managed fleet workstation                     |
 *
 * Windows is adopted the same way: the line turns on Windows' own OpenSSH Server and installs a
 * PowerShell probe (BitLocker, Windows Firewall, Windows Update, Defender, Administrators).
 *
 * ## Devices
 *
 * Printers, routers, switches, access points, NAS boxes, cameras, and UPSes are read over SNMPv3,
 * encrypted and read only (Stolos sends only GET and GETNEXT; never SNMPv1 or v2c). Make a read-only
 * SNMPv3 user on the device (authPriv, SHA-256, AES), then:
 *
 * ```bash
 * bun run stolos device add front-printer --address 10.0.30.40 --kind printer --user stolos
 * ```
 *
 * Its passphrases are typed in the terminal and kept in the vault; its model, serial, firmware,
 * uptime, contact, and location go to `fleets/<fleet>/devices/front-printer/observed.ts`.
 * `device check` reports its policies (observed, an owner and location, restarted for firmware).
 *
 * ## Adopt a machine over your own SSH
 *
 * ```bash
 * bun run stolos host adopt alice-mbp --ssh alice@alice-mbp.local --owner alice
 * ```
 *
 * It shows the machine's host key (compare it with `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub`
 * on the machine), makes a probe key in the vault, installs the probe over your own SSH (it may ask
 * your password once), and records what it found.
 *
 * The probe key can do one thing: run the probe. Its line in `~/.ssh/authorized_keys` forces the
 * command and forbids a shell, a terminal, and forwarding. The probe needs no root and listens on
 * nothing.
 *
 * ## Every day
 *
 * | Question                     | Command                                                                      |
 * | ---------------------------- | ---------------------------------------------------------------------------- |
 * | What is it now?              | `bun run stolos host observe alice-mbp`                                    |
 * | Does it meet the policies?   | `bun run stolos host check` (`--json` for evidence)                        |
 * | Which Macs run which Chrome? | `bun run stolos fleet query "select name, bundle_short_version from apps"` |
 * | How did it change?           | `git log -p fleets/<fleet>/adopted/alice-mbp/observed.ts`                    |
 * | Stop observing it            | `bun run stolos host release alice-mbp`                                    |
 *
 * `fleet query` needs osquery on the machine (`brew install --cask osquery` on a Mac); the policies do
 * not.
 *
 * ## When a policy cannot pass
 *
 * Sometimes a policy cannot pass, for a good reason: a Linux desktop installed without disk encryption
 * that holds no customer data, say. Record that decision instead of living with a red line:
 *
 * ```bash
 * bun run stolos host accept bob-desk disk-encryption --reason "holds only open-source code; no customer data" --until 2027-06-30
 * ```
 *
 * The policy then shows as **accepted** (not as passing), with who accepted it, why, and until when;
 * Compliance counts it as partial. After the date it fails again, so the decision is reviewed at least
 * yearly. The signed commit that keeps it is the auditor's record.
 *
 * ## Discovered machines
 *
 * `bun run stolos discover` lists the machines this PC has seen on its network (its neighbor table)
 * and the cloud servers no fleet machine owns. It scans nothing and records nothing; adopt the ones
 * you are responsible for.
 *
 * ## The policies
 *
 * Each policy names the Secure Controls Framework (SCF) controls it gives evidence for: the disk is
 * encrypted (CRY-07), the firewall is on (END-07, NET-02), security updates install by themselves
 * (VPM-08), the OS is supported (AST-39), SSH takes keys only (IAC-14), at most three administrators
 * (IAC-30), observed in the last week (AST-04, MON-02). The frameworks are reached from those through
 * the SCF Council's own mappings (see [Compliance](../compliance/mod.ts)).
 *
 * ## Cloud accounts
 *
 * Stolos can also see what the fleet keeps in its clouds, read-only: it never creates, changes, or
 * deletes anything there (managing a cloud stays in that cloud's own console).
 *
 * ```mermaid
 * flowchart LR
 *   vault["Vault: connectors/&lt;provider&gt;/credential.json (read-only)"] --> observe["bun run stolos estate observe"]
 *   observe -- "HTTPS GET" --> cf["Cloudflare"] & ms["Microsoft 365 and Azure"] & aws["AWS"] & hz["Hetzner"]
 *   observe --> file["fleets/&lt;fleet&gt;/estate/&lt;provider&gt;.ts (GENERATED)"]
 *   file --> check["estate check: posture policies (SCF)"]
 *   file --> assets["estate assets: one table"]
 * ```
 *
 * | Provider                | What Stolos reads                                                             | Posture policies                                                    |
 * | ----------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------- |
 * | Cloudflare              | accounts, zones, DNS records, Workers, Pages, R2 buckets, tunnels             | Full (strict) TLS, HTTPS only, TLS 1.2 or later, DNSSEC             |
 * | Microsoft 365 and Azure | tenant, domains, users, licenses, Global Administrators, MFA, Azure resources | MFA enforced, every member registered for MFA, 2 to 4 Global Admins |
 * | AWS                     | account, IAM users, S3 buckets, EC2 instances in every enabled region         | root MFA, no root keys, S3 blocks public access, IMDSv2             |
 * | Hetzner Cloud           | servers, volumes, firewalls, primary IPs, load balancers                      | backups, a firewall on every server, deletion protection            |
 * | Google Workspace        | users, administrators, 2-Step Verification                                    | 2-Step Verification used and enforced, 2 to 4 super administrators |
 * | Okta                    | users, administrator roles, second factors                                    | every active user has a second factor, 2 to 4 administrators       |
 * | JumpCloud               | users, administrators, second factors, devices and their disk encryption      | second factors for users and admins, 2 to 4 admins, encrypted disks |
 * | Microsoft Intune        | managed devices: serial, OS, primary user, encryption, last sync, compliance  | encrypted disks, checked in within 14 days, compliant               |
 * | Jamf Pro, Kandji        | computers: serial, OS, assigned user, FileVault, last check-in                | encrypted disks, checked in within 14 days                          |
 * | Defender for Endpoint   | machines: OS, last seen, onboarding, sensor health                            | sensors healthy, every discovered device onboarded, seen in 14 days |
 * | CrowdStrike Falcon      | hosts: serial, OS, last seen, reduced functionality mode                      | sensors fully working, seen within 14 days                          |
 * | SentinelOne             | agents: serial, OS, last active, disk encryption, agent state, threats        | encrypted disks, agents working, no unresolved threat, active       |
 * | GitHub                  | members, owners, members without 2FA, repositories and their branch rules     | 2FA required, protected and reviewed branches, secret scanning     |
 * | GitLab                  | the group's 2FA rule, members (owners, 2FA), projects and protected branches  | 2FA required, protected and reviewed branches, secret push protection |
 * | Bitbucket Cloud         | members, owners, repositories and their branch restrictions                   | protected branches, required approvals, 2 to 4 owners               |
 * | BambooHR, Rippling      | the roster only: name, work email, status, start and end dates, manager       | (the estate graph checks every account against it)                 |
 * | Gusto, Deel, Justworks  | the roster only: name, work email, status, start and end dates, manager       | every leaver has an end date (the estate graph checks the rest)     |
 * | Jira (Cloud)            | people, admin groups, 90 days of tickets (type, status, linked commits)       | changes recorded as tickets and linked to commits, 2 to 4 admins    |
 * | Linear                  | workspace SAML, people, admins, 90 days of issues and attached pull requests  | SAML sign-in, changes linked to commits, 2 to 4 admins              |
 * | Slack                   | workspace, people, owners and admins, guests, two-factor, shared channels     | every member has 2FA, 2 to 4 admins, shared channels reviewed       |
 * | 1Password               | people (active, suspended, not yet joined)                                    | everyone invited has joined (the estate graph checks coverage)      |
 * | Bitwarden               | members, owners and admins, two-step login, collections and who opens them    | two-step login required and on, 2 to 4 admins                       |
 * | Snyk                    | open issues: CVE, severity, project, package, first found                     | no critical open; none past 15 days (critical) or 30 (high)         |
 * | Tenable VM              | assets' vulnerabilities (30 days), CVEs and first seen for high and critical  | no critical open; none past 15 days (critical) or 30 (high)         |
 * | GitHub (Dependabot)     | open Dependabot alerts: CVE, severity, repository, package                    | no critical open; none past 15 days (critical) or 30 (high)         |
 * | KnowBe4                 | training enrollments: who, which module, passed or failed, when               | none past due (people/training reads the completions)               |
 * | Checkr                  | each candidate's reports: outcome and date only, never the findings           | none pending (people/screening reads the outcomes)                  |
 * | Google Cloud            | assets, the project's roles and who holds them, service account keys, sinks   | nothing public, 2 to 4 owners, no long-lived keys, logs routed      |
 * | DigitalOcean            | the team, Droplets, cloud firewalls, volumes                                  | backups, a firewall on every Droplet                                |
 * | AWS (deeper)            | CloudTrail trails, GuardDuty per region, AWS Config recorders                 | a trail logging every region, GuardDuty and Config everywhere       |
 * | Azure (deeper)          | Defender for Cloud plans, the activity log's export, per subscription         | activity log exported, a Defender plan on each subscription         |
 *
 * A laptop the probe adopted, Intune manages, and Falcon protects is one device in the estate: the
 * graph merges every source's devices by serial number, then hostname, and records which source
 * each property came from (the probe first, then the MDM, then the EDR).
 *
 * ```bash
 * bun run stolos connect github
 * ```
 *
 * `connect` shows how to make a read-only credential in the provider's console, asks for it here
 * (nothing you type is shown), keeps it in the vault, and observes once. Then:
 *
 * - `bun run stolos estate observe` reads every connected account again (daily is plenty);
 * - `bun run stolos estate check` reports the posture (`--json` for an auditor);
 * - `bun run stolos estate assets --kind dns-record` lists every DNS record and the machine it points
 *   at;
 * - `git log -p fleets/<fleet>/estate/cloudflare.ts` shows what changed, and when;
 * - `bun run stolos disconnect cloudflare` forgets the credential (revoke it in Cloudflare
 *   too).
 *
 * A part the credential may not read (Workers, say) is listed as not readable, not as a failure.
 *
 * Open vulnerabilities (Snyk, Tenable, Dependabot) are OCSF Vulnerability Findings: each open one is
 * an item of the OSCAL plan of action and milestones, with its CVE, severity, and asset. Training
 * completions (KnowBe4) and screening outcomes (Checkr) are the records the people controls read
 * beside `people/training.ts` and `people/screening.ts`. A connector Stolos does not ship can be
 * added from its own repository, pinned and locked like the engine: see
 * [the connector registry](../connect/registry-guide.ts).
 *
 * Every connector is labeled the way the industry labels it: its NIST SP 800-145 service models
 * (IaaS, PaaS, SaaS) and its market categories as the analyst firms name them (Strategic Cloud
 * Platform Services, Access Management, DevOps Platforms, Cloud HCM Suites, ...).
 *
 * ### Across systems: the estate graph
 *
 * People, accounts, machines, and repositories meet in one graph (spec 090). People come only from
 * the source of truth (the HR system; with none, the identity provider), and every other system's
 * accounts link to them by work email. Machines are deduplicated by serial number, then hostname.
 * `bun run stolos estate check` reports what no single system can say (people who left with
 * accounts still on, accounts no person owns, administrators without a second factor, people
 * without a machine), and one SQL question spans them all:
 *
 * ```bash
 * bun run stolos estate query "select connector, display_name from user_account where admin = 1 and mfa = 0"
 * bun run stolos estate diff "select uid, hostname from device" --since 2026-10-01
 * bun run stolos estate build
 * bun run stolos estate schema --docs
 * ```
 *
 * The tables follow the Universal Data Model (`person`, `party_role`, `contact_mechanism`,
 * `fixed_asset`, ...) and a property graph (`tenant`, `node`, `edge`); views carry OCSF's and
 * D3FEND's names (`user_account`, `code_repository`, `user_inventory`, `device`,
 * `compliance_finding`). First seen and last seen come from Git. `estate build` writes the graph as
 * canonical SQL (`estate.sql`, loadable into other databases) and as `estate.auto.sqlite.db`.
 *
 * ### The estate graph in osquery
 *
 * `estate build` also writes `estate.osquery.json` (spec 093): an osquery configuration that makes
 * every estate table and view an osquery table named `stolos_<name>`, through osquery's Automatic
 * Table Construction (osquery reads the SQLite file itself; no extension runs). It is generated from
 * the schema's declarations, so each table has exactly the declared columns. On your PC, where the
 * file is, osquery can join the estate with what it sees on the machine:
 *
 * ```bash
 * bun run stolos estate osquery          # write the configuration; print its path and how to load it
 * osqueryi --config_path <that path> "select uid, hostname, owner_email_addr from stolos_device"
 * ```
 *
 * ```mermaid
 * flowchart LR
 *   git["observations in Git"] --> build["bun run stolos estate build"]
 *   build --> sql["estate.sql (canonical)"] --> db["estate.auto.sqlite.db"]
 *   build --> conf["estate.osquery.json"]
 *   conf --> osq["osqueryi or osqueryd"]
 *   db --> osq --> t["stolos_device, stolos_user_account, ..."]
 * ```
 *
 * For an `osqueryd` that already has a configuration, or a fleet manager, merge the file's
 * `auto_table_construction` object into the configuration it uses (`estate osquery --print` prints
 * it). Every column is text in osquery, and each table has osquery's own `path` column.
 *
 * A system that knows people by login only (GitHub) is linked to work emails in
 * `fleets/<fleet>/estate/links.ts`: `export const links = { "github:alice": "alice@example.org" };`.
 * A machine two sources see under different names is joined there too:
 * `"device:snmp:printer": "hostname:front-printer"`.
 *
 * @module
 */
// Spec: 097-controller
// Spec: 098-pair

export {};
