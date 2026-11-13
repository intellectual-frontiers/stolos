# Feature Specification: Telemetry by OpenTelemetry

**Feature Branch**: `049-telemetry` (committed directly to main) **Created**: 2026-11-13 **Status**:
In progress (v0.5.0) **Input**: Constitution Article 27. Use Deno's built-in OpenTelemetry
extensively: one list of signal names, resource attributes that say which fleet, host, engine, and
commit, traces carried across machines, security events as metrics, nothing secret. Where the
network has no other collector, the boot PC's Deno boot server is the fleet's default, ephemeral
collector. Research: [research.md](research.md).

## User Scenarios & Testing _(mandatory)_

1. **Given** any host, **When** an archon command runs, **Then** the local Collector receives a
   trace `archon <command>` with a span per phase and the run's attributes (`archon.fleet`,
   `archon.host`, `archon.engine.version`, `archon.tier`), and the metrics of
   `man 7 archon-telemetry`, under the resource `service.namespace` (fleet), `host.name`,
   `service.version` (pinned engine tag), and `vcs.ref.head.revision` (commit).
2. **Given** `archon fleet status` or `archon fleet query` on the boot machine, **Then** each
   server's command continues the caller's trace (the MCP call carries `_meta.traceparent`).
3. **Given** a refused update (unsigned, untrusted, rollback), a refused query or MCP call, an
   emergency trust, or a typed `--confirm-destroy`, **Then** it is counted under the security
   metrics.
4. **Given** a network with no `fleet.telemetry.collector` and no `otel.localdomain`, **When** the
   boot server runs, **Then** servers find it (`archon observe discover`) and forward their
   telemetry to `http://<boot PC>:<http port>/otlp` as OTLP JSON; it keeps it a week (512 MB at
   most) and hands it to otel-tui when that runs.

## Requirements _(mandatory)_

- **FR-001** `src/archon/telemetry/signals.ts` declares every metric (kind, unit, group: health,
  security, state; description; attributes), span, attribute, and resource attribute. `count()` and
  `measure()` accept only declared metric names (TypeScript). `man 7 archon-telemetry` is rendered
  from it.
- **FR-002** A run's span is the child of `TRACEPARENT` when set (W3C, parsed strictly).
  `archon mcp` passes a call's `_meta.traceparent` to the command it runs; the MCP client
  (`fleet status`, `fleet query`) sends the current one; sudo preserves it.
- **FR-003** The host launcher sets `OTEL_RESOURCE_ATTRIBUTES` from `/etc/archon/fleet`,
  `/etc/archon/host`, the `@stolos` tag in `/srv/archon/deno.json`, and the checkout's commit.
- **FR-004** Metrics: `archon.run.duration`, `archon.run.problems`, `archon.verify.checks`,
  `archon.apply.changes` (health); `archon.update.outcome`, `archon.query.requests`,
  `archon.mcp.calls`, `archon.signers.trusted`, `archon.confirm_destroy.used` (security);
  `archon.state.writes`, `archon.engine.info` (state). Spans `archon.query` and `archon.remote`.
- **FR-005** Every attribute value passes the same redaction as mail (Article 13).
- **FR-006** The boot server answers OTLP/HTTP JSON (gzip or not) at
  `/otlp/v1/{traces,metrics,logs}` on its HTTP port, keeps daily files under its boot cache
  (`telemetry/fleet/`), 7 days and 512 MB at most, and forwards to otel-tui on the PC. Host
  discovery tries it last (`source: boot`), and the Collector's exporter then sends JSON.
- **FR-007** Silent and harmless with no collector: the API loads only with `OTEL_DENO`.
- **FR-008** Events are structured at their source (`src/archon/telemetry/events.ts`: a declared
  name, severity, host, client address, attributes, message) and recorded as OpenTelemetry log
  records (attribute `archon.event`). The boot server records each one in its OTLP files (and hands
  it to otel-tui); its window and `boot.log` are renderings of the record: icons and tone come from
  the event's name, severity, and attributes (which boot file), never from parsing text. Debug
  events (GRUB's harmless probes) are recorded but kept out of the window unless verbose. This PC's
  commands announce events (`boot.armed`, `boot.reboot`, `boot.certificate`), never free text.

- **FR-009** An install is one trace: the boot server opens it when the host is armed
  (`boot.armed`), hands its traceparent and the boot server's collector to the host
  (`/etc/archon/first-boot.env`), and the first boot's `archon` run continues it there.
- **FR-010** An `archon` run's phases and problems are events (`archon.phase`, `archon.problem`),
  each an OTLP log record in the run's trace, sent to the collector when the run ends (best effort,
  3 seconds at most). The terminal and the run log print the same facts.

## Open

- The install as one trace from `boot arm` to the end of the first boot (the boot server's trace
  context through the install token).
- The archon command's own output as a rendering of events too (today its phases are spans, and its
  lines go to the journal and the run log), with Archon's own OTLP log exporter.
- The boot window rendering events that servers send to the fleet collector (first boot reporting as
  OTLP logs instead of its progress webhook).

## Success Criteria

- **SC-003** The e2e lab checks that the host's first boot continued the boot server's install trace
  (`tests/e2e/trace.ts`); `tests/telemetry_test.ts` checks a run's phases arrive as log records in
  its trace.
- **SC-002** `tests/pretty_test.ts`: the window renders events (tone, columns, debug, repeats), the
  same line from an OTLP log record as from the event, and the boot server accepts only declared
  events from this PC.
- **SC-001** `tests/telemetry_test.ts`: the list and the man page agree; traceparent and redaction;
  a real run exports a trace continuing a given parent, its phases, and its metrics; the boot server
  keeps OTLP JSON (and gzip) and refuses anything else; discovery falls back to the boot server with
  JSON encoding.
