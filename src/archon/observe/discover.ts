/**
 * `archon observe discover` (spec 024): find a central OpenTelemetry collector
 * and forward this machine's telemetry to it. By unicast DNS only (Article 20:
 * never mDNS or DNS-SD): the fleet model's address, else the name
 * "otel.localdomain" (fleet.telemetry.name, a UniFi Local DNS record). A
 * candidate counts only if it accepts OTLP. What is found goes into a second Collector config file, merged
 * with the base one: journald, PCP (through pmproxy), and Archon's own OTLP
 * are then forwarded, with a bounded queue on disk. Until a collector answers,
 * the file is empty and everything stays local.
 *
 * @module
 */

import { LOCAL_UI_ENDPOINT } from "../otelui/otelui.ts";
import { OTEL_UI } from "../containers/catalog.ts";
import { fs } from "@intellectual-frontiers/ifc-ts/runtime";
import { run } from "../core/exec.ts";
import { onHost } from "../core/paths.ts";
import { ui } from "../core/ui.ts";
import { loadFleet } from "../model/load.ts";
import type { FleetDef, HostDef } from "../model/types.ts";
import { CORE_PCP_METRICS, OBSERVE } from "../capabilities/observability.ts";

/** Where discovery writes its result. */
export const CENTRAL = {
  /** The second Collector config file: the forwarding to the central collector, or `{}`. */
  config: OBSERVE.centralConfig,
  /** JSON: the endpoint and source last found (null when none) and when it was checked. */
  status: "/var/lib/archon/status/otel-central.json",
};

/** The collector's conventional name: a UniFi Local DNS record (Article 20). */
export const DEFAULT_COLLECTOR_NAME = "otel.localdomain";

/** A collector candidate: where it is and how it was found. */
export interface Found {
  /** Its OTLP/HTTP base URL (for example `http://otel.localdomain:4318`). */
  endpoint: string;
  /**
   * How it was found: the telemetry web UI on this server (spec 050), the
   * fleet model's address, the DNS name, or the boot PC's boot server (spec 049).
   */
  source: "local-ui" | "model" | "dns" | "boot";
}

async function healthy(url: string): Promise<boolean> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(3000) });
    await r.body?.cancel();
    return r.ok;
  } catch {
    return false;
  }
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

/**
 * The collectors to try, in order: the web UI on this server when opted in,
 * the model's collector, the DNS name when it resolves, then the boot server.
 */
export async function candidates(fleet: FleetDef, host: HostDef): Promise<Found[]> {
  const t = fleet.telemetry ?? {};
  const out: Found[] = [];
  // Spec 050: the telemetry web UI on this very server comes first.
  if (host.optIn?.["otel-ui"]?.enabled) {
    out.push({ endpoint: LOCAL_UI_ENDPOINT, source: "local-ui" });
  }
  if (t.collector) out.push({ endpoint: t.collector, source: "model" });
  const name = t.name ?? DEFAULT_COLLECTOR_NAME;
  if ((await run(["getent", "ahostsv4", name])).ok) {
    out.push({ endpoint: `http://${name}:4318`, source: "dns" });
  }
  // Spec 049: with no other collector, the boot PC's boot server (its HTTP
  // port, which the servers already reach) keeps the fleet's telemetry a week.
  const boot = fleet.site?.bootServer;
  if (boot) out.push({ endpoint: `http://${boot.address}:${boot.http}/otlp`, source: "boot" });
  return out;
}

