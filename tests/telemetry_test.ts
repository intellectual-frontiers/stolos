// Spec 049-telemetry (Article 27): every signal is declared once; a run is a
// trace that can continue one begun elsewhere; nothing secret is sent; the
// boot server is the fleet's collector when there is no other.

import { assert, assertEquals, assertStringIncludes } from "./assert.ts";
import { ATTRIBUTES, METRICS, RESOURCE, SPANS } from "../src/archon/telemetry/signals.ts";
import { clean, parseTraceparent } from "../src/archon/core/telemetry.ts";
import { telemetryMarkdown } from "../src/archon/render/man.ts";
import { otlpHandler } from "../src/archon-boot/telemetry.ts";
import { centralConfig } from "../src/archon/observe/discover.ts";
import { sandbox } from "./sandbox.ts";

Deno.test("049: one list of signals, and its man page names every one", () => {
  const page = telemetryMarkdown();
  for (const name of Object.keys(METRICS)) {
    assert(/^archon\.[a-z_.]+$/.test(name), name);
    assertStringIncludes(page, `\`${name}\``);
  }
  for (const m of Object.values(METRICS)) {
    for (const a of m.attributes) assert(a in ATTRIBUTES, `${a} is declared`);
  }
  for (const n of [...Object.keys(SPANS), ...Object.keys(RESOURCE)]) assertStringIncludes(page, n);
});

Deno.test("049: traceparent is parsed strictly; attributes never carry a secret", () => {
  const tp = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
  assertEquals(parseTraceparent(tp), {
    traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
    spanId: "00f067aa0ba902b7",
    traceFlags: 1,
    isRemote: true,
  });
  assertEquals(
    parseTraceparent("00-00000000000000000000000000000000-00f067aa0ba902b7-01"),
    undefined,
  );
  assertEquals(parseTraceparent("garbage"), undefined);
  const c = clean({ "archon.phase.result": 'token="abcdefghijklmnop"', n: 3 });
  assert(!String(c["archon.phase.result"]).includes("abcdefghijklmnop"));
  assertEquals(c.n, 3);
});

Deno.test("049: a run exports its trace (continuing TRACEPARENT) and its metrics", async () => {
  const got: Array<{ path: string; body: string }> = [];
  const server = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen() {} }, async (req) => {
    got.push({ path: new URL(req.url).pathname, body: await req.text() });
    return new Response("{}", { headers: { "content-type": "application/json" } });
  });
  const sb = await sandbox("archon-otel-test-");
  try {
    const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";
    const parent = "00f067aa0ba902b7";
    const r = await sb.run("src/archon/main.ts", ["validate"], "", {
      OTEL_DENO: "true",
      OTEL_SERVICE_NAME: "archon",
      OTEL_EXPORTER_OTLP_PROTOCOL: "http/json",
      OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${server.addr.port}`,
      OTEL_METRIC_EXPORT_INTERVAL: "100",
      OTEL_RESOURCE_ATTRIBUTES: "service.namespace=lab",
      TRACEPARENT: `00-${traceId}-${parent}-01`,
      // The exporter honors proxy settings: the local sink is reached directly.
      HTTP_PROXY: "",
      HTTPS_PROXY: "",
      NO_PROXY: "127.0.0.1,localhost",
    });
    assertEquals(r.code, 0, r.out);
    // Compact, whatever spacing the exporter used.
    const compact = (b: string) => JSON.stringify(JSON.parse(b));
    const all = got.map((g) => compact(g.body)).join("\n");
    const traces = got.filter((g) => g.path === "/v1/traces").map((g) => compact(g.body)).join(
      "\n",
    );
    assertStringIncludes(traces, '"name":"archon validate"');
    assertStringIncludes(traces, `"traceId":"${traceId}"`);
    assertStringIncludes(traces, `"parentSpanId":"${parent}"`);
    assertStringIncludes(traces, "archon.engine.version");
    assertStringIncludes(all, '"stringValue":"lab"');
    assertStringIncludes(traces, '"name":"Model"', "each phase is a span");
    const metrics = got.filter((g) => g.path === "/v1/metrics").map((g) => compact(g.body)).join(
      "\n",
    );
    assertStringIncludes(metrics, "archon.run.duration");
    assertStringIncludes(metrics, "archon.engine.info");
  } finally {
    await server.shutdown();
    await Deno.remove(sb.home, { recursive: true });
  }
});

Deno.test("049: the boot server keeps the fleet's OTLP JSON (gzip too), and nothing else", async () => {
  const dir = await Deno.makeTempDir({ prefix: "archon-fleet-otlp-" });
  try {
    const handle = otlpHandler(dir, { days: 7, bytes: 1e9 }, "/otlp");
    const body = JSON.stringify({ resourceLogs: [] });
    let r = await handle(new Request("http://pc:8080/otlp/v1/logs", { method: "POST", body }));
    assertEquals(r.status, 200);
    const gz = await new Response(
      new Blob([JSON.stringify({ resourceSpans: [] })]).stream().pipeThrough(
        new CompressionStream("gzip"),
      ),
    ).arrayBuffer();
    r = await handle(
      new Request("http://pc:8080/otlp/v1/traces", {
        method: "POST",
        body: gz,
        headers: { "content-encoding": "gzip" },
      }),
    );
    assertEquals(r.status, 200);
    r = await handle(
      new Request("http://pc:8080/otlp/v1/logs", { method: "POST", body: "\x0a\x00" }),
    );
    assertEquals(r.status, 415, "protobuf is not kept");
    r = await handle(new Request("http://pc:8080/otlp/v1/other", { method: "POST", body }));
    assertEquals(r.status, 404);
    const files = [...Deno.readDirSync(dir)].map((e) => e.name);
    assertEquals(files.length, 1);
    const lines = Deno.readTextFileSync(`${dir}/${files[0]}`).trim().split("\n");
    assertEquals(lines.length, 2);
    assertStringIncludes(lines[1], "resourceSpans");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("049: with no other collector, servers forward to the boot server as JSON", async () => {
  const { candidates } = await import("../src/archon/observe/discover.ts");
  const { site } = await import("../examples/fleets/lab/site.ts");
  const { fleet, host } = await import("./fixtures.ts");
  const found = await candidates({ ...fleet(), site }, host());
  const last = found.at(-1)!;
  assertEquals(last.source, "boot");
  assertEquals(last.endpoint, `http://${site.bootServer.address}:${site.bootServer.http}/otlp`);
  const boot = JSON.parse(centralConfig(last.endpoint, ["a"], "boot").replace(/^#.*\n/, ""));
  assertEquals(boot.exporters["otlphttp/central"].encoding, "json");
  const real = JSON.parse(centralConfig("http://otel:4318", ["a"], "dns").replace(/^#.*\n/, ""));
  assertEquals(real.exporters["otlphttp/central"].encoding, undefined);
});
