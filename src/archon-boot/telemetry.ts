/**
 * The boot server's own telemetry (spec 023, on IFC TypeScript since spec 096). The boot server's
 * signals are IFC TypeScript's (`runtime/otel`), in-process: started once with
 * {@link initBootTelemetry}, they are kept in a journal in the boot cache (OTLP JSON lines,
 * OpenTelemetry's file format, rotated by size: 256 MB at most, and kept 30 days) and sent over
 * OTLP/HTTP to otel-tui while it runs on this PC (`localhost:4318`, the pipeline's default; silent
 * where nothing listens). Nothing else leaves the
 * PC. There is no restart to turn telemetry on.
 *
 * Spec 049: the boot server is also the fleet's default collector. Servers that find no other
 * (fleet.telemetry, or otel.localdomain) send their telemetry to http://<boot PC>:<http port>/otlp,
 * which IFC TypeScript's OTLP receiver decodes; it is kept a week (ephemeral) in daily files.
 *
 * Each install is one trace, an `archon.boot.install` span (its host in `host.name`), with an
 * `archon.boot.step` span per step (its name in `archon.boot.step`).
 *
 * ```mermaid
 * flowchart LR
 *   boot["boot serve"] -->|"spans, metrics"| journal["telemetry/boot.otlp.jsonl"]
 *   boot -->|"OTLP/HTTP, while it runs"| tui["otel-tui on this PC"]
 *   servers["the fleet's servers"] -->|"POST /otlp/v1/..."| fleet["telemetry/fleet/otlp-date.jsonl"]
 * ```
 *
 * @module
 */

import { err, ok, otlp, type Result, signals } from "@intellectual-frontiers/ifc-ts/kernel";
import type { otel as kotel } from "@intellectual-frontiers/ifc-ts/kernel";
import { fs, otel, path as paths, proc } from "@intellectual-frontiers/ifc-ts/runtime";
import { type ArchonEvent, toLogsRequest } from "../archon/telemetry/events.ts";
import { P } from "../archon/core/paths.ts";
import { VERSION } from "../archon/version.ts";

/** Where the boot server keeps its telemetry. */
export const TELEMETRY_DIR: string = paths.join(P.bootCache, "telemetry");
/** The journal of the boot server's own signals, in {@link TELEMETRY_DIR}. */
export const JOURNAL_FILE = "boot.otlp.jsonl";
/** The journal is rotated at 64 MB, three older files kept (256 MB at most), none past 30 days. */
export const JOURNAL = { maxBytes: 64 * 1024 * 1024, keep: 3, maxAgeDays: 30 };
/**
 * The boot server's daily files of its console lines (`otlp-<date>.jsonl` in
 * {@link TELEMETRY_DIR}, spec 023 SC-001): none past 30 days, 256 MB at most in all.
 */
export const DAILY_KEEP = { days: 30, bytes: 256 * 1024 * 1024 };
const OTEL_TUI = "http://127.0.0.1:4318";

/** Every attribute the boot server's signals carry. */
const INSTALL = { "host.name": "string", "archon.result?": "string" } as const;
const STEP = {
  "host.name": "string",
  "archon.boot.step": "string",
  "client.address?": "string",
  "archon.problem?": "string",
} as const;
const OUTCOME = { "host.name": "string", "archon.outcome": "string" } as const;

/** The boot server's signal registry (spec 023 FR-003): an install, its steps, and its metrics. */
export const BOOT_SIGNALS = signals.defineSignals({
  "archon.boot.install": {
    signal: "span",
    role: "step",
    description: "One install of a host, from its network boot to Ready: the root of its trace.",
    attributes: INSTALL,
  },
  "archon.boot.step": {
    signal: "span",
    role: "detail",
    description: "One step of an install (network boot, downloading Ubuntu, a first-boot phase).",
    attributes: STEP,
  },
  "archon.boot.installs": {
    signal: "counter",
    role: "none",
    unit: "1",
    description: "Installs that finished, by outcome.",
    attributes: OUTCOME,
  },
  "archon.boot.install.duration": {
    signal: "histogram",
    role: "none",
    unit: "s",
    description: "From network boot to Ready.",
    attributes: OUTCOME,
  },
  "archon.boot.served": {
    signal: "counter",
    role: "none",
    unit: "By",
    description: "Bytes served, by file and protocol (TFTP or HTTP).",
    attributes: { "archon.file": "string", "network.protocol.name": "string" },
  },
});

type BootKinds = (typeof BOOT_SIGNALS)["kinds"];
type SpanKind = "archon.boot.install" | "archon.boot.step";

let boot: signals.Telemetry<BootKinds> | undefined;

/**
 * Start the boot server's own telemetry, in this process: on the pipeline already installed, or a
 * new one (service `archon-boot`), with the journal in `dir`. Safe to call twice; the first call wins.
 */
