# Feature Specification: The telemetry web UI (OpenObserve), opt-in on any server

> **Revised by spec 064:** the machine restricts no network; who reaches this service is the
> router's decision. Statements below about the local networks only no longer hold.

**Feature Branch**: `050-telemetry-ui` (committed directly to main) **Created**: 2026-11-13
**Status**: Implemented **Input**: Keep the official OpenTelemetry Collector as it is (headless, on
every server). Add a web UI as an opt-in on any server: OpenObserve (one container; logs, metrics,
and traces; OTLP in). Forward only from the moment a collector exists; nothing is replayed. The boot
PC is optional: discovered and used when its boot server runs, and when it does not, servers say so
and say how to start it. Research: OpenObserve, Jaeger v2, Grafana LGTM, SigNoz, HyperDX, Uptrace,
and otel-tui were compared (OpenObserve: the only one that is a single node with all three signals
and light enough for an opt-in).

## User Scenarios & Testing _(mandatory)_

1. **Given** a fleet where nothing is turned on, **Then** every server's Collector is as before:
   OTLP on 127.0.0.1, journald and PCP, local ephemeral files; nothing leaves the server.
2. **Given** a server, **When** an operator runs `sudo archon otel ui on --ephemeral`, **Then**
   OpenObserve (pinned by digest) starts under Podman, unprivileged, on 127.0.0.1:5080; Traefik
   serves it at `otel.<host>.<domain>` on the local networks; its admin password is generated there,
   root only (`archon otel ui password --show`, typed by a person); that server's Collector forwards
   everything to it with the credential from an environment file and accepts OTLP from the local
   networks on 4318.
3. **Given** `otel.localdomain` (router DNS) or `telemetry.collector` names that server, **Then**
   the other servers forward to it within 15 minutes, from then on.
4. **Given** no collector answers and the site has a boot server, **Then** discovery says the boot
   PC is not collecting and how to start it (`deno task boot serve`), and the server keeps its
   telemetry locally.
5. **Given** `sudo archon otel ui off`, **Then** the container stops, its route and the 4318 opening
   go away, the Collector goes back to local only (or another collector), and the data and
   credentials are kept.

## Requirements _(mandatory)_

- **FR-001** `OTEL_UI` in the container catalog: OpenObserve's newest stable release, pinned by
  digest, UID 10002, port 5080 on 127.0.0.1 (route `otel`), `/srv/otel-ui` for data, its phone-home
  off, its admin in a root-only environment file.
- **FR-002** An opt-in (`otel-ui`) with the forced durable or ephemeral choice (Article 23); its
  data path joins the nightly archive when durable.
- **FR-003** When it is on, the apply prepares `/var/lib/archon/otel-ui/openobserve.env` and
  `collector.env` (`ARCHON_OTEL_UI_AUTH`, the Basic credential), root only; the Collector's unit
  reads `collector.env` as an `EnvironmentFile`, and its forwarding configuration names
  `${env:ARCHON_OTEL_UI_AUTH}`, never the secret.
- **FR-004** When it is on, the Collector's OTLP/HTTP receiver listens on all addresses and the
  firewall opens 4318/tcp to the local networks only; when it is off, the receiver is on 127.0.0.1
  and nothing is opened.
- **FR-005** Discovery's order: the web UI on this server (healthy), `telemetry.collector`,
  `otel.localdomain`, the boot PC. Only what is collected after a collector is found is forwarded.
- **FR-006** When no collector answers, discovery explains it: the boot PC is not collecting and how
  to start it, or how to collect in one place.
- **FR-007** Commands: `archon otel ui on|off` (mutate), `archon otel ui status` (read, also over
  MCP), `archon otel ui password [--show]` (never over MCP; `--show` typed by a person).
- **FR-008** `docs/telemetry.md` explains it for newcomers: the headless Collector, the order of
  collectors, the web UI, the boot PC, and troubleshooting.

## Success Criteria

- **SC-001** `tests/otelui_test.ts`: the image is a pinned release without phone-home; off, the
  Collector is local and nothing is opened; on, it listens for the fleet, the firewall opens 4318 to
  the local networks, the route exists, and the credential is only an environment reference; this
  server's UI comes first in discovery, and only where it is on.
