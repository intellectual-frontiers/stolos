/**
 * Clock preflight (spec 016): apt rejects signatures that are "not live
 * until" a future time when the host clock is behind, which silently skips
 * trixie-security. Compare with an HTTPS Date header before touching apt.
 *
 * @module
 */

/** The local clock compared with a web server's Date header. */
export interface ClockCheck {
  /** Seconds the local clock is ahead (positive) or behind (negative). */
  skew: number;
  /** The URL whose Date header was compared. */
  source: string;
}

/**
 * Compare the local clock with `source`'s HTTP Date header (one HEAD request,
 * 5 second timeout). Undefined when the server cannot be reached or sends no Date.
 */
export async function checkClock(
  source = "https://deb.debian.org/debian/",
): Promise<ClockCheck | undefined> {
  try {
    const res = await fetch(source, { method: "HEAD", signal: AbortSignal.timeout(5000) });
    await res.body?.cancel();
    const date = res.headers.get("date");
    if (!date) return undefined;
    return { skew: Math.round((Date.now() - Date.parse(date)) / 1000), source };
  } catch {
    return undefined;
  }
}

/** A skew in seconds for people, rounded: "3m behind", "2h ahead", "0s ahead". */
export function describeSkew(skew: number): string {
  const a = Math.abs(skew);
  const amount =
    a >= 3600 ? `${Math.round(a / 3600)}h` : a >= 60 ? `${Math.round(a / 60)}m` : `${a}s`;
  return `${amount} ${skew < 0 ? "behind" : "ahead"}`;
}
