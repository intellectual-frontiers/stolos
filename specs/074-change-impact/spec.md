# 074: Compliance impact at the point of change

Issue intellectual-frontiers/stolos#11.

## Why

`stolos compliance` and `compliance drift` say what a fleet's controls look like, and what changed
after the fact. A person making a change, and a reviewer reading a pull request, need it before:
which controls this change weakens, with the framework requirements behind them, for example "turns
off unattended upgrades: VPM-08, HIPAA 164.308(a)(5)(ii)(B)". A fleet may also want such a change
refused unless someone accepted the risk or approved it.

## Requirements

- **FR-001** Stolos declares, as typed data next to its capabilities' model
  (`src/archon/compliance/impact.ts`, `IMPLEMENTATIONS`), which SCF control each model setting
  implements and which direction weakens it. Each declaration names an SCF id of `scf.ts` (a wrong
  id fails type checking), the setting in words, and a pure comparison of two sides' facts. The
  declarations:

  | Declaration      | Setting                                                 | SCF    | Weakens it                                                 |
  | ---------------- | ------------------------------------------------------- | ------ | ---------------------------------------------------------- |
  | `updates`        | unattended-upgrades, apt-daily-upgrade.timer (009)      | VPM-08 | turned off                                                 |
  | `ssh-passwords`  | `fleet.ssh.passwordFrom`, sshd's drop-in (007)          | IAC-14 | passwords from more networks, or sshd no longer configured |
  | `firewall`       | ufw installed and enabled (008)                         | NET-02 | turned off                                                 |
  | `firewall-ports` | every capability's ports (008)                          | NET-02 | a port opened                                              |
  | `backup`         | the daily backup timer (016)                            | BCD-24 | the host removed from backups                              |
  | `backup-scope`   | `host.backup` paths and keep, durable guests (016, 044) | BCD-24 | less held, fewer archives kept                             |
  | `osquery`        | osquery (042)                                           | MON-02 | removed                                                    |
  | `etckeeper`      | etckeeper (033)                                         | CHG-03 | removed                                                    |
  | `admins`         | `host.users[].admin` (006)                              | IAC-30 | more administrators                                        |
  | `agent-tier`     | `fleet.mcp.maxTier` (030)                               | IAC-30 | a higher tier                                              |
  | `cadence`        | `fleet.compliance.cadence` (073)                        | MON-02 | observed less often, or stale later                        |

  The reverse direction strengthens the control. Each declaration is tested.
- **FR-002** Impact analysis: given the fleet at a base commit and at a head commit (or the working
  tree), each side's model is loaded (its `fleet.ts` and `host.ts`, as build does; a commit is read
  into a temporary folder without touching the checkout), every host's plan resolved and reduced to
  facts, and the declarations compared over every host on both sides and over the fleet. Hosts added
  or removed are listed, not compared. The base is the merge base of `--base` and the head.
- **FR-003** Evidence: the observations Git records (adopted machines, devices, connected accounts)
  and the fleet's control packs (spec 078) are read on both sides as `compliance drift` reads them,
  and the controls whose status changed are listed with the evidence under them.
- **FR-004** Each affected control is listed with its SCF name and, when the SCF catalog is cached,
  the framework requirements the SCF Council's STRM maps it to (SOC 2 by criterion). Without the
  catalog, the output says so. Requirement ids come only from the catalog.
- **FR-005** `stolos compliance impact [--base <rev>] [--head <rev>] [--json|--markdown]` prints it;
  the base defaults to the fleet's branch on GitHub (`origin/<branch>`, else `HEAD`), the head to
  the working tree. It exits 1 when the gate blocks, 2 when the impact cannot be computed. Terminal
  only (`noMcp`).
- **FR-006** `stolos apply` shows a "Compliance impact" phase after "Changes" and before the commit,
  comparing the working tree with GitHub's branch: weakenings as warnings, strengthenings as passes,
  the requirements as notes. When the gate blocks, nothing is committed. `--approve <keys>` writes
  the approval trailer into the commit it signs.
