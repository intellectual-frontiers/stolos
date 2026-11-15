# 088: Wave 3 connectors and the connector registry

Epic intellectual-frontiers/stolos#7; issue intellectual-frontiers/stolos#23.

## Why

Vulnerability findings, awareness training, background screening, and more clouds are evidence every
framework asks for, and no single connector list can cover every vendor a company uses. A fleet
should be able to add a connector Stolos does not ship, written in TypeScript by anyone, with the
same guarantees as the engine itself: pinned, locked, checked, and approved by a signed commit.

## Requirements

- **FR-001** The connector registry (`src/archon/connect/registry.ts`, `registry-contract.ts`,
  `registry-probe.ts`, `registry-commands.ts`):
  - a registry connector is a TypeScript module that default-exports a `defineConnector` result and
    exports `engine` (the engine versions it supports, a range) and `fixtures` (its recorded-fixture
    tests, `ConnectorFixture`);
  - `stolos connector add <source>@<ref>` resolves `https://github.com/<owner>/<repo>[/<path>]` to
    `raw.githubusercontent.com/<owner>/<repo>/<ref>/<path>` (default `mod.ts`); the ref is a version
    tag or a full commit SHA (a branch is refused);
  - it fetches the module, takes its SHA-256, and loads it in a process of its own (the probe,
    `registry-probe.ts`, under the runtime running Stolos), given only the environment variables the
    engine reads for its paths and no standard input, so none of the operator's secrets; the module
    resolves the engine the fleet installs. The probe reads its declaration and runs its fixtures.
    Bun and Node give that process no permission sandbox: the connector's code is read before it is
    approved, as the engine's is;
  - it refuses, changing nothing, a module that is not made with `defineConnector`, an id an engine
    or another added connector has, a label that breaks the naming rules or redeclares a built-in
    one, an SCF id not in `scf.ts`, a credential without a secret field, connect steps that do not
    say how to make a read-only credential, a missing or unsuitable engine range, an unknown market
    or OCSF class, and missing or failing fixtures;
  - it copies the module, byte for byte as checked, into the fleet repository
    (`fleets/<fleet>/connectors/<id>.ts`), checks the copy hashes as checked, and writes
    `fleets/<fleet>/connectors.ts` (the import of the copy and Stolos's lock entry: the source, the
    pinned URL, the module's SHA-256, its engine range, the engine that checked it, its fixture
    count); the person commits both, signed;
  - `stolos connector list | remove | test`: `test` probes each added connector's copy again (its
    hash against the lock, the pinned URL's hash, its engine range, its fixtures), or a module given
    by path or URL (an author's own check);
  - the engine loads the added connectors beside `CONNECTORS` (`allConnectors()`: connect, observe,
    check, assets, disconnect, the console, freshness, drift, impact), leaving out, with a warning,
    one whose copy no longer hashes as `connectors.ts` locks it, one that does not load, does not
    suit this engine, or takes an engine id;
  - `stolos fleet upgrade` refuses an engine version an added connector does not support;
  - an index anyone can host is a JSON file (`stolos-connector-index/1`);
    `connector add <id>@<tag> --index <url>` finds the source in it. Stolos runs no central server;
  - the author's contract and a template with a fixture test: `examples/connector-template/`, and
    the guide `connectors` (`src/archon/connect/registry-guide.ts`).
- **FR-002** Vulnerability scanners (`src/archon/connect/vulnerability.ts`):
  - findings are records labeled `vulnerability` (OCSF's object) and emitted as OCSF Vulnerability
    Finding (2002): CVE, title, severity, status, asset, package, first seen, fix available, and the
    scanner's URL;
  - policies `<id>-vuln-overdue` (VPM-07, VPM-06: no critical open past 15 days or high past 30,
    CISA BOD 19-02's timelines) and `<id>-vuln-critical` (VPM-06, a warning);
  - the OSCAL POA&M carries each open vulnerability as an open risk and POA&M item with its CVE,
    severity, asset, and source; `stolos compliance export` reads them from the observations;
  - the OCSF export emits each vulnerability node as a Vulnerability Finding (a CVE, or the
    scanner's own finding as an advisory);
  - Snyk (REST API `2024-10-15`: `/orgs/{org}/issues?status=open`, projects for names; a service
    account token with a view-only role);
  - Tenable Vulnerability Management (workbenches: assets with findings in 30 days, each asset's
    findings, the CVEs and first seen of high and critical ones; a Basic, read-only user's API
    keys);
  - GitHub: open Dependabot alerts (`/orgs/{org}/dependabot/alerts`), which the token's read-only
    Dependabot alerts permission already allows; a denial is a gap. Its other outputs are unchanged
    (the existing fixtures are given an empty alert list).
- **FR-003** Training and screening fill spec 077's `person_record` hook:
  - KnowBe4 (Reporting API, read-only key): passed and failed enrollments are training records; past
    due and unfinished ones are counted (`kb4-past-due`, SAT-04);
  - Checkr: completed reports' outcomes and dates only (clear, or not clear), never their findings;
    pending ones counted (`checkr-pending`, HRS-05). Checkr's keys are not scoped: the guard sends
    only GET, and the connect steps say so.
- **FR-004** More clouds:
  - Google Cloud (`gcp`): a service account with Cloud Asset Viewer, Security Reviewer, and Logs
    Viewer, signing in with `cloud-platform.read-only`; assets, the project's roles and any public
    binding, service account keys (Stolos's own not counted), and log sinks. Policies `gcp-public`
    (DCH-02), `gcp-owners` (IAC-30), `gcp-sa-keys` (IAC-10), `gcp-log-sink` (MON-03, MON-13);
  - DigitalOcean: a Read-scope token; the team, Droplets, cloud firewalls (by Droplet or tag),
    volumes. Policies `do-backups` (BCD-24), `do-firewall` (NET-02);
  - AWS, deeper: CloudTrail trails and status, GuardDuty detectors per region, AWS Config recorders
    per region. CloudTrail and Config are JSON APIs read with POST: the SDK's guard takes a
    `readPost` predicate, and AWS's lets through only their Describe, Get, and List actions.
    Policies `aws-cloudtrail` (MON-03), `aws-cloudtrail-all-regions` (MON-05, MON-03),
    `aws-guardduty` (MON-16), `aws-config` (CFG-02), each reported only when read, so an account
    observed before reads the same;
  - Azure, deeper: Defender for Cloud plans and the activity log's diagnostic settings, per
    subscription, with the same Reader role. Policies `az-activity-log` (MON-03, MON-13) and
    `az-defender` (MON-16), reported only when read.
- **FR-005** New labels (D3FEND and OCSF terms): `vulnerability`, `event_log`,
  `intrusion_detection_system`, `configuration_management_database`; `person_record` joins the
  connector labels; `cloud_user_account` gains `access_keys`. `schemaProblems(CONNECTOR_LABELS)`
  stays empty.
- **FR-006** SCF ids added, each confirmed in SCF 2026.3: VPM-06, VPM-07, MON-03, MON-05, MON-13,
  MON-16, CFG-02.
- **FR-007** Registered in `CONNECTORS`, every connector-id choice list in `registry.ts`, the
  provider table in `src/archon/adopt/mod.ts`, and `tests/connect084.test.ts`.

## Success criteria

- **SC-001** `tests/connect088.test.ts`: per connector, records and posture, a 403 as a gap, a
  failing policy with its fix, and reads only (GET, the token endpoint, and AWS's read actions);
  KnowBe4's and Checkr's records drive the 077 training and screening controls; open vulnerabilities
  validate as an OSCAL 1.2.3 POA&M and as OCSF 1.9.0 Vulnerability Findings.
- **SC-002** `tests/registry088.test.ts`: pins and ranges; the index; every declaration check; a
  local "GitHub" serving the template, where `connector add` writes the copy as checked, the import,
  and the entry with the module's SHA-256, and refuses a clashing id, a bad label, a made-up SCF id,
  failing fixtures, a branch, and a second source for the same id; `connector list` and `test`; the
  engine loads the added connector while its copy hashes as locked, and leaves it out once the copy
  changes; `connector remove`.
- **SC-003** Existing tests pass, with the GitHub fixture given an empty Dependabot alert list and
  the AWS fixture's read check allowing CloudTrail's and Config's read actions.

## Later

- Code scanning alerts (GitHub's token needs one more permission: Code scanning alerts, Read).
- Running an added connector's observation in its own restricted process (it runs in Stolos's
  process today, trusted like the engine once pinned, locked, and approved).
- Offering added connectors in the console's connector choice lists (the command line takes them).
- Fields checked only against vendors' documentation need a live account: Snyk's issue coordinates,
  Tenable's per-asset plugin info, Checkr's report assessment, KnowBe4's statuses.
