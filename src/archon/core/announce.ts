/**
 * Tell a running boot server something happened on this PC (spec 004): an
 * event (spec 049) it records and shows in its window and boot.log. Arming,
 * for example, is only a file the server reads when a machine contacts it, so
 * without this the window stays silent until the host network-boots. Loopback
 * only; best effort: no server running is not an error.
 *
 * @module
 */

import type { ArchonEvent } from "../telemetry/events.ts";

export async function announce(
  event: Pick<ArchonEvent, "name" | "host" | "message" | "attrs">,
  port = Number(Deno.env.get("ARCHON_BOOT_PORT")) || 8080,
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
