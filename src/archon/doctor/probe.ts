/**
 * archon doctor's building blocks (spec 026): one HTTP(S) probe with curl's
 * own timings, what a curl failure means, and parsers for the output of
 * Ubuntu's network tools. Pure where it can be, so it is tested without a network.
 *
 * @module
 */

import { proc } from "@intellectual-frontiers/ifc-ts/runtime";
import { run } from "../core/exec.ts";

/** The result of one curl probe of a URL. */
export interface Probe {
  /** The URL probed. */
  url: string;
  /** Any HTTP answer (even 404) means the path works; `ok` is false only without one. */
  ok: boolean;
  /** The HTTP status code; 0 without an answer. */
  http: number;
  /** curl's exit code (0 on success; see `explainCurl`). */
  curlExit: number;
  /** The address curl connected to. */
  ip?: string | undefined;
  /** Seconds, cumulative as curl reports them. */
  dns?: number | undefined;
  /** Seconds until the TCP connection was made. */
  connect?: number | undefined;
  /** Seconds until the TLS handshake finished. */
  tls?: number | undefined;
  /** Seconds for the whole request. */
  total?: number | undefined;
  /** The final URL, after any redirects followed. */
  effective?: string | undefined;
  /** curl's error message, without its `curl: (N)` prefix. */
  error?: string | undefined;
}

const W =
  "%{http_code} %{remote_ip} %{time_namelookup} %{time_connect} %{time_appconnect} %{time_total} %{url_effective}";

/** Probe a URL with curl: HEAD by default, following redirects when asked. */
export async function probe(
  url: string,
  o: {
    ipv4?: boolean | undefined;
    get?: boolean | undefined;
    follow?: boolean | undefined;
    timeout?: number | undefined;
  } = {},
): Promise<Probe> {
  const argv = [
    "curl",
    "-sS",
    "-o",
    proc.build.os === "windows" ? "NUL" : "/dev/null",
    "--connect-timeout",
    "5",
    "--max-time",
    String(o.timeout ?? 10),
    "-w",
    W,
  ];
  if (o.ipv4) argv.push("-4");
  if (o.follow) argv.push("-L");
  // A GET of one byte where a HEAD is refused (GitHub's release assets).
  argv.push(...(o.get ? ["-r", "0-0"] : ["-I"]), url);
  // curl's own limits (--connect-timeout, --max-time) bound it; the C locale for its messages.
  const r = await run(argv, { env: { LC_ALL: "C" } });
  return parseProbe(url, r.code, r.stdout, r.stderr);
}

/** Build a `Probe` from curl's `-w` output (status, IP, timings, final URL), exit code and stderr. */
export function parseProbe(url: string, code: number, stdout: string, stderr: string): Probe {
  const [http, ip, dns, connect, tls, total, effective] = stdout.trim().split(" ");
  const h = Number(http) || 0;
  return {
    url,
    ok: h > 0,
    http: h,
    curlExit: code,
    ip: ip || undefined,
    dns: Number(dns) || undefined,
    connect: Number(connect) || undefined,
    tls: Number(tls) || undefined,
    total: Number(total) || undefined,
    effective: effective || undefined,
    error: stderr.trim().replace(/^curl: \(\d+\) /, "") || undefined,
  };
}

/** What a curl exit code means for this machine's network, and where to look. */
export function explainCurl(exit: number, error = ""): { what: string; look: string } {
  if (exit === 28 && /Resolving timed out/i.test(error)) return explainCurl(6);
  switch (exit) {
    case 5:
    case 6:
      return {
        what: "the name did not resolve",
        look: "DNS: the DNS phase above; resolvectl query <name>; the router's upstream DNS",
      };
    case 7:
      return {
        what: "the connection was refused or the network is unreachable",
        look: "the default route and the router's firewall; with IPv6 addresses only, the IPv6 phase",
      };
    case 28:
      return {
        what: "timed out",
        look: "a firewall silently dropping, packet loss, or an MTU problem: archon doctor --trace",
      };
    case 35:
      return {
        what: "the TLS handshake failed",
        look: "something between here and the site interferes with TLS (a filtering proxy or firewall)",
      };
    case 60:
      return {
        what: "the site's certificate did not verify",
        look: "the clock (Time phase), or a proxy that intercepts TLS",
      };
    case 52:
    case 56:
      return {
        what: "the connection was reset or closed",
        look: "a firewall or intrusion prevention (UniFi IPS/IDS, content filtering) resetting it",
      };
    default:
      return { what: `curl exit ${exit}`, look: "man curl, EXIT CODES" };
  }
}

