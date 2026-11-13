// `archon web serve` (specs 032, 035): the welcome page and the guides on
// 127.0.0.1:8090, behind Traefik. Read-only: the model, Archon's status files,
// the install record, the timers' last runs, the update state, the listening
// ports, and Traefik's own list of routes (to show containers as they start).
// Slow facts (pending updates, the certificate, Traefik's routes) are cached.

import { hostData } from "../model/durable.ts";
import { join } from "../core/path.ts";
import { readTextOr } from "../core/fsx.ts";
import { P } from "../core/paths.ts";
import { engineFileOr } from "../core/assets.ts";
import { run } from "../core/exec.ts";
import { STATUS_DIR } from "../core/status.ts";
import type { LastRun, LastVerify } from "../core/status.ts";
import { loadFleet, loadHosts } from "../model/load.ts";
import { resolvePlan } from "../model/resolve.ts";
import { agentSetup, guideFor } from "../guide/guide.ts";
import { fqdn, WEB } from "./config.ts";
import { certificateOf, serverAddress } from "./commands.ts";
import { markdownToHtml } from "./markdown.ts";
import { renderGuide, renderWelcome, type Service, type WelcomeData } from "./welcome.ts";

/** The repository's guides served here (docs/<name>.md), with their titles. */
export const GUIDES: Array<{ name: string; title: string }> = [
  { name: "guide", title: "Your Archon server: a guide for newcomers" },
  { name: "dotfiles", title: "Dotfiles: how your settings work" },
  { name: "web", title: "HTTPS, apps, and containers" },
  { name: "daily-use", title: "Working on a server, day to day" },
  { name: "agent", title: "Managing servers with an AI agent" },
  { name: "smb", title: "File shares (SMB) for Windows, macOS, and Linux" },
  { name: "pg", title: "PostgreSQL databases" },
  { name: "s3", title: "S3 object storage" },
  { name: "sql", title: "SQL over your infrastructure" },
];

const cache = new Map<string, { at: number; value: unknown }>();
async function cached<T>(key: string, ms: number, f: () => Promise<T>): Promise<T> {
  const c = cache.get(key);
  if (c && Date.now() - c.at < ms) return c.value as T;
  const value = await f();
  cache.set(key, { at: Date.now(), value });
  return value;
}

async function osName(): Promise<string> {
  const rel = (await readTextOr("/etc/os-release")) ?? "";
  return rel.match(/^PRETTY_NAME="?([^"\n]*)"?$/m)?.[1] ?? "Ubuntu";
}

/** TCP ports open to the network (not loopback-only), from `ss -Hltn`. */
export function listeningPorts(ss: string): number[] {
  const ports = new Set<number>();
  for (const line of ss.split("\n")) {
    const local = line.trim().split(/\s+/)[3];
    const m = local?.match(/^(.*):(\d+)$/);
    if (!m) continue;
    const addr = m[1].replace(/^\[|\]$/g, "").replace(/%.*$/, "");
    if (/^127\./.test(addr) || addr === "::1" || addr === "::ffff:127.0.0.1") continue;
    ports.add(Number(m[2]));
  }
  return [...ports].sort((a, b) => a - b);
}

/** A unit's last run: when it ended, and whether it succeeded. */
async function lastRunOf(unit: string): Promise<{ at?: string; ok?: boolean }> {
  return parseLastRun(
    (await run([
      "systemctl",
      "show",
      unit,
      "--timestamp=unix",
      "-p",
      "ExecMainExitTimestamp",
      "-p",
      "Result",
    ])).stdout,
  );
}

/** systemctl show --timestamp=unix: "ExecMainExitTimestamp=@1731419462", "Result=success". */
export function parseLastRun(out: string): { at?: string; ok?: boolean } {
  const at = out.match(/^ExecMainExitTimestamp=@(\d+)/m)?.[1];
  const result = out.match(/^Result=(.+)$/m)?.[1]?.trim();
  return at ? { at: new Date(Number(at) * 1000).toISOString(), ok: result === "success" } : {};
}

/** Traefik's routers, as it sees them right now (containers included). */
export function routersToServices(
  routers: Array<{ name?: string; rule?: string; provider?: string; status?: string }>,
): Service[] {
  const out: Service[] = [];
  for (const r of routers) {
    if (r.provider !== "docker" || r.status === "disabled") continue;
    const host = r.rule?.match(/Host\(`([^`]+)`\)/)?.[1];
    if (!host) continue;
    out.push({ name: host.split(".")[0], url: `https://${host}`, source: "container" });
  }
  return out;
}

async function traefikRouters(name: string): Promise<Service[]> {
  const r = await run([
    "curl",
    "-s",
    "--max-time",
    "3",
    "--resolve",
    `traefik.${name}:443:127.0.0.1`,
    `https://traefik.${name}/api/http/routers`,
  ]);
  try {
    return routersToServices(JSON.parse(r.stdout));
  } catch {
    return [];
  }
}

async function json<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse((await readTextOr(path)) ?? "") as T;
  } catch {
    return undefined;
  }
}

