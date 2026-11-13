// `deno task boot observe` (spec 023): recent installs from the boot server's
// own telemetry (the OTLP JSON files on this PC): when, how long, which step
// took the time, and what failed.

import { join } from "../archon/core/path.ts";
import { exists } from "../archon/core/fsx.ts";
import { TELEMETRY_DIR } from "./telemetry.ts";

interface OtlpSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  status?: { code?: number | string };
  attributes?: Array<{ key: string; value: { stringValue?: string } }>;
}

export interface Install {
  name: string;
  start: Date;
  seconds: number;
  ok: boolean;
  result?: string;
  steps: Array<{ name: string; seconds: number; ok: boolean; problem?: string }>;
}

const secs = (s: OtlpSpan) => (Number(s.endTimeUnixNano) - Number(s.startTimeUnixNano)) / 1e9;
const failed = (s: OtlpSpan) => s.status?.code === 2 || s.status?.code === "STATUS_CODE_ERROR";
const attr = (s: OtlpSpan, k: string) => s.attributes?.find((a) => a.key === k)?.value.stringValue;

/** Installs (root spans "install <host>") with their steps, newest first. */
export function installsFrom(lines: string[]): Install[] {
  const spans: OtlpSpan[] = [];
  for (const line of lines) {
    try {
      const j = JSON.parse(line);
      for (const rs of j.resourceSpans ?? []) {
        for (const ss of rs.scopeSpans ?? []) spans.push(...(ss.spans ?? []));
      }
    } catch { /* a partial line */ }
  }
  return spans
    .filter((s) => !s.parentSpanId && s.name.startsWith("install "))
    .map((root) => ({
      name: root.name.slice("install ".length),
      start: new Date(Number(root.startTimeUnixNano) / 1e6),
      seconds: secs(root),
      ok: !failed(root),
      result: attr(root, "archon.result"),
      steps: spans
        .filter((s) => s.traceId === root.traceId && s.parentSpanId === root.spanId)
        .sort((a, b) => Number(a.startTimeUnixNano) - Number(b.startTimeUnixNano))
        .map((s) => ({
          name: s.name,
          seconds: secs(s),
          ok: !failed(s),
          problem: attr(s, "archon.problem"),
        })),
    }))
    .sort((a, b) => b.start.getTime() - a.start.getTime());
}

const dur = (s: number) =>
  s >= 60
    ? `${Math.floor(s / 60)}m${String(Math.round(s % 60)).padStart(2, "0")}s`
    : `${s.toFixed(s < 10 ? 1 : 0)}s`;

export async function bootObserve(o: { count: number }): Promise<number> {
  if (!(await exists(TELEMETRY_DIR))) {
    console.log(`No telemetry yet: deno task boot serve writes it to ${TELEMETRY_DIR}.`);
    return 0;
  }
  const lines: string[] = [];
  const files: string[] = [];
  for await (const e of Deno.readDir(TELEMETRY_DIR)) {
    if (e.isFile && e.name.endsWith(".jsonl")) files.push(e.name);
  }
  for (const f of files.sort()) {
    lines.push(...(await Deno.readTextFile(join(TELEMETRY_DIR, f))).split("\n"));
  }
  const installs = installsFrom(lines).slice(0, o.count);
  if (!installs.length) {
    console.log(`No installs recorded yet (${TELEMETRY_DIR}).`);
    return 0;
  }
  for (const i of installs) {
    console.log(
      `${i.ok ? "✓" : "✗"} ${i.name}  ${i.start.toLocaleString()}  ${dur(i.seconds)}${
        i.result ? `  ${i.result}` : ""
      }`,
    );
    const slowest = Math.max(...i.steps.map((s) => s.seconds));
    for (const s of i.steps) {
      const bar = "█".repeat(Math.max(1, Math.round((s.seconds / (slowest || 1)) * 20)));
      console.log(
        `    ${s.ok ? " " : "✗"} ${s.name.padEnd(34)} ${dur(s.seconds).padStart(7)}  ${bar}${
          s.problem ? `  ${s.problem}` : ""
        }`,
      );
    }
  }
  console.log(`\n(OpenTelemetry files: ${TELEMETRY_DIR}; live: otel-tui, while boot serve runs)`);
  return 0;
}
