/**
 * 021-observability: every server and workstation observes itself with
 * Ubuntu's own components, and OpenTelemetry (OTLP) is the only protocol
 * anything speaks when data leaves where it was made.
 *
 *   metrics  PCP (pmcd, pmlogger) records; pmproxy serves them as OpenMetrics
 *            on localhost, which an OpenTelemetry Collector reads as OTLP
 *   logs     journald stores; the Collector's journald receiver reads it
 *   Archon   speaks OTLP itself (Deno); the local Collector writes it to files
 *
 * Every local store is ephemeral: age and size limits, pruned first when the
 * disk runs low, never backed up (/var/log/pcp, /var/log/journal, and
 * /var/cache/archon-otel are outside spec 016's paths), and cheap to run (the
 * Collector is niced, idle I/O, memory-capped).
 *
 * @module
 */

import { localNetworks } from "./ssh.ts";
import type { Capability, FleetDef, HostDef, ObservabilityDef } from "../model/types.ts";
import { header, ini } from "../render/systemd.ts";
import { timedJob } from "./ops.ts";

const SPEC = "021-observability" as const;

/** The default observability limits. */
export const DEFAULT_OBSERVABILITY: ObservabilityDef = {
  metricsDays: 365,
  metricsMaxSize: "2G",
  logsRetention: "3month",
  logsMaxSize: "1G",
  tracesDays: 7,
  minFreePercent: 15,
};

/** A host's observability limits: the defaults, the fleet's, then the host's. */
export function observabilityPolicy(fleet: FleetDef, host: HostDef): ObservabilityDef {
  return {
    ...DEFAULT_OBSERVABILITY,
    ...(fleet.observability ?? {}),
    ...(host.observability ?? {}),
  };
}

/** Where things are; shared with `archon observe`. */
export const OBSERVE = {
  collectorConfig: "/etc/archon/otelcol/config.yaml",
  /** Written by archon observe discover (spec 024): "{}" until a central collector answers. */
  centralConfig: "/etc/archon/otelcol/central.yaml",
  collectorUnit: "archon-otelcol.service",
  otlpHttp: "127.0.0.1:4318",
  otlpGrpc: "127.0.0.1:4317",
  /** Archon's OTLP stream as the Collector writes it (OTLP JSON lines, rotated). */
  otlpFile: "/var/cache/archon-otel/archon.jsonl",
  otlpDir: "/var/cache/archon-otel",
  pcpArchives: "/var/log/pcp/pmlogger",
  pmproxy: "127.0.0.1:44322",
};

/**
 * The PCP metrics behind OpenTelemetry's system semantic conventions (CPU,
 * memory, disk, filesystem, network, load, processes), the set a viewer or a
 * collector asks pmproxy for (`/metrics?names=...`).
 */
export const CORE_PCP_METRICS = [
  "kernel.all.cpu.user",
  "kernel.all.cpu.sys",
  "kernel.all.cpu.idle",
  "kernel.all.cpu.wait.total",
  "kernel.all.load",
  "kernel.all.nprocs",
  "mem.physmem",
  "mem.util.used",
  "mem.util.free",
  "mem.util.available",
  "mem.util.cached",
  "swap.used",
  "disk.dev.read_bytes",
  "disk.dev.write_bytes",
  "disk.dev.avactive",
  "filesys.capacity",
  "filesys.used",
  "filesys.avail",
  "network.interface.in.bytes",
  "network.interface.out.bytes",
  "network.interface.in.errors",
  "network.interface.out.errors",
];

/** The local Collector: Archon's OTLP in, OTLP JSON files out (JSON is valid YAML). */
/** Spec 050: with the telemetry web UI on, this server collects for the fleet. */
export const collectsForFleet = (host: HostDef) => host.optIn?.["otel-ui"]?.enabled === true;

/** The OpenTelemetry Collector's configuration for this host. */
export function collectorConfig(host: HostDef, fleet: FleetDef, o: ObservabilityDef): string {
  const pipeline = {
    receivers: ["otlp"],
    processors: ["memory_limiter", "resource", "batch"],
    exporters: ["file"],
  };
  const config = {
    receivers: {
      otlp: {
        protocols: {
          grpc: { endpoint: OBSERVE.otlpGrpc },
          // Spec 050: the fleet's other servers send here when the web UI is on
          // (the firewall opens 4318 to the local networks only).
          http: { endpoint: collectsForFleet(host) ? "0.0.0.0:4318" : OBSERVE.otlpHttp },
        },
      },
    },
    processors: {
      memory_limiter: { check_interval: "5s", limit_mib: 192, spike_limit_mib: 48 },
      // OpenTelemetry resource attributes from the model (semantic conventions
      // where they exist, archon.* for Archon's own).
      resource: {
        attributes: [
          { key: "host.name", value: host.name, action: "upsert" },
          { key: "service.namespace", value: fleet.id, action: "upsert" },
          { key: "archon.host.kind", value: host.kind ?? "server", action: "upsert" },
        ],
      },
      batch: { timeout: "5s" },
    },
    exporters: {
      // One file for every signal, rotated: 4 files of 16 MB at most, each kept
      // up to tracesDays. Ephemeral by design.
      file: {
        path: OBSERVE.otlpFile,
        format: "json",
        rotation: { max_megabytes: 16, max_days: o.tracesDays, max_backups: 3 },
      },
    },
    service: {
      telemetry: { logs: { level: "warn" }, metrics: { level: "none" } },
      pipelines: { traces: pipeline, metrics: pipeline, logs: pipeline },
    },
  };
  return header(SPEC) + JSON.stringify(config, null, 2) + "\n";
}

