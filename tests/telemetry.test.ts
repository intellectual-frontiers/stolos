/**
 * Spec 049-telemetry (Article 27): every signal is declared once; a run is a trace that can
 * continue one begun elsewhere; nothing secret is sent; the boot server is the fleet's collector
 * when there is no other. Spec 023: the boot server's own install traces, in its journal (on IFC
 * TypeScript's signals since spec 096).
 *
 * @module
 */

import { otel as kotel } from "@intellectual-frontiers/commons/ts/kernel";
import { fs, path, proc } from "@intellectual-frontiers/system";
import { serve } from "@intellectual-frontiers/commons/ts/runtime";
import {
  assert,
  assertEquals,
  assertStringIncludes,
  proves,
  test,
} from "@intellectual-frontiers/commons/ts/runtime/test";
import { ATTRIBUTES, METRICS, RESOURCE, SPANS } from "../src/archon/telemetry/signals.ts";
import { clean } from "../src/archon/core/telemetry.ts";
import { telemetryMarkdown } from "../src/archon/render/man.ts";
import {
  initBootTelemetry,
  installEnd,
  installProblem,
  installStep,
  installTraceparent,
  DAILY_KEEP,
  JOURNAL,
  JOURNAL_FILE,
  otlpHandler,
  recordEvents,
  stopBootTelemetry,
} from "../src/archon-boot/telemetry.ts";
import { installsFrom } from "../src/archon-boot/observe.ts";
import { centralConfig } from "../src/archon/observe/discover.ts";
import { sandbox } from "./sandbox.ts";
import { at, parse } from "./console/tree.ts";

proves(
  ["049-telemetry FR-001"],
  "049: one list of signals, and its man page names every one",
  async () => {
    const page = telemetryMarkdown();
    for (const name of Object.keys(METRICS)) {
      assert(/^archon\.[a-z_.]+$/.test(name), name);
      assertStringIncludes(page, `\`${name}\``);
    }
    for (const m of Object.values(METRICS)) {
      for (const a of m.attributes) assert(a in ATTRIBUTES, `${a} is declared`);
    }
    for (const n of [...Object.keys(SPANS), ...Object.keys(RESOURCE)])
      assertStringIncludes(page, n);
    const { EVENTS } = await import("../src/archon/telemetry/events.ts");
    for (const n of Object.keys(EVENTS)) assertStringIncludes(page, `\`${n}\``);
  },
);

proves(["049-telemetry FR-002"], "049: traceparent is parsed strictly", () => {
  const tp = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
  const r = kotel.parseTraceparent(tp);
  assert(r.kind === "ok");
  assertEquals(r.value.traceId, "4bf92f3577b34da6a3ce929d0e0e4736");
  assertEquals(r.value.spanId, "00f067aa0ba902b7");
  assertEquals(r.value.traceFlags, 1);
  assertEquals(r.value.isRemote, true);
  assertEquals(
    kotel.parseTraceparent("00-00000000000000000000000000000000-00f067aa0ba902b7-01").kind,
    "err",
  );
  assertEquals(kotel.parseTraceparent("garbage").kind, "err");
});

// One redaction (kernel `redactText`) for attributes and for mail: bearer tokens, credentials in
// URLs, keys, and the shapes mail carries (Postfix's api_token:, Cloudflare's tokens).
proves(["049-telemetry FR-005"], "049: attributes pass the same redaction as mail", () => {
  const given = {
    "archon.phase.result": "Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789",
    "archon.fix": "curl https://alice:s3cretpassword@example.net/x",
    "archon.command": "[smtp.mx.cloudflare.net]:465 api_token:abcdef123456",
    "archon.code": "cfut_ZYXWVUTSRQPONMLKJIHGFEDCBA9876543210",
  };
  const c = clean({ ...given, n: 3 });
  assert(!String(c["archon.phase.result"]).includes("abcdefghijklmnopqrstuvwxyz"));
  assert(!String(c["archon.fix"]).includes("s3cretpassword"));
  assert(!String(c["archon.command"]).includes("abcdef123456"));
  assert(!String(c["archon.code"]).includes("ZYXWVUTSRQ"));
  for (const [k, v] of Object.entries(given)) assertEquals(c[k], kotel.redactText(v), k);
  assertEquals(c["n"], 3);
});

