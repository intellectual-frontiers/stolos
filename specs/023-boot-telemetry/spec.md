# Feature Specification: Boot server telemetry

**Feature Branch**: `023-boot-telemetry` (committed directly to main) **Created**: 2026-11-11
**Status**: Implemented **Input**: The boot server observable with OpenTelemetry, its files kept on
the boot machine. The Windows PC itself is not observed.

## User Scenarios & Testing _(mandatory)_

1. **Given** an install, **When** it reaches Ready, **Then** `deno task boot observe` shows it as
   one install with each step's duration (network boot, loading the installer, downloading Ubuntu,
   starting the installer, the installer's milestones, rebooting, each first-boot phase) and any
   step that failed.
2. **Given** otel-tui running on the PC, **Then** it shows the boot server's traces, metrics, and
   logs live.

## Requirements _(mandatory)_

- **FR-001**: `deno task boot` runs with Deno's built-in OpenTelemetry (`OTEL_DENO=true`, service
  `archon-boot`, OTLP/JSON to `http://127.0.0.1:4319`), set in `src/archon-boot/otel.env` and loaded
  with `--env-file` so the task line stays short.
- **FR-002**: `boot serve` receives that OTLP itself on 127.0.0.1:4319 and writes each batch as one
  OTLP JSON line (OpenTelemetry's file format) to `telemetry/otlp-<date>.jsonl` in the boot cache
  (`%LOCALAPPDATA%\archon\boot`), keeping 30 days and 256 MB at most. Nothing leaves the PC; while
  otel-tui listens on 127.0.0.1:4318, each batch is also handed to it (best effort, retried after 30
  seconds).
- **FR-003**: Each install is a trace `install <host>` with a span per step, ended by the first
  boot's Ready (OK) or Done with problems (error); failed installer steps mark their span and the
  install as errors. Metrics: `archon.boot.installs` and `archon.boot.install.duration` by outcome,
  `archon.boot.served` bytes by file and protocol. The boot server's console lines are its
  OpenTelemetry logs.
- **FR-004**: `deno task boot observe [--last 5]` summarizes recent installs from those files.

### Overrides of Ubuntu defaults

None (the boot machine is Windows or any Linux).

## Success Criteria _(mandatory)_

- **SC-001**: After an install, `boot observe` shows it with its steps; the telemetry folder stays
  under its limits.
