// 008-firewall: Ubuntu's native firewall, ufw (nftables backend), with
// incoming traffic denied except the ports the model declares.

import type { Capability, HostPlan } from "../model/types.ts";

const SPEC = "008-firewall" as const;

const portList = (ports: HostPlan["ports"]) => {
  const of = (p: "tcp" | "udp") =>
    [...new Set(ports.filter((x) => x.protocol === p).map((x) => x.port))].sort((a, b) => a - b);
  return [
    ...(of("tcp").length ? [`${of("tcp").join(",")}/tcp`] : []),
    ...(of("udp").length ? [`${of("udp").join(",")}/udp`] : []),
  ].join("|");
};

/** Ports open to everyone (profile Archon) and ports open to local networks only (Archon-LAN). */
export function ufwProfile(plan: HostPlan): string {
  const open = plan.ports.filter((p) => !p.from?.length);
  const lan = plan.ports.filter((p) => p.from?.length);
  const out = [
    "# Rendered by archon from spec 008-firewall. Do not edit.",
    "[Archon]",
    "title=Archon host",
    "description=Ports in this host's Archon model, open to every network",
    `ports=${portList(open) || "22/tcp"}`,
  ];
  if (lan.length) {
    out.push(
      "",
      "[Archon-LAN]",
      "title=Archon host, local networks",
      "description=Ports in this host's Archon model, open to the local networks only",
      `ports=${portList(lan)}`,
    );
  }
  return out.join("\n") + "\n";
}

/** The networks local-only ports admit (the union of their from lists). */
export function lanSources(plan: HostPlan): string[] {
  return [...new Set(plan.ports.flatMap((p) => p.from ?? []))];
}

export const firewall = (): Capability => () => ({
  spec: SPEC,
  packages: [{ name: "ufw", spec: SPEC }],
  units: [{
    unitName: "ufw.service",
    managed: false,
    state: "enabled",
    verify: "systemctl is-active ufw.service",
    spec: SPEC,
  }],
  derive: (plan) => [{
    path: "/etc/ufw/applications.d/archon",
    content: ufwProfile(plan),
    mode: "0644",
    owner: "root",
    spec: SPEC,
    onChange: [
      { kind: "run", argv: ["ufw", "app", "update", "Archon"] },
      { kind: "run", argv: ["ufw", "default", "deny", "incoming"] },
      { kind: "run", argv: ["ufw", "default", "allow", "outgoing"] },
      { kind: "run", argv: ["ufw", "allow", "Archon"] },
      // Local-only ports: one rule per local network (spec 022: Cockpit).
      ...(lanSources(plan).length
        ? [
          { kind: "run" as const, argv: ["ufw", "app", "update", "Archon-LAN"] },
          ...lanSources(plan).map((net) => ({
            kind: "run" as const,
            argv: ["ufw", "allow", "from", net, "to", "any", "app", "Archon-LAN"],
          })),
        ]
        : []),
      { kind: "run", argv: ["ufw", "--force", "enable"] },
      // `ufw app update` rewrites the saved rules but not the running firewall:
      // without a reload, a port added to a profile (445 beside 9090) stays closed.
      { kind: "run", argv: ["ufw", "reload"] },
    ],
  }],
  notes: [
    "Incoming traffic is denied except the ports the model declares: ufw profile Archon (every network) and Archon-LAN (local networks only).",
  ],
});
