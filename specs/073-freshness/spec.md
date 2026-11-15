# 073: Evidence freshness as a control

Issue intellectual-frontiers/stolos#10.

## Why

Evidence is only as good as its last observation. A disk that was encrypted a month ago, or a server
that matched its model last week, says little about today. Continuous monitoring asks that each
source is observed on a schedule and that missing the schedule is itself a finding. FedRAMP 20x's
persistent validation expects machine-based validation every 3 to 7 days; Stolos observes more often
than that, and treats stale evidence as failing.

## Requirements

- **FR-001** Cadences are typed data (`src/archon/compliance/freshness.ts`): per source of evidence,
  how often it is observed (`every`) and its service level (`staleAfter`, how late an observation
  may be). Defaults: managed servers verify every 15 minutes (the reconcile timer); adopted
  machines, SNMP devices, and connected accounts daily. The service level defaults to twice the
  cadence and is never more than 7 days (FedRAMP 20x's longest validation interval); a longer one is
  capped and marked so.
- **FR-002** A connector may declare its own cadence (`Connector.cadence`, also through
  `defineConnector`). A fleet overrides any of them in `fleet.ts`, `compliance.cadence`: per source
  (`managed`, `adopted`, `device`, `cloud`) and per connector id (`connectors.<id>`, which wins over
  the connector's own; `cloud` applies to connectors without their own).
- **FR-003** Every piece of evidence carries `observedAt` when its source knows it: a managed
  machine's last pull (its reconcile run, which verifies; else its install), an adopted machine's or
  device's observation, a connector's observation. The repository's checks and the estate graph are
  read live from Git and carry none.
- **FR-004** Evidence older than its service level is stale: it becomes a failing check of its own
  controls and of SCF MON-02 (Continuous Monitoring), keeps what it said (`stale.was`), says its age
  and service level in its detail, and its fix is the command that observes its source again
  (`stolos fleet status`, `host observe <name>`, `device observe <name>`, `estate observe <id>`).
  Evidence without a result (`unknown`) is never stale.
- **FR-005** The compliance view gives each control its evidence's age: newest and oldest
  observation, their ages, and how many are stale. `stolos compliance` prints them per control and
  lists the stale sources once each, with their fix; `--json` includes the ages, the time they were
  measured (`asOf`), and the cadences in force. The Compliance tab shows each control's age, a stale
  pill, and an Observed column per piece of evidence. The OSCAL exports use the same view.
- **FR-006** `stolos compliance drift [--since <date|commit>] [--notify]` compares each control's
  status now (the working tree) with its status at a past commit (a commit, or the last commit
  before a date; default "1 day ago"), from the observations in Git (adopted machines, devices,
  connected accounts), each side held to the cadences as of its own time. It lists the controls
  whose status changed, worse first, with the evidence that changed under them. With `--notify` it
  mails a summary to the fleet's mailbox (`fleet.mail.to`) through the notify path (redacted,
  deduplicated within an hour): control ids, subjects, checks, and statuses only, never what a check
  found. It runs on a schedule with the PC's own scheduler (the compliance guide shows cron and Task
  Scheduler lines). Terminal only (`noMcp`).

## Decisions

- The issue's starter id MON-01 is not the SCF 2026.3 id for Continuous Monitoring; that is MON-02,
  already in `scf.ts`.
- Managed verifies are in this PC's state, not in Git, so drift does not compare them; their
  freshness still counts in `stolos compliance` and the consoles.
- The server's own Archon Console holds its verify evidence to the managed cadence too.
- The existing "observed in the last 7 days" policies stay as they are; freshness applies over every
  source uniformly, on top of them.

## Success criteria

- **SC-001** `tests/freshness073.test.ts`: cadence defaults, a connector's own and the fleet's
  overrides, the 7-day cap; stale evidence fails its controls and MON-02 with the refresh command;
  each control's newest and oldest age; the drift comparison over a real Git repository; and the
  notify body carries no detail and no secret.
