/**
 * The end-to-end lab (tests/e2e/ci.sh), spec 049: was the install one trace? Finds the boot
 * server's run span for `install <host>` in its OTLP files, then a span in the same trace among
 * what the host sent (the fleet collector's files). Prints the trace id and the host's span
 * names; exits 1 when there is none.
 *
 * Usage: `bun tests/e2e/trace.ts <boot telemetry dir> <host>`.
 *
 * @module
 */
import { fs, path, proc } from "@intellectual-frontiers/ifc-ts/runtime";

const [dir = ".", host = ""] = proc.args;

/** A span, as far as this check reads it. */
type Span = { readonly traceId: string; readonly name: string; readonly command: string };

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

function spans(folder: string): Span[] {
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
            out.push({ traceId, name, command: attribute(s, "archon.command") });
          }
        }
      }
    }
  }
  return out;
}

// The install's span: named `install <host>`, or (spec 096: span names are kinds) a run span
// whose command is `install <host>`.
const install = spans(dir).find(
  (s) => s.name === `install ${host}` || s.command === `install ${host}`,
);
if (install === undefined) {
  console.log(`no "install ${host}" span in ${dir}`);
  proc.exit(1);
}
const fromHost = spans(path.join(dir, "fleet")).filter((s) => s.traceId === install.traceId);
console.log(
  `trace ${install.traceId}: ${fromHost.length} span(s) from ${host}: ${[
    ...new Set(fromHost.map((s) => s.name)),
  ]
    .slice(0, 8)
    .join(", ")}`,
);
proc.exit(fromHost.length > 0 ? 0 : 1);