- **FR-007** The gate: `compliance.gate` in `fleet.ts`:
  `{ block?: "weakens" | "never"; allow?:
  string[]; evidence?: boolean }`, default `never` (show
  only). With `block: "weakens"`, a change that weakens a control is refused unless (a) `allow`
  names it, (b) an accepted risk in `fleets/<fleet>/controls/accepted.ts` covers it
  (`policy: "impact/<key>"`, until a date), or (c) an approval is recorded. A weakening's keys are
  its declaration (`updates`), the declaration on its subject (`updates/beta`), and its SCF id
  (`VPM-08`). With `evidence: true`, observed evidence that turns a control to fail is judged the
  same way; evidence an adopted machine's own accepted list covers is accepted, not failing.
- **FR-008** An approval is a commit in the change (`base..head`) whose message carries the trailer
  `Compliance-Approved: <keys>` (comma or space separated, or `all`) and a good SSH signature by one
  of the signers in `signers.ts` **at the base**, checked as servers check a tip
  (`git verify-commit` with an allowed-signers file). A trailer on a commit not so signed is not
  counted, and is listed as such.
- **FR-009** The gate's configuration is read from the base side, so a change cannot turn off the
  gate that judges it (when the base's model cannot be read, the head's is used, and that is
  listed).
- **FR-010** A fleet repository carries `.github/workflows/compliance-impact.yml`, written by
  `stolos fleet init` (scaffold) and again by `stolos fleet upgrade` when its text differs. On
  `pull_request` it checks out the head (full history, without keeping credentials), installs the
  engine `bun.lock` holds (`bun install --frozen-lockfile`), downloads the SCF catalog, runs
  `stolos compliance impact --base <PR base> --head <PR head> --markdown` for each fleet, writes it
  to the run's summary, posts one comment (found again by a marker and updated) when a control is
  affected or a comment exists already, and fails the check when the gate blocks. It uses only
  GitHub's `GITHUB_TOKEN` (`contents: read`, `pull-requests: write`, given only to the commenting
  step through `gh api`) and two actions pinned to commits: `actions/checkout` and
  `oven-sh/setup-bun` (the Bun the engine pins). Values from the event reach shell steps only
  through the environment.
- **FR-011** The guide: a section in the compliance guide (`src/archon/compliance/mod.ts`) with a
  Mermaid diagram.

## Decisions

- The issue's starter id VPM-05 is not SCF's patching control; patching is VPM-08, in `scf.ts`.
  Every declaration cites only ids in `scf.ts`.
- Model facts come from each host's resolved plan, not from `host.ts` text: capabilities are
  functions, and the plan is what a server applies.
- The model is loaded in this process for both sides, with the head's engine (a commit's `fleets/`
  is copied to a temporary folder and imported from there). Fleet files that import files outside
  `fleets/` are not supported at a past commit.
- The gate judges model weakenings by default; evidence changes are shown, and judged only with
  `gate.evidence: true`, because committing an observation records the truth and should not be
  stopped by default.
- Accepted risks are read from the head (a change may record its own accepted risk, visible in its
  diff, with who, why, and until when); approvals must be signed by a base signer. Configuration
  (`gate`) comes from the base.
- Approval as a signed commit trailer, rather than a file of approvals: the signature is the
  verifiable part, it is checked exactly as servers check a tip, and `stolos apply` can write it in
  the one commit it signs.
- A new host is listed as added, not compared against a baseline.
- The existing workflows pin actions by major tag; this workflow pins by commit, with the tag in a
  comment, because it runs with a token that can write.
- A pull request from a fork gets a read-only token: the comment step warns and the impact is in the
  run's summary.

## Success criteria

- A pull request that weakens a control gets a comment naming the control (with its SCF name, and
  its framework requirements when the catalog is cached).
- `compliance.gate` in `fleet.ts` configures the gate; with `block: "weakens"`, the check fails and
  `stolos apply` commits nothing unless an accepted risk or a signed approval covers the weakening.
- `tests/impact074.test.ts`: each declaration (weakens, strengthens, only it fires), the comment's
  text, the gate (blocks, allows with an accepted risk, with an approval, with `allow`), a fleet
  repository end to end (CLI, signed approval), and the workflow's content (pinned actions,
  permissions, the token's scope).
