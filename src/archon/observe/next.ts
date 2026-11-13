// "What now?" for a freshly installed server or workstation (specs 021, 022):
// how to reach it, its web console, and how to observe it. One list, shown by
// the boot server when a host is ready, at the end of the first boot, by
// `boot reinstall`, by `archon fleet status`, and (servers) at SSH login.

import type { FleetDef, HostDef } from "../model/types.ts";
import { localNetworks } from "../capabilities/ssh.ts";

export interface NextOptions {
  host: HostDef;
  fleet: FleetDef;
  /** An address it is known by besides its name. */
  address?: string;
}

export function nextSteps(o: NextOptions): string[] {
  const name = o.host.name;
  const addr = o.address && o.address !== name ? o.address : undefined;
  const server = o.host.kind !== "workstation";
  const lines: string[] = [];
  if (server) {
    lines.push(
      `connect   ssh ${name}${addr ? `   (or ssh ${o.fleet.admin.user}@${addr})` : ""}`,
    );
    if (localNetworks(o.fleet).length && o.fleet.web) {
      lines.push(
        `cockpit   https://cockpit.${name}.${o.fleet.web.domain}   Cockpit: system, services, logs, metric history; your password; from your local network`,
      );
    } else if (localNetworks(o.fleet).length) {
      lines.push(
        `web       https://${name}:9090${
          addr ? `   (or https://${addr}:9090)` : ""
        }   Cockpit: system, services, logs, metric history; your password; from your local network; accept its certificate once`,
      );
    }
  } else {
    lines.push("open      a new Ubuntu tab on this PC (fish with the Archon prompt)");
  }
  lines.push(
    "observe   archon observe          logs, metrics, and OpenTelemetry: how far back, how much, limits",
    "live      btop                    processes and load; archon observe tui: metrics and Archon's runs; journalctl -f: logs",
    "health    archon verify           every check, with a fix for anything failing",
  );
  if (server && o.fleet.web) {
    lines.push(
      `https     https://${name}.${o.fleet.web.domain}   the welcome page (local networks); archon web status`,
    );
  }
  if (server) {
    lines.push(
      `agent     from a workstation's checkout: your MCP client   (server archon-${o.fleet.id}-${name}, over ssh ops@${name}; spec 030)`,
    );
  }
  return lines;
}
