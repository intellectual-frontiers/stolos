/**
 * Spec 021 (local observability, OpenTelemetry as the protocol): journald, PCP and the local
 * OpenTelemetry Collector as each host's plan renders them, Archon's own signals, and `archon
 * observe`'s tools. What the plan renders is what apply writes; the VM e2e (tests/e2e/ci.sh,
 * lib.sh's install to Ready and `archon verify` after a reboot) checks beyond it that pmcd,
 * pmlogger, pmproxy and the Collector are active on a real Ubuntu host.
 *
 * @module
 */

import { fs, path, proc } from "@intellectual-frontiers/system";
import { serve } from "@intellectual-frontiers/net";
import { assert, assertEquals, assertStringIncludes, proves } from "@intellectual-frontiers/test";
import { workstation } from "../src/archon/capabilities/mod.ts";
import {
  collectorConfig,
  DEFAULT_OBSERVABILITY,
  OBSERVE,
  observabilityPolicy,
} from "../src/archon/capabilities/observability.ts";
import { DEFAULT_BACKUP } from "../src/archon/capabilities/backup.ts";
import { LAUNCHER } from "../src/archon/capabilities/cli.ts";
import { COMMANDS } from "../src/archon/commands/registry.ts";
import { candidates } from "../src/archon/observe/discover.ts";
import { type Archive, pcpArchives, pruneChoice } from "../src/archon/observe/observe.ts";
import { resolvePlan } from "../src/archon/model/resolve.ts";
import type { HostDef, HostPlan } from "../src/archon/model/types.ts";
import { TOOLS } from "../src/archon/tools/catalog.ts";
import { at, fleet, host } from "./fixtures.ts";
import { ENGINE_ROOT, sandbox } from "./sandbox.ts";

const posix = proc.build.os !== "windows";