export function initBootTelemetry(dir: string = TELEMETRY_DIR): void {
  if (boot !== undefined) return;
  const pipeline =
    otel.installed() ??
    otel.startTelemetry({ registry: BOOT_SIGNALS, service: "archon-boot", version: VERSION })
      .pipeline;
  pipeline.addProcessor(otel.journalProcessor({ path: paths.join(dir, JOURNAL_FILE), ...JOURNAL }));
  boot = pipeline.telemetry(BOOT_SIGNALS, { name: "archon-boot", version: VERSION });
}

/** Flush the boot server's telemetry and shut its pipeline down (the boot server stops). */
export async function stopBootTelemetry(): Promise<void> {
  boot = undefined;
  // A span ends once its function's promise settles: let the ends just asked for happen first.
  await proc.sleep(0);
  await otel.installed()?.shutdown();
}

// ------------------------------------------------------------------- the fleet's collector

/** The day each folder's daily files were last pruned in this process. */
const pruned = new Map<string, string>();

/**
 * Remove a folder's daily files (`otlp-<date>.jsonl`), oldest first, while any is older than
 * `keepDays` or they hold more than `keepBytes` in all; the newest is always kept.
 */
export async function prune(dir: string, keepDays: number, keepBytes: number): Promise<void> {
  const files: Array<{ name: string; size: number }> = [];
  for await (const e of fs.readDir(dir)) {
    if (e.isFile && /^otlp-\d{4}-\d{2}-\d{2}\.jsonl$/.test(e.name)) {
      files.push({ name: e.name, size: (await fs.stat(paths.join(dir, e.name))).size });
    }
  }
  files.sort((a, b) => a.name.localeCompare(b.name)); // oldest first
  const cutoff = new Date(Date.now() - keepDays * 86_400_000).toISOString().slice(0, 10);
  let total = files.reduce((n, f) => n + f.size, 0);
  for (const f of files.slice(0, -1)) {
    if (f.name.slice(5, 15) >= cutoff && total <= keepBytes) break;
    await fs.remove(paths.join(dir, f.name)).catch(() => undefined);
    total -= f.size;
  }
}

/** Where the fleet's servers' telemetry lands when the boot PC is their collector (spec 049). */
export const FLEET_TELEMETRY_DIR: string = paths.join(TELEMETRY_DIR, "fleet");
/** The fleet collector is ephemeral: a week, 512 MB at most. */
export const FLEET_KEEP = { days: 7, bytes: 512 * 1024 * 1024 };
/** Under the boot server's HTTP port, which the servers already reach (spec 049). */
export const FLEET_OTLP_PATH = "/otlp";

/** Hand a batch to otel-tui when it runs on this PC: best effort, never waited on for long. */
function toTui(path: string, body: string, down: { until: number }): void {
  if (Date.now() <= down.until) return;
  fetch(OTEL_TUI + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
    signal: AbortSignal.timeout(1000),
  })
    .then((r) => r.body?.cancel())
    .catch(() => {
      down.until = Date.now() + 30_000;
    });
}

/**
 * A handler for OTLP/HTTP with JSON bodies (gzip or not), on IFC TypeScript's OTLP receiver: each
 * batch becomes one OTLP JSON line of a daily file in `dir`, pruned to `keep`; when otel-tui runs on
 * this PC, the batch is also handed to it. Paths are /v1/traces, /v1/metrics, /v1/logs after
 * `prefix`; protobuf is refused (415).
 */
export function otlpHandler(
  dir: string,
  keep: { days: number; bytes: number },
  prefix = "",
): (req: Request) => Promise<Response> {
  const tui = { until: 0 };
  let lastDay = "";
  let ready: Promise<void> | undefined;
  const write = async (path: string, json: unknown): Promise<void> => {
    ready ??= fs.ensureDir(dir).then(() => prune(dir, keep.days, keep.bytes));
    await ready;
    const body = JSON.stringify(json);
    const day = new Date().toISOString().slice(0, 10);
    await fs.writeTextFile(paths.join(dir, `otlp-${day}.jsonl`), `${body}\n`, { append: true });
    if (day !== lastDay) {
      lastDay = day;
      await prune(dir, keep.days, keep.bytes);
    }
    toTui(path, body, tui);
  };
  const receive = otel.otlpReceiver({
    onTraces: (b) => write("/v1/traces", otlp.encodeTraces(b)),
    onLogs: (b) => write("/v1/logs", otlp.encodeLogs(b)),
    onMetrics: (b) => write("/v1/metrics", otlp.encodeMetrics(b)),
  });
  return otel.untraced(async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    if (!url.pathname.startsWith(prefix)) return new Response("not found\n", { status: 404 });
    url.pathname = url.pathname.slice(prefix.length) || "/";
    const body =
      req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer();
    return await receive(
      new Request(url, {
        method: req.method,
        headers: req.headers,
        ...(body === undefined ? {} : { body }),
      }),
    );
  });
}

