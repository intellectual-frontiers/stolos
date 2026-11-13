// Archon's own telemetry (spec 021), through Deno's built-in OpenTelemetry:
// every command is a trace (one span per phase), and its results are metrics.
// The launcher sets OTEL_DENO and points OTLP at the local Collector; without
// them, or if the OpenTelemetry API cannot be loaded, everything here is a
// no-op and nothing is ever printed. Names follow OpenTelemetry's conventions;
// Archon's own are under archon.*.

type Attrs = Record<string, string | number | boolean>;
interface Span {
  setAttribute(k: string, v: string | number | boolean): void;
  setStatus(s: { code: number; message?: string }): void;
  end(): void;
}
interface Instrument {
  add?(v: number, a?: Attrs): void;
  record?(v: number, a?: Attrs): void;
}
interface OtelApi {
  trace: {
    getTracer(n: string): {
      startSpan(name: string, o?: { attributes?: Attrs }, ctx?: unknown): Span;
    };
    setSpan(ctx: unknown, s: Span): unknown;
  };
  context: { active(): unknown };
  metrics: {
    getMeter(n: string): {
      createCounter(n: string, o?: { unit?: string; description?: string }): Instrument;
      createHistogram(n: string, o?: { unit?: string; description?: string }): Instrument;
    };
  };
  SpanStatusCode: { OK: number; ERROR: number };
}

let api: OtelApi | undefined;
let root: Span | undefined;
let rootCtx: unknown;
let started = 0;
const phases = new Map<string, Span>();
const runAttrs: Attrs = {};

/** Load the API when OpenTelemetry is on; silently off otherwise. */
export async function initTelemetry(): Promise<void> {
  if (!Deno.env.get("OTEL_DENO")) return;
  try {
    api = (await import("npm:@opentelemetry/api@1.9.0")) as unknown as OtelApi;
  } catch {
    api = undefined;
  }
}

export function startRun(command: string, attrs: Attrs = {}): void {
  if (!api) return;
  Object.assign(runAttrs, { "archon.command": command, ...attrs });
  started = performance.now();
  root = api.trace.getTracer("archon").startSpan(`archon ${command}`, { attributes: runAttrs });
  rootCtx = api.trace.setSpan(api.context.active(), root);
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
    s.setAttribute("archon.phase.result", summary);
    s.setAttribute("archon.phase.level", level);
    s.setStatus({ code: level === "fail" ? api.SpanStatusCode.ERROR : api.SpanStatusCode.OK });
    s.end();
    phases.delete(name);
  },
};

export function endRun(code: number, failures: number, warnings: number): void {
  if (!api || !root) return;
  const meter = api.metrics.getMeter("archon");
  const outcome = code === 0 && !failures ? "ok" : "failed";
  meter.createHistogram("archon.run.duration", {
    unit: "s",
    description: "How long an archon command took",
  }).record?.((performance.now() - started) / 1000, { ...runAttrs, "archon.outcome": outcome });
  const problems = meter.createCounter("archon.run.problems", {
    description: "Problems an archon command reported",
  });
  if (failures) problems.add?.(failures, { ...runAttrs, "archon.level": "fail" });
  if (warnings) problems.add?.(warnings, { ...runAttrs, "archon.level": "warn" });
  for (const s of phases.values()) s.end();
  root.setAttribute("archon.outcome", outcome);
  root.setStatus({ code: outcome === "ok" ? api.SpanStatusCode.OK : api.SpanStatusCode.ERROR });
  root.end();
  root = undefined;
}

/** archon verify: how many checks passed and failed. */
export function recordChecks(passed: number, failed: number): void {
  if (!api) return;
  const c = api.metrics.getMeter("archon").createCounter("archon.verify.checks", {
    description: "Verification checks run, by result",
  });
  c.add?.(passed, { ...runAttrs, "archon.result": "passed" });
  c.add?.(failed, { ...runAttrs, "archon.result": "failed" });
}

/** archon apply: how many changes it made (or would make, with --check). */
export function recordChanges(n: number, check: boolean): void {
  if (!api) return;
  api.metrics.getMeter("archon").createCounter("archon.apply.changes", {
    description: "Changes archon apply made or planned",
  }).add?.(n, { ...runAttrs, "archon.check": check });
}
