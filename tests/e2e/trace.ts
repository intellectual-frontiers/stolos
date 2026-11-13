// The end-to-end lab (tests/e2e/ci.sh), spec 049: was the install one trace?
// Finds the boot server's span "install <host>" in its OTLP files, then a span
// in the same trace among what the host sent (the fleet collector's files).
// usage: deno run -A tests/e2e/trace.ts <boot telemetry dir> <host>
// prints the trace id and the host's span names; exits 1 when there is none.

const [dir, host] = Deno.args;

interface Span {
  traceId: string;
  name: string;
}

function spans(folder: string): Span[] {
  const out: Span[] = [];
  let names: string[] = [];
  try {
    names = [...Deno.readDirSync(folder)].filter((e) => e.isFile && e.name.endsWith(".jsonl"))
      .map((e) => e.name);
  } catch {
    return out;
  }
  for (const n of names) {
    for (const line of Deno.readTextFileSync(`${folder}/${n}`).split("\n")) {
      if (!line.trim()) continue;
      try {
        const j = JSON.parse(line) as {
          resourceSpans?: Array<{ scopeSpans?: Array<{ spans?: Span[] }> }>;
        };
        for (const rs of j.resourceSpans ?? []) {
          for (const ss of rs.scopeSpans ?? []) out.push(...(ss.spans ?? []));
        }
      } catch { /* not OTLP JSON */ }
    }
  }
  return out;
}

const install = spans(dir).find((s) => s.name === `install ${host}`);
if (!install) {
  console.log(`no "install ${host}" span in ${dir}`);
  Deno.exit(1);
}
const fromHost = spans(`${dir}/fleet`).filter((s) => s.traceId === install.traceId);
console.log(
  `trace ${install.traceId}: ${fromHost.length} span(s) from ${host}: ${
    [...new Set(fromHost.map((s) => s.name))].slice(0, 8).join(", ")
  }`,
);
Deno.exit(fromHost.length ? 0 : 1);
