/**
 * `bun run stolos boot observe` (spec 023): recent installs from the boot server's
 * own telemetry (the OTLP JSON files on this PC): when, how long, which step
 * took the time, and what failed.
 *
 * @module
 */

import { fs, path } from "@intellectual-frontiers/commons/ts/runtime";
import { ui } from "../archon/core/ui.ts";
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

/** One install, from its root span `archon.boot.install`. */
export interface Install {
  /** The host's name. */
  name: string;
  /** When it started. */
  start: Date;
  /** How long it took, in seconds. */
  seconds: number;
  /** Whether the root span ended without an error. */
  ok: boolean;
  /** Its archon.result attribute (for example "Ready"), if any. */
  result?: string;
  /** Its steps (the root's children), in order, with their durations and any problem. */
  steps: Array<{ name: string; seconds: number; ok: boolean; problem?: string }>;
}

const secs = (s: OtlpSpan): number =>
  (Number(s.endTimeUnixNano) - Number(s.startTimeUnixNano)) / 1e9;
const failed = (s: OtlpSpan): boolean =>
  s.status?.code === 2 || s.status?.code === "STATUS_CODE_ERROR";
const attr = (s: OtlpSpan, k: string): string | undefined =>
  s.attributes?.find((a) => a.key === k)?.value.stringValue;

/** The spans of one line of OTLP JSON (none where it is not one: a partial line). */
function spansOf(line: string): OtlpSpan[] {
  try {
    const j = JSON.parse(line) as {
      resourceSpans?: Array<{ scopeSpans?: Array<{ spans?: OtlpSpan[] }> }>;
    };
    return (j.resourceSpans ?? []).flatMap((rs) =>
      (rs.scopeSpans ?? []).flatMap((ss) => ss.spans ?? []),
    );
  } catch {
    return [];
  }
}

/** Installs (`archon.boot.install` spans) with their steps (`archon.boot.step`), newest first. */
export function installsFrom(lines: string[]): Install[] {
  const spans = lines.flatMap(spansOf);
  return spans
    .filter((s) => !s.parentSpanId && s.name === "archon.boot.install")
    .map((root) => {
      const result = attr(root, "archon.result");
      return {
        name: attr(root, "host.name") ?? "?",
        start: new Date(Number(root.startTimeUnixNano) / 1e6),
        seconds: secs(root),
        ok: !failed(root),
        ...(result === undefined ? {} : { result }),
        steps: spans
          .filter((s) => s.traceId === root.traceId && s.parentSpanId === root.spanId)
          .sort((a, b) => Number(a.startTimeUnixNano) - Number(b.startTimeUnixNano))
          .map((s) => {
            const problem = attr(s, "archon.problem");
            return {
              name: attr(s, "archon.boot.step") ?? s.name,
              seconds: secs(s),
              ok: !failed(s),
              ...(problem === undefined ? {} : { problem }),
            };
          }),
      };
    })
    .sort((a, b) => b.start.getTime() - a.start.getTime());
}

const dur = (s: number): string =>
  s >= 60
    ? `${Math.floor(s / 60)}m${String(Math.round(s % 60)).padStart(2, "0")}s`
    : `${s.toFixed(s < 10 ? 1 : 0)}s`;

/** `bun run stolos boot observe`: the newest `count` installs, each with its slowest and failed steps. */
export async function bootObserve(o: { count: number }): Promise<number> {
  if (!(await fs.exists(TELEMETRY_DIR))) {
    ui.say(`No telemetry yet: bun run stolos boot serve writes it to ${TELEMETRY_DIR}.`);
    return 0;
  }
  const lines: string[] = [];
  const files: string[] = [];
  for await (const e of fs.readDir(TELEMETRY_DIR)) {
    if (e.isFile && /\.jsonl(\.\d+)?$/.test(e.name)) files.push(e.name);
  }
  for (const f of files.sort()) {
    lines.push(...(await fs.readTextFile(path.join(TELEMETRY_DIR, f))).split("\n"));
  }
  const installs = installsFrom(lines).slice(0, o.count);
  if (!installs.length) {
    ui.say(`No installs recorded yet (${TELEMETRY_DIR}).`);
    return 0;
  }
  for (const i of installs) {
    ui.say(
      `${i.ok ? "✓" : "✗"} ${i.name}  ${i.start.toLocaleString()}  ${dur(i.seconds)}${
        i.result ? `  ${i.result}` : ""
      }`,
    );
    const slowest = Math.max(...i.steps.map((s) => s.seconds));
    for (const s of i.steps) {
      const bar = "█".repeat(Math.max(1, Math.round((s.seconds / (slowest || 1)) * 20)));
      ui.say(
        `    ${s.ok ? " " : "✗"} ${s.name.padEnd(34)} ${dur(s.seconds).padStart(7)}  ${bar}${
          s.problem ? `  ${s.problem}` : ""
        }`,
      );
    }
  }
  ui.say(`(OpenTelemetry files: ${TELEMETRY_DIR}; live: otel-tui, while boot serve runs)`);
  return 0;
}
