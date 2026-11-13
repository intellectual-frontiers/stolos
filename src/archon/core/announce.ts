// Tell a running boot server something happened on this PC (spec 004): it
// writes the line to its window and boot.log. Arming, for example, is only a
// file the server reads when a machine contacts it, so without this the window
// stays silent until the host network-boots. Loopback only; best effort: no
// server running is not an error.

export async function announce(
  line: string,
  port = Number(Deno.env.get("ARCHON_BOOT_PORT")) || 8080,
): Promise<boolean> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/local/event`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ line }),
      signal: AbortSignal.timeout(1500),
    });
    await r.body?.cancel();
    return r.ok;
  } catch {
    return false;
  }
}
