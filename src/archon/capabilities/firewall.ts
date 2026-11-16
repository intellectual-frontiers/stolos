/**
 * 008-firewall: Ubuntu's native firewall, ufw (nftables backend), with
 * incoming traffic denied except the ports the model declares.
 *
 * @module
 */

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

/**
 * The ports this host opens, every one to every network: who reaches the
 * server is the router's decision (the firewall at the edge, outside the
 * machine), never a per-network rule here.
 */
export function ufwProfile(plan: HostPlan): string {
  return (
    [
      "# Rendered by archon from spec 008-firewall. Do not edit.",
      "[Archon]",
      "title=Archon host",
      "description=Ports in this host's Archon model, open to every network (the router filters)",
      `ports=${portList(plan.ports) || "22/tcp"}`,
    ].join("\n") + "\n"
  );
}

/** ufw: incoming traffic denied except the ports the plan opens (spec 008). */
export const firewall = (): Capability => () => ({
  spec: SPEC,
  packages: [{ name: "ufw", spec: SPEC }],
  units: [
    {
      unitName: "ufw.service",
      managed: false,
      state: "enabled",
      verify: "systemctl is-active ufw.service",
      spec: SPEC,
    },
  ],
  derive: (plan) => [
    {
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
        { kind: "run", argv: ["ufw", "--force", "enable"] },
        // `ufw app update` rewrites the saved rules but not the running firewall:
        // without a reload, a port added to a profile (445 beside 9090) stays closed.
        { kind: "run", argv: ["ufw", "reload"] },
      ],
    },
  ],
  notes: [
    "Incoming traffic is denied except the ports the model declares (ufw profile Archon), each open to every network: which networks reach the server is the router's decision.",
  ],
});
