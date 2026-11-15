/**
 * Spec 050-telemetry-ui: OpenObserve as an opt-in on any server. Until it is
 * turned on, the headless Collector does what it always did. Once it is on:
 *   - its admin credentials are generated here, root only;
 *   - this server's Collector forwards everything it collects (journald, PCP,
 *     OTLP from Archon and apps) to OpenObserve on loopback, adding the
 *     credential itself (an environment file systemd reads as root);
 *   - the Collector also accepts OTLP on 4318 (the router decides from where), so other
 *     servers can send here without any secret (they find it by otel.localdomain
 *     or telemetry.collector, spec 024);
 *   - Traefik serves the UI at otel.<host>.<domain>.
 * Only telemetry from then on is forwarded: nothing is replayed.
 *
 * @module
 */

import { ensureDir, exists, readTextOr } from "../core/fsx.ts";
import { run } from "../core/exec.ts";
import { ui } from "../core/ui.ts";
import { newPassword } from "../pg/config.ts";
import { OTEL_UI } from "../containers/catalog.ts";
import { loadFleet, loadHosts } from "../model/load.ts";
import { fqdn } from "../web/config.ts";
import type { Sink } from "../pg/converge.ts";

/** Paths and names for the telemetry web UI (spec 050). */
export const OTEL_UI_PATHS = {
  /** Its state directory (root only). */
  dir: "/var/lib/archon/otel-ui",
  /** For the Collector's unit (EnvironmentFile): the Basic credential, root only. */
  collectorEnv: "/var/lib/archon/otel-ui/collector.env",
  /** OpenObserve's own organization: OTLP lands at /api/<org>/v1/<signal>. */
  org: "default",
  /** The admin's sign-in name (an e-mail address in OpenObserve's form). */
  admin: "admin@archon.local",
};

/** Where this server's Collector sends when the UI is on here. */
export const LOCAL_UI_ENDPOINT = `http://127.0.0.1:${
  OTEL_UI.ports[0].host
}/api/${OTEL_UI_PATHS.org}`;

/** Before the container first starts: its admin and the Collector's credential, root only. */
export async function prepareOtelUi(s: Sink): Promise<void> {
  if ((await exists(OTEL_UI.secrets)) && (await exists(OTEL_UI_PATHS.collectorEnv))) return;
  s.change(`${OTEL_UI_PATHS.dir} (telemetry web UI credentials, root only)`);
  if (s.check) return;
  const password = newPassword();
  await ensureDir(OTEL_UI_PATHS.dir);
  await Deno.chmod(OTEL_UI_PATHS.dir, 0o700);
  await Deno.writeTextFile(
    OTEL_UI.secrets,
    `ZO_ROOT_USER_EMAIL=${OTEL_UI_PATHS.admin}\nZO_ROOT_USER_PASSWORD=${password}\n`,
    { mode: 0o600 },
  );
  await Deno.writeTextFile(
    OTEL_UI_PATHS.collectorEnv,
    `ARCHON_OTEL_UI_AUTH=${btoa(`${OTEL_UI_PATHS.admin}:${password}`)}\n`,
    { mode: 0o600 },
  );
}

/** archon otel ui status: on or off, ready, where, and what this server forwards to. */
export async function otelUiStatus(hostName: string, json: boolean): Promise<number> {
  const fleet = await loadFleet();
  const host = (await loadHosts()).find((h) => h.name === hostName);
  if (!host) throw new Error(`no host ${hostName} in the model`);
  const on = host.optIn?.[OTEL_UI.name]?.enabled === true;
  const ready = on &&
    (await run(["curl", "-fsS", "-o", "/dev/null", "--max-time", "3", OTEL_UI.health])).ok;
  const n = fqdn(fleet, host);
  const url = `https://otel.${n ?? host.name}`;
  const { lastDiscovery } = await import("../observe/discover.ts");
  const forward = await lastDiscovery();
  if (json) {
    console.log(JSON.stringify({ on, ready, url: on ? url : null, forwardsTo: forward ?? null }));
    return 0;
  }
  const p = ui.phase("Telemetry web UI");
  if (!on) {
    p.done(
      "off on this server: the Collector keeps telemetry locally and forwards it when a collector is found",
    );
    ui.next.push(
      "to turn it on here: archon otel ui on --ephemeral (see man archon-otel-ui-on and archon docs telemetry)",
    );
    return ui.finish();
  }
  if (!ready) {
    p.warn(
      "on, but not answering yet",
      "systemctl status archon-otel-ui; it pulls its image the first time",
    );
  }
  p.done(
    `${
      ready ? "ready" : "starting"
    } · ${url} (local networks) · sign in: archon otel ui password --show`,
  );
  ui.next.push(
    `other servers send here once otel.localdomain (router DNS) or telemetry.collector in fleet.ts names ${host.name}`,
  );
  return ui.finish();
}

/** archon otel ui password --show: the admin's sign-in, typed by a person (never over MCP). */
export async function otelUiPassword(show: boolean): Promise<number> {
  const env = (await readTextOr(OTEL_UI.secrets)) ?? "";
  const pw = env.match(/^ZO_ROOT_USER_PASSWORD=(.*)$/m)?.[1];
  const p = ui.phase("Telemetry web UI sign-in");
  if (!pw) {
    p.fail("no credentials yet", "archon otel ui on --ephemeral");
    return ui.finish();
  }
  p.done(`user ${OTEL_UI_PATHS.admin}${show ? "" : " · add --show to print the password"}`);
  if (show) console.log(pw);
  return ui.finish();
}
