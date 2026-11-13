// Spec 050-telemetry-ui: OpenObserve as an opt-in on any server. Off, the
// headless Collector is unchanged (local only); on, this server collects for
// the fleet and forwards to OpenObserve with a credential no file of the
// repository or the Collector's config ever holds.

import { assert, assertEquals, assertStringIncludes } from "./assert.ts";
import { fleet, host } from "./fixtures.ts";

const webFleet = () => fleet({ web: { domain: "lab.example.net" } });
import { OTEL_UI } from "../src/archon/containers/catalog.ts";
import { resolvePlan } from "../src/archon/model/resolve.ts";
import { candidates, centralConfig } from "../src/archon/observe/discover.ts";
import { LOCAL_UI_ENDPOINT } from "../src/archon/otelui/otelui.ts";
import { USER_DATA_OPT_INS } from "../src/archon/model/durable.ts";
import { OBSERVE } from "../src/archon/capabilities/observability.ts";

const on = { "otel-ui": { enabled: true, by: "alice", at: "t", data: "ephemeral" as const } };

Deno.test("050: the image is a pinned release, unprivileged, on loopback, without phone-home", () => {
  assert(
    /^docker\.io\/openobserve\/openobserve:v\d+\.\d+\.\d+@sha256:[0-9a-f]{64}$/.test(OTEL_UI.image),
  );
  assert(!/-rc|alpha|beta/.test(OTEL_UI.image), "never a pre-release (Article 5)");
  assertEquals(OTEL_UI.environment.ZO_TELEMETRY, "false");
  assert(OTEL_UI.uid >= 1000);
  assert(!JSON.stringify(OTEL_UI.environment).includes("PASSWORD"), "secrets only in its env file");
  assert("otel-ui" in USER_DATA_OPT_INS, "a forced durable or ephemeral choice (Article 23)");
});

Deno.test("050: off, the Collector stays headless and local; on, it collects for the fleet", () => {
  const conf = (h: ReturnType<typeof host>) =>
    JSON.parse(
      (resolvePlan(h, webFleet()).files.find((f) => f.path === OBSERVE.collectorConfig)!.content ??
        "").replace(/^#.*\n/gm, ""),
    );
  const off = resolvePlan(host(), webFleet());
  assertEquals(conf(host()).receivers.otlp.protocols.http.endpoint, "127.0.0.1:4318");
  assert(!off.ports.some((p) => p.port === 4318));
  assert(!off.routes.some((r) => r.name === "otel"));

  const h = host({ optIn: on });
  const plan = resolvePlan(h, webFleet());
  assertEquals(conf(h).receivers.otlp.protocols.http.endpoint, "0.0.0.0:4318");
  const port = plan.ports.find((p) => p.port === 4318)!;
  assert(port && port.from && port.from.length > 0, "only from the local networks");
  assert(plan.routes.some((r) => r.name === "otel" && r.port === 5080));
  const unit = plan.units.find((u) => u.unitName === OBSERVE.collectorUnit)!;
  assertStringIncludes(unit.content!, "EnvironmentFile=-/var/lib/archon/otel-ui/collector.env");
});

Deno.test("050: this server's web UI comes first, and its credential stays in the environment", async () => {
  const found = await candidates(fleet(), host({ optIn: on }));
  assertEquals(found[0], { endpoint: LOCAL_UI_ENDPOINT, source: "local-ui" });
  assertEquals(LOCAL_UI_ENDPOINT, "http://127.0.0.1:5080/api/default");
  const text = centralConfig(LOCAL_UI_ENDPOINT, ["a"], "local-ui");
  const exp = JSON.parse(text.replace(/^#.*\n/, "")).exporters["otlphttp/central"];
  assertEquals(exp.headers.Authorization, "Basic ${env:ARCHON_OTEL_UI_AUTH}");
  assert(!/ZO_ROOT|password/i.test(text));
  const elsewhere = await candidates(fleet(), host());
  assert(!elsewhere.some((c) => c.source === "local-ui"), "only where it is on");
});
