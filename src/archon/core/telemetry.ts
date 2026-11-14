/**
 * Archon's own telemetry (specs 021, 049; Article 27), through Deno's built-in
 * OpenTelemetry: every command is a trace (one span per phase) and its results
 * are metrics. Console output (errors, --json) is exported by Deno as logs
 * linked to the trace; the journal reaches the Collector through journald.
 * Every name comes from telemetry/signals.ts.
 *
 * The launcher sets OTEL_DENO and points OTLP at the local Collector, with the
 * fleet, host, engine version, and commit as resource attributes. A run
 * continues a trace begun elsewhere when TRACEPARENT is set (an MCP call's
 * `_meta.traceparent`, an SSH command from the boot machine). Without
 * OTEL_DENO, or if the API cannot load, everything here is a no-op.
 *
 * ```mermaid
 * flowchart LR
 *   run["an archon run"] --> trace["a trace: its phases as spans"]
 *   run --> events["its problems as log records"]
 *   trace --> col{"collector"}
 *   events --> col
 *   col -->|on the host| local["the local OpenTelemetry Collector"]
 *   col -->|first boot| boot["the boot server (/otlp)"]
 *   local -->|opt-in| ui["OpenObserve"]
 * ```
 *
 * @module
 */

import { type MetricName, METRICS } from "../telemetry/signals.ts";
import { type ArchonEvent, toLogsRequest } from "../telemetry/events.ts";
import { redact } from "../notify/redact.ts";

/** Span or metric attributes: OpenTelemetry's flat key to value map. */
export type Attrs = Record<string, string | number | boolean>;
/** A span's identity, as a W3C traceparent carries it. */
export interface SpanContext {
  /** The trace ID: 32 lowercase hex digits, not all zero. */
  traceId: string;
  /** The parent span's ID: 16 lowercase hex digits, not all zero. */
  spanId: string;
  /** Trace flags (bit 0: sampled). */
  traceFlags: number;
  /** True when the context came from another process. */
  isRemote?: boolean;
}
interface Span {
  setAttribute(k: string, v: string | number | boolean): void;
  setStatus(s: { code: number; message?: string }): void;
  spanContext(): SpanContext;
  end(): void;
}
interface Instrument {
  add?(v: number, a?: Attrs): void;
  record?(v: number, a?: Attrs): void;
}
interface Meter {
  createCounter(n: string, o?: { unit?: string; description?: string }): Instrument;
  createHistogram(n: string, o?: { unit?: string; description?: string }): Instrument;
  createGauge?(n: string, o?: { unit?: string; description?: string }): Instrument;
}
interface OtelApi {
  trace: {
    getTracer(n: string): {
      startSpan(name: string, o?: { attributes?: Attrs }, ctx?: unknown): Span;
    };
    setSpan(ctx: unknown, s: Span): unknown;
    setSpanContext(ctx: unknown, sc: SpanContext): unknown;
  };
  context: { active(): unknown };
  metrics: { getMeter(n: string): Meter };
  SpanStatusCode: { OK: number; ERROR: number };
}

let api: OtelApi | undefined;
let root: Span | undefined;
let rootCtx: unknown;
let started = 0;
const phases = new Map<string, Span>();
const runAttrs: Attrs = {};
const instruments = new Map<string, Instrument>();
/** Spec 049: this run's events (phases, problems), sent as OTLP log records at its end. */
const runEvents: ArchonEvent[] = [];

/** Load the API when OpenTelemetry is on; silently off otherwise. */
export async function initTelemetry(): Promise<void> {
  if (!Deno.env.get("OTEL_DENO")) return;
  try {
    api = (await import("npm:@opentelemetry/api@1.9.0")) as unknown as OtelApi;
  } catch {
    api = undefined;
  }
}

/** Attribute values never carry a secret (Article 13): the same redaction as mail. */
export function clean(a: Attrs): Attrs {
  return Object.fromEntries(
    Object.entries(a).map(([k, v]) => [k, typeof v === "string" ? redact(v) : v]),
  );
}

const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;

/** A W3C traceparent, parsed, or undefined. */
export function parseTraceparent(tp: string | undefined): SpanContext | undefined {
  const m = tp?.trim().match(TRACEPARENT);
  if (!m || /^0+$/.test(m[1]) || /^0+$/.test(m[2])) return undefined;
  return { traceId: m[1], spanId: m[2], traceFlags: parseInt(m[3], 16), isRemote: true };
}

/** This run's traceparent, to hand to the next process (MCP, SSH), or undefined. */
export function currentTraceparent(): string | undefined {
  if (!root) return undefined;
  const c = root.spanContext();
  return `00-${c.traceId}-${c.spanId}-${c.traceFlags.toString(16).padStart(2, "0")}`;
}

function instrument(name: MetricName): Instrument | undefined {
  if (!api) return undefined;
  let i = instruments.get(name);
  if (!i) {
    const spec = METRICS[name];
    const meter = api.metrics.getMeter("archon");
    const o = { description: spec.description, ...("unit" in spec ? { unit: spec.unit } : {}) };
    i = spec.kind === "histogram"
      ? meter.createHistogram(name, o)
      : spec.kind === "gauge"
      ? (meter.createGauge?.(name, o) ?? {})
      : meter.createCounter(name, o);
    instruments.set(name, i);
  }
  return i;
}

/** Add to a counter declared in signals.ts. */
export function count(name: MetricName, n = 1, attrs: Attrs = {}): void {
  if (n) instrument(name)?.add?.(n, clean({ ...runAttrs, ...attrs }));
}

