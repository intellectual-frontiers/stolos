# Feature Specification: Ops reports

**Feature Branch**: `013-ops` (committed directly to main) **Created**: 2026-11-10 **Status**:
Implemented **Input**: Each server writes and mails a deterministic daily health report. No agent
runs on a server (spec 030, constitution Article 17).

## Requirements _(mandatory)_

- **FR-001**: `archon report daily` (timer, 06:23) writes failed units, disk, pending upgrades,
  archon timers, drift, and the latest tools report to `/var/lib/archon/reports/daily-<date>.md`. No
  AI summary: the report is facts only (Article 17).
- **FR-002**: The daily report is also the host's daily email (spec 025): "[Archon] <host>: daily
  report <date>", with the report attached, once per day.
- **FR-003**: Reports are MCP resources (`archon://reports/<file>`), so a workstation agent can read
  and summarize them over `archon mcp` (spec 030).

### Overrides of Ubuntu defaults

None.
