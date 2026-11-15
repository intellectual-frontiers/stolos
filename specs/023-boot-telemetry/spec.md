# Feature Specification: Boot server telemetry

**Feature Branch**: `023-boot-telemetry` (committed directly to main) **Created**: 2026-11-11
**Status**: Implemented **Input**: The boot server observable with OpenTelemetry, its files kept on
the boot machine. The Windows PC itself is not observed.

## User Scenarios & Testing _(mandatory)_

1. **Given** an install, **When** it reaches Ready, **Then** `bun run stolos boot observe` shows it
   as one install with each step's duration (network boot, loading the installer, downloading
   Ubuntu, starting the installer, the installer's milestones, rebooting, each first-boot phase) and
   any step that failed.
2. **Given** otel-tui running on the PC, **Then** it shows the boot server's traces, metrics, and
   logs live.

## Requirements _(mandatory)_

- **FR-001**: `bun run stolos boot` runs with IFC TypeScript's OpenTelemetry (`runtime/otel`,
  service `archon-boot`), in-process: started once when the boot server starts, with nothing to set
  on the command line and no restart to turn it on.
- **FR-002**: `boot serve` keeps its signals in a journal in the boot cache
  (`%LOCALAPPDATA%\archon\boot`): OTLP JSON lines (OpenTelemetry's file format) in
  `telemetry/boot.otlp.jsonl`, rotated at 64 MB with three older files kept (256 MB at most), and
  its console lines as OTLP log records in `telemetry/otlp-<date>.jsonl`. Nothing leaves the PC;
  while otel-tui listens on 127.0.0.1:4318, the signals are also sent to it (best effort, silent
  where nothing listens).
- **FR-003**: Each install is a trace, an `archon.boot.install` span (its host in `host.name`) with
  an `archon.boot.step` span per step (its name in `archon.boot.step`), ended by the first boot's
  Ready (OK) or Done with problems (error); failed installer steps mark their span and the install
  as errors. Metrics: `archon.boot.installs` and `archon.boot.install.duration` by outcome,
  `archon.boot.served` bytes by file and protocol. The boot server's console lines are its
  OpenTelemetry logs.
- **FR-004**: `bun run stolos boot observe [--last 5]` summarizes recent installs from those files.

### Overrides of Ubuntu defaults

None (the boot machine is Windows or any Linux).

## Success Criteria _(mandatory)_

- **SC-001**: After an install, `boot observe` shows it with its steps; the telemetry folder stays
  under its limits.
