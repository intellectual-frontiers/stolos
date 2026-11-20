/**
 * `archon doctor` (spec 026): a quick, read-only look at whether this machine
 * can reach what it depends on, with what is wrong and where to look. It uses
 * Ubuntu's own network tools (ip, ping, resolvectl, dig, chronyc, ufw, snap,
 * mtr) and curl's timings; the endpoints come from this machine's own
 * configuration (apt sources, the checkout's remote, the tools catalog, the
 * fleet model), never from a list kept here. It changes nothing.
 *
 * @module
 */

import { array, integer, json, number, object, string } from "@intellectual-frontiers/core";
import { fs, proc, stdio } from "@intellectual-frontiers/system";
import { run } from "../core/exec.ts";
import { asRoot, P } from "../core/paths.ts";
import { ui } from "../core/ui.ts";
import type { FleetDef, HostDef } from "../model/types.ts";
import { loadFleet } from "../model/load.ts";
import { networkOf } from "../model/resolve.ts";
import { TOOLS } from "../tools/catalog.ts";
import { hostSite } from "../notify/notify.ts";
import { emailChecks } from "./email.ts";
import {
  aptRepos,
  explainCurl,
  inReleaseUrl,
  parseChronyTracking,
  parsePing,
  parseResolvectlDns,
  parseSnapConnectivity,
  type Probe,
  probe,
  timings,
  ufwOutgoing,
} from "./probe.ts";

/** A command with a time limit (coreutils timeout), so no check can hang the doctor. */
const t = (secs: number, argv: string[]) =>
  run(["timeout", String(secs), ...argv], { env: { LC_ALL: "C" } });

/** `ip -j -4 addr show dev <dev>`, as far as the doctor reads it. */
const IP_ADDR = array(
  object({}, { addr_info: array(object({ local: string, prefixlen: integer })) }),
);

/** `ip -j -s link show dev <dev>`: its error counters. */
const IP_LINK_STATS = array(
  object(
    {},
    {
      stats64: object({ rx: object({ errors: number }), tx: object({ errors: number }) }),
    },
  ),
);

/** The name archon doctor and its checks use to test DNS: Ubuntu's archive. */
const ARCHIVE = "archive.ubuntu.com";

interface Endpoint {
  what: string;
  url: string;
  get?: boolean;
  follow?: boolean;
  /** Any HTTP answer will do (a private repository answers 401 or 404 without credentials). */
  anyHttp?: boolean;
}

/** What this machine reaches out to, from its own configuration. */
async function endpoints(fleet: FleetDef, host: HostDef): Promise<Endpoint[]> {
  const out: Endpoint[] = [];
  // apt: every enabled repository's InRelease, exactly what apt update fetches.
  const files: Array<{ name: string; text: string }> = [];
  const dir = "/etc/apt/sources.list.d";
  try {
    for await (const e of fs.readDir(dir)) {
      if (/\.(sources|list)$/.test(e.name)) {
        files.push({ name: e.name, text: (await fs.readTextOr(`${dir}/${e.name}`)) ?? "" });
      }
    }
  } catch {
    /* no sources.list.d */
  }
  files.push({ name: "sources.list", text: (await fs.readTextOr("/etc/apt/sources.list")) ?? "" });
  for (const r of aptRepos(files)) {
    out.push({ what: `apt ${new URL(r.uri).host} ${r.suite}`, url: inReleaseUrl(r) });
  }
  // The checkout's remote (reconcile pulls it) and GitHub's API (tools sync).
  const remote = (await t(5, ["git", "-C", P.repo, "remote", "get-url", "origin"])).stdout.trim();
  if (/^https:/.test(remote)) out.push({ what: "git remote", url: remote, anyHttp: true });
  out.push({
    what: "GitHub API (tools sync)",
    url: `${proc.env.get("ARCHON_GITHUB_API") ?? "https://api.github.com"}/rate_limit`,
    // GitHub's API answers HEAD on /rate_limit with 404; a GET is what the tools sync does.
    get: true,
  });
  // The Snap Store's API, by curl (snapd's own check below needs more time and root).
  out.push({ what: "Snap Store API", url: "https://api.snapcraft.io/", anyHttp: true });
  // A release asset, followed through GitHub's redirect to its download host.
  const gh = TOOLS.find((x) => x.github);
  if (gh?.github) {
    out.push({
      what: `GitHub release download (${gh.id})`,
      url: `https://github.com/${gh.github.repo}/releases/latest`,
      follow: true,
    });
  }
  // Workstation-only tools (the agent layer, spec 030) only where they install.
  const ws = host.kind === "workstation";
  for (const tool of TOOLS.filter((t) => (!t.workstationOnly || ws) && (!t.serverOnly || !ws))) {
    if (tool.installer) out.push({ what: `${tool.name} installer`, url: tool.installer });
  }
  if (fleet.telemetry?.collector) {
    out.push({ what: "OpenTelemetry collector", url: fleet.telemetry.collector });
  }
  return out;
}

