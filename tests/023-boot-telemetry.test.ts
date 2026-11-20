/**
 * Spec 023 (the boot server's own telemetry): started in-process with nothing to set, kept in a
 * journal in the boot cache, its console lines as OTLP log records in daily files, and handed to
 * otel-tui while it listens on this PC. Run in a sandboxed child, so the pipeline is the boot
 * server's alone (a test process may already hold another).
 *
 * @module
 */

import { fs, path } from "@intellectual-frontiers/system";
import {
  assert,
  assertEquals,
  assertStringIncludes,
  proves,
} from "@intellectual-frontiers/commons/ts/runtime/test";
import { P } from "../src/archon/core/paths.ts";
import { JOURNAL, JOURNAL_FILE, TELEMETRY_DIR } from "../src/archon-boot/telemetry.ts";
import { installTrace } from "./e2e/trace.ts";
import { at } from "./fixtures.ts";
import { sandbox } from "./sandbox.ts";

/** A boot server's telemetry in a child: started twice (the first wins), one install, one line. */
const CHILD = (src: string, serve: string): string => `
import { initBootTelemetry, installEnd, installStep, installTraceparent, recordEvents, stopBootTelemetry } from ${JSON.stringify(src)};
import { serve } from ${JSON.stringify(serve)};
const dir = process.argv[2];
// otel-tui's address on this PC: listen there when it is free, to see what is handed to it.
const got = [];
let tui;
try {
  tui = await serve({ port: 4318, hostname: "127.0.0.1" }, async (req) => {
    got.push(new URL(req.url).pathname);
    await req.text();
    return new Response("{}", { headers: { "content-type": "application/json" } });
  });
} catch {
  tui = undefined;
}
initBootTelemetry(dir);
initBootTelemetry(dir);
installStep("alpha", "network boot");
const traceparent = installTraceparent("alpha");
installEnd("alpha", true, "Ready");
await recordEvents([{ name: "boot.menu", severity: "info", message: "served the menu to alpha", attrs: {} }], { "service.name": "archon-boot" }, dir);
await stopBootTelemetry();
await new Promise((r) => setTimeout(r, 300));
await tui?.shutdown();
console.log(JSON.stringify({ tui: tui === undefined ? null : got, traceparent }));
`;

proves(
  ["023-boot-telemetry FR-001", "023-boot-telemetry FR-002"],
  "023: boot serve's telemetry starts in-process as archon-boot, into its journal and daily files, and to otel-tui",
  async () => {
    // The journal and its limits: in the boot cache, 64 MB, three older files (256 MB at most).
    assertEquals(TELEMETRY_DIR, path.join(P.bootCache, "telemetry"));
    assertEquals(JOURNAL_FILE, "boot.otlp.jsonl");
    assertEquals([JOURNAL.maxBytes, JOURNAL.keep], [64 * 1024 * 1024, 3]);

    const sb = await sandbox("archon-023-");
    try {
      const script = path.join(sb.home, "boot.ts");
      const dir = path.join(sb.home, "telemetry");
      await fs.writeTextFile(
        script,
        CHILD(
          new URL("../src/archon-boot/telemetry.ts", import.meta.url).href,
          import.meta.resolve("@intellectual-frontiers/net"),
        ),
      );
      // Nothing set: no OTEL_* variable, no flag.
      const r = await sb.run(script, [dir], "", { HTTP_PROXY: "", HTTPS_PROXY: "", NO_PROXY: "*" });
      assertEquals(r.code, 0, r.out);
      const result: unknown = JSON.parse(r.out.trim().split("\n").pop() ?? "{}");

      // The journal: OTLP JSON lines, the install's spans once (started twice, the first won).
      const journal = (await fs.readTextFile(path.join(dir, JOURNAL_FILE)))
        .split("\n")
        .filter((l) => l !== "");
      assert(journal.length > 0);
      for (const l of journal) JSON.parse(l);
      const all = journal.join("\n");
      assertStringIncludes(all, '"stringValue":"archon-boot"');
      assertEquals(all.split('"name":"archon.boot.install"').length - 1, 1, "one install span");
      assertStringIncludes(all, '"name":"archon.boot.step"');

      // The console line: an OTLP log record in telemetry/otlp-<date>.jsonl.
      const day = new Date().toISOString().slice(0, 10);
      const daily = (await fs.readTextFile(path.join(dir, `otlp-${day}.jsonl`))).trim();
      const logs: unknown = JSON.parse(daily);
      assertEquals(
        at(logs, "resourceLogs", 0, "scopeLogs", 0, "logRecords", 0, "body", "stringValue"),
        "served the menu to alpha",
      );

      // While otel-tui listens on 127.0.0.1:4318 the signals are also sent there (when this test
      // could take that port; elsewhere they were dropped silently, as the run above shows).
      const tui = at(result, "tui");
      if (Array.isArray(tui)) {
        assert(tui.includes("/v1/logs"), JSON.stringify(tui));
        assert(tui.includes("/v1/traces"), JSON.stringify(tui));
      }
    } finally {
      await fs.remove(sb.home, { recursive: true });
    }
  },
);

proves(
  ["049-telemetry FR-009"],
  "049: the e2e lab's trace check finds the boot server's install span and the host's spans in its trace",
  async () => {
    const sb = await sandbox("archon-049-");
    try {
      const script = path.join(sb.home, "boot.ts");
      const dir = path.join(sb.home, "telemetry");
      await fs.writeTextFile(
        script,
        CHILD(
          new URL("../src/archon-boot/telemetry.ts", import.meta.url).href,
          import.meta.resolve("@intellectual-frontiers/net"),
        ),
      );
      const r = await sb.run(script, [dir], "", { HTTP_PROXY: "", HTTPS_PROXY: "", NO_PROXY: "*" });
      assertEquals(r.code, 0, r.out);
      const result: unknown = JSON.parse(r.out.trim().split("\n").pop() ?? "{}");
      // The traceparent handed to the host's first boot (/etc/archon/first-boot.env).
      const traceparent = String(at(result, "traceparent"));
      const traceId = traceparent.split("-")[1] ?? "";
      assertEquals(traceId.length, 32, traceparent);

      // What the host sent the fleet collector: one span continuing the install, one not.
      const span = (t: string, name: string): string =>
        JSON.stringify({
          resourceSpans: [{ scopeSpans: [{ spans: [{ traceId: t, spanId: "1", name }] }] }],
        });
      await fs.mkdir(path.join(dir, "fleet"), { recursive: true });
      await fs.writeTextFile(
        path.join(dir, "fleet", "otlp-day.jsonl"),
        `${span(traceId, "archon.run")}\n${span("0".repeat(31) + "1", "archon.phase")}\n`,
      );

      // The check reads the journal as the boot server wrote it: its install span for alpha.
      const found = installTrace(dir, "alpha");
      assert(!("missing" in found), JSON.stringify(found));
      assertEquals(found.traceId, traceId);
      assertEquals(
        found.fromHost.map((s) => s.name),
        ["archon.run"],
      );
      // Another host's install is not there.
      assert("missing" in installTrace(dir, "beta"));
    } finally {
      await fs.remove(sb.home, { recursive: true });
    }
  },
);
