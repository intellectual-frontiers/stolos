/**
 * Archon's own telemetry (specs 021, 049, 096; Article 27), through IFC TypeScript's signals
 * (`runtime/otel`, commons 0006-signals): every command is a trace, an `archon.run` span with one
 * `archon.phase` span per phase, its results are metrics, and its phases and problems are
 * `archon.phase` and `archon.problem` log records in that trace. Every name comes from
 * `telemetry/signals.ts` and `telemetry/events.ts`, and the registry below is made from them, so a
 * name that is not declared does not compile.
 *
 * The pipeline is configured by OpenTelemetry's own variables (`OTEL_EXPORTER_OTLP_ENDPOINT`,
 * `OTEL_SERVICE_NAME`, `OTEL_RESOURCE_ATTRIBUTES`, ...), which the launcher sets to the local
 * Collector with the fleet, host, engine version and commit as resource attributes; without an
 * endpoint it looks for a Collector on `localhost:4318` and is silent where none listens. A run
 * continues a trace begun elsewhere when `TRACEPARENT` is set (an MCP call's `_meta.traceparent`,
 * an SSH command from the boot machine), and every program it runs through `proc` is given its
 * `TRACEPARENT` in turn.
 *
 * ```mermaid
 * flowchart LR
 *   run["an archon run"] --> trace["a trace: archon.run, its phases as archon.phase"]
 *   run --> events["its problems as archon.problem log records"]
 *   trace --> col{"collector"}
 *   events --> col
 *   col -->|on the host| local["the local OpenTelemetry Collector"]
 *   col -->|first boot| boot["the boot server (/otlp)"]
 *   local -->|opt-in| ui["OpenObserve"]
 * ```
 *
 * @example
 * ```ts
 * import { endRun, flushEvents, initTelemetry, span, startRun } from "./telemetry.ts";
 * initTelemetry("archon", "0.1.0");
 * startRun("verify", { "archon.fleet": "lab" });
 * const end = span("archon.query", { "archon.table": "archon_verify" });
 * end(true);
 * endRun(0, 0, 0);
 * await flushEvents([]);
 * ```
 *
 * @module
 */
// Spec: 049-telemetry
// Spec: 096-bun-runtime
import {
  err,
  ok,
  otel as kotel,
  type Result,
  signals,
} from "@intellectual-frontiers/commons/ts/kernel";
import { otel } from "@intellectual-frontiers/commons/ts/runtime";
import { ATTRIBUTES, type MetricName, METRICS, SPANS } from "../telemetry/signals.ts";
import { EVENTS } from "../telemetry/events.ts";

/** Span, metric and log attributes: OpenTelemetry's flat key to value map. */
export type Attrs = Record<string, string | number | boolean>;

/** Every attribute of `telemetry/signals.ts`, each optional: `archon.check` a boolean, the rest text. */
const SCHEMA: signals.AttributeSchema = Object.fromEntries(
  Object.keys(ATTRIBUTES).map((k) => [`${k}?`, k === "archon.check" ? "boolean" : "string"]),
);

/** A span kind of `SPANS`. */
type SpanName = keyof typeof SPANS;

/** The declarations the registry is made of, typed by the lists they come from. */
type Declarations = {
  readonly [K in SpanName]: signals.SpanDeclaration;
} & {
  readonly [K in MetricName]: (typeof METRICS)[K]["kind"] extends "histogram"
    ? signals.HistogramDeclaration & { readonly signal: "histogram" }
    : signals.InstrumentDeclaration & { readonly signal: (typeof METRICS)[K]["kind"] };
} & {
  readonly "archon.problem": signals.LogDeclaration;
};

const SEVERITY: Readonly<Record<string, kotel.SeverityNumber>> = {
  debug: 5,
  info: 9,
  warn: 13,
  error: 17,
};

function declarations(): Declarations {
  const spans = Object.fromEntries(
    Object.entries(SPANS).map(([name, description]) => [
      name,
      {
        signal: "span",
        role: name === "archon.run" || name === "archon.phase" ? "step" : "detail",
        description,
        attributes: SCHEMA,
      },
    ]),
  );
  const metrics = Object.fromEntries(
    Object.entries(METRICS).map(([name, m]) => [
      name,
      {
        signal: m.kind,
        role: "none",
        unit: "unit" in m ? m.unit : "1",
        description: m.description,
        attributes: SCHEMA,
      },
    ]),
  );
  const problem: signals.LogDeclaration = {
    signal: "log",
    role: "warning",
    severity: SEVERITY[EVENTS["archon.problem"].severity] ?? 13,
    description: EVENTS["archon.problem"].description,
    attributes: SCHEMA,
  };
  // The shapes are those of `Declarations`, made from the same lists.
  return { ...spans, ...metrics, "archon.problem": problem } as unknown as Declarations;
}

