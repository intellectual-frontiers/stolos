/**
 * Spec 050-telemetry-ui: OpenObserve as an opt-in on any server. Off, the headless Collector is
 * unchanged (local only); on, this server collects for the fleet and forwards to OpenObserve with a
 * credential no file of the repository or the Collector's config ever holds.
 *
 * @module
 */

import {
  assert,
  assertEquals,
  assertStringIncludes,
  proves,
} from "@intellectual-frontiers/commons/ts/runtime/test";
import { fs, path, proc, serve } from "@intellectual-frontiers/commons/ts/runtime";
import { engineFile } from "../src/archon/core/assets.ts";
import { fleet, host } from "./fixtures.ts";
import { ENGINE_ROOT, linkEngine, sandbox } from "./sandbox.ts";
import { at, must, parse } from "./console/tree.ts";

import { OTEL_UI } from "../src/archon/containers/catalog.ts";
import { resolvePlan } from "../src/archon/model/resolve.ts";
import { candidates, centralConfig } from "../src/archon/observe/discover.ts";
import { LOCAL_UI_ENDPOINT } from "../src/archon/otelui/otelui.ts";
import { USER_DATA_OPT_INS } from "../src/archon/model/durable.ts";
import { OBSERVE } from "../src/archon/capabilities/observability.ts";

const webFleet = (): ReturnType<typeof fleet> => fleet({ web: { domain: "lab.example.net" } });

const on = { "otel-ui": { enabled: true, by: "alice", at: "t", data: "ephemeral" as const } };

proves(
  ["050-telemetry-ui FR-001", "050-telemetry-ui FR-002"],
  "050: the image is a pinned release, unprivileged, on loopback, without phone-home",
  () => {
    assert(
      /^docker\.io\/openobserve\/openobserve:v\d+\.\d+\.\d+@sha256:[0-9a-f]{64}$/.test(
        OTEL_UI.image,
      ),
    );
    assert(!/-rc|alpha|beta/.test(OTEL_UI.image), "never a pre-release (Article 5)");
    assertEquals(OTEL_UI.environment["ZO_TELEMETRY"], "false");
    assert(OTEL_UI.uid >= 1000);
    assert(
      !JSON.stringify(OTEL_UI.environment).includes("PASSWORD"),
      "secrets only in its env file",
    );
    assert("otel-ui" in USER_DATA_OPT_INS, "a forced durable or ephemeral choice (Article 23)");
  },
);

