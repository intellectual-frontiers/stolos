/**
 * Clock preflight (spec 016): apt rejects signatures that are "not live
 * until" a future time when the host clock is behind, which silently skips
 * trixie-security. Compare with an HTTPS Date header before touching apt.
 *
 * @module
 */

export interface ClockCheck {
  /** Seconds the local clock is ahead (positive) or behind (negative). */
  skew: number;
  source: string;
}

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

export function describeSkew(skew: number): string {
  const a = Math.abs(skew);
  const amount = a >= 3600
    ? `${Math.round(a / 3600)}h`
    : a >= 60
    ? `${Math.round(a / 60)}m`
    : `${a}s`;
  return `${amount} ${skew < 0 ? "behind" : "ahead"}`;
}