/** journald, PCP, and the OpenTelemetry Collector, within limits (spec 021). */
export const observability = (): Capability => ({ fleet, host }) => {
  const o = observabilityPolicy(fleet, host);
  return {
    spec: SPEC,
    // Ubuntu's own metrics recorder (pmcd, pmlogger, pmproxy).
    packages: [{ name: "pcp", spec: SPEC }],
    // Spec 050: OTLP from the fleet's other servers, when this one has the web UI.
    ports: collectsForFleet(host)
      ? [{
        port: 4318,
        protocol: "tcp" as const,
        from: localNetworks(fleet),
        spec: "050-telemetry-ui" as const,
      }]
      : [],
    files: [
      {
        // journald: persistent, bounded by age and size; it also keeps 15% of
        // the disk free by itself (SystemKeepFree's default), oldest first.
        path: "/etc/systemd/journald.conf.d/50-archon.conf",
        content: ini({
          Journal: {
            Storage: "persistent",
            MaxRetentionSec: o.logsRetention,
            SystemMaxUse: o.logsMaxSize,
          },
        }, SPEC),
        mode: "0644",
        owner: "root",
        spec: SPEC,
        onChange: [{ kind: "restart", unit: "systemd-journald.service" }],
      },
      {
        // pmlogger_daily culls archives older than metricsDays (Ubuntu: 14) and
        // compresses the rest; archon observe prune adds the size limit.
        path: "/etc/default/pmlogger_timers",
        content: header(SPEC) + `PMLOGGER_DAILY_PARAMS="-E -k ${o.metricsDays}"\n`,
        mode: "0644",
        owner: "root",
        spec: SPEC,
      },
      {
        // pmproxy serves OpenMetrics to this machine only (-i); -A is Ubuntu's
        // default (no service advertising).
        path: "/etc/pcp/pmproxy/pmproxy.options",
        content: header(SPEC) + "-A\n-i 127.0.0.1\n",
        mode: "0644",
        owner: "root",
        spec: SPEC,
        onChange: [{ kind: "restart", unit: "pmproxy.service" }],
      },
      {
        path: OBSERVE.collectorConfig,
        content: collectorConfig(host, fleet, o),
        mode: "0644",
        owner: "root",
        spec: SPEC,
        // On a fresh host the unit is written after this file (Units follow Files):
        // nothing to restart yet.
        onChange: [{
          kind: "run",
          argv: ["systemctl", "try-restart", OBSERVE.collectorUnit],
          ifExists: `/etc/systemd/system/${OBSERVE.collectorUnit}`,
        }],
      },
    ],
    units: [
      ...["pmcd.service", "pmlogger.service", "pmproxy.service"].map((unitName) => ({
        unitName,
        managed: false,
        state: "enabled" as const,
        verify: `systemctl is-active ${unitName}`,
        spec: SPEC,
      })),
      {
        unitName: OBSERVE.collectorUnit,
        managed: true,
        content: ini({
          Unit: {
            Description: "Archon: OpenTelemetry Collector (local OTLP)",
            Documentation: "man:archon-observe(1)",
            After: "network.target",
            // Installed by the tools sync, which then restarts this unit.
            ConditionPathExists: "/usr/local/bin/otelcol-contrib",
          },
          Service: {
            // Spec 024: discovery's file is merged in; it is "{}" until a central collector answers.
            ExecStartPre:
              `+/bin/sh -c 'test -s ${OBSERVE.centralConfig} || echo "{}" > ${OBSERVE.centralConfig}'`,
            ExecStart:
              `/usr/local/bin/otelcol-contrib --config=${OBSERVE.collectorConfig} --config=${OBSERVE.centralConfig}`,
            // Spec 050: the web UI's credential, when it is on here (read by systemd as root).
            EnvironmentFile: "-/var/lib/archon/otel-ui/collector.env",
            DynamicUser: true,
            CacheDirectory: "archon-otel",
            CacheDirectoryMode: "0755",
            StateDirectory: "archon-otel",
            SupplementaryGroups: "systemd-journal",
            Nice: 10,
            IOSchedulingClass: "idle",
            MemoryMax: "256M",
            CPUQuota: "25%",
            Restart: "on-failure",
            RestartSec: 10,
          },
          Install: { WantedBy: "multi-user.target" },
        }, SPEC),
        state: "enabled" as const,
        verify: `systemctl is-active ${OBSERVE.collectorUnit}`,
        spec: SPEC,
      },
      ...timedJob({
        name: "observe-discover",
        description: "look for a central OpenTelemetry collector",
        argv: ["observe", "discover"],
        onCalendar: "*:07/15",
        spec: "024-discovery",
      }),
      ...timedJob({
        name: "observe-prune",
        description: "keep local metric archives within their size and free-space limits",
        argv: ["observe", "prune"],
        onCalendar: "*-*-* 04:41:00",
        spec: SPEC,
      }),
    ],
    notes: [
      `Ephemeral local stores: PCP archives up to ${o.metricsDays} days and ${o.metricsMaxSize}; journald up to ${o.logsRetention} and ${o.logsMaxSize}; Archon's OTLP files up to ${o.tracesDays} days and 64 MB. Below ${o.minFreePercent}% free disk, metric archives are pruned first.`,
      collectsForFleet(host)
        ? "This server has the telemetry web UI: its Collector also accepts OTLP from the local networks (4318) and forwards everything to OpenObserve."
        : "OTLP is the only protocol data leaves in; the Collector listens on 127.0.0.1 only.",
    ],
  };
};
