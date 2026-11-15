# 087: Wave 2 connectors: endpoint and EDR, ticketing, collaboration, secrets

Epic intellectual-frontiers/stolos#7; issue intellectual-frontiers/stolos#18.

## Requirements

- **FR-001** Endpoint management and EDR: Microsoft Intune, Microsoft Defender for Endpoint, Jamf
  Pro, Kandji, CrowdStrike Falcon, and SentinelOne.
  - Each is read-only with the least-privilege read role its vendor documents.
  - Devices are `hardware_device` records: serial, hostname, OS, owner, disk encryption, last
    check-in, sensor health, and compliance.
  - Policies, per connector: disk encryption (CRY-07), check-in within 14 days (AST-04, MON-02),
    sensor healthy (END-04, MON-02), and compliance (CFG-04).
- **FR-002** Each device is counted once.
  - Devices are deduplicated by serial number, then hostname. A device with no serial joins the one
    serial-keyed machine with its hostname, never a guess between two.
  - Source precedence: Stolos's own managed and adopted machines first, then SNMP, then MDM, then
    directories, then EDR.
  - Each property records its source.
- **FR-003** Ticketing: Jira Cloud and Linear.
  - Tickets are OCSF `ticket` records, classed as change, incident, or other, with the commits and
    pull requests they link.
  - Policies (CHG-03): changes are recorded, and resolved changes link a commit or pull request.
  - Administrators: two to four (IAC-30).
- **FR-004** Slack: every member has 2FA (IAC-37), two to four owners and admins (IAC-30), and
  externally shared channels (DCH-02).
- **FR-005** Secrets: 1Password (Users API: accounts and coverage) and Bitwarden (members' two-step
  login, the organization's policy, administrators, and collections).
  - A cross-system policy (IAC-14): active people on the roster without a password manager account.
- **FR-006** Vendor limits are stated in each connector's connect steps:
  - 1Password's Users API is in preview and shows no roles or MFA.
  - Slack exposes 2FA only to admin tokens.
  - Jira shows commit and pull request counts, not SHAs.
  - Linear's GraphQL is read only through query documents.

## Success criteria

- **SC-001** `tests/connect087a.test.ts` and `tests/connect087b.test.ts` cover, per connector:
  - entities and posture;
  - a 403 as a gap;
  - a failing policy with its fix;
  - GET only (plus declared token and GraphQL query endpoints).

  They also cover the three-source device merge and the ambiguous-hostname rule.

## Later

Fields checked only against third-party documentation need a live sandbox:

- SentinelOne's disk encryption;
- Kandji's list fields;
- Linear's filters;
- Jira's development field.

OS patch state needs extra vulnerability permissions.
