/**
 * Maintainers' PPAs (spec 010, Article 5). Ubuntu's own tool adds them:
 * add-apt-repository fetches the PPA's signing key from Launchpad over HTTPS
 * and writes a deb822 source with the key inline. Archon first checks that the
 * PPA has builds for this release, so a PPA can never break apt.
 *
 * @module
 */

import { run } from "../core/exec.ts";

/** "git-core/ppa" -> the source file add-apt-repository writes. */
export function ppaSourcePath(ppa: string, codename: string): string {
  const [owner, name] = ppa.split("/");
  return `/etc/apt/sources.list.d/${owner}-ubuntu-${name}-${codename}.sources`;
}

/** The Origin a PPA's Release file carries (for unattended-upgrades): LP-PPA-<owner>[-<name>]. */
export function ppaOrigin(ppa: string): string {
  const [owner, name] = ppa.split("/");
  return name === "ppa" ? `LP-PPA-${owner}` : `LP-PPA-${owner}-${name}`;
}

export function ppaReleaseUrl(ppa: string, codename: string): string {
  return `https://ppa.launchpadcontent.net/${ppa.split("/")[0]}/${
    ppa.split("/")[1]
  }/ubuntu/dists/${codename}/InRelease`;
}

/**
 * Has the PPA published builds for this Ubuntu release? Asked with curl (IPv4
 * only on an IPv4-only network, spec 009), retried with the same backoff as apt
 * (about 10 s, 30 s, 60 s). "unreachable", with curl's reason, after that.
 */
export async function ppaHasRelease(
  ppa: string,
  codename: string,
  o: { ipv4Only?: boolean; retries?: boolean } = {},
): Promise<{ answer: "yes" | "no" | "unreachable"; reason?: string }> {
  const { NETWORK_BACKOFF_MS, aptDeps } = await import("./apt.ts");
  const waits = o.retries === false ? [] : NETWORK_BACKOFF_MS;
  let reason = "";
  for (let attempt = 0;; attempt++) {
    const r = await run([
      "curl",
      "-sS",
      ...(o.ipv4Only ? ["-4"] : []),
      "-o",
      "/dev/null",
      "-I",
      "-w",
      "%{http_code}",
      "--connect-timeout",
      "5",
      "--max-time",
      "15",
      ppaReleaseUrl(ppa, codename),
    ]);
    const status = Number(r.stdout.trim());
    if (status >= 200 && status < 300) return { answer: "yes" };
    if (status === 404) return { answer: "no" };
    reason = status
      ? `HTTP ${status}`
      : (r.stderr.trim().replace(/^curl: \(\d+\) /, "") || "no answer");
    if (attempt >= waits.length) break;
    await aptDeps.sleep(waits[attempt]);
  }
  return { answer: "unreachable", reason };
}

/** Is the PPA already a source? Found by its URL, whatever the file is called. */
export async function ppaPresent(ppa: string, _codename?: string): Promise<boolean> {
  const url = `ppa.launchpadcontent.net/${ppa}/ubuntu`;
  try {
    for await (const e of Deno.readDir("/etc/apt/sources.list.d")) {
      if (!e.isFile || !/\.(sources|list)$/.test(e.name)) continue;
      const text = await Deno.readTextFile(`/etc/apt/sources.list.d/${e.name}`).catch(() => "");
      if (text.split("\n").some((l) => l.includes(url) && !/^\s*#/.test(l))) return true;
    }
  } catch { /* no sources directory */ }
  return false;
}

export async function addPpa(ppa: string): Promise<{ ok: boolean; output: string }> {
  const r = await run(["add-apt-repository", "--yes", "--no-update", `ppa:${ppa}`], {
    env: { DEBIAN_FRONTEND: "noninteractive", PATH: Deno.env.get("PATH") ?? "/usr/bin:/bin" },
  });
  return { ok: r.ok, output: (r.stderr || r.stdout).trim() };
}

/** Installed and candidate versions of an apt package. */
export async function aptVersions(
  pkg: string,
): Promise<{ installed?: string; candidate?: string }> {
  const r = await run(["apt-cache", "policy", pkg]);
  const get = (k: string) => {
    const v = r.stdout.match(new RegExp(`${k}:\\s*(\\S+)`))?.[1];
    return v && v !== "(none)" ? v : undefined;
  };
  return { installed: get("Installed"), candidate: get("Candidate") };
}
