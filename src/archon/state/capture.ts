/**
 * `archon capture` (spec 014, 048): read this host's actual state and compare
 * it with the plan (drift). Nothing is written: the machine answers for itself
 * (archon query).
 *
 * @module
 */

import { fs } from "@intellectual-frontiers/ifc-ts/runtime";
import { run } from "../core/exec.ts";
import { planFor } from "../build.ts";
import type { HostDef } from "../model/types.ts";

/** What a host is now, read from it (archon capture): packages, units, ports, users, tools. */
export interface Snapshot {
  /** The host. */
  host: string;
  /** When it was read (ISO time). */
  captured: string;
  /** Its Ubuntu release. */
  ubuntu: string;
  /** Its running kernel. */
  kernel: string;
  /** Packages installed by hand (apt-mark showmanual). */
  manualPackages: string[];
  /** Snaps installed. */
  snaps: string[];
  /** Enabled systemd units. */
  enabledUnits: string[];
  /** Listening sockets. */
  listening: string[];
  /** Accounts with a login shell. */
  users: string[];
  /** Each tool's version (null: not installed). */
  tools: Record<string, string | null>;
}

/** How a host differs from its plan. */
export interface Drift {
  /** Packages the plan has that the host does not. */
  missingPackages: string[];
  /** Units not in the state the plan says. */
  unitsNotInDesiredState: string[];
  /** Ports listening that the plan does not open. */
  unmodeledListeningPorts: string[];
}

const out = async (argv: string[]) => (await run(argv)).stdout;
const lines = (s: string) =>
  s
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

/** Read what the host is now. */
export async function snapshot(host: HostDef): Promise<Snapshot> {
  const plan = await planFor(host);
  const osr = await fs.readTextFile("/etc/os-release").catch(() => "");
  const tools: Record<string, string | null> = {};
  for (const t of plan.tools) {
    const r = await run(["sh", "-c", `${t.versionCommand} 2>/dev/null | head -1`]);
    tools[t.id] = r.stdout.trim() || null;
  }
  return {
    host: host.name,
    captured: new Date().toISOString(),
    ubuntu: osr.match(/^VERSION="?([^"\n]+)/m)?.[1] ?? "unknown",
    kernel: (await out(["uname", "-r"])).trim(),
    manualPackages: lines(await out(["apt-mark", "showmanual"])).sort(),
    snaps: lines(await out(["snap", "list"]))
      .slice(1)
      .map((l) => l.split(/\s+/)[0] ?? "")
      .sort(),
    enabledUnits: lines(
      await out(["systemctl", "list-unit-files", "--state=enabled", "--no-legend", "--plain"]),
    )
      .map((l) => l.split(/\s+/)[0] ?? "")
      .sort(),
    listening: [
      ...new Set(
        lines(await out(["ss", "-Hlntu"])).map((l) => {
          const f = l.split(/\s+/);
          return `${f[0]}/${f[4]}`;
        }),
      ),
    ].sort(),
    users: lines(await out(["getent", "passwd"]))
      .map((l) => l.split(":"))
      .filter((f) => Number(f[2]) >= 1000 && Number(f[2]) < 60000)
      .map((f) => f[0] ?? "")
      .sort(),
    tools,
  };
}

/** Compare a snapshot with the host's plan. */
export async function drift(host: HostDef, s: Snapshot): Promise<Drift> {
  const plan = await planFor(host);
  const installed = new Set(lines(await out(["dpkg-query", "-W", "-f=${Package}\\n"])));
  const snaps = new Set(s.snaps);
  const missingPackages = plan.packages
    .filter((p) => (p.source === "snap" ? !snaps.has(p.name) : !installed.has(p.name)))
    .map((p) => p.name);
  const unitsNotInDesiredState: string[] = [];
  for (const u of plan.units) {
    if (u.state === "ignore") continue;
    const en = (await out(["systemctl", "is-enabled", u.unitName])).trim();
    const enabled = en === "enabled" || en === "static" || en === "alias";
    if ((u.state === "enabled") !== enabled) {
      unitsNotInDesiredState.push(`${u.unitName} (want ${u.state})`);
    }
  }
  const modeled = new Set(plan.ports.map((p) => `${p.protocol}/${p.port}`));
  const unmodeledListeningPorts = s.listening.filter((l) => {
    const [proto, addr = ""] = l.split("/");
    const port = addr.slice(addr.lastIndexOf(":") + 1);
    const local = /^(127\.|\[::1\]|\[?::ffff:127\.)/.test(addr) || addr.includes("%lo:");
    // DHCP clients (68, 546) and resolved's stub (53 on 127.0.0.53/54) serve nothing.
    const client = proto === "udp" && (port === "68" || port === "546");
    return !local && !client && !modeled.has(`${proto}/${port}`);
  });
  return { missingPackages, unitsNotInDesiredState, unmodeledListeningPorts };
}

/** archon capture: show the snapshot and the drift (read-only). */
export async function capture(
  host: HostDef,
): Promise<{ snapshot: Snapshot; drift: Drift; summary: string }> {
  const s = await snapshot(host);
  const d = await drift(host, s);
  const summary = [
    `drift for ${host.name}:`,
    `  missing modeled packages:    ${d.missingPackages.join(", ") || "none"}`,
    `  units not in desired state:  ${d.unitsNotInDesiredState.join(", ") || "none"}`,
    `  unmodeled listening ports:   ${d.unmodeledListeningPorts.join(", ") || "none"}`,
  ].join("\n");
  return { snapshot: s, drift: d, summary };
}
