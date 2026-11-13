// The boot server's own telemetry (spec 023). Deno's built-in OpenTelemetry
// sends OTLP/JSON to a receiver inside the boot server (127.0.0.1:4319), which
// writes it to local files only: one OTLP JSON line per batch, the format
// OpenTelemetry's file exporter and otlpjsonfile receiver use, in daily files
// kept 30 days and 256 MB at most. Nothing leaves the PC; when otel-tui runs
// on the PC (OTLP on 127.0.0.1:4318), each batch is also handed to it.
//
// Spec 049: the boot server is also the fleet's default collector. Servers
// that find no other (fleet.telemetry, or otel.localdomain) send their
// telemetry to http://<boot PC>:<http port>/otlp, kept a week (ephemeral).
//
// Each install is one trace, "install <host>", with a span per step.

import { type ArchonEvent, toLogsRequest } from "../archon/telemetry/events.ts";
import { join } from "../archon/core/path.ts";
import { ensureDir } from "../archon/core/fsx.ts";
import { P } from "../archon/core/paths.ts";

export const TELEMETRY_DIR = join(P.bootCache, "telemetry");
export const SINK = { hostname: "127.0.0.1", port: 4319 };
const KEEP_DAYS = 30;
const KEEP_BYTES = 256 * 1024 * 1024;
const OTEL_TUI = "http://127.0.0.1:4318";

// ------------------------------------------------------------------- sink

async function prune(dir: string, keepDays = KEEP_DAYS, keepBytes = KEEP_BYTES) {
  const files: Array<{ name: string; size: number }> = [];
  for await (const e of Deno.readDir(dir)) {
    if (e.isFile && /^otlp-\d{4}-\d{2}-\d{2}\.jsonl$/.test(e.name)) {
      files.push({ name: e.name, size: (await Deno.stat(join(dir, e.name))).size });
    }
  }
  files.sort((a, b) => a.name.localeCompare(b.name)); // oldest first
  const cutoff = new Date(Date.now() - keepDays * 86_400_000).toISOString().slice(0, 10);
  let total = files.reduce((n, f) => n + f.size, 0);
  for (const f of files.slice(0, -1)) {
    if (f.name.slice(5, 15) >= cutoff && total <= keepBytes) break;
    await Deno.remove(join(dir, f.name)).catch(() => {});
    total -= f.size;
  }
}

/** Where the fleet's servers' telemetry lands when the boot PC is their collector (spec 049). */
export const FLEET_TELEMETRY_DIR = join(TELEMETRY_DIR, "fleet");
/** The fleet collector is ephemeral: a week, 512 MB at most. */
export const FLEET_KEEP = { days: 7, bytes: 512 * 1024 * 1024 };
/** Under the boot server's HTTP port, which the servers already reach (spec 049). */
export const FLEET_OTLP_PATH = "/otlp";

/**
 * A handler for OTLP/HTTP with JSON bodies (gzip or not): each batch becomes
 * one line of a daily file in `dir`, pruned to `keep`; when otel-tui runs on
 * this PC, the batch is also handed to it. Paths are /v1/traces, /v1/metrics,
 * /v1/logs after `prefix`.
 */
export function otlpHandler(
  dir: string,
  keep: { days: number; bytes: number },
  prefix = "",
): (req: Request) => Promise<Response> {
  let tuiDownUntil = 0;
  let lastDay = "";
  let ready: Promise<void> | undefined;
  return async (req: Request) => {
    ready ??= ensureDir(dir).then(() => prune(dir, keep.days, keep.bytes));
    await ready;
    const path = new URL(req.url).pathname.slice(prefix.length);
    if (req.method !== "POST" || !/^\/v1\/(traces|metrics|logs)$/.test(path)) {
      return new Response("not found\n", { status: 404 });
    }
    let body: string;
    try {
      body = req.headers.get("content-encoding") === "gzip"
        ? await new Response(req.body!.pipeThrough(new DecompressionStream("gzip"))).text()
        : await req.text();
    } catch {
      return new Response("bad body\n", { status: 400 });
    }
    try {
      const line = JSON.stringify(JSON.parse(body)) + "\n";
      const day = new Date().toISOString().slice(0, 10);
      await Deno.writeTextFile(join(dir, `otlp-${day}.jsonl`), line, { append: true });
      if (day !== lastDay) {
        lastDay = day;
        await prune(dir, keep.days, keep.bytes);
      }
    } catch {
      return new Response("only OTLP JSON\n", { status: 415 });
    }
    // otel-tui, when it runs on this PC: best effort, never waited on for long.
    if (Date.now() > tuiDownUntil) {
      fetch(OTEL_TUI + path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        signal: AbortSignal.timeout(1000),
      }).then((r) => r.body?.cancel()).catch(() => {
        tuiDownUntil = Date.now() + 30_000;
      });
    }
    return new Response("{}", { headers: { "content-type": "application/json" } });
  };
}

