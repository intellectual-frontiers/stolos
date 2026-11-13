// `archon observe` (spec 021): what this machine records about itself, where,
// and within which limits; `observe tui` opens otel-tui on it; `observe prune`
// keeps PCP's metric archives within their size and free-space limits (journald
// and the Collector's files limit themselves).

import { join } from "../core/path.ts";
import { exists } from "../core/fsx.ts";
import { run, which } from "../core/exec.ts";
import { ui } from "../core/ui.ts";
import { loadFleet } from "../model/load.ts";
import type { HostDef } from "../model/types.ts";
import { CORE_PCP_METRICS, observabilityPolicy, OBSERVE } from "../capabilities/observability.ts";

/** "2G" -> bytes (K, M, G, T are powers of 1024, as journald reads them). */
export function parseSize(s: string): number {
  const m = s.trim().match(/^(\d+(?:\.\d+)?)\s*([KMGT]?)i?B?$/i);
  if (!m) throw new Error(`not a size: ${s}`);
  const exp = { "": 0, K: 1, M: 2, G: 3, T: 4 }[m[2].toUpperCase() as "" | "K" | "M" | "G" | "T"];
  return Math.round(Number(m[1]) * 1024 ** exp);
}

export function fmtBytes(n: number): string {
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(n >= 10 || i === 0 ? 0 : 1)} ${u[i]}`;
}

/** One PCP archive: its files share a base name such as 20261111.00.10 or 20261110. */
export interface Archive {
  dir: string;
  base: string;
  files: string[];
  bytes: number;
}

const ARCHIVE_FILE = /^(\d{8}(?:\.\d{2}\.\d{2})?)\.(index|meta|\d+)(\.[a-z]+)?$/;

export async function pcpArchives(root = OBSERVE.pcpArchives): Promise<Archive[]> {
  const out = new Map<string, Archive>();
  if (!(await exists(root))) return [];
  for await (const host of Deno.readDir(root)) {
    if (!host.isDirectory) continue;
    const dir = join(root, host.name);
    for await (const f of Deno.readDir(dir)) {
      const m = f.isFile ? f.name.match(ARCHIVE_FILE) : null;
      if (!m) continue;
      const key = `${dir}/${m[1]}`;
      const a = out.get(key) ?? { dir, base: m[1], files: [], bytes: 0 };
      a.files.push(f.name);
      a.bytes += (await Deno.stat(join(dir, f.name))).size;
      out.set(key, a);
    }
  }
  // Oldest first (base names sort by time).
  return [...out.values()].sort((a, b) => a.base.localeCompare(b.base));
}

/** Free space of the filesystem holding a path, in percent. */
export async function freePercent(path: string): Promise<number | undefined> {
  const r = await run(["df", "--output=size,avail", "-B1", path]);
  const nums = r.stdout.trim().split("\n").pop()?.trim().split(/\s+/).map(Number);
  return nums && nums[0] ? (100 * nums[1]) / nums[0] : undefined;
}

/**
 * Which archives to delete: oldest first while the total is over the limit or
 * the disk is below its free-space floor. The newest archive (being written)
 * is never deleted.
 */
export function pruneChoice(
  archives: Archive[],
  limitBytes: number,
  freePct: number | undefined,
  minFreePct: number,
  diskBytes: number,
): Archive[] {
  const drop: Archive[] = [];
  let total = archives.reduce((n, a) => n + a.bytes, 0);
  let free = freePct;
  for (const a of archives.slice(0, -1)) {
    const lowDisk = free !== undefined && free < minFreePct;
    if (total <= limitBytes && !lowDisk) break;
    drop.push(a);
    total -= a.bytes;
    if (free !== undefined && diskBytes) free += (100 * a.bytes) / diskBytes;
  }
  return drop;
}

export async function prune(host: HostDef, check = false): Promise<number> {
  const p = ui.phase("Metric archives");
  const o = observabilityPolicy(await loadFleet(), host);
  const archives = await pcpArchives();
  const df = await run(["df", "--output=size", "-B1", OBSERVE.pcpArchives]);
  const disk = Number(df.stdout.trim().split("\n").pop()) || 0;
  const drop = pruneChoice(
    archives,
    parseSize(o.metricsMaxSize),
    await freePercent(OBSERVE.pcpArchives),
    o.minFreePercent,
    disk,
  );
  for (const a of drop) {
    p.change(`remove ${a.dir}/${a.base} (${fmtBytes(a.bytes)})`);
    if (!check) { for (const f of a.files) await Deno.remove(join(a.dir, f)).catch(() => {}); }
  }
  const total = archives.reduce((n, a) => n + a.bytes, 0) - drop.reduce((n, a) => n + a.bytes, 0);
  p.done(
    `${fmtBytes(total)} of ${o.metricsMaxSize} · ${archives.length - drop.length} archive(s)${
      drop.length ? ` · ${drop.length} ${check ? "to remove" : "removed"}` : ""
    }`,
  );
  return 0;
}

async function sizeOf(dir: string): Promise<number | undefined> {
  let n = 0;
  try {
    if (!(await exists(dir))) return 0;
    for await (const e of Deno.readDir(dir)) {
      if (e.isFile) n += (await Deno.stat(join(dir, e.name)).catch(() => ({ size: 0 }))).size;
    }
  } catch {
    return undefined; // not readable by this user
  }
  return n;
}

const active = async (unit: string) => (await run(["systemctl", "is-active", unit])).stdout.trim();

export async function observe(host: HostDef): Promise<number> {
  const o = observabilityPolicy(await loadFleet(), host);

  const l = ui.phase("Logs");
  const usage = (await run(["journalctl", "--disk-usage"])).stdout.match(/take up ([\d.]+\s*\S+)/)
    ?.[1];
  const first = (await run(["journalctl", "-q", "--no-pager", "-o", "short-iso", "--lines=+1"]))
    .stdout.trim().slice(0, 10);
  l.done(
    `journald ${usage ?? "?"} of ${o.logsMaxSize}${
      first ? ` · since ${first}` : ""
    } · kept up to ${o.logsRetention}`,
  );

  const m = ui.phase("Metrics");
  const archives = await pcpArchives();
  const bytes = archives.reduce((n, a) => n + a.bytes, 0);
  const since = archives[0]?.base.slice(0, 8).replace(/(\d{4})(\d{2})(\d{2})/, "$1-$2-$3");
  for (const u of ["pmcd.service", "pmlogger.service", "pmproxy.service"]) {
    const s = await active(u);
    if (s !== "active") m.warn(`${u} is ${s || "not installed"}`, "sudo archon update");
  }
  m.done(
    `PCP ${fmtBytes(bytes)} of ${o.metricsMaxSize}${
      since ? ` · since ${since}` : ""
    } · kept up to ${o.metricsDays} days`,
  );

  const c = ui.phase("OpenTelemetry");
  const state = await active(OBSERVE.collectorUnit);
  if (state !== "active") {
    c.warn(
      `the local Collector is ${state || "not installed"}`,
      "sudo archon tools sync (installs it), then sudo archon update",
    );
  }
  const { lastDiscovery } = await import("./discover.ts");
  const found = await lastDiscovery();
  c.done(
    `Collector ${state} on ${OBSERVE.otlpHttp} · Archon's OTLP ${
      ((n) => n === undefined ? "(size: root only)" : fmtBytes(n))(await sizeOf(OBSERVE.otlpDir))
    } (up to ${o.tracesDays} days, 64 MB) · ${
      found?.endpoint
        ? `forwarding to ${found.endpoint} (found by ${found.source})`
        : "no central collector found: local only"
    }`,
  );

  ui.next.push(
    "live: btop · OpenTelemetry view: archon observe tui · logs: journalctl -f",
  );
  return 0;
}

/** otel-tui on this machine's telemetry: PCP's core metrics live, Archon's recent OTLP. */
export async function observeTui(): Promise<number> {
  const bin = await which("otel-tui");
  if (!bin) {
    console.error("otel-tui is not installed yet: sudo archon tools sync");
    return 1;
  }
  const args = [
    "--host",
    "127.0.0.1",
    "--http",
    "4328",
    "--grpc",
    "4327",
    "--prom-target",
    `http://${OBSERVE.pmproxy}/metrics?names=${CORE_PCP_METRICS.join(",")}`,
  ];
  if (await exists(OBSERVE.otlpFile)) args.push("--from-json-file", OBSERVE.otlpFile);
  const r = await new Deno.Command(bin, {
    args,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  }).spawn().status;
  return r.code;
}