/**
 * `archon doctor`: runs each read-only phase (link, Internet, endpoints, email)
 * and prints what it finds. With `trace`, adds a path trace to unreachable
 * endpoints; with `send`, mails the email findings. Returns 0: the closing
 * summary counts the problems.
 */
export async function doctor(
  host: HostDef,
  o: { trace: boolean; send?: string | undefined },
): Promise<number> {
  const fleet = await loadFleet();
  const ipv6Model = networkOf(fleet, host).ipv6;

  // ---------------------------------------------------------------- link
  const l = ui.phase("Link");
  const routes = JSON.parse(
    (await t(5, ["ip", "-j", "route", "show", "default"])).stdout || "[]",
  ) as Array<{ gateway?: string; dev?: string }>;
  const def = routes[0];
  let gateway: string | undefined;
  if (!def) {
    l.fail(
      "no IPv4 default route: nothing outside this network is reachable",
      "ip route; netplan get; sudo netplan apply",
    );
  } else {
    gateway = def.gateway;
    const dev = def.dev ?? "?";
    const sys = (f: string) => fs.readTextOr(`/sys/class/net/${dev}/${f}`).then((x) => x?.trim());
    const [carrier, speed, duplex, mtu] = await Promise.all([
      sys("carrier"),
      sys("speed"),
      sys("duplex"),
      sys("mtu"),
    ]);
    if (carrier !== "1") {
      l.fail(`${dev} has no carrier (cable or switch port)`, `ip link show ${dev}; ethtool ${dev}`);
    }
    if (duplex === "half") {
      l.warn(
        `${dev} runs half duplex (a speed/duplex mismatch with the switch?)`,
        `ethtool ${dev}`,
      );
    }
    const addrs = json(
      (await t(5, ["ip", "-j", "-4", "addr", "show", "dev", dev])).stdout || "[]",
      IP_ADDR,
    );
    const addr = addrs.kind === "ok" ? addrs.value[0]?.addr_info?.[0] : undefined;
    const links = json(
      (await t(5, ["ip", "-j", "-s", "link", "show", "dev", dev])).stdout || "[]",
      IP_LINK_STATS,
    );
    const stats = links.kind === "ok" ? links.value[0]?.stats64 : undefined;
    const errs = stats ? stats.rx.errors + stats.tx.errors : 0;
    if (errs) {
      l.warn(
        `${dev}: ${errs} receive/transmit errors since boot`,
        `ip -s link show ${dev}; ethtool -S ${dev}; check the cable`,
      );
    }
    l.done(
      `${dev} ${addr ? `${addr.local}/${addr.prefixlen}` : "(no IPv4 address)"} · gateway ${
        gateway ?? "?"
      }${speed && Number(speed) > 0 ? ` · ${speed} Mb/s ${duplex ?? ""}` : ""} · MTU ${mtu ?? "?"}`,
    );
  }

  // ------------------------------------------------------------- gateway
  const g = ui.phase("Gateway");
  if (!gateway) g.skip("no gateway");
  else {
    const ping = parsePing(
      (await t(8, ["ping", "-n", "-c", "5", "-i", "0.2", "-W", "1", gateway])).stdout,
    );
    if (!ping || ping.received === 0) {
      g.warn(
        `${gateway} does not answer ping`,
        "the router may drop ping; if the probes below fail too, check the cable, VLAN, and the router",
      );
    } else if (ping.received < ping.sent) {
      g.warn(
        `${ping.sent - ping.received} of ${ping.sent} pings to ${gateway} lost`,
        "packet loss on the LAN: cable, switch port, Wi-Fi bridge",
      );
    }
    const mtu = Number(await fs.readTextOr(`/sys/class/net/${def?.dev}/mtu`)) || 1500;
    const big = await t(4, [
      "ping",
      "-n",
      "-c",
      "1",
      "-W",
      "2",
      "-M",
      "do",
      "-s",
      String(mtu - 28),
      gateway,
    ]);
    if (ping?.received && !big.ok) {
      g.warn(
        `full-size packets (${mtu} bytes, don't fragment) do not reach ${gateway}`,
        "an MTU mismatch on the path: tracepath -n <host>",
      );
    }
    g.done(
      ping?.received
        ? `${gateway} · ${ping.received}/${ping.sent} replies · ${ping.avgMs?.toFixed(1)} ms`
        : gateway,
    );
  }

  // ----------------------------------------------------------------- DNS
  const d = ui.phase("DNS");
  const rdns = await t(5, ["resolvectl", "dns"]);
  const servers = parseResolvectlDns(rdns.stdout);
  if (rdns.code === 127) {
    d.warn(
      "resolvectl is not available: systemd-resolved is not this machine's resolver",
      "resolvectl comes with systemd on Ubuntu; cat /etc/resolv.conf",
    );
  } else if (!servers.length) {
    d.fail("no DNS server configured", "resolvectl status; netplan get (nameservers)");
  }
  // Uncached, through systemd-resolved, five times: catches a flaky upstream.
  let resolved = 0;
  for (let i = 0; i < 5; i++) {
    if ((await t(5, ["resolvectl", "query", "-4", "--cache=no", "--legend=no", ARCHIVE])).ok) {
      resolved++;
    }
  }
  if (resolved < 5) {
    d.fail(
      `${ARCHIVE}: ${5 - resolved} of 5 uncached lookups failed`,
      "DNS isn't returning IPv4 addresses reliably; check the router's upstream DNS",
    );
  }
  // Each server directly (dig), and, only when they fail, a public resolver
  // to tell the router's DNS apart from the internet's.
  let serverOk = false;
  for (const s of servers.slice(0, 3)) {
    const r = await t(5, ["dig", "+time=2", "+tries=1", "+short", "A", ARCHIVE, `@${s}`]);
    const ok = r.ok && /^\d+\.\d+\.\d+\.\d+$/m.test(r.stdout);
    serverOk ||= ok;
    if (ok) d.ok(`${s} answers for ${ARCHIVE}`);
    else d.fail(`${s} gave no IPv4 address for ${ARCHIVE}`, "the router's DNS or its upstream");
  }
  if (servers.length && !serverOk) {
    const pub = await t(5, ["dig", "+time=2", "+tries=1", "+short", "A", ARCHIVE, "@1.1.1.1"]);
    d.note(
      pub.ok && pub.stdout.trim()
        ? "1.1.1.1 answers: the internet's DNS works, so the router's DNS (or its upstream setting) is the problem"
        : "1.1.1.1 does not answer either: outbound DNS is blocked or the internet link is down",
    );
  }
  const self = await t(5, ["getent", "ahostsv4", `${host.name}.localdomain`]);
  if (!self.ok) {
    d.warn(
      `${host.name}.localdomain does not resolve: the router has no Local DNS record for this host`,
      "UniFi: add a Local DNS record (Article 20: names, not announcements)",
    );
  }
  d.done(`${servers.join(", ") || "none"} · ${resolved}/5 uncached lookups`);

  // ---------------------------------------------------------------- IPv6
  const v6 = ui.phase("IPv6");
  const route6 = (await t(5, ["ip", "-6", "route", "show", "default"])).stdout.trim();
  const aaaa = (
    await t(5, ["dig", "+time=2", "+tries=1", "+short", "AAAA", ARCHIVE])
  ).stdout.trim();
  const force4 = /ForceIPv4 "true"/.test(
    (await fs.readTextOr("/etc/apt/apt.conf.d/52archon-network")) ?? "",
  );
  if (!route6) {
    if (ipv6Model) {
      v6.warn(
        "no IPv6 default route, but the model says this network has IPv6",
        "network: { ipv6: false } in fleets/<fleet>/fleet.ts",
      );
    }
    if (aaaa && !force4) {
      v6.fail(
        "sites have IPv6 addresses this host cannot reach, and apt is not limited to IPv4",
        "network: { ipv6: false } (spec 009), then sudo archon update",
      );
    }
    v6.done(`none (IPv4 only)${force4 ? " · apt uses IPv4 only" : ""}`);
  } else {
    const p6 = await probe(`https://${ARCHIVE}/`, {});
    if (!p6.ok) {
      v6.warn(
        "an IPv6 default route exists but connections fail",
        "the router's IPv6, or set network: { ipv6: false }",
      );
    }
    v6.done(`default route ${route6.split(" ").slice(0, 3).join(" ")}`);
  }

  // ---------------------------------------------------------------- time
  const tm = ui.phase("Time");
  const td = await t(5, ["timedatectl", "show", "-p", "NTPSynchronized", "--value"]);
  const synced = td.ok ? td.stdout.trim() : "unknown";
  const chrony = await t(5, ["chronyc", "-n", "tracking"]);
  const tr = chrony.ok ? parseChronyTracking(chrony.stdout) : {};
  if (synced === "unknown") {
    tm.warn(
      "timedatectl could not report the clock's state (no systemd here?)",
      "chronyc tracking",
    );
  } else if (synced !== "yes") {
    tm.fail(
      "the clock is not synchronized: TLS certificates can fail to verify",
      "chronyc sources -v; timedatectl timesync-status",
    );
  }
  if (tr.offset !== undefined && Math.abs(tr.offset) > 1) {
    tm.warn(`the clock is ${tr.offset.toFixed(2)} s off`, "chronyc sources -v");
  }
  if (chrony.ok) {
    const src = (await t(5, ["chronyc", "-n", "sources"])).stdout;
    const reach = src.split("\n").filter((x) => /^\^/.test(x)).length;
    if (!reach) {
      tm.warn("chrony has no time sources", "chronyc sources -v; the NTP servers in /etc/chrony/");
    }
  }
  tm.done(
    `${
      synced === "yes"
        ? "synchronized"
        : synced === "unknown"
          ? "state unknown"
          : "NOT synchronized"
    }${tr.ref ? ` to ${tr.ref}` : ""}${
      tr.offset !== undefined ? ` · offset ${(tr.offset * 1000).toFixed(1)} ms` : ""
    }`,
  );

  // ------------------------------------------------------- proxy, firewall
  const pf = ui.phase("Proxy and firewall");
  const proxyEnv = ["https_proxy", "http_proxy", "HTTPS_PROXY", "HTTP_PROXY"]
    .map((k) => proc.env.get(k))
    .find(Boolean);
  const aptProxy = (await t(5, ["apt-config", "dump"])).stdout
    .split("\n")
    .filter((x) => /::Proxy/i.test(x));
  if (proxyEnv) pf.note(`proxy in the environment: ${proxyEnv}`);
  for (const a of aptProxy) pf.note(`apt proxy: ${a}`);
  const ufw = await t(5, ["ufw", "status", "verbose"]);
  const outgoing = ufw.ok ? ufwOutgoing(ufw.stdout) : undefined;
  if (outgoing && outgoing !== "allow") {
    pf.fail(
      `UFW's default outgoing policy is ${outgoing}`,
      "spec 008 leaves outgoing open: sudo archon apply",
    );
  }
  pf.done(
    `${proxyEnv || aptProxy.length ? "a proxy is set" : "no proxy"} · UFW outgoing ${
      outgoing ?? "?"
    }`,
  );

  // ------------------------------------------------------------ endpoints
  const e = ui.phase("Internet");
  const ipv4 = !ipv6Model;
  const list = await endpoints(fleet, host);
  e.status(`${list.length} endpoints`);
  const results = await Promise.all(
    list.map(async (x) => ({ x, r: await probe(x.url, { ipv4, follow: x.follow, get: x.get }) })),
  );
  const failed: Array<{ x: Endpoint; r: Probe }> = [];
  for (const { x, r } of results) {
    const host = new URL(r.effective ?? x.url).host;
    if (r.ok && (r.http < 400 || x.anyHttp)) e.ok(`${x.what}: ${host} ${r.http} (${timings(r)})`);
    else if (r.ok) {
      e.warn(
        `${x.what}: ${host} answers HTTP ${r.http}`,
        /InRelease$/.test(x.url)
          ? "the repository has no release for this suite (a PPA without builds for this Ubuntu?)"
          : "the site answers; check the URL",
      );
    } else {
      failed.push({ x, r });
      const why = explainCurl(r.curlExit, r.error);
      e.fail(`${x.what}: ${host}: ${why.what}${r.error ? ` (${r.error})` : ""}`, why.look);
    }
  }
  // GitHub over SSH, as ops with the deploy key: what reconcile and push use.
  if (
    /^(git@|ssh:)/.test(
      (await t(5, ["git", "-C", P.repo, "remote", "get-url", "origin"])).stdout.trim(),
    )
  ) {
    const ls = await t(20, [
      "runuser",
      "-u",
      "ops",
      "--",
      "git",
      "-C",
      P.repo,
      "ls-remote",
      "--exit-code",
      "origin",
      "HEAD",
    ]);
    if (ls.ok) e.ok("git remote over SSH (ops, deploy key): works");
    else {
      e.fail(
        `git remote over SSH failed: ${ls.stderr.trim().split("\n").pop()}`,
        "ssh -T git@github.com as ops; outbound TCP 22; git -C /srv/archon fetch",
      );
    }
  }
  // snapd's own connectivity check against the Snap Store.
  if (asRoot() && (await t(5, ["sh", "-c", "command -v snap"])).ok) {
    const sc = await t(30, ["snap", "debug", "connectivity"]);
    const st = parseSnapConnectivity(sc.stdout);
    if (st?.pass) e.ok("Snap Store reachable (snap debug connectivity)");
    for (const h of st?.unreachable ?? []) {
      e.warn(
        `Snap Store: ${h} unreachable (snapd)`,
        "snap installs wait for the next reconcile; snap debug connectivity",
      );
    }
    if (!st) {
      e.warn(
        `snapd's own check (snap debug connectivity): ${
          sc.code === 124 ? "no answer in 30 s" : (sc.stderr || sc.stdout).trim() || "no answer"
        }`,
        "sudo snap debug connectivity; snap changes",
      );
    }
  }
  e.done(
    `${results.length - failed.length}/${results.length} reachable${ipv4 ? " over IPv4" : ""}`,
  );

  // ---------------------------------------------------------------- trace
  if (failed.length) {
    const tr2 = ui.phase("Trace");
    if (!o.trace) {
      tr2.skip("archon doctor --trace follows the path to each failing site (mtr)");
      tr2.done("not run");
    } else {
      for (const { x } of failed.slice(0, 3)) {
        const u = new URL(x.url);
        const port = u.port || (u.protocol === "https:" ? "443" : "80");
        tr2.status(`mtr ${u.hostname}`);
        const m = await t(45, [
          "mtr",
          "--report",
          "--report-cycles",
          "3",
          "--no-dns",
          "--tcp",
          "--port",
          port,
          ...(ipv4 ? ["-4"] : []),
          u.hostname,
        ]);
        stdio.stdout.writeSync(`\n${u.hostname}:${port}\n${(m.stdout || m.stderr).trim()}\n\n`);
      }
      tr2.done("the last hop that answers is where the path stops");
    }
  }

  // ---------------------------------------------------------------- email
  const em = ui.phase("Email");
  await emailChecks(
    hostSite(fleet, host.name, host.kind === "workstation" ? "workstation" : "server", ipv6Model),
    em,
    `on the boot machine: bun run stolos boot mail-push ${host.name}`,
    { send: o.send },
  );

  // ------------------------------------------------------------ proposals
  // Spec 095: changes made outside Stolos that wait on a person (what was collected; read-only).
  if (host.kind !== "workstation") {
    const pr = ui.phase("Proposals");
    try {
      const { loadDrift } = await import("../proposal/server.ts");
      const { waiting, waitingLine } = await import("../proposal/record.ts");
      const v = await loadDrift(host);
      if (!v.state) pr.done("nothing collected yet (sudo archon drift --collect)");
      else {
        const w = waiting(v);
        if (v.alerts.length) {
          pr.fail(
            `SECURITY ALERT: ${v.alerts.length} package file(s) modified`,
            "archon drift lists them; reinstall the package, or re-create the host",
          );
        }
        if (w.due) {
          pr.warn(
            waitingLine(w),
            "archon drift, then sudo archon propose; on your PC: stolos proposal",
          );
        } else pr.done(waitingLine(w));
      }
    } catch (e) {
      pr.warn(`not read: ${(e as Error).message}`, "sudo archon drift --collect");
    }
  }

  return 0; // the closing summary counts the problems
}