proves(
  ["050-telemetry-ui FR-003", "050-telemetry-ui FR-004"],
  "050: off, the Collector stays headless and local; on, it collects for the fleet",
  () => {
    const conf = (h: ReturnType<typeof host>): unknown =>
      parse(
        (
          must(resolvePlan(h, webFleet()).files.find((f) => f.path === OBSERVE.collectorConfig))
            .content ?? ""
        ).replace(/^#.*\n/gm, ""),
      );
    const off = resolvePlan(host(), webFleet());
    assertEquals(
      at(conf(host()), "receivers", "otlp", "protocols", "http", "endpoint"),
      "127.0.0.1:4318",
    );
    assert(!off.ports.some((p) => p.port === 4318));
    assert(!off.routes.some((r) => r.name === "otel"));

    const h = host({ optIn: on });
    const plan = resolvePlan(h, webFleet());
    assertEquals(at(conf(h), "receivers", "otlp", "protocols", "http", "endpoint"), "0.0.0.0:4318");
    const port = must(plan.ports.find((p) => p.port === 4318));
    assert(port, "open: the router decides who reaches it");
    assert(plan.routes.some((r) => r.name === "otel" && r.port === 5080));
    const unit = must(plan.units.find((u) => u.unitName === OBSERVE.collectorUnit));
    assertStringIncludes(
      must(unit.content),
      "EnvironmentFile=-/var/lib/archon/otel-ui/collector.env",
    );
  },
);

proves(
  ["050-telemetry-ui FR-005"],
  "050: this server's web UI comes first, and its credential stays in the environment",
  async () => {
    const found = await candidates(fleet(), host({ optIn: on }));
    assertEquals(found[0], { endpoint: LOCAL_UI_ENDPOINT, source: "local-ui" });
    assertEquals(LOCAL_UI_ENDPOINT, "http://127.0.0.1:5080/api/default");
    const text = centralConfig(LOCAL_UI_ENDPOINT, ["a"], "local-ui");
    const exp = at(parse(text.replace(/^#.*\n/, "")), "exporters", "otlphttp/central");
    assertEquals(at(exp, "headers", "Authorization"), "Basic ${env:ARCHON_OTEL_UI_AUTH}");
    assert(!/ZO_ROOT|password/i.test(text));
    const elsewhere = await candidates(fleet(), host());
    assert(!elsewhere.some((c) => c.source === "local-ui"), "only where it is on");
  },
);

proves(
  ["050-telemetry-ui FR-006"],
  "050: no collector answering: discovery says the boot PC is not collecting, or how to collect in one place",
  async () => {
    const sb = await sandbox("archon-discover-test-");
    try {
      const repo = path.join(sb.home, "fleet");
      await fs.mkdir(path.join(repo, "fleets"), { recursive: true });
      await proc.output([
        "cp",
        "-r",
        path.join(ENGINE_ROOT, "examples/fleets/lab"),
        `${repo}/fleets/lab`,
      ]);
      await linkEngine(repo);
      // The boot PC on this machine, on a port where nothing listens; no otel.localdomain (getent).
      const closed = await serve({ port: 0 }, () => new Response(""));
      const port = closed.addr.port;
      await closed.shutdown();
      const siteFile = path.join(repo, "fleets", "lab", "site.ts");
      const site = await fs.readTextFile(siteFile);
      const local = site.replace(
        /(bootServer: \{[^}]*?)address: ipv4\("[0-9.]+"\)([^}]*?)http: port\(\d+\)/,
        `$1address: ipv4("127.0.0.1")$2http: port(${port})`,
      );
      assert(local !== site, "the boot server is on this machine (no other address is tried)");
      await fs.writeTextFile(siteFile, local);
      const bin = path.join(sb.home, "bin");
      await fs.mkdir(bin);
      await fs.writeTextFile(path.join(bin, "getent"), "#!/bin/sh\nexit 2\n");
      await fs.chmod(path.join(bin, "getent"), 0o755);
      const env = {
        ARCHON_REPO: repo,
        ARCHON_FLEET: "lab",
        ARCHON_VERBOSE: "1",
        PATH: `${bin}:${proc.env.get("PATH")}`,
        NO_PROXY: "127.0.0.1",
      };
      const discover = () =>
        sb.run(
          "src/archon/main.ts",
          ["--host", "alpha", "observe", "discover", "--check"],
          "",
          env,
        );
      let r = await discover();
      assertEquals(r.code, 0, r.out);
      assertStringIncludes(r.out, `the boot PC (http://127.0.0.1:${port}/otlp) is not collecting`);
      assertStringIncludes(r.out, "bun run stolos boot serve");
      assertStringIncludes(r.out, "none found: local only");
      // No boot PC in the site: how to keep telemetry in one place.
      await fs.writeTextFile(siteFile, site.replace(/\n {2}bootServer: \{[^}]*\},\n/, "\n"));
      r = await discover();
      assertEquals(r.code, 0, r.out);
      assertStringIncludes(r.out, "no collector: telemetry stays on this machine");
      assertStringIncludes(r.out, "archon otel ui on --ephemeral");
    } finally {
      await fs.remove(sb.home, { recursive: true });
    }
  },
);

proves(
  ["050-telemetry-ui FR-007"],
  "050: otel ui on|off mutate, status read (and over MCP), password never over MCP, --show by a person",
  async () => {
    const { COMMANDS } = await import("../src/archon/commands/registry.ts");
    const { listed, toolFor } = await import("../src/archon/mcp/server.ts");
    const by = (n: string) => {
      const c = COMMANDS.find((x) => x.name === n);
      assert(c !== undefined, n);
      return c;
    };
    assertEquals(
      ["otel ui on", "otel ui off", "otel ui status"].map((n) => by(n).tier),
      ["mutate", "mutate", "read"],
    );
    assert(listed(by("otel ui status"), "read"), "status over MCP");
    const pw = by("otel ui password");
    assert(pw.noMcp === true && !listed(pw, "mutate"), "password never over MCP");
    assert(pw.args.find((a) => a.name === "show")?.human === true, "--show is typed by a person");
    assert(!("show" in toolFor(pw).inputSchema.properties));
  },
);

proves(
  ["050-telemetry-ui FR-008"],
  "050: docs/telemetry.md, for newcomers: the Collector, the order, the web UI, the boot PC, troubleshooting",
  () => {
    const doc = engineFile("docs/telemetry.md");
    for (const s of [
      "## On every server, always: the headless Collector",
      "in this order",
      "1. **The telemetry web UI on this very server**",
      "2. **`telemetry.collector`**",
      "3. **`otel.localdomain`**",
      "4. **The boot PC**",
      "## The telemetry web UI (OpenObserve), on any server",
      "bun run stolos boot serve",
      "## Troubleshooting",
      "is not collecting",
    ]) {
      assertStringIncludes(doc, s);
    }
  },
);
