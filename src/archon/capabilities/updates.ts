/**
 * 009-updates: Ubuntu's unattended-upgrades, as Ubuntu configures it, plus
 * one override (spec 009): the -updates pocket too, so Ubuntu's stable bug-fix
 * updates install daily alongside security updates. Verified, not replaced.
 *
 * @module
 */

import type { Capability } from "../model/types.ts";
import { networkOf } from "../model/resolve.ts";

/** apt on a network without IPv6 (spec 009 FR-005); also covers unattended-upgrades and apt-daily. */
export const APT_NETWORK_IPV4 = [
  "// Archon: this network has no IPv6 route. Resolve and connect over IPv4 only, so a lost",
  '// A record is a retryable "Temporary failure resolving", not an instant IPv6-only failure.',
  'Acquire::ForceIPv4 "true";',
  "// Retry failed downloads (transient DNS failures, timeouts, resets).",
  'Acquire::Retries "5";',
  'Acquire::http::Timeout "30";',
  'Acquire::https::Timeout "30";',
].join("\n") + "\n";

const SPEC = "009-updates" as const;

export const updates = (): Capability => ({ fleet, host }) => ({
  spec: SPEC,
  packages: [{ name: "unattended-upgrades", spec: SPEC }],
  files: [
    {
      path: "/etc/apt/apt.conf.d/52archon-updates",
      content:
        "// Archon (spec 009): also install Ubuntu's stable updates (the -updates pocket) daily.\n" +
        "// Ubuntu's 50unattended-upgrades lists it commented out; apt joins these lists.\n" +
        'Unattended-Upgrade::Allowed-Origins {\n  "${distro_id}:${distro_codename}-updates";\n};\n',
      mode: "0644",
      owner: "root",
      spec: SPEC,
    },
    ...(networkOf(fleet, host).ipv6 ? [] : [{
      // Spec 009 FR-005: an IPv4-only network (network.ipv6 false in the model).
      path: "/etc/apt/apt.conf.d/52archon-network",
      content: APT_NETWORK_IPV4,
      mode: "0644",
      owner: "root",
      spec: SPEC,
    }]),
  ],
  checks: [
    {
      name: "dns:ipv4",
      command: "getent ahostsv4 archive.ubuntu.com",
      level: "warn",
      fix: "DNS isn't returning IPv4 addresses; check the router's upstream DNS",
      spec: SPEC,
    },
    {
      name: "apt:ipv4-only",
      // Only where the host has no global IPv6 default route.
      command:
        `sh -c 'ip -6 route show default | grep -q . || grep -q "Acquire::ForceIPv4 \\"true\\"" /etc/apt/apt.conf.d/52archon-network'`,
      level: "warn",
      fix:
        "this host has no IPv6 route: set network: { ipv6: false } in fleets/<fleet>/fleet.ts (or the host), then sudo archon update",
      spec: SPEC,
    },
  ],
  units: [
    {
      unitName: "apt-daily-upgrade.timer",
      managed: false,
      state: "enabled",
      verify: "systemctl is-enabled apt-daily-upgrade.timer",
      spec: SPEC,
    },
    {
      unitName: "unattended-upgrades.service",
      managed: false,
      state: "ignore",
      verify: "systemctl is-enabled unattended-upgrades.service",
      spec: SPEC,
    },
  ],
});