const file = (plan: HostPlan, p: string): string => {
  const f = plan.files.find((x) => x.path === p);
  assert(f?.content !== undefined, `${p} is in the plan`);
  return f.content;
};
const unit = (plan: HostPlan, name: string) => plan.units.find((u) => u.unitName === name);
const json = (text: string): unknown => JSON.parse(text.replace(/^#.*\n/gm, ""));

const ws = (): HostDef =>
  host({
    name: "pc",
    kind: "workstation",
    user: "alice",
    mac: undefined,
    disk: undefined,
    capabilities: workstation(),
    spec: "020-workstation",
  });

proves(
  ["021-observability FR-001"],
  "021: the limits are the defaults, then the fleet's, then the host's",
  () => {
    assertEquals(DEFAULT_OBSERVABILITY, {
      metricsDays: 365,
      metricsMaxSize: "2G",
      logsRetention: "3month",
      logsMaxSize: "1G",
      tracesDays: 7,
      minFreePercent: 15,
    });
    const f = fleet({ observability: { metricsDays: 90, logsMaxSize: "500M" } });
    const h = host({ observability: { metricsDays: 30, tracesDays: 3 } });
    assertEquals(observabilityPolicy(f, host()), {
      ...DEFAULT_OBSERVABILITY,
      metricsDays: 90,
      logsMaxSize: "500M",
    });
    assertEquals(observabilityPolicy(f, h), {
      ...DEFAULT_OBSERVABILITY,
      metricsDays: 30,
      logsMaxSize: "500M",
      tracesDays: 3,
    });
    // The limits reach what is rendered.
    const plan = resolvePlan(h, f);
    assertStringIncludes(file(plan, "/etc/default/pmlogger_timers"), "-k 30");
    assertStringIncludes(file(plan, "/etc/systemd/journald.conf.d/50-archon.conf"), "500M");
    assertEquals(
      at(json(file(plan, OBSERVE.collectorConfig)), "exporters", "file", "rotation", "max_days"),
      3,
    );
  },
);

proves(
  ["021-observability FR-002"],
  "021: journald is persistent, within Archon's age and size limits",
  () => {
    const plan = resolvePlan(host(), fleet());
    const conf = file(plan, "/etc/systemd/journald.conf.d/50-archon.conf");
    assertStringIncludes(conf, "[Journal]");
    for (const line of ["Storage=persistent", "MaxRetentionSec=3month", "SystemMaxUse=1G"]) {
      assert(conf.split("\n").includes(line), `${line} in\n${conf}`);
    }
    const f = plan.files.find((x) => x.path === "/etc/systemd/journald.conf.d/50-archon.conf");
    assertEquals(f?.onChange, [{ kind: "restart", unit: "systemd-journald.service" }]);
  },
);

proves(
  ["021-observability FR-003"],
  "021: PCP is installed and enabled, keeps metricsDays, and pmproxy serves 127.0.0.1 only",
  () => {
    const plan = resolvePlan(host(), fleet());
    assert(plan.packages.some((p) => p.name === "pcp"));
    for (const u of ["pmcd.service", "pmlogger.service", "pmproxy.service"]) {
      assertEquals(unit(plan, u)?.state, "enabled", u);
      assertEquals(unit(plan, u)?.managed, false, `${u} is Ubuntu's own unit`);
    }
    assertStringIncludes(
      file(plan, "/etc/default/pmlogger_timers"),
      'PMLOGGER_DAILY_PARAMS="-E -k 365"',
    );
    const options = file(plan, "/etc/pcp/pmproxy/pmproxy.options")
      .split("\n")
      .filter((l) => l !== "" && !l.startsWith("#"));
    assertEquals(options, ["-A", "-i 127.0.0.1"]);
  },
);

proves(
  ["021-observability FR-004"],
  "021: the Collector is the official contrib release, confined, local only, with the model's attributes",
  () => {
    const t = TOOLS.find((x) => x.id === "otelcol");
    assert(t?.github !== undefined);
    // The official release archive, installed by the tools sync (which checks GitHub's SHA-256)
    // and restarted by it after an upgrade.
    assertEquals(t.source, "upstream-binary");
    assertEquals(t.github.repo, "open-telemetry/opentelemetry-collector-releases");
    assert(t.github.asset("amd64", "0.120.0").test("otelcol-contrib_0.120.0_linux_amd64.tar.gz"));
    assert(!t.github.asset("amd64", "0.120.0").test("otelcol_0.120.0_linux_amd64.tar.gz"));
    assertEquals(t.restarts, ["archon-otelcol.service"]);

    const plan = resolvePlan(host({ name: "alpha" }), fleet({ id: "lab" }));
    const u = unit(plan, "archon-otelcol.service");
    assert(u?.content !== undefined);
    assertEquals(u.state, "enabled");
    for (const line of [
      "DynamicUser=yes",
      "Nice=10",
      "IOSchedulingClass=idle",
      "MemoryMax=256M",
      "CPUQuota=25%",
      "ConditionPathExists=/usr/local/bin/otelcol-contrib",
    ]) {
      assert(u.content.split("\n").includes(line), `${line} in the unit`);
    }
    const cfg = json(file(plan, OBSERVE.collectorConfig));
    assertEquals(at(cfg, "receivers", "otlp", "protocols", "http", "endpoint"), "127.0.0.1:4318");
    assertEquals(at(cfg, "receivers", "otlp", "protocols", "grpc", "endpoint"), "127.0.0.1:4317");
    assertEquals(at(cfg, "processors", "resource", "attributes"), [
      { key: "host.name", value: "alpha", action: "upsert" },
      { key: "service.namespace", value: "lab", action: "upsert" },
      { key: "archon.host.kind", value: "server", action: "upsert" },
    ]);
    // One file exporter: 4 files of 16 MB (the current one and 3 backups), tracesDays.
    const exporters: unknown = at(cfg, "exporters");
    assert(typeof exporters === "object" && exporters !== null);
    assertEquals(Object.keys(exporters), ["file"]);
    assertEquals(at(cfg, "exporters", "file", "path"), "/var/cache/archon-otel/archon.jsonl");
    assertEquals(at(cfg, "exporters", "file", "rotation"), {
      max_megabytes: 16,
      max_days: 7,
      max_backups: 3,
    });
    for (const s of ["traces", "metrics", "logs"]) {
      assertEquals(at(cfg, "service", "pipelines", s, "exporters"), ["file"]);
    }
    // A workstation says so in its resource.
    const wcfg = json(collectorConfig(ws(), fleet(), DEFAULT_OBSERVABILITY));
    assertEquals(at(wcfg, "processors", "resource", "attributes", 2, "value"), "workstation");
  },
);

proves(
  ["021-observability FR-005"],
  "021: the launcher points archon at the local Collector over OTLP/JSON",
  () => {
    for (const line of [
      'export OTEL_SERVICE_NAME="${OTEL_SERVICE_NAME:-archon}"',
      'export OTEL_EXPORTER_OTLP_ENDPOINT="${OTEL_EXPORTER_OTLP_ENDPOINT:-http://127.0.0.1:4318}"',
      'export OTEL_EXPORTER_OTLP_PROTOCOL="${OTEL_EXPORTER_OTLP_PROTOCOL:-http/json}"',
    ]) {
      assert(LAUNCHER.split("\n").includes(line), line);
    }
    assertEquals(file(resolvePlan(host(), fleet()), "/usr/local/bin/archon"), LAUNCHER);
  },
);

/** A child that reports a run as archon does: a trace with a phase, and the four metrics. */
const CHILD = (src: string): string => `
import { endRun, flushEvents, initTelemetry, phaseListener, recordChanges, recordChecks, startRun } from ${JSON.stringify(src)};
initTelemetry("archon", "0.0.0-test");
startRun("verify", {});
phaseListener.start("Checks");
recordChecks(5, 1);
recordChanges(2, false);
phaseListener.end("Checks", "fail", "1 failed");
endRun(1, 1, 2);
await flushEvents([]);
console.log("done");
`;

proves(
  ["021-observability FR-005"],
  "021: a run is an archon.run trace with archon.phase spans and Archon's four metrics; silent where nothing listens",
  async () => {
    const got: Array<{ path: string; body: string }> = [];
    const server = await serve({ port: 0 }, async (req) => {
      got.push({ path: new URL(req.url).pathname, body: await req.text() });
      return new Response("{}", { headers: { "content-type": "application/json" } });
    });
    const sb = await sandbox("archon-021-otel-");
    try {
      const script = path.join(sb.home, "child.ts");
      await fs.writeTextFile(
        script,
        CHILD(new URL("../src/archon/core/telemetry.ts", import.meta.url).href),
      );
      const env = (endpoint: string): Record<string, string> => ({
        OTEL_SERVICE_NAME: "archon",
        OTEL_EXPORTER_OTLP_PROTOCOL: "http/json",
        OTEL_EXPORTER_OTLP_ENDPOINT: endpoint,
        OTEL_EXPORTER_OTLP_TIMEOUT: "2000",
        HTTP_PROXY: "",
        HTTPS_PROXY: "",
        NO_PROXY: "127.0.0.1,localhost",
      });
      const r = await sb.run(script, [], "", env(`http://127.0.0.1:${server.addr.port}`));
      assertEquals(r.code, 0, r.out);
      const of = (p: string): string =>
        got
          .filter((g) => g.path === p)
          .map((g) => JSON.stringify(JSON.parse(g.body)))
          .join("\n");
      const traces = of("/v1/traces");
      assertStringIncludes(traces, '"name":"archon.run"');
      assertStringIncludes(traces, '"name":"archon.phase"');
      assertStringIncludes(traces, '"key":"service.name","value":{"stringValue":"archon"}');
      const metrics = of("/v1/metrics");
      for (const m of [
        "archon.run.duration",
        "archon.run.problems",
        "archon.verify.checks",
        "archon.apply.changes",
      ]) {
        assertStringIncludes(metrics, `"name":"${m}"`);
      }

      // Nothing listens: the same run, the same result, nothing printed about telemetry.
      const closed = await serve({ port: 0 }, () => new Response(""));
      const port = closed.addr.port;
      await closed.shutdown();
      const quiet = await sb.run(script, [], "", env(`http://127.0.0.1:${port}`));
      assertEquals(quiet.code, 0, quiet.out);
      assertEquals(quiet.out.trim(), "done");
    } finally {
      await server.shutdown();
      await fs.remove(sb.home, { recursive: true });
    }
  },
);

const archive = (base: string, bytes: number): Archive => ({
  dir: "/var/log/pcp/pmlogger/alpha",
  base,
  files: [`${base}.0`, `${base}.index`, `${base}.meta`],
  bytes,
});

proves(
  ["021-observability FR-006"],
  "021: observe prune removes the oldest archives over the size or free-space limit, never the newest",
  async () => {
    const a = [archive("20261101", 100), archive("20261102", 100), archive("20261103", 100)];
    // Within limits: nothing.
    assertEquals(pruneChoice(a, 1000, 50, 15, 10_000), []);
    // Over the size limit: oldest first until within it.
    assertEquals(
      pruneChoice(a, 150, 50, 15, 10_000).map((x) => x.base),
      ["20261101", "20261102"],
    );
    // Below the free-space floor: oldest first until above it (each archive frees 1%).
    assertEquals(
      pruneChoice(a, 1000, 14.5, 15, 10_000).map((x) => x.base),
      ["20261101"],
    );
    // Never the one being written, however far over.
    assertEquals(
      pruneChoice(a, 0, 1, 15, 10_000).map((x) => x.base),
      ["20261101", "20261102"],
    );

    // Archives are read as PCP writes them: one per base name, oldest first.
    const root = await fs.makeTempDir({ prefix: "archon-021-pcp-" });
    try {
      const dir = path.join(root, "alpha");
      await fs.mkdir(dir, { recursive: true });
      for (const f of [
        "20261111.00.10.0",
        "20261111.00.10.index",
        "20261111.00.10.meta",
        "20261110.0.xz",
        "20261110.index",
        "20261110.meta.xz",
        "Latest",
        "pmlogger.log",
      ]) {
        await fs.writeTextFile(path.join(dir, f), "xx");
      }
      const found = await pcpArchives(root);
      assertEquals(
        found.map((x) => [x.base, x.files.length, x.bytes]),
        [
          ["20261110", 3, 6],
          ["20261111.00.10", 3, 6],
        ],
      );
    } finally {
      await fs.remove(root, { recursive: true });
    }

    // Daily, by its timer; observe and observe tui only read.
    const plan = resolvePlan(host(), fleet());
    assertEquals(unit(plan, "archon-observe-prune.timer")?.state, "enabled");
    assertEquals(unit(plan, "archon-observe-prune.timer")?.onCalendar, "*-*-* 04:41:00");
    assertStringIncludes(
      unit(plan, "archon-observe-prune.service")?.content ?? "",
      "observe prune",
    );
    const tier = (n: string) => COMMANDS.find((c) => c.name === n)?.tier;
    assertEquals([tier("observe"), tier("observe tui")], ["read", "read"]);
  },
);

proves(
  ["021-observability FR-006"],
  "021: observe tui runs otel-tui on 127.0.0.1 with PCP's core metrics through pmproxy",
  async () => {
    const sb = await sandbox("archon-021-tui-");
    try {
      const bin = path.join(sb.home, "bin");
      await fs.mkdir(bin, { recursive: true });
      const fake = path.join(bin, "otel-tui");
      await fs.writeTextFile(fake, '#!/bin/sh\nfor a in "$@"; do echo "arg:$a"; done\n');
      await fs.chmod(fake, 0o755);
      const script = path.join(sb.home, "tui.ts");
      const src = new URL("../src/archon/observe/observe.ts", import.meta.url).href;
      await fs.writeTextFile(
        script,
        `import { observeTui } from ${JSON.stringify(src)};\nconsole.log("code:" + (await observeTui()));\n`,
      );
      const r = await sb.run(script, [], "", { PATH: `${bin}:${proc.env.get("PATH") ?? ""}` });
      assertEquals(r.code, 0, r.out);
      const args = r.out
        .split("\n")
        .filter((l) => l.startsWith("arg:"))
        .map((l) => l.slice(4));
      assertEquals(args.slice(0, 6), ["--host", "127.0.0.1", "--http", "4328", "--grpc", "4327"]);
      assertEquals(args[6], "--prom-target");
      assert(args[7]?.startsWith("http://127.0.0.1:44322/metrics?names=kernel.all.cpu.user,"));
      assertStringIncludes(r.out, "code:0");
    } finally {
      await fs.remove(sb.home, { recursive: true });
    }
  },
  { skip: posix ? false : "a stand-in otel-tui written as a POSIX shell script" },
);

proves(
  ["021-observability FR-007"],
  "021: btop, otel-tui and the Collector on every server and workstation",
  () => {
    const btop = TOOLS.find((t) => t.id === "btop");
    assertEquals([btop?.source, btop?.package], ["apt", "btop"]);
    const tui = TOOLS.find((t) => t.id === "otel-tui");
    assertEquals([tui?.source, tui?.github?.repo], ["upstream-binary", "ymtdzzz/otel-tui"]);
    for (const h of [host(), ws()]) {
      const plan = resolvePlan(h, fleet());
      for (const id of ["btop", "otel-tui", "otelcol"]) {
        assert(
          plan.tools.some((t) => t.id === id),
          `${id} on ${h.kind ?? "server"}`,
        );
      }
      assert(plan.packages.some((p) => p.name === "btop"));
    }
  },
);

proves(
  ["021-observability FR-008"],
  "021: nothing local is backed up, and nothing listens beyond 127.0.0.1 through the firewall",
  () => {
    for (const p of DEFAULT_BACKUP.paths) {
      for (const local of [
        "/var/log/pcp",
        "/var/log/journal",
        "/var/cache/archon-otel",
        "/var/log",
      ]) {
        assert(!local.startsWith(p) && !p.startsWith(local), `${p} would carry ${local}`);
      }
    }
    const plan = resolvePlan(host(), fleet());
    // pmcd (44321), pmproxy (44322) and OTLP (4317, 4318) are not opened: ufw denies the rest.
    for (const port of [44321, 44322, 4317, 4318]) {
      assert(!plan.ports.some((p) => p.port === port), `${port} is closed`);
    }
    const ufw = file(plan, "/etc/ufw/applications.d/archon");
    assert(!/4432[12]|431[78]/.test(ufw), ufw);
    const fw = plan.files.find((f) => f.path === "/etc/ufw/applications.d/archon");
    assert(
      fw?.onChange?.some(
        (c) => c.kind === "run" && c.argv.join(" ") === "ufw default deny incoming",
      ),
    );
  },
);

proves(
  ["021-observability FR-009"],
  "021: a workstation observes itself the same way, without the server's parts",
  () => {
    const s = resolvePlan(host(), fleet());
    const w = resolvePlan(ws(), fleet());
    for (const p of [
      "/etc/systemd/journald.conf.d/50-archon.conf",
      "/etc/default/pmlogger_timers",
      "/etc/pcp/pmproxy/pmproxy.options",
    ]) {
      assertEquals(file(w, p), file(s, p), p);
    }
    for (const u of [
      "pmcd.service",
      "pmlogger.service",
      "pmproxy.service",
      "archon-otelcol.service",
      "archon-observe-prune.timer",
      "archon-observe-discover.timer",
    ]) {
      assert(unit(w, u) !== undefined, `${u} on a workstation`);
    }
    assert(w.packages.some((p) => p.name === "pcp"));
    // What needs a server: the web console and the firewall are not there.
    assert(!w.packages.some((p) => p.name === "cockpit"));
    assert(!w.files.some((f) => f.path.startsWith("/etc/ufw/")));
  },
);

proves(
  ["021-observability FR-010"],
  "021: OpenTelemetry endpoints come from the model and DNS names, never from DNS-SD",
  async () => {
    const f = fleet({
      telemetry: { collector: "http://otel.lab.example.net:4318", name: "no-such-name.invalid" },
    });
    assertEquals(await candidates(f, host()), [
      { endpoint: "http://otel.lab.example.net:4318", source: "model" },
    ]);
    // Nothing in the engine looks up _otlp-*._tcp records.
    const hits: string[] = [];
    const root = path.join(ENGINE_ROOT, "src", "archon");
    for (const p of await fs.walkFiles(root)) {
      if (!p.endsWith(".ts") || p.endsWith("assets.auto.ts")) continue;
      const text = await fs.readTextFile(path.join(root, p));
      if (/_otlp[-.]|avahi-browse/.test(text)) hits.push(p);
    }
    assertEquals(hits, []);
  },
);
