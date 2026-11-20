/**
 * The end-to-end lab (tests/e2e/ci.sh), spec 049: was the install one trace? Finds the boot
 * server's install span in its OTLP files (spec 023: an `archon.boot.install` span, its host in
 * `host.name`), then a span in the same trace among what the host sent (the fleet collector's
 * files, `fleet/`). Prints the trace id and the host's span names; exits 1 when there is none.
 *
 * Usage: `bun tests/e2e/trace.ts <boot telemetry dir> <host>`.
 *
 * @module
 */
import { fs, path, proc } from "@intellectual-frontiers/system";

/** A span, as far as this check reads it. */
export type Span = { readonly traceId: string; readonly name: string; readonly host: string };

/** A string attribute of an OTLP JSON span. */
function attribute(span: unknown, key: string): string {
  if (typeof span !== "object" || span === null || !("attributes" in span)) return "";
  const attrs = span.attributes;
  if (!Array.isArray(attrs)) return "";
  for (const a of attrs as unknown[]) {
    if (typeof a !== "object" || a === null || !("key" in a) || a.key !== key) continue;
    const v = "value" in a ? a.value : undefined;
    if (typeof v === "object" && v !== null && "stringValue" in v) return String(v.stringValue);
  }
  return "";
}

/** Each element of a field that is an array, or nothing. */
function each(o: unknown, key: string): unknown[] {
  if (typeof o !== "object" || o === null || !(key in o)) return [];
  const v: unknown = (o as Record<string, unknown>)[key];
  return Array.isArray(v) ? (v as unknown[]) : [];
}

/** Every span in the OTLP JSON lines files (`*.jsonl`) of a folder (none when it is missing). */
export function spans(folder: string): Span[] {
  const out: Span[] = [];
  let names: string[];
  try {
    names = fs
      .readDirSync(folder)
      .filter((e) => e.isFile && e.name.endsWith(".jsonl"))
      .map((e) => e.name);
  } catch {
    return out;
  }
  for (const n of names) {
    for (const line of fs.readTextFileSync(path.join(folder, n)).split("\n")) {
      if (line.trim() === "") continue;
      let j: unknown;
      try {
        j = JSON.parse(line);
      } catch {
        continue; // not OTLP JSON
      }
      for (const rs of each(j, "resourceSpans")) {
        for (const ss of each(rs, "scopeSpans")) {
          for (const s of each(ss, "spans")) {
            if (typeof s !== "object" || s === null) continue;
            const traceId = "traceId" in s ? String(s.traceId) : "";
            const name = "name" in s ? String(s.name) : "";
            out.push({ traceId, name, host: attribute(s, "host.name") });
          }
        }
      }
    }
  }
  return out;
}

/** What the check found: the install's trace and the host's spans in it, or why there is none. */
export type InstallTrace =
  { readonly traceId: string; readonly fromHost: readonly Span[] } | { readonly missing: string };

/**
 * The install of `host` as the boot server recorded it in `dir` (spec 023 FR-003: an
 * `archon.boot.install` span whose `host.name` is the host), and the spans of its trace that the
 * host sent to the fleet collector (`dir/fleet`).
 */
export function installTrace(dir: string, host: string): InstallTrace {
  const install = spans(dir).find((s) => s.name === "archon.boot.install" && s.host === host);
  if (install === undefined)
    return { missing: `no archon.boot.install span for ${host} in ${dir}` };
  const fromHost = spans(path.join(dir, "fleet")).filter((s) => s.traceId === install.traceId);
  return { traceId: install.traceId, fromHost };
}

if (import.meta.main) {
  const [dir = ".", host = ""] = proc.args;
  const t = installTrace(dir, host);
  if ("missing" in t) {
    console.log(t.missing);
    proc.exit(1);
  } else {
    const names = [...new Set(t.fromHost.map((s) => s.name))].slice(0, 8).join(", ");
    console.log(`trace ${t.traceId}: ${t.fromHost.length} span(s) from ${host}: ${names}`);
    proc.exit(t.fromHost.length > 0 ? 0 : 1);
  }
}
