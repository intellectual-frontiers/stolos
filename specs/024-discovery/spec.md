# Feature Specification: Finding a central collector

**Feature Branch**: `024-discovery` (committed directly to main) **Created**: 2026-11-11 **Status**:
Implemented **Input**: A central OpenTelemetry collector will run later, on the boot machine or a
container host. Until then everything stays local (spec 021); once one exists anywhere on the LAN,
every server and workstation should find it and forward to it with no change to the model.

## User Scenarios & Testing _(mandatory)_

1. **Given** no central collector, **Then** `archon observe` says "local only" and nothing is sent
   anywhere.
2. **Given** a collector that answers OTLP at the model's address or as `otel.localdomain` in the
   router's DNS, **When** discovery next runs (every 15 minutes), **Then** the machine forwards
   journald, PCP's metrics, and Archon's own telemetry to it, and `archon observe` names it and how
   it was found.
3. **Given** the collector goes away, **Then** forwarding queues on disk, bounded, and stops when
   discovery no longer finds it.

## Requirements _(mandatory)_

- **FR-001**: `fleet.telemetry`: `collector` (an OTLP/HTTP URL, by a host name or address), `name` (default
  `otel.localdomain`, a UniFi Local DNS record).
- **FR-002**: `archon observe discover` (timer `archon-observe-discover`, every 15 minutes) tries,
  in order: `telemetry.collector`; `http://<name>:4318` when the name resolves over unicast DNS
  (`getent ahostsv4`). A candidate counts only if an empty OTLP export to `/v1/logs` succeeds. Never
  mDNS or DNS-SD (constitution Article 20): to make a collector findable, add a UniFi Local DNS
  record (for example `otel.localdomain`) or put its address in the model.
- **FR-003**: The result goes into `/etc/archon/otelcol/central.yaml`, which the Collector merges
  after its base config (`--config` twice; `{}` until something is found, created at start if
  missing). With a collector: receivers `journald` and `prometheus/pcp` (pmproxy, the core PCP
  metrics, every 60 seconds), exporter `otlphttp/central` with a disk-backed queue (`file_storage`
  in `/var/lib/archon-otel`, 2000 batches at most), and pipelines `logs/central`, `metrics/pcp`,
  `metrics/central`, `traces/central`. The local pipelines and files of spec 021 are unchanged. The
  Collector restarts only when the file changes.
- **FR-004**: PCP's metrics are forwarded under their own names with a `pcp.` prefix
  (`metricstransform`). Mapping them to OpenTelemetry's `system.*` semantic conventions (units
  included) waits for the central collector's dashboards.
- **FR-005**: Superseded 2026-11-11 (Article 20): no mDNS browsing, no Avahi, no UDP 5353. Hosts
  that had them get avahi masked (spec 001 FR-006) and the port closed (spec 008 FR-005) at their
  next reconcile.
- **FR-006**: `archon observe` shows what discovery last found
  (`/var/lib/archon/status/otel-central.json`).

### Overrides of Ubuntu defaults

None.

## Success Criteria _(mandatory)_

- **SC-001**: With a collector reachable as `otel.localdomain`, every server and workstation
  forwards to it within 15 minutes, with no change to the model.