/** Archon's signal registry (commons 0006-signals FR-009), made from `telemetry/signals.ts`. */
export const ARCHON_SIGNALS: signals.Registry<Declarations> = signals.defineSignals(declarations());

type Kinds = Declarations;
type Open = {
  readonly handle: signals.SpanHandle<Kinds, SpanName>;
  readonly end: (r: Result<void, string>) => void;
};

let started: otel.Started<Kinds> | undefined;
let scope: kotel.Scope = { name: "archon" };
let root: Open | undefined;
let lastRoot: Open | undefined;
let startedAt = 0;
const phases = new Map<string, Open>();
const runAttrs: Attrs = {};

/** Attribute values never carry a secret (Article 13): IFC TypeScript's redaction of text. */
export function clean(a: Attrs): Attrs {
  return Object.fromEntries(
    Object.entries(a).map(([k, v]) => [k, typeof v === "string" ? kotel.redactText(v) : v]),
  );
}

/**
 * Start this process's telemetry, as `service` (`archon`, `stolos`, `archon-boot`) unless
 * `OTEL_SERVICE_NAME` says otherwise. Safe to call twice; the first call wins.
 */
export function initTelemetry(service = "archon", version?: string): void {
  if (started !== undefined) return;
  scope = { name: service, ...(version === undefined ? {} : { version }) };
  started = otel.startTelemetry({
    registry: ARCHON_SIGNALS,
    service,
    ...(version === undefined ? {} : { version }),
  });
}

/** A span opened now and ended later by the caller (a run, a phase), under `parent`. */
function open(
  kind: SpanName,
  attrs: Attrs,
  parent: kotel.SpanContext | undefined,
): Open | undefined {
  if (started === undefined) return undefined;
  let handle: signals.SpanHandle<Kinds, SpanName> | undefined;
  let end: ((r: Result<void, string>) => void) | undefined;
  void started.telemetry.span(
    kind,
    clean(attrs),
    (s) => {
      handle = s;
      return new Promise<Result<void, string>>((resolve) => (end = resolve));
    },
    parent === undefined ? {} : { parent },
  );
  return handle === undefined || end === undefined ? undefined : { handle, end };
}

/** This run's traceparent, to hand to the next process (MCP, SSH), or undefined. */
export function currentTraceparent(): string | undefined {
  return root?.handle.traceparent;
}

/** The metrics of one kind. */
type MetricOf<S extends "counter" | "histogram" | "gauge"> = {
  [K in MetricName]: (typeof METRICS)[K]["kind"] extends S ? K : never;
}[MetricName];

const isCounter = (n: MetricName): n is MetricOf<"counter"> => METRICS[n].kind === "counter";
const isHistogram = (n: MetricName): n is MetricOf<"histogram"> => METRICS[n].kind === "histogram";
const isGauge = (n: MetricName): n is MetricOf<"gauge"> => METRICS[n].kind === "gauge";

/** Add to a counter declared in signals.ts. */
export function count(name: MetricName, n = 1, attrs: Attrs = {}): void {
  if (started === undefined || n === 0 || !isCounter(name)) return;
  void started.telemetry.add(name, n, clean({ ...runAttrs, ...attrs }));
}

/** Record a histogram or gauge value declared in signals.ts. */
export function measure(name: MetricName, v: number, attrs: Attrs = {}): void {
  if (started === undefined) return;
  const a = clean({ ...runAttrs, ...attrs });
  if (isHistogram(name)) void started.telemetry.record(name, v, a);
  else if (isGauge(name)) void started.telemetry.set(name, v, a);
}

/** Start this run's trace (continuing `TRACEPARENT` when given): one `archon.run` span. */
export function startRun(command: string, attrs: Attrs = {}): void {
  if (started === undefined || root !== undefined) return;
  Object.assign(runAttrs, clean({ "archon.command": command, ...attrs }));
  startedAt = performance.now();
  root = open("archon.run", runAttrs, undefined);
  if (typeof runAttrs["archon.engine.version"] === "string") measure("archon.engine.info", 1);
}

/** A child span of the run (`archon.query`, `archon.remote`): call the returned function to end it. */
export function span(
  name: "archon.query" | "archon.remote",
  attrs: Attrs = {},
): (ok?: boolean) => void {
  const s = open(name, attrs, root?.handle.context);
  if (s === undefined) return () => {};
  return (good = true) => s.end(good ? ok(undefined) : err(`${name} failed`));
}

