// `archon capture` (spec 014): record this host's actual state as JSON under
// state/hosts/<host>/snapshot/ and compare it with the plan (drift). Exported
// as RDF by `archon export`.

import { join } from "../core/path.ts";
import { ensureDir } from "../core/fsx.ts";
import { P } from "../core/paths.ts";
import { run } from "../core/exec.ts";
import { planFor } from "../build.ts";
import type { HostDef } from "../model/types.ts";

export interface Snapshot {
  host: string;
  captured: string;
  ubuntu: string;
  kernel: string;
  manualPackages: string[];
  snaps: string[];
  enabledUnits: string[];
  listening: string[];
  users: string[];
  tools: Record<string, string | null>;
}

export interface Drift {
  missingPackages: string[];
  unitsNotInDesiredState: string[];
  unmodeledListeningPorts: string[];
}

const out = async (argv: string[]) => (await run(argv)).stdout;
const lines = (s: string) => s.split("\n").map((l) => l.trim()).filter(Boolean);

export async function snapshot(host: HostDef): Promise<Snapshot> {
  const plan = await planFor(host);
  const osr = await Deno.readTextFile("/etc/os-release").catch(() => "");
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
    snaps: lines(await out(["snap", "list"])).slice(1).map((l) => l.split(/\s+/)[0]).sort(),
    enabledUnits: lines(
      await out(["systemctl", "list-unit-files", "--state=enabled", "--no-legend", "--plain"]),
    ).map((l) => l.split(/\s+/)[0]).sort(),
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
      .map((f) => f[0])
      .sort(),
    tools,
  };
}

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
    const [proto, addr] = l.split("/");
    const port = addr.slice(addr.lastIndexOf(":") + 1);
    const local = /^(127\.|\[::1\]|\[?::ffff:127\.)/.test(addr) || addr.includes("%lo:");
    // DHCP clients (68, 546) and resolved's stub (53 on 127.0.0.53/54) serve nothing.
    const client = proto === "udp" && (port === "68" || port === "546");
    return !local && !client && !modeled.has(`${proto}/${port}`);
  });
  return { missingPackages, unitsNotInDesiredState, unmodeledListeningPorts };
}

export async function capture(host: HostDef, opts: { write: boolean }) {
  const s = await snapshot(host);
  const d = await drift(host, s);
  const dir = join(P.state, "hosts", host.name, "snapshot");
  if (opts.write) {
    await ensureDir(dir);
    // The capture time lives in the commit; files change only when the host does.
    const { captured: _c, ...stable } = s;
    await Deno.writeTextFile(join(dir, "snapshot.json"), JSON.stringify(stable, null, 2) + "\n");
    await Deno.writeTextFile(join(dir, "drift.json"), JSON.stringify(d, null, 2) + "\n");
  }
  const summary = [
    `drift for ${host.name}:`,
    `  missing modeled packages:    ${d.missingPackages.join(", ") || "none"}`,
    `  units not in desired state:  ${d.unitsNotInDesiredState.join(", ") || "none"}`,
    `  unmodeled listening ports:   ${d.unmodeledListeningPorts.join(", ") || "none"}`,
    ...(opts.write
      ? ["", "next: archon push --check (is this state waiting to go to GitHub?), then archon push"]
      : []),
  ].join("\n");
  return { snapshot: s, drift: d, summary };
}
