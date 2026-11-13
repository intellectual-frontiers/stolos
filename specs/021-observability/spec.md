# Feature Specification: Local observability, OpenTelemetry as the protocol

**Feature Branch**: `021-observability` (committed directly to main) **Created**: 2026-11-11
**Status**: Implemented **Input**: Make every server and workstation observable. OpenTelemetry
(OTLP) is the protocol end to end; each piece is the operating system's own where it has one, as
long as it speaks OpenTelemetry or a format the OpenTelemetry Collector officially reads. Every
local store is ephemeral, so performance and disk space are not impacted. No central collector yet.

## User Scenarios & Testing _(mandatory)_

### User Story 1: See what a machine is doing (Priority: P1)

**Acceptance Scenarios**:

1. **Given** a host or workstation, **When** the owner runs `archon observe`, **Then** it shows logs
   (journald), metrics (PCP), and Archon's own OpenTelemetry, each with its size, how far back it
   goes, and its limits.
2. **When** the owner runs `btop`, **Then** live system load shows; **when** `archon observe tui`,
   **Then** otel-tui shows PCP's core metrics live and Archon's recent traces, metrics, and logs.
3. **Given** the disk runs low, **Then** the local stores give way first: journald keeps 15% free by
   itself, and `archon observe prune` removes PCP's oldest archives below the free-space floor.

## Requirements _(mandatory)_

| Data    | Collected and stored (natively)        | Speaks OpenTelemetry through                                                                                          | Kept, at most                                                                  |
| ------- | -------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Metrics | PCP: pmcd, pmlogger (Ubuntu's package) | pmproxy's OpenMetrics endpoint (127.0.0.1:44322, `/metrics?names=...`), read by the Collector's `prometheus` receiver | `metricsDays` (365) and `metricsMaxSize` (2G)                                  |
| Logs    | journald                               | the Collector's `journald` receiver                                                                                   | `logsRetention` (3month) and `logsMaxSize` (1G), and journald's 15% free floor |
| Archon  | Deno's built-in OpenTelemetry          | OTLP to the local Collector (127.0.0.1:4318), written as OTLP JSON lines to `/var/cache/archon-otel/archon.jsonl`     | `tracesDays` (7) and 64 MB                                                     |

- **FR-001**: `ObservabilityDef` (fleet, overridden per host) sets the limits above and
  `minFreePercent` (15). They are upper bounds, never promises.
- **FR-002**: journald: `/etc/systemd/journald.conf.d/50-archon.conf` (`Storage=persistent`,
  `MaxRetentionSec`, `SystemMaxUse`).
- **FR-003**: PCP: the `pcp` package, `pmcd`, `pmlogger`, `pmproxy` enabled;
  `/etc/default/pmlogger_timers` sets `pmlogger_daily -k <metricsDays>` (Ubuntu's default is 14
  days); `/etc/pcp/pmproxy/pmproxy.options` keeps Ubuntu's `-A` and adds `-i 127.0.0.1`.
- **FR-004**: The OpenTelemetry Collector (contrib, the official release archive, SHA-256 verified,
  spec 010) runs as `archon-otelcol.service`: dynamic user, niced, idle I/O, 256 MB memory cap, 25%
  CPU cap, OTLP on 127.0.0.1 only, resource attributes from the model (`host.name`,
  `service.namespace` = the fleet, `archon.host.kind`), one rotated file exporter (4 files of 16 MB,
  `tracesDays`). It starts once the tools sync installed it (`ConditionPathExists`), and the tools
  sync restarts it after upgrades.
- **FR-005**: `archon` reports itself through Deno's built-in OpenTelemetry (the launcher sets
  `OTEL_DENO`, `OTEL_SERVICE_NAME=archon`, OTLP/JSON to the local Collector): each command is a
  trace with a span per phase; metrics `archon.run.duration`, `archon.run.problems`,
  `archon.verify.checks`, `archon.apply.changes`. Silent and harmless when the Collector is not
  running; the OpenTelemetry API is loaded only when enabled, and a failure to load it changes
  nothing.
- **FR-006**: `archon observe` (read-only summary), `archon observe tui` (otel-tui on 127.0.0.1,
  PCP's core metrics through pmproxy, Archon's OTLP file), `archon observe prune` (PCP archives over
  `metricsMaxSize` or below `minFreePercent` free, oldest first, never the one being written; daily
  timer `archon-observe-prune`).
- **FR-007**: Tools (spec 010): btop (Ubuntu) and otel-tui (official release) on every server and
  workstation; the Collector likewise.
- **FR-008**: Nothing here is backed up (spec 016's paths exclude `/var/log/pcp`,
  `/var/log/journal`, `/var/cache/archon-otel`), and nothing listens beyond 127.0.0.1 except what
  Ubuntu's PCP does by default (pmcd), which the firewall (spec 008) closes on servers.
- **FR-009**: Workstations (spec 020) get the same, except what needs a server.
- **FR-010**: OpenTelemetry endpoints come from the model as DNS names (spec 024), never from
  `_otlp-*._tcp` discovery (constitution Article 20).

### Overrides of Ubuntu defaults

- journald: persistent, with Archon's retention and size limits (Ubuntu: up to 10% of the disk, 4G).
- PCP: archives kept up to `metricsDays` (Ubuntu: 14 days), pmproxy bound to 127.0.0.1 (Ubuntu: all
  interfaces).

## Success Criteria _(mandatory)_

- **SC-001**: `archon verify` passes with pmcd, pmlogger, pmproxy, and the Collector active.
- **SC-002**: The local stores together stay within their limits (by default about 3 GB) and shrink
  first when the disk runs low.