proves(
  ["049-telemetry FR-002", "049-telemetry FR-010", "096-bun-runtime FR-008"],
  "049: a run exports its trace (continuing TRACEPARENT), its metrics, and its phases and problems as events",
  async () => {
    const got: Array<{ path: string; body: string }> = [];
    const server = await serve({ port: 0 }, async (req) => {
      got.push({ path: new URL(req.url).pathname, body: await req.text() });
      return new Response("{}", { headers: { "content-type": "application/json" } });
    });
    const sb = await sandbox("archon-otel-test-");
    try {
      const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";
      const parent = "00f067aa0ba902b7";
      const env = {
        OTEL_SERVICE_NAME: "archon",
        OTEL_EXPORTER_OTLP_PROTOCOL: "http/json",
        OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${server.addr.port}`,
        OTEL_METRIC_EXPORT_INTERVAL: "100",
        // Bound each export, so a busy CI runner's slow sink cannot hold the run open at exit.
        OTEL_EXPORTER_OTLP_TIMEOUT: "2000",
        OTEL_BSP_EXPORT_TIMEOUT: "2000",
        OTEL_METRIC_EXPORT_TIMEOUT: "2000",
        OTEL_RESOURCE_ATTRIBUTES: "service.namespace=lab",
        TRACEPARENT: `00-${traceId}-${parent}-01`,
        // The exporter honors proxy settings: the local sink is reached directly.
        HTTP_PROXY: "",
        HTTPS_PROXY: "",
        NO_PROXY: "127.0.0.1,localhost",
      };
      const r = await sb.run("src/stolos/main.ts", ["validate"], "", env);
      assertEquals(r.code, 0, r.out);
      // Compact, whatever spacing the exporter used.
      const compact = (b: string): string => JSON.stringify(JSON.parse(b));
      const all = got.map((g) => compact(g.body)).join("\n");
      const traces = got
        .filter((g) => g.path === "/v1/traces")
        .map((g) => compact(g.body))
        .join("\n");
      assertStringIncludes(traces, '"name":"archon.run"');
      assertStringIncludes(traces, '"key":"archon.command","value":{"stringValue":"validate"}');
      assertStringIncludes(traces, `"traceId":"${traceId}"`);
      assertStringIncludes(traces, `"parentSpanId":"${parent}"`);
      assertStringIncludes(traces, "archon.engine.version");
      assertStringIncludes(all, '"stringValue":"lab"');
      assertStringIncludes(traces, '"name":"archon.phase"', "each phase is a span");
      assertStringIncludes(traces, '"key":"archon.phase","value":{"stringValue":"Model"}');
      // Spec 049 FR-010: each phase is also an archon.phase log record, in the run's trace.
      const logs = got
        .filter((g) => g.path === "/v1/logs")
        .map((g) => compact(g.body))
        .join("\n");
      assertStringIncludes(logs, '"eventName":"archon.phase"', "each phase is an event");
      assertStringIncludes(logs, `"traceId":"${traceId}"`, "in the run's trace");
      assertStringIncludes(logs, '"key":"archon.phase.level","value":{"stringValue":"ok"}');
      // And a problem is an archon.problem log record: `keys` in a sandbox has no keys to find.
      got.length = 0;
      await sb.run("src/stolos/main.ts", ["keys"], "", env);
      const problems = got
        .filter((g) => g.path === "/v1/logs")
        .map((g) => compact(g.body))
        .join("\n");
      assertStringIncludes(problems, '"eventName":"archon.problem"', "each problem is an event");
      assertStringIncludes(problems, '"eventName":"archon.phase"');
      const metrics = got
        .filter((g) => g.path === "/v1/metrics")
        .map((g) => compact(g.body))
        .join("\n");
      assertStringIncludes(metrics, "archon.run.duration");
      assertStringIncludes(metrics, "archon.engine.info");
    } finally {
      await server.shutdown();
      await fs.remove(sb.home, { recursive: true });
    }
  },
);

proves(
  ["049-telemetry FR-006"],
  "049: the boot server keeps the fleet's OTLP JSON (gzip too), and nothing else",
  async () => {
    const dir = await fs.makeTempDir({ prefix: "archon-fleet-otlp-" });
    const json = { "content-type": "application/json" };
    try {
      const handle = otlpHandler(dir, { days: 7, bytes: 1e9 }, "/otlp");
      const body = JSON.stringify({ resourceLogs: [] });
      let r = await handle(
        new Request("http://pc:8080/otlp/v1/logs", { method: "POST", body, headers: json }),
      );
      assertEquals(r.status, 200);
      const gz = await new Response(
        new Blob([JSON.stringify({ resourceSpans: [] })])
          .stream()
          .pipeThrough(new CompressionStream("gzip")),
      ).arrayBuffer();
      r = await handle(
        new Request("http://pc:8080/otlp/v1/traces", {
          method: "POST",
          body: gz,
          headers: { ...json, "content-encoding": "gzip" },
        }),
      );
      assertEquals(r.status, 200);
      r = await handle(
        new Request("http://pc:8080/otlp/v1/logs", {
          method: "POST",
          body: "\x0a\x00",
          headers: { "content-type": "application/x-protobuf" },
        }),
      );
      assertEquals(r.status, 415, "protobuf is not kept");
      r = await handle(
        new Request("http://pc:8080/otlp/v1/other", { method: "POST", body, headers: json }),
      );
      assertEquals(r.status, 404);
      const files = fs.readDirSync(dir).map((e) => e.name);
      assertEquals(files.length, 1);
      const lines = fs
        .readTextFileSync(`${dir}/${files[0] ?? ""}`)
        .trim()
        .split("\n");
      assertEquals(lines.length, 2);
      assertStringIncludes(lines[1] ?? "", "resourceSpans");
    } finally {
      await fs.remove(dir, { recursive: true });
    }
  },
);

proves(
  ["049-telemetry FR-006", "050-telemetry-ui FR-005"],
  "049: with no other collector, servers forward to the boot server as JSON",
  async () => {
    const { candidates } = await import("../src/archon/observe/discover.ts");
    const { site } = await import("../examples/fleets/lab/site.ts");
    const { fleet, host } = await import("./fixtures.ts");
    const found = await candidates({ ...fleet(), site }, host());
    const last = found.at(-1);
    assert(last);
    assertEquals(last.source, "boot");
    assertEquals(last.endpoint, `http://${site.bootServer.address}:${site.bootServer.http}/otlp`);
    const boot = parse(centralConfig(last.endpoint, ["a"], "boot").replace(/^#.*\n/, ""));
    assertEquals(at(boot, "exporters", "otlphttp/central", "encoding"), "json");
    const real = parse(centralConfig("http://otel:4318", ["a"], "dns").replace(/^#.*\n/, ""));
    assertEquals(at(real, "exporters", "otlphttp/central", "encoding"), undefined);
  },
);

proves(
  ["023-boot-telemetry FR-003", "023-boot-telemetry FR-004"],
  "023: an install is one trace with a span per step, kept in the boot server's journal",
  async () => {
    const dir = await fs.makeTempDir({ prefix: "archon-boot-otel-" });
    try {
      initBootTelemetry(dir);
      installStep("alpha", "armed");
      const tp = installTraceparent("alpha");
      assert(
        tp !== undefined && kotel.parseTraceparent(tp).kind === "ok",
        "a traceparent to hand on",
      );
      installStep("alpha", "network boot", { "client.address": "10.0.0.5" });
      installStep("alpha", "downloading Ubuntu");
      installProblem("alpha", "a mirror did not answer");
      installStep("alpha", "rebooting into Ubuntu");
      installEnd("alpha", true, "Ready");
      assertEquals(installTraceparent("alpha"), undefined, "the install is over");
      await stopBootTelemetry();
      const lines = (await fs.readTextFile(path.join(dir, JOURNAL_FILE))).split("\n");
      const [i] = installsFrom(lines);
      assert(i);
      assertEquals(i.name, "alpha");
      assertEquals(i.ok, true);
      assertEquals(i.result, "Ready");
      assertEquals(
        i.steps.map((s) => s.name),
        ["armed", "network boot", "downloading Ubuntu", "rebooting into Ubuntu"],
      );
      const failed = i.steps.find((s) => !s.ok);
      assertEquals(failed?.name, "downloading Ubuntu");
      assertEquals(failed?.problem, "a mirror did not answer");
      const all = lines.join("\n");
      assertStringIncludes(all, "archon.boot.installs");
      assertStringIncludes(all, "archon.boot.install.duration");
    } finally {
      await fs.remove(dir, { recursive: true });
    }
  },
);

test("023: the boot journal rotates at 64 MB, keeps three older files, and nothing past 30 days", () => {
  assertEquals(JOURNAL, { maxBytes: 64 * 1024 * 1024, keep: 3, maxAgeDays: 30 });
});

test("023: the boot server's daily files are kept 30 days, within the telemetry folder's limit", async () => {
  assertEquals(DAILY_KEEP, { days: 30, bytes: 256 * 1024 * 1024 });
  const dir = await fs.makeTempDir({ prefix: "archon-boot-daily-" });
  try {
    await fs.writeTextFile(path.join(dir, "otlp-2020-01-01.jsonl"), "{}\n");
    const recent = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    await fs.writeTextFile(path.join(dir, `otlp-${recent}.jsonl`), "{}\n");
    await recordEvents(
      [{ name: "boot.menu", severity: "info", message: "a menu", attrs: {} }],
      { "service.name": "archon-boot" },
      dir,
    );
    const left = (await fs.listFiles(dir)).sort();
    const today = new Date().toISOString().slice(0, 10);
    assertEquals(left, [`otlp-${recent}.jsonl`, `otlp-${today}.jsonl`].sort());
  } finally {
    await fs.remove(dir, { recursive: true });
  }
});

proves(
  ["049-telemetry FR-003"],
  "049: the launcher sets OTEL_RESOURCE_ATTRIBUTES from the fleet, the host, the engine's tag, and the commit",
  async () => {
    const { LAUNCHER } = await import("../src/archon/capabilities/cli.ts");
    const dir = await fs.makeTempDir({ prefix: "archon-launcher-otel-" });
    try {
      // /etc/archon and /srv/archon as an installed host has them, in a test folder.
      const etc = path.join(dir, "etc");
      const srv = path.join(dir, "srv");
      await fs.mkdir(etc, { recursive: true });
      await fs.mkdir(srv, { recursive: true });
      await fs.writeTextFile(path.join(etc, "fleet"), "lab\n");
      await fs.writeTextFile(path.join(etc, "host"), "alpha\n");
      const { packageJsonText } = await import("../src/archon/fleet/scaffold.ts");
      await fs.writeTextFile(path.join(srv, "package.json"), packageJsonText("stolos-v1.2.3"));
      const git = (...a: string[]) =>
        proc.output(["git", "-C", srv, ...a], { stdout: "piped", stderr: "null" });
      await git("init", "-q", "-b", "main");
      await git("-c", "user.name=t", "-c", "user.email=t@example.invalid", "add", "-A");
      await git(
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@example.invalid",
        "commit",
        "-q",
        "--no-gpg-sign",
        "-m",
        "x",
      );
      const head = new TextDecoder().decode((await git("rev-parse", "HEAD")).stdout).trim();
      const bun = path.join(dir, "bun");
      await fs.writeTextFile(bun, `#!/bin/sh\necho "$OTEL_RESOURCE_ATTRIBUTES"\n`);
      await fs.chmod(bun, 0o755);
      const script = path.join(dir, "archon");
      await fs.writeTextFile(
        script,
        LAUNCHER.replaceAll("/etc/archon/", `${etc}/`)
          .replaceAll("/srv/archon", srv)
          .replaceAll("/usr/local/bin/bun", bun),
      );
      const r = await proc.output(["sh", script, "verify"], {
        env: { OTEL_RESOURCE_ATTRIBUTES: "" },
        stdout: "piped",
      });
      assertEquals(
        new TextDecoder().decode(r.stdout).trim(),
        `service.namespace=lab,host.name=alpha,service.version=stolos-v1.2.3,vcs.ref.head.revision=${head}`,
      );
    } finally {
      await fs.remove(dir, { recursive: true });
    }
  },
  {
    // The launcher is a host's /usr/local/bin/archon (POSIX sh, spec 012); Windows runs no launcher.
    skip: proc.build.os === "windows" && "the launcher is a host's shell script",
  },
);

proves(
  ["049-telemetry FR-004"],
  "049: the metrics, by group, and the query and remote spans; each is emitted by the engine",
  async () => {
    const groups = Object.fromEntries(
      Object.entries(METRICS).map(([n, m]) => [n, m.group as string]),
    );
    assertEquals(groups, {
      "archon.run.duration": "health",
      "archon.run.problems": "health",
      "archon.verify.checks": "health",
      "archon.apply.changes": "health",
      "archon.update.outcome": "security",
      "archon.query.requests": "security",
      "archon.mcp.calls": "security",
      "archon.signers.trusted": "security",
      "archon.confirm_destroy.used": "security",
      "archon.state.writes": "state",
      "archon.engine.info": "state",
    });
    for (const s of ["archon.query", "archon.remote"]) assert(s in SPANS, s);
    // Each is recorded somewhere in the engine (not only declared).
    const root = path.fromFileUrl(new URL("../src/", import.meta.url));
    let code = "";
    for (const f of await fs.walkFiles(root)) {
      if (!f.endsWith(".ts") || f.endsWith(".auto.ts") || f.endsWith("telemetry/signals.ts"))
        continue;
      code += await fs.readTextFile(path.join(root, f));
    }
    for (const name of [...Object.keys(METRICS), "archon.query", "archon.remote"]) {
      assert(
        new RegExp(`(count|measure|span)\\(\\s*"${name.replaceAll(".", "\\.")}"`).test(code),
        `${name} is recorded`,
      );
    }
  },
);

proves(
  ["049-telemetry FR-007"],
  "049: with no collector listening, a run is silent and its result unchanged",
  async () => {
    // A port that was just free: nothing listens there.
    const closed = await serve({ port: 0 }, () => new Response(""));
    const port = closed.addr.port;
    await closed.shutdown();
    const sb = await sandbox("archon-otel-none-");
    try {
      const nowhere = {
        OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${port}`,
        OTEL_EXPORTER_OTLP_PROTOCOL: "http/json",
        OTEL_METRIC_EXPORT_INTERVAL: "100",
        HTTP_PROXY: "",
        HTTPS_PROXY: "",
        NO_PROXY: "127.0.0.1,localhost",
      };
      const off = { OTEL_SDK_DISABLED: "true" };
      // Without what differs from run to run: how long it took and its log's name.
      const steady = (s: string) =>
        s
          .replace(/ in \d+(\.\d+)?m?s/g, "")
          .replace(/log: \S+/g, "log")
          .trim();
      for (const args of [["validate"], ["keys"]]) {
        const a = await sb.run("src/stolos/main.ts", args, "", nowhere);
        const b = await sb.run("src/stolos/main.ts", args, "", off);
        assertEquals(a.code, b.code, `${args.join(" ")}: the same result`);
        assertEquals(steady(a.out), steady(b.out), `${args.join(" ")}: nothing more said`);
        assert(!/ECONNREFUSED|otlp|export failed/i.test(a.out), a.out);
      }
    } finally {
      await fs.remove(sb.home, { recursive: true });
    }
  },
);