/** One phrase of timings: "dns 12 ms · connect 31 ms · tls 70 ms · 120 ms". */
export function timings(p: Probe): string {
  const ms = (s?: number) => (s === undefined ? undefined : `${Math.round(s * 1000)} ms`);
  return [
    p.dns !== undefined ? `dns ${ms(p.dns)}` : "",
    p.connect !== undefined ? `connect ${ms(p.connect)}` : "",
    p.tls !== undefined ? `tls ${ms(p.tls)}` : "",
    p.total !== undefined ? `${ms(p.total)} in all` : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

// ------------------------------------------------------------- parsers

/** apt sources: every repository's base URI and suite (deb822 .sources and one-line .list). */
export function aptRepos(
  files: Array<{ name: string; text: string }>,
): Array<{ uri: string; suite: string }> {
  const out: Array<{ uri: string; suite: string }> = [];
  for (const f of files) {
    if (f.name.endsWith(".sources")) {
      for (const stanza of f.text.split(/\n\s*\n/)) {
        const field = (k: string): string | undefined =>
          stanza.match(new RegExp(`^${k}:\\s*(.+)$`, "mi"))?.[1]?.trim();
        if (/^Enabled:\s*no/im.test(stanza)) continue;
        const uris = field("URIs")?.split(/\s+/) ?? [];
        const suites = field("Suites")?.split(/\s+/) ?? [];
        for (const uri of uris) for (const suite of suites) out.push({ uri, suite });
      }
    } else {
      for (const l of f.text.split("\n")) {
        const m = l.match(/^\s*deb\s+(?:\[[^\]]*\]\s+)?(\S+)\s+(\S+)/);
        const [, uri, suite] = m ?? [];
        if (uri !== undefined && suite !== undefined) out.push({ uri, suite });
      }
    }
  }
  const seen = new Set<string>();
  return out.filter((r) => {
    const k = `${r.uri.replace(/\/$/, "")} ${r.suite}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** The InRelease file apt fetches for a repository (a suite ending in / is a flat repository). */
export function inReleaseUrl(r: { uri: string; suite: string }): string {
  const base = r.uri.replace(/\/$/, "");
  return r.suite.endsWith("/")
    ? `${base}/${r.suite}InRelease`
    : `${base}/dists/${r.suite}/InRelease`;
}

/** ping's summary: loss and average round trip. */
export function parsePing(
  out: string,
): { sent: number; received: number; avgMs?: number | undefined } | undefined {
  const m = out.match(/(\d+) packets transmitted, (\d+) (?:packets )?received/);
  if (!m) return undefined;
  const rtt = out.match(/= [\d.]+\/([\d.]+)\/[\d.]+/);
  return { sent: Number(m[1]), received: Number(m[2]), avgMs: rtt ? Number(rtt[1]) : undefined };
}

/** `resolvectl dns`: the DNS servers per link ("Link 2 (eth0): 10.0.30.1"). */
export function parseResolvectlDns(out: string): string[] {
  // systemd's resolvectl.c: "Global:", "Link N (ifname):", or "Delegate X:", then the
  // servers, wrapped onto lines indented like "Global: ". A server may carry
  // %ifname and #name suffixes.
  const servers: string[] = [];
  for (const l of out.split("\n")) {
    const m =
      l.match(/^(?:Global|Link \d+ \([^)]+\)|Delegate \S+):\s*(.*)$/) ?? l.match(/^\s{2,}(\S.*)$/);
    if (m?.[1])
      servers.push(
        ...m[1]
          .split(/\s+/)
          .filter(Boolean)
          .map((s) => s.replace(/[%#].*$/, "")),
      );
  }
  return [...new Set(servers)];
}

/** `chronyc -n tracking`: offset in seconds (positive: fast) and leap status. */
export function parseChronyTracking(out: string): {
  offset?: number | undefined;
  leap?: string | undefined;
  ref?: string | undefined;
} {
  const sys = out.match(/^System time\s*:\s*([\d.]+) seconds (fast|slow)/m);
  return {
    offset: sys ? Number(sys[1]) * (sys[2] === "fast" ? 1 : -1) : undefined,
    leap: out.match(/^Leap status\s*:\s*(.+)$/m)?.[1]?.trim(),
    ref: out.match(/^Reference ID\s*:\s*\S+ \(([^)]*)\)/m)?.[1],
  };
}

/**
 * `snap debug connectivity` (snapd's cmd_debug_connectivity_check.go): " * PASS",
 * or one " * <host>: unreachable" line per store host snapd could not reach.
 */
export function parseSnapConnectivity(
  out: string,
): { pass: boolean; unreachable: string[] } | undefined {
  if (!/^Connectivity status:/m.test(out)) return undefined;
  return {
    pass: /^\s*\*\s*PASS\s*$/m.test(out),
    unreachable: [...out.matchAll(/^\s*\*\s*(\S+):\s*unreachable/gm)].map((m) => m[1] ?? ""),
  };
}

/** `ufw status verbose`: the default outgoing policy. */
export function ufwOutgoing(out: string): string | undefined {
  return out.match(/^Default:.*?(\w+) \(outgoing\)/m)?.[1];
}