/**
 * Spec 049: record events as OpenTelemetry log records, the source of what the window and boot.log
 * show: one OTLP logs request per batch of events, in a daily file of {@link TELEMETRY_DIR} (and to
 * otel-tui when it runs).
 */
export async function recordEvents(
  events: ArchonEvent[],
  resource: Record<string, string>,
  dir: string = TELEMETRY_DIR,
): Promise<void> {
  if (!events.length) return;
  const body = JSON.stringify(toLogsRequest(events, resource, "archon-boot"));
  await fs.ensureDir(dir);
  const day = new Date().toISOString().slice(0, 10);
  // Kept within the folder's limits: pruned at the first write of each day.
  if (pruned.get(dir) !== day) {
    pruned.set(dir, day);
    await prune(dir, DAILY_KEEP.days, DAILY_KEEP.bytes);
  }
  await fs.writeTextFile(paths.join(dir, `otlp-${day}.jsonl`), body + "\n", { append: true });
  toTui("/v1/logs", body, { until: 0 });
}

// ------------------------------------------------------- instrumentation

/** A span opened now and ended later (an install, a step). */
type Open<K extends SpanKind> = {
  readonly handle: signals.SpanHandle<BootKinds, K>;
  readonly end: (r: Result<void, string>) => void;
};

/** Open a span of `kind` that the caller ends, under `parent` (a new trace where null). */
function open<K extends SpanKind>(
  kind: K,
  attrs: signals.AttributesOf<BootKinds, K>,
  parent: kotel.SpanContext | null,
): Open<K> | undefined {
  if (boot === undefined) return undefined;
  let handle: signals.SpanHandle<BootKinds, K> | undefined;
  let end: ((r: Result<void, string>) => void) | undefined;
  void boot.span(
    kind,
    attrs,
    (s) => {
      handle = s;
      return new Promise<Result<void, string>>((resolve) => (end = resolve));
    },
    { parent },
  );
  return handle === undefined || end === undefined ? undefined : { handle, end };
}

interface Install {
  readonly root: Open<"archon.boot.install">;
  failed: boolean;
  step?: Open<"archon.boot.step"> | undefined;
  stepName?: string;
  stepFailed: boolean;
  readonly started: number;
}
const installs = new Map<string, Install>();

function endStep(i: Install): void {
  i.step?.end(i.stepFailed ? err(`${i.stepName ?? "a step"} failed`) : ok(undefined));
  i.step = undefined;
  i.stepFailed = false;
}

/** The install of `host` reached `step`: it ends the previous step and starts this one. */
export function installStep(
  host: string,
  step: string,
  attrs: { "client.address"?: string } = {},
): void {
  let i = installs.get(host);
  if (!i) {
    const root = open("archon.boot.install", { "host.name": host }, null);
    if (!root) return;
    i = { root, failed: false, stepFailed: false, started: performance.now() };
    installs.set(host, i);
  }
  if (i.stepName === step) return;
  endStep(i);
  i.stepName = step;
  const s = open(
    "archon.boot.step",
    { "host.name": host, "archon.boot.step": step, ...attrs },
    i.root.handle.context,
  );
  if (s) i.step = s;
}

/**
 * Spec 049: the install's trace, as a W3C traceparent, for the host's first boot to continue
 * (undefined when no install is under way).
 */
export function installTraceparent(host: string): string | undefined {
  const i = installs.get(host);
  return i ? (i.step ?? i.root).handle.traceparent : undefined;
}

/** A failed step: marked on the step and the install, which goes on. */
export function installProblem(host: string, message: string): void {
  const i = installs.get(host);
  if (!i) return;
  i.step?.handle.set({ "archon.problem": message });
  i.stepFailed = true;
  i.failed = true;
}

/** The install ended (Ready, or done with problems). */
export function installEnd(host: string, good: boolean, summary: string): void {
  const i = installs.get(host);
  if (!i || boot === undefined) return;
  endStep(i);
  i.root.handle.set({ "archon.result": summary });
  i.root.end(good ? ok(undefined) : err(summary));
  installs.delete(host);
  const a = { "host.name": host, "archon.outcome": good ? "ok" : "failed" };
  boot.add("archon.boot.installs", 1, a);
  boot.record("archon.boot.install.duration", (performance.now() - i.started) / 1000, a);
}

/** Bytes the boot server sent, by file (TFTP and HTTP). */
export function served(file: string, bytes: number, via: string): void {
  boot?.add("archon.boot.served", bytes, { "archon.file": file, "network.protocol.name": via });
}