export async function welcomeData(hostName: string): Promise<WelcomeData> {
  const fleet = await loadFleet();
  const host = (await loadHosts()).find((h) => h.name === hostName);
  if (!host) throw new Error(`no host ${hostName} in the model`);
  const plan = resolvePlan(host, fleet);
  const name = fqdn(fleet, host);
  const certificate = await cached("cert", 5 * 60_000, () => certificateOf(name ?? host.name));
  const installed = await json<WelcomeData["installed"] & { installed?: string }>(
    join(P.state, "hosts", host.name, "installed.json"),
  );
  const pending = await cached("updates", 10 * 60_000, async () => {
    const r = await run(["apt", "list", "--upgradable"], { env: { LANG: "C" } });
    return r.ok ? r.stdout.split("\n").filter((l) => l.includes("[upgradable")).length : undefined;
  });
  const rebootPkgs = (await readTextOr("/run/reboot-required.pkgs")) ?? "";
  const containers = name ? await cached("routers", 15_000, () => traefikRouters(name)) : [];
  const services: Service[] = name
    ? [
      ...plan.routes.map((r) => ({
        name: r.name,
        url: `https://${r.name}.${name}`,
        description: r.description,
        source: (r.spec === "032-web" ? "model" : "system") as Service["source"],
      })),
      {
        name: "traefik",
        url: `https://traefik.${name}`,
        description: "the web front door's dashboard: every route, live",
        source: "system",
      },
      ...containers.filter((c) => !plan.routes.some((r) => r.name === c.name)),
    ]
    : [];
  // Ports already behind the proxy, and the proxy's and the system's own.
  const known = new Set([
    22,
    53,
    80,
    443,
    9090,
    WEB.welcomePort,
    ...plan.routes.filter((r) => !r.address || r.address === "127.0.0.1").map((r) => r.port),
    ...plan.ports.map((p) => p.port),
  ]);
  const ss = await run(["ss", "-Hltn"]);
  const unrouted = listeningPorts(ss.stdout).filter((p) => !known.has(p) && p < 32768);
  return {
    host: host.name,
    fqdn: name,
    title: fleet.title,
    os: await osName(),
    address: await serverAddress(host),
    repo: { slug: fleet.repository.slug, url: `https://github.com/${fleet.repository.slug}` },
    lastRun: await json<LastRun>(join(STATUS_DIR, "last.json")),
    verify: await json<LastVerify>(join(STATUS_DIR, "verify.json")),
    installed: installed?.installed
      ? { at: installed.installed, ok: installed.ok, checks: installed.checks }
      : undefined,
    certificate,
    updates: {
      pending,
      reboot: !!(await readTextOr("/run/reboot-required")),
      rebootPackages: rebootPkgs.split("\n").filter(Boolean),
      lastRun: (await lastRunOf("apt-daily-upgrade.service")).at,
    },
    backup: plan.units.some((u) => u.unitName === "archon-backup.timer")
      ? await (async () => {
        const b = await lastRunOf("archon-backup.service");
        return { last: b.at, ok: b.ok };
      })()
      : undefined,
    data: host.kind === "workstation"
      ? undefined
      : (({ class: c, reasons }) => ({ class: c, reasons }))(hostData(host)),
    services,
    unrouted,
    guide: guideFor(plan),
    agent: host.kind === "workstation" ? undefined : agentSetup(plan),
    guides: GUIDES,
    admin: fleet.admin.user,
    mailbox: fleet.mail?.to,
    generated: new Date().toISOString().slice(0, 16).replace("T", " ") + " UTC",
  };
}

export async function guidePage(hostName: string, docName: string): Promise<string | undefined> {
  const g = GUIDES.find((x) => x.name === docName);
  if (!g) return undefined;
  const md = engineFileOr(`docs/${g.name}.md`);
  if (!md) return undefined;
  const fleet = await loadFleet();
  const html = markdownToHtml(md, {
    served: GUIDES.map((x) => x.name),
    repoBlob: `https://github.com/${fleet.repository.slug}/blob/main/`,
  });
  return renderGuide(hostName, g.title, html);
}

export async function webServe(hostName: string): Promise<number> {
  const html = (body: string, status = 200) =>
    new Response(body, {
      status,
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
    });
  const server = Deno.serve(
    { hostname: WEB.welcomeAddress, port: WEB.welcomePort, onListen: () => {} },
    async (req) => {
      const path = new URL(req.url).pathname;
      try {
        if (path === "/healthz") return new Response("ok\n");
        if (path === "/") return html(renderWelcome(await welcomeData(hostName)));
        const g = path.match(/^\/guide\/([a-z0-9-]+)$/);
        if (g) {
          const body = await guidePage(hostName, g[1]);
          if (body) return html(body);
        }
        return new Response("not found\n", { status: 404 });
      } catch (e) {
        return new Response(`welcome page error: ${(e as Error).message}\n`, { status: 500 });
      }
    },
  );
  console.log(`welcome page on http://${WEB.welcomeAddress}:${WEB.welcomePort} (behind Traefik)`);
  await server.finished;
  return 0;
}