/**
 * Spec 049 FR-010: a finished phase is also an `archon.phase` event, an OTLP log record in the
 * phase's span (its name, its level, its summary line). The registry gives the name `archon.phase`
 * to the span (spec 096: names are declared once), so the record is handed to the pipeline as made
 * here, redacted the same way.
 */
function phaseEvent(name: string, level: string, summary: string, at: kotel.SpanContext): void {
  if (started === undefined) return;
  const severity: kotel.SeverityNumber = level === "fail" ? 17 : level === "warn" ? 13 : 9;
  const time = BigInt(Date.now()) * 1_000_000n;
  const record: kotel.LogRecord = {
    time,
    observedTime: time,
    severityNumber: severity,
    severityText: kotel.severityText(severity),
    body: kotel.redactText(`${name}: ${summary}`),
    attributes: clean({ "archon.phase": name, "archon.phase.level": level }),
    droppedAttributesCount: 0,
    eventName: "archon.phase",
    traceId: at.traceId,
    spanId: at.spanId,
    traceFlags: at.traceFlags,
  };
  started.pipeline.emit({ kind: "log", record }, { resource: started.pipeline.resource, scope });
}

/** UI phases become `archon.phase` spans, children of the run's span, and `archon.phase` events. */
export const phaseListener = {
  start(name: string): void {
    const s = open("archon.phase", { "archon.phase": name }, root?.handle.context);
    if (s !== undefined) phases.set(name, s);
  },
  end(name: string, level: string, summary: string): void {
    const s = phases.get(name);
    if (s === undefined) return;
    s.handle.set({ "archon.phase.result": kotel.redactText(summary), "archon.phase.level": level });
    phaseEvent(name, level, summary, s.handle.context);
    s.end(level === "fail" ? err(kotel.redactText(`${name}: ${summary}`)) : ok(undefined));
    phases.delete(name);
  },
};

/** End this run's trace with its outcome. */
export function endRun(code: number, failures: number, warnings: number): void {
  if (root === undefined) return;
  const outcome = code === 0 && failures === 0 ? "ok" : "failed";
  measure("archon.run.duration", (performance.now() - startedAt) / 1000, {
    "archon.outcome": outcome,
  });
  count("archon.run.problems", failures, { "archon.level": "fail" });
  count("archon.run.problems", warnings, { "archon.level": "warn" });
  for (const s of phases.values()) s.end(ok(undefined));
  phases.clear();
  root.handle.set({ "archon.outcome": outcome });
  lastRoot = root;
  root.end(outcome === "ok" ? ok(undefined) : err(`exit ${code}, ${failures} failed`));
  root = undefined;
}

/** archon verify: how many checks passed and failed. */
export function recordChecks(passed: number, failed: number): void {
  count("archon.verify.checks", passed, { "archon.result": "passed" });
  count("archon.verify.checks", failed, { "archon.result": "failed" });
}

/** archon apply: how many changes it made (or would make, with --check). */
export function recordChanges(n: number, check: boolean): void {
  count("archon.apply.changes", n, { "archon.check": check });
}

/** A problem as the run reported it (the UI's `Problem`). */
export type ProblemRecord = {
  readonly level: "warn" | "fail" | "pending" | "action";
  readonly phase: string;
  readonly message: string;
  readonly fix?: string | undefined;
  readonly code?: string | undefined;
};

/**
 * Spec 049: the run's problems as `archon.problem` log records in the run's trace (the terminal
 * and the run log print the same facts), then the pipeline flushed and shut down, within 3 seconds.
 * Silent where nothing listens.
 */
export async function flushEvents(problems: readonly ProblemRecord[]): Promise<void> {
  if (started === undefined) return;
  const run = root ?? lastRoot;
  for (const p of problems) {
    const attrs: Attrs = {
      "archon.phase": p.phase,
      "archon.level": p.level,
      ...(p.fix === undefined ? {} : { "archon.fix": kotel.redactText(p.fix) }),
      ...(p.code === undefined ? {} : { "archon.code": p.code }),
    };
    // Spec 052: not set up yet is information, not a problem.
    const severity: kotel.SeverityNumber = p.level === "fail" ? 17 : p.level === "warn" ? 13 : 9;
    // A span's handle emits into its trace even after the span ended (endRun comes first).
    const body = kotel.redactText(p.message);
    if (run !== undefined) run.handle.log("archon.problem", clean(attrs), body, { severity });
    else started.telemetry.log("archon.problem", clean(attrs), body, { severity });
  }
  // Spec 049 FR-010: best effort, 3 seconds at most.
  await started.pipeline.shutdown(3000);
}