/**
 * Spec 049: record events as OpenTelemetry log records, the source of what the
 * window and boot.log show: one OTLP logs request per event, in the same daily
 * files as the boot server's other telemetry (and to otel-tui when it runs).
 */
export async function recordEvents(
  events: ArchonEvent[],
  resource: Record<string, string>,
  dir = TELEMETRY_DIR,
): Promise<void> {
  if (!events.length) return;
  const body = JSON.stringify(toLogsRequest(events, resource, "archon-boot"));
  await ensureDir(dir);
  const day = new Date().toISOString().slice(0, 10);
  await Deno.writeTextFile(join(dir, `otlp-${day}.jsonl`), body + "\n", { append: true });
  fetch(OTEL_TUI + "/v1/logs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
    signal: AbortSignal.timeout(1000),
  }).then((r) => r.body?.cancel()).catch(() => {});
}

/** Receive the boot server's own OTLP/JSON on 127.0.0.1:4319 and keep it in local files. */
export async function startSink(dir = TELEMETRY_DIR): Promise<void> {
  await ensureDir(dir);
  await prune(dir);
  const handle = otlpHandler(dir, { days: KEEP_DAYS, bytes: KEEP_BYTES });
  Deno.serve({ ...SINK, onListen() {} }, handle);
}

// ------------------------------------------------------- instrumentation

type Attrs = Record<string, string | number | boolean>;
interface Span {
  setAttribute(k: string, v: string | number | boolean): void;
  setStatus(s: { code: number }): void;
  end(): void;
}
interface Api {
  trace: {
    getTracer(n: string): {
      startSpan(name: string, o?: { attributes?: Attrs }, ctx?: unknown): Span;
    };
    setSpan(ctx: unknown, s: Span): unknown;
  };
  context: { active(): unknown };
  metrics: {
    getMeter(n: string): {
      createCounter(n: string, o?: { unit?: string; description?: string }): {
        add(v: number, a?: Attrs): void;
      };
      createHistogram(n: string, o?: { unit?: string; description?: string }): {
        record(v: number, a?: Attrs): void;
      };
    };
  };
  SpanStatusCode: { OK: number; ERROR: number };
}

let api: Api | undefined;

export async function initBootTelemetry(): Promise<void> {
  if (!Deno.env.get("OTEL_DENO")) return;
  try {
    api = (await import("npm:@opentelemetry/api@1.9.0")) as unknown as Api;
  } catch {
    api = undefined;
  }
}

interface Install {
  root: Span;
  ctx: unknown;
  step?: Span;
  stepName?: string;
  started: number;
}
const installs = new Map<string, Install>();

/** The install of `host` reached `step`: it ends the previous step and starts this one. */
export function installStep(host: string, step: string, attrs: Attrs = {}): void {
  if (!api) return;
  const tracer = api.trace.getTracer("archon-boot");
  let i = installs.get(host);
  if (!i) {
    const root = tracer.startSpan(`install ${host}`, { attributes: { "host.name": host } });
    i = { root, ctx: api.trace.setSpan(api.context.active(), root), started: performance.now() };
    installs.set(host, i);
  }
  if (i.stepName === step) return;
  i.step?.end();
  i.stepName = step;
  i.step = tracer.startSpan(step, { attributes: { "host.name": host, ...attrs } }, i.ctx);
}

/** A failed step: marked on the step and the install, which goes on. */
export function installProblem(host: string, message: string): void {
  const i = installs.get(host);
  if (!api || !i) return;
  i.step?.setAttribute("archon.problem", message);
  i.step?.setStatus({ code: api.SpanStatusCode.ERROR });
  i.root.setStatus({ code: api.SpanStatusCode.ERROR });
}

/** The install ended (Ready, or done with problems). */
export function installEnd(host: string, ok: boolean, summary: string): void {
  const i = installs.get(host);
  if (!api || !i) return;
  i.step?.end();
  i.root.setAttribute("archon.result", summary);
  i.root.setStatus({ code: ok ? api.SpanStatusCode.OK : api.SpanStatusCode.ERROR });
  i.root.end();
  installs.delete(host);
  const meter = api.metrics.getMeter("archon-boot");
  const a = { "host.name": host, "archon.outcome": ok ? "ok" : "failed" };
  meter.createCounter("archon.boot.installs", { description: "Installs that finished" }).add(1, a);
  meter.createHistogram("archon.boot.install.duration", {
    unit: "s",
    description: "From network boot to Ready",
  }).record((performance.now() - i.started) / 1000, a);
}

/** Bytes the boot server sent, by file (TFTP and HTTP). */
export function served(file: string, bytes: number, via: string): void {
  api?.metrics.getMeter("archon-boot").createCounter("archon.boot.served", {
    unit: "By",
    description: "Bytes served",
  }).add(bytes, { "archon.file": file, "network.protocol.name": via });
}