/** Record a histogram or gauge value declared in signals.ts. */
export function measure(name: MetricName, v: number, attrs: Attrs = {}): void {
  instrument(name)?.record?.(v, clean({ ...runAttrs, ...attrs }));
}

/** Start this run's trace (continuing TRACEPARENT when given). */
export function startRun(command: string, attrs: Attrs = {}, program = "archon"): void {
  if (!api) return;
  Object.assign(runAttrs, clean({ "archon.command": command, ...attrs }));
  started = performance.now();
  const parent = parseTraceparent(Deno.env.get("TRACEPARENT"));
  const ctx = parent
    ? api.trace.setSpanContext(api.context.active(), parent)
    : api.context.active();
  root = api.trace.getTracer("archon").startSpan(
    `${program} ${command}`,
    { attributes: runAttrs },
    ctx,
  );
  rootCtx = api.trace.setSpan(api.context.active(), root);
  if (typeof runAttrs["archon.engine.version"] === "string") {
    measure("archon.engine.info", 1, {});
  }
}

/** A child span of the run (archon.query, archon.remote): call the returned function to end it. */
export function span(name: string, attrs: Attrs = {}): (ok?: boolean) => void {
  if (!api || !root) return () => {};
  const s = api.trace.getTracer("archon").startSpan(name, { attributes: clean(attrs) }, rootCtx);
  return (ok = true) => {
    s.setStatus({ code: ok ? api!.SpanStatusCode.OK : api!.SpanStatusCode.ERROR });
    s.end();
  };
}

/** UI phases become child spans of the command's span. */
export const phaseListener = {
  start(name: string): void {
    if (!api || !root) return;
    phases.set(name, api.trace.getTracer("archon").startSpan(name, {}, rootCtx));
  },
  end(name: string, level: string, summary: string): void {
    const s = phases.get(name);
    if (!api || !s) return;
    s.setAttribute("archon.phase.result", redact(summary));
    s.setAttribute("archon.phase.level", level);
    const c = s.spanContext();
    runEvents.push({
      name: "archon.phase",
      severity: level === "fail" ? "error" : level === "warn" ? "warn" : "info",
      message: redact(`${name}: ${summary}`),
      attrs: { "archon.phase": name, "archon.phase.level": level },
      traceId: c.traceId,
      spanId: c.spanId,
    });
    s.setStatus({ code: level === "fail" ? api.SpanStatusCode.ERROR : api.SpanStatusCode.OK });
    s.end();
    phases.delete(name);
  },
};

/** End this run's trace with its outcome. */
export function endRun(code: number, failures: number, warnings: number): void {
  if (!api || !root) return;
  const outcome = code === 0 && !failures ? "ok" : "failed";
  measure("archon.run.duration", (performance.now() - started) / 1000, {
    "archon.outcome": outcome,
  });
  count("archon.run.problems", failures, { "archon.level": "fail" });
  count("archon.run.problems", warnings, { "archon.level": "warn" });
  for (const s of phases.values()) s.end();
  root.setAttribute("archon.outcome", outcome);
  root.setStatus({ code: outcome === "ok" ? api.SpanStatusCode.OK : api.SpanStatusCode.ERROR });
  lastRoot = root.spanContext();
  root.end();
  root = undefined;
}

let lastRoot: SpanContext | undefined;

/** archon verify: how many checks passed and failed. */
export function recordChecks(passed: number, failed: number): void {
  count("archon.verify.checks", passed, { "archon.result": "passed" });
  count("archon.verify.checks", failed, { "archon.result": "failed" });
}

/** archon apply: how many changes it made (or would make, with --check). */
export function recordChanges(n: number, check: boolean): void {
  count("archon.apply.changes", n, { "archon.check": check });
}

/**
 * Spec 049: the run's problems join its events, and every event goes to the
 * collector as an OTLP log record in the run's trace (the terminal and the run
 * log print the same facts). Best effort, a few seconds at most; silent when
 * OpenTelemetry is off.
 */
export async function flushEvents(
  problems: Array<
    {
      level: "warn" | "fail" | "pending";
      phase: string;
      message: string;
      fix?: string;
      code?: string;
    }
  >,
): Promise<void> {
  if (!api) return;
  const ids = root?.spanContext() ?? lastRoot;
  for (const p of problems) {
    runEvents.push({
      name: "archon.problem",
      // Spec 052: not set up yet is information, not a problem.
      severity: p.level === "fail" ? "error" : p.level === "warn" ? "warn" : "info",
      message: redact(p.message),
      attrs: {
        "archon.phase": p.phase,
        "archon.level": p.level,
        ...(p.fix ? { "archon.fix": redact(p.fix) } : {}),
        ...(p.code ? { "archon.code": p.code } : {}),
      },
      ...(ids ? { traceId: ids.traceId, spanId: ids.spanId } : {}),
    });
  }
  const endpoint = Deno.env.get("OTEL_EXPORTER_OTLP_ENDPOINT");
  if (!endpoint || !runEvents.length) return;
  const resource: Record<string, string> = {
    "service.name": Deno.env.get("OTEL_SERVICE_NAME") ?? "archon",
  };
  for (const kv of (Deno.env.get("OTEL_RESOURCE_ATTRIBUTES") ?? "").split(",")) {
    const i = kv.indexOf("=");
    if (i > 0 && kv.slice(i + 1)) resource[kv.slice(0, i).trim()] = kv.slice(i + 1).trim();
  }
  const body = JSON.stringify(toLogsRequest(runEvents.splice(0), resource, "archon"));
  await fetch(`${endpoint.replace(/\/$/, "")}/v1/logs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
    signal: AbortSignal.timeout(3000),
  }).then((r) => r.body?.cancel()).catch(() => {});
}
