/**
 * 022-cockpit: Ubuntu's web console on every server, with PCP's metric history
 * (cockpit-bridge reads the archives spec 021 keeps). Reachable on port 9090 from
 * the local networks only (the networks that may also log in with a password,
 * spec 007); logins are the accounts' own (PAM), root excluded by Cockpit.
 * Installed without apt's recommended extras, so no NetworkManager or
 * PackageKit next to netplan and apt.
 *
 * @module
 */

import type { Capability } from "../model/types.ts";
import { localNetworks } from "./ssh.ts";
import { archonMotd } from "../render/motd.ts";

const SPEC = "022-cockpit" as const;

/** Ubuntu's web console on every server, with PCP's metric history (spec 022). */
export const cockpit = (): Capability => ({ fleet, host }) => {
  const from = localNetworks(fleet);
  return {
    spec: SPEC,
    // PCP's metric history comes with cockpit-bridge itself on Ubuntu 26.04
    // (cockpit-pcp is now a virtual package it provides).
    packages: [{ name: "cockpit", spec: SPEC }],
    // Spec 032: also cockpit.<host>.<domain> through the proxy. Traefik passes
    // the Host header and speaks TLS to Cockpit, so Cockpit's same-origin
    // check holds without an Origins list.
    routes: [{
      name: "cockpit",
      port: 9090,
      https: true,
      description: "Cockpit: system, services, logs, metric history",
      spec: SPEC,
    }],
    // Without local networks (keys only, spec 007), Cockpit is installed but closed.
    ports: from.length ? [{ port: 9090, protocol: "tcp", from, spec: SPEC }] : [],
    files: [{
      // Ubuntu's login banner (update-motd) says how to observe this host.
      path: "/etc/update-motd.d/70-archon",
      // Spec 019: the same emoji and colors as archon's own output.
      content: archonMotd(fleet, host, from.length > 0),
      mode: "0755",
      owner: "root",
      spec: SPEC,
    }],
    units: [{
      unitName: "cockpit.socket",
      managed: false,
      state: "enabled",
      start: true,
      verify: "systemctl is-active cockpit.socket",
      spec: SPEC,
    }],
    notes: [
      `Cockpit: https://<host>:9090 from ${
        from.join(", ") || "nowhere (keys only)"
      }, with PCP's metric history.`,
    ],
  };
};
