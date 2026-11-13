// First-boot progress to the boot server's window (spec 004): the install left
// the URL in /etc/archon/boot-events. Best effort: a boot server that is gone
// changes nothing.

import { readTextOr } from "../core/fsx.ts";

export const BOOT_EVENTS = "/etc/archon/boot-events";

export async function bootEvent(
  e: { phase: string; level?: string; summary?: string },
): Promise<void> {
  const url = (await readTextOr(BOOT_EVENTS))?.trim();
  if (!url) return;
  try {
    await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ origin: "archon", ...e }),
      signal: AbortSignal.timeout(5000),
    });
  } catch { /* the boot server may be off */ }
}
