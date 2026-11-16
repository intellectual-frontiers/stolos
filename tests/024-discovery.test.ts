/**
 * Spec 024 (finding a central OpenTelemetry collector): the model's `fleet.telemetry`, the order
 * candidates are tried in, and PCP's names in the forwarding config.
 *
 * @module
 */

import { proc } from "@intellectual-frontiers/commons/ts/runtime";
import { assert, assertEquals, proves } from "@intellectual-frontiers/commons/ts/runtime/test";
import { CORE_PCP_METRICS } from "../src/archon/capabilities/observability.ts";
import {
  candidates,
  centralConfig,
  DEFAULT_COLLECTOR_NAME,
} from "../src/archon/observe/discover.ts";
import { validateFleet } from "../src/archon/model/validate.ts";
import { at, fleet, host, list } from "./fixtures.ts";

proves(
  ["024-discovery FR-001"],
  "024: fleet.telemetry names a collector by URL and a name that defaults to otel.localdomain",
  async () => {
    const where = (collector: string) =>
      validateFleet(fleet({ telemetry: { collector } }), [host()]).filter(
        (p) => p.where === "fleet.telemetry.collector",
      );
    assertEquals(where("http://otel.lab.example.net:4318"), []);
    assertEquals(where("https://otel.lab.example.net"), []);
    for (const bad of ["otel.lab.example.net:4318", "ftp://otel.lab.example.net", "http://a b"]) {
      assertEquals(where(bad).length, 1, bad);
    }
    assertEquals(DEFAULT_COLLECTOR_NAME, "otel.localdomain");
    // The model's collector first, then the name when it resolves (unicast DNS: getent). getent is
    // glibc's, on the hosts (Ubuntu): elsewhere no name resolves and only the model's is left.
    assertEquals(
      await candidates(
        fleet({ telemetry: { collector: "http://otel.lab.example.net:4318", name: "localhost" } }),
        host(),
      ),
      [
        { endpoint: "http://otel.lab.example.net:4318", source: "model" },
        ...(proc.build.os === "linux"
          ? [{ endpoint: "http://localhost:4318", source: "dns" } as const]
          : []),
      ],
    );
    // A name that does not resolve is not a candidate.
    assertEquals(
      await candidates(fleet({ telemetry: { name: "no-such-name.invalid" } }), host()),
      [],
    );
  },
);

proves(
  ["024-discovery FR-004"],
  "024: PCP's metrics are forwarded under their own names, prefixed pcp.",
  () => {
    const cfg: unknown = JSON.parse(
      centralConfig("http://otel.localdomain:4318", CORE_PCP_METRICS).replace(/^#.*\n/, ""),
    );
    assertEquals(at(cfg, "processors", "metricstransform/pcp", "transforms"), [
      { include: "^(.*)$", match_type: "regexp", action: "update", new_name: "pcp.$${1}" },
    ]);
    // Only the PCP pipeline renames; Archon's own metrics keep theirs.
    const procs = (p: string) => at(cfg, "service", "pipelines", p, "processors");
    assert(list(procs("metrics/pcp")).includes("metricstransform/pcp"));
    assert(!list(procs("metrics/central")).includes("metricstransform/pcp"));
    assertEquals(
      at(cfg, "receivers", "prometheus/pcp", "config", "scrape_configs", 0, "params", "names"),
      [CORE_PCP_METRICS.join(",")],
    );
  },
);
