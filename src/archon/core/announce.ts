/**
 * Tell a running boot server something happened on this PC (spec 004): an
 * event (spec 049) it records and shows in its window and boot.log. Arming,
 * for example, is only a file the server reads when a machine contacts it, so
 * without this the window stays silent until the host network-boots. Loopback
 * only; best effort: no server running is not an error.
 *
 * @module
 */
// Spec: 004-install
// Spec: 103-three-ports FR-001

import { proc } from "@intellectual-frontiers/commons/ts/runtime";
import type { ArchonEvent } from "../telemetry/events.ts";
import { standardPort } from "./listeners.ts";

/**
 * POST `event` to the boot server on loopback (`port`, default
 * ARCHON_BOOT_PORT or the boot server's standard port), waiting at most 1.5 seconds. Returns whether the
 * server accepted it; false when none is running.
 */
export async function announce(
  event: Pick<ArchonEvent, "name" | "host" | "message" | "attrs">,
  port = Number(proc.env.get("ARCHON_BOOT_PORT")) || standardPort("boot-http"),
): Promise<boolean> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/local/event`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(event),
      signal: AbortSignal.timeout(1500),
    });
    await r.body?.cancel();
    return r.ok;
  } catch {
    return false;
  }
}
