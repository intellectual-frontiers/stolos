// `archon observe discover` (spec 024): find a central OpenTelemetry collector
// and forward this machine's telemetry to it. By unicast DNS only (Article 20:
// never mDNS or DNS-SD): the fleet model's address, else the name
// "otel.localdomain" (fleet.telemetry.name, a UniFi Local DNS record). A
// candidate counts only if it accepts OTLP. What is found goes into a second Collector config file, merged
// with the base one: journald, PCP (through pmproxy), and Archon's own OTLP
// are then forwarded, with a bounded queue on disk. Until a collector answers,
// the file is empty and everything stays local.

import { readTextOr } from "../core/fsx.ts";
import { run } from "../core/exec.ts";
import { ui } from "../core/ui.ts";
import { loadFleet } from "../model/load.ts";
import type { FleetDef, HostDef } from "../model/types.ts";
import { CORE_PCP_METRICS, OBSERVE } from "../capabilities/observability.ts";

export const CENTRAL = {
  config: OBSERVE.centralConfig,
  status: "/var/lib/archon/status/otel-central.json",
};

/** The collector's conventional name: a UniFi Local DNS record (Article 20). */
export const DEFAULT_COLLECTOR_NAME = "otel.localdomain";

export interface Found {
  endpoint: string;
  source: "model" | "dns";
}

/** Does this URL accept OTLP/HTTP? (An empty export is a valid request.) */
export async function acceptsOtlp(endpoint: string): Promise<boolean> {
  try {
    const r = await fetch(`${endpoint.replace(/\/$/, "")}/v1/logs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(3000),
    });
    await r.body?.cancel();
    return r.ok;
  } catch {
    return false;
  }
}

export async function candidates(fleet: FleetDef, _host: HostDef): Promise<Found[]> {
  const t = fleet.telemetry ?? {};
  const out: Found[] = [];
  if (t.collector) out.push({ endpoint: t.collector, source: "model" });
  const name = t.name ?? DEFAULT_COLLECTOR_NAME;
  if ((await run(["getent", "ahostsv4", name])).ok) {
    out.push({ endpoint: `http://${name}:4318`, source: "dns" });
  }
  return out;
}

/** The Collector config that forwards everything to `endpoint` (JSON is valid YAML). */
export function centralConfig(endpoint: string, pcpNames: string[]): string {
  const processors = ["memory_limiter", "resource", "batch"];
  const config = {
    extensions: {
      file_storage: { directory: "/var/lib/archon-otel", create_directory: true },
    },
    receivers: {
      journald: { directory: "/var/log/journal", priority: "info" },
      "prometheus/pcp": {
        config: {
          scrape_configs: [{
            job_name: "pcp",
            scrape_interval: "60s",
            metrics_path: "/metrics",
            params: { names: [pcpNames.join(",")] },
            static_configs: [{ targets: [OBSERVE.pmproxy] }],
          }],
        },
      },
    },
    processors: {
      // PCP's metrics keep their own names, under pcp.* (spec 024): mapping
      // them to OpenTelemetry's system.* conventions waits for the dashboards.
      "metricstransform/pcp": {
        transforms: [{
          include: "^(.*)$",
          match_type: "regexp",
          action: "update",
          new_name: "pcp.$${1}",
        }],
      },
    },
    exporters: {
      "otlphttp/central": {
        endpoint,
        // Bounded and on disk: a collector that is down costs some space, never memory.
        sending_queue: { storage: "file_storage", queue_size: 2000 },
        retry_on_failure: { enabled: true },
      },
    },
    service: {
      extensions: ["file_storage"],
      pipelines: {
        "logs/central": {
          receivers: ["otlp", "journald"],
          processors,
          exporters: ["otlphttp/central"],
        },
        "metrics/pcp": {
          receivers: ["prometheus/pcp"],
          processors: ["memory_limiter", "metricstransform/pcp", "resource", "batch"],
          exporters: ["otlphttp/central"],
        },
        "metrics/central": { receivers: ["otlp"], processors, exporters: ["otlphttp/central"] },
        "traces/central": { receivers: ["otlp"], processors, exporters: ["otlphttp/central"] },
      },
    },
  };
  return "# Written by archon observe discover (spec 024). Do not edit.\n" +
    JSON.stringify(config, null, 2) + "\n";
}

export async function discover(host: HostDef, check = false): Promise<number> {
  const p = ui.phase("Collector");
  const fleet = await loadFleet();
  let found: Found | undefined;
  for (const c of await candidates(fleet, host)) {
    p.status(`trying ${c.endpoint} (${c.source})`);
    if (await acceptsOtlp(c.endpoint)) {
      found = c;
      break;
    }
  }
  const want = found ? centralConfig(found.endpoint, CORE_PCP_METRICS) : "{}\n";
  if ((await readTextOr(CENTRAL.config)) !== want) {
    p.change(
      found ? `forward to ${found.endpoint} (${found.source})` : "forward nothing: local only",
    );
    if (!check) {
      await Deno.writeTextFile(CENTRAL.config, want, { mode: 0o644 });
      await run(["systemctl", "try-restart", OBSERVE.collectorUnit]);
    }
  }
  if (!check) {
    await Deno.writeTextFile(
      CENTRAL.status,
      JSON.stringify({
        endpoint: found?.endpoint ?? null,
        source: found?.source ?? null,
        checked: new Date().toISOString(),
      }) + "\n",
    ).catch(() => {});
  }
  p.done(found ? `${found.endpoint} (found by ${found.source})` : "none found: local only");
  return 0;
}

/** What discovery last found (for archon observe). */
export async function lastDiscovery(): Promise<
  { endpoint: string | null; source: string | null } | undefined
> {
  try {
    return JSON.parse((await readTextOr(CENTRAL.status)) ?? "");
  } catch {
    return undefined;
  }
}
