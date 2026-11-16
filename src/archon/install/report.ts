/**
 * First-boot progress to the boot server's window (spec 004): the install left
 * the URL in /etc/archon/boot-events. Best effort: a boot server that is gone
 * changes nothing.
 *
 * @module
 */
// Spec: 004-install

import { fs } from "@intellectual-frontiers/commons/ts/runtime";
import { onHost } from "../core/paths.ts";

/** The file holding the boot server's event URL, left by the install. */
export const BOOT_EVENTS: string = "/etc/archon/boot-events";

/** Posts a first-boot event (a phase, its level and summary) to the boot server; best effort, 5 s timeout. */
export async function bootEvent(e: {
  phase: string;
  level?: string;
  summary?: string;
}): Promise<void> {
  const url = (await fs.readTextOr(onHost(BOOT_EVENTS)))?.trim();
  if (!url) return;
  try {
    await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ origin: "archon", ...e }),
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    /* the boot server may be off */
  }
}
