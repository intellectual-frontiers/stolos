/**
 * Spec 103-three-ports FR-009: why the console cannot listen on TCP 443, in plain words. There is no fallback to another port (Article
 * 29): when 443 is in use or not allowed, the LAN listener is refused, and the message names what holds the port where that is cheap
 * to find (Windows: `Get-NetTCPConnection` and the owning process; Linux: `ss -ltnp`; macOS: `lsof`), and the fix. The lookup never
 * fails a command: where it cannot tell, the message says only that the port is taken. `stolos console --lan --lan-port <n>` is the
 * explicit choice, which prints its own firewall rule.
 *
 * @example
 * ```ts
 * import { parseSs } from "./holder.ts";
 * parseSs('LISTEN 0 511 0.0.0.0:443 0.0.0.0:* users:(("nginx",pid=812,fd=6))', 443); // "nginx (process 812)"
 * ```
 *
 * @module
 */
// Spec: 100-remote-access FR-003
// Spec: 103-three-ports FR-009

import { proc } from "@intellectual-frontiers/system";
import { tcp } from "@intellectual-frontiers/net";
import { run } from "../core/exec.ts";

/** What holds a TCP port, read from `ss -ltnp` output (Linux); undefined where it does not show. */
export function parseSs(out: string, port: number): string | undefined {
  for (const line of out.split("\n")) {
    if (!new RegExp(`[:.\\]]${port}\\s`).test(line)) continue;
    const m = line.match(/users:\(\("([^"]+)",pid=(\d+)/);
    if (m) return `${m[1] ?? "?"} (process ${m[2] ?? "?"})`;
    return "another process (run as root to see which)";
  }
  return undefined;
}

/** What holds a TCP port, read from `lsof -nP -iTCP:<port> -sTCP:LISTEN` output (macOS); undefined where it does not show. */
export function parseLsof(out: string): string | undefined {
  const row = out
    .split("\n")
    .slice(1)
    .find((l) => l.trim() !== "");
  const [command, pid] = row?.trim().split(/\s+/) ?? [];
  return command && pid ? `${command} (process ${pid})` : undefined;
}

/** What holds a TCP port, from PowerShell's `name pid` lines (Windows); undefined where it does not show. */
export function parseWindows(out: string): string | undefined {
  const line = out.split("\n").find((l) => /\S+\s+\d+\s*$/.test(l));
  const m = line?.trim().match(/^(.*\S)\s+(\d+)$/);
  return m ? `${m[1] ?? "?"} (process ${m[2] ?? "?"})` : undefined;
}

/** Runs a command and gives its standard output, or undefined where it could not run or failed. */
export type Lookup = (argv: string[]) => Promise<string | undefined>;

const real: Lookup = async (argv) => {
  try {
    const r = await run(argv);
    return r.ok ? r.stdout : undefined;
  } catch {
    return undefined;
  }
};

/** The command lines the lookup runs on one operating system (what holds TCP `port`). */
export function holderCommand(os: string, port: number): string[] {
  if (os === "windows") {
    return [
      "powershell",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `Get-NetTCPConnection -LocalPort ${port} -State Listen | ForEach-Object { $p = Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue; "$($p.ProcessName) $($_.OwningProcess)" }`,
    ];
  }
  if (os === "darwin") return ["lsof", "-nP", `-iTCP:${port}`, "-sTCP:LISTEN"];
  return ["ss", "-ltnp"];
}

/** What holds TCP `port` on this PC, or undefined where it is free or cannot be told. Never throws. */
export async function portHolder(
  port: number,
  os: string = proc.build.os,
  lookup: Lookup = real,
): Promise<string | undefined> {
  const out = await lookup(holderCommand(os, port)).catch(() => undefined);
  if (out === undefined) return undefined;
  return os === "windows"
    ? parseWindows(out)
    : os === "darwin"
      ? parseLsof(out)
      : parseSs(out, port);
}

/** Whether this PC can listen on TCP `port` now (binds on every address and lets go at once); the error's code where it cannot. */
export async function bindProblem(port: number): Promise<string | undefined> {
  try {
    (await tcp.listen({ port, hostname: "0.0.0.0" })).close();
    return undefined;
  } catch (e) {
    return (e as { code?: string }).code ?? (e as Error).name;
  }
}

/** What to do about a port the console cannot have, by the error's code and the operating system. */
function remedy(os: string, port: number, code: string, holder: string | undefined): string {
  if (code === "EACCES" || code === "EPERM") {
    return os === "linux"
      ? `allow Bun to listen on ${port}: sudo setcap 'cap_net_bind_service=+ep' "$(command -v bun)" (or sudo sysctl net.ipv4.ip_unprivileged_port_start=${port}), then run this again`
      : os === "windows"
        ? `see whether Windows reserves it: netsh interface ipv4 show excludedportrange protocol=tcp (run this PC's console from an administrator terminal if it does), then run this again`
        : `run the console as a user who may listen on port ${port}, then run this again`;
  }
  return holder
    ? `stop ${holder.replace(/ \(process \d+\)$/, "")}, or move it off ${port}, then run this again`
    : `stop what listens on ${port} (${os === "windows" ? "Get-NetTCPConnection -LocalPort " + port + " -State Listen" : os === "darwin" ? `lsof -nP -iTCP:${port} -sTCP:LISTEN` : "ss -ltnp"}), then run this again`;
}

/**
 * The refusal when the console cannot listen on its standard port: what failed, what holds the port (if cheap to find), the fix and
 * the explicit choice (`--lan-port`, outside the three standard ports, with its own firewall rule).
 */
export function listenRefusal(o: {
  port: number;
  code: string;
  holder?: string | undefined;
  os?: string;
}): { why: string; fix: string } {
  const os = o.os ?? proc.build.os;
  const inUse = o.code === "EADDRINUSE";
  const cause = inUse
    ? `TCP ${o.port} is in use${o.holder ? `, held by ${o.holder}` : ""}`
    : o.code === "EACCES" || o.code === "EPERM"
      ? `this account may not listen on TCP ${o.port}`
      : `TCP ${o.port} cannot be used (${o.code})`;
  return {
    why: `cannot listen on ${o.port} for the console, and it does not fall back to another port (${cause})`,
    fix: `${remedy(os, o.port, o.code, o.holder)}; or choose a port yourself: bun run stolos console --lan --lan-port <n> (it is outside the three standard ports, and prints its own firewall rule)`,
  };
}