/** The Collector config that forwards everything to `endpoint` (JSON is valid YAML). */
export function centralConfig(
  endpoint: string,
  pcpNames: string[],
  source: Found["source"] = "model",
): string {
  const processors = ["memory_limiter", "resource", "batch"];
  const config = {
    extensions: {
      file_storage: { directory: "/var/lib/archon-otel", create_directory: true },
    },
    receivers: {
      journald: { directory: "/var/log/journal", priority: "info" },
      "prometheus/pcp": {
        config: {
          scrape_configs: [
            {
              job_name: "pcp",
              scrape_interval: "60s",
              metrics_path: "/metrics",
              params: { names: [pcpNames.join(",")] },
              static_configs: [{ targets: [OBSERVE.pmproxy] }],
            },
          ],
        },
      },
    },
    processors: {
      // PCP's metrics keep their own names, under pcp.* (spec 024): mapping
      // them to OpenTelemetry's system.* conventions waits for the dashboards.
      "metricstransform/pcp": {
        transforms: [
          {
            include: "^(.*)$",
            match_type: "regexp",
            action: "update",
            new_name: "pcp.$${1}",
          },
        ],
      },
    },
    exporters: {
      "otlphttp/central": {
        endpoint,
        // The boot server reads OTLP as JSON (spec 049); a real collector takes protobuf.
        ...(source === "boot" ? { encoding: "json" } : {}),
        // The web UI on this server (spec 050): its credential comes from the
        // Collector's environment file, never from this file.
        ...(source === "local-ui"
          ? { headers: { Authorization: "Basic ${env:ARCHON_OTEL_UI_AUTH}" } }
          : {}),
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
  return (
    "# Written by archon observe discover (spec 024). Do not edit.\n" +
    JSON.stringify(config, null, 2) +
    "\n"
  );
}

/**
 * `archon observe discover`: try each candidate, write the forwarding config
 * for the first that answers (or `{}` for none) and restart the Collector when
 * it changed, then record the result. With `check`, only report what would
 * change. Returns 0.
 */
export async function discover(host: HostDef, check = false): Promise<number> {
  const p = ui.phase("Collector");
  const fleet = await loadFleet();
  let found: Found | undefined;
  const tried: Found[] = [];
  for (const c of await candidates(fleet, host)) {
    p.status(`trying ${c.endpoint} (${c.source})`);
    tried.push(c);
    // The web UI here needs its credential to accept OTLP: its health says it is up.
    const up =
      c.source === "local-ui" ? await healthy(OTEL_UI.health) : await acceptsOtlp(c.endpoint);
    if (up) {
      found = c;
      break;
    }
  }
  // Spec 050: the boot PC is optional. When it is the one that did not answer,
  // say so, and how to use it, so that anyone can set it up.
  const boot = tried.find((c) => c.source === "boot");
  if (!found && boot) {
    p.note(
      `the boot PC (${boot.endpoint}) is not collecting: it does only while \`bun run stolos boot serve\` runs on it (optional; see the telemetry guide (bun run stolos docs telemetry))`,
    );
  } else if (!found && !fleet.site?.bootServer) {
    p.note(
      "no collector: telemetry stays on this machine (journald, PCP, Archon's OTLP files). To keep it in one place, turn on the web UI on a server (archon otel ui on --ephemeral) or run the boot PC's boot server (the telemetry guide (bun run stolos docs telemetry))",
    );
  }
  const want = found ? centralConfig(found.endpoint, CORE_PCP_METRICS, found.source) : "{}\n";
  if ((await fs.readTextOr(onHost(CENTRAL.config))) !== want) {
    p.change(
      found ? `forward to ${found.endpoint} (${found.source})` : "forward nothing: local only",
    );
    if (!check) {
      await fs.writeTextFile(onHost(CENTRAL.config), want, { mode: 0o644 });
      await run(["systemctl", "try-restart", OBSERVE.collectorUnit]);
    }
  }
  if (!check) {
    await fs
      .writeTextFile(
        onHost(CENTRAL.status),
        JSON.stringify({
          endpoint: found?.endpoint ?? null,
          source: found?.source ?? null,
          checked: new Date().toISOString(),
        }) + "\n",
      )
      .catch(() => undefined);
  }
  p.done(found ? `${found.endpoint} (found by ${found.source})` : "none found: local only");
  return 0;
}

/** What discovery last found (for archon observe). */
export async function lastDiscovery(): Promise<
  { endpoint: string | null; source: string | null } | undefined
> {
  try {
    return JSON.parse(await fs.readTextOr(onHost(CENTRAL.status), "")) as {
      endpoint: string | null;
      source: string | null;
    };
  } catch {
    return undefined;
  }
}
