// 001-platform: Ubuntu Server 26.04's own components, verified, never
// replaced (Article 2). This capability installs nothing: it checks that the
// defaults Archon relies on are present, names the host, and creates
// Archon's state directories.

import type { Capability, UnitDef } from "../model/types.ts";
import { header } from "../render/systemd.ts";

const SPEC = "001-platform" as const;

/** Packages Ubuntu installs that Archon relies on (spec 001 table). */
export const RELIED_ON = [
  "netplan.io",
  "systemd-resolved",
  "chrony",
  "sudo-rs",
  "ufw",
  "snapd",
  "unattended-upgrades",
  "cloud-init",
  "openssh-server",
  "apparmor",
  "git",
  "curl",
  "btrfs-progs",
  "zstd",
];

const active = (unitName: string): UnitDef => ({
  unitName,
  managed: false,
  state: "ignore",
  verify: `systemctl is-active ${unitName}`,
  spec: SPEC,
});

/**
 * Article 20 (spec 001 FR-006): no multicast name resolution. resolved keeps
 * mDNS and LLMNR off explicitly; avahi, if any package pulled it in, is masked
 * (its package kept, so dependents stay installed).
 */
export const NO_MULTICAST_NAMES = {
  resolved: "[Resolve]\nMulticastDNS=no\nLLMNR=no\n",
  checks: [
    {
      name: "names:no-multicast-listeners",
      command: `sh -c '! ss -Hlun "sport = :5353 or sport = :5355" | grep -q .'`,
      level: "fail" as const,
      fix: "something listens for mDNS or LLMNR (ss -lunp): mask it (Article 20)",
      spec: "001-platform" as const,
    },
    {
      name: "names:avahi-masked",
      command:
        `sh -c 'for u in avahi-daemon.service avahi-daemon.socket; do s=$(systemctl is-enabled $u 2>/dev/null); case "$s" in masked|masked-runtime|not-found|"") ;; *) exit 1;; esac; done'`,
      level: "fail" as const,
      fix: "sudo archon update (masks avahi-daemon; Article 20)",
      spec: "001-platform" as const,
    },
    {
      name: "names:resolved-no-multicast",
      command:
        `sh -c 'p=$(resolvectl status | grep -m1 "Protocols:"); echo "$p" | grep -q -- "-LLMNR" && echo "$p" | grep -q -- "-mDNS"'`,
      level: "fail" as const,
      fix: "sudo archon update (resolved: MulticastDNS=no, LLMNR=no; Article 20)",
      spec: "001-platform" as const,
    },
  ],
};

export const platform = (): Capability => ({ host, fleet }) => ({
  spec: SPEC,
  packages: RELIED_ON.map((name) => ({ name, spec: SPEC })),
  units: [
    // Article 20: avahi stays installed if something depends on it, but never runs.
    ...["avahi-daemon.service", "avahi-daemon.socket"].map((unitName) => ({
      unitName,
      managed: false,
      state: "masked" as const,
      verify: "true",
      spec: SPEC,
    })),
    active("systemd-networkd.service"),
    active("systemd-resolved.service"),
    active("chrony.service"),
    // snapd is socket-activated: its service runs only while something uses it
    // (a network install seeds snaps, so it happens to be active then; Ubuntu's
    // cloud image leaves it idle). The socket is what must be there.
    active("snapd.socket"),
    active("apparmor.service"),
  ],
  checks: NO_MULTICAST_NAMES.checks,
  files: [
    {
      // Article 20: no mDNS, no LLMNR (also Ubuntu's defaults on a server; explicit and verified).
      path: "/etc/systemd/resolved.conf.d/50-archon.conf",
      content: header(SPEC) + NO_MULTICAST_NAMES.resolved,
      mode: "0644",
      owner: "root",
      spec: SPEC,
      onChange: [{ kind: "restart", unit: "systemd-resolved.service" }],
    },
    {
      // Spec 046: which fleet of the checkout this machine is (archon reads it on every run).
      path: "/etc/archon/fleet",
      content: `${fleet.id}\n`,
      mode: "0644",
      owner: "root",
      spec: SPEC,
    },
    {
      path: "/etc/archon/host",
      content: `${host.name}\n`,
      mode: "0644",
      owner: "root",
      spec: SPEC,
    },
    {
      path: "/etc/tmpfiles.d/archon.conf",
      content: header(SPEC) +
        [
          "d /var/lib/archon 0750 root archon-ops -",
          "d /var/lib/archon/reports 2770 root archon-ops -",
          "d /var/lib/archon/status 2775 root archon-ops -",
          "d /var/lib/archon/prov 2770 root archon-ops -",
          "d /var/lib/archon/snapshots 2770 root archon-ops -",
          "d /var/lib/archon-keys 0711 root root -",
          "d /var/log/archon 2750 root archon-ops 30d",
          "z /srv/archon 2775 ops archon-ops -",
        ].join("\n") + "\n",
      mode: "0644",
      owner: "root",
      spec: SPEC,
      onChange: [{
        kind: "run",
        argv: ["systemd-tmpfiles", "--create", "/etc/tmpfiles.d/archon.conf"],
      }],
    },
  ],
  notes: ["Ubuntu decides; Archon only adds. See specs/001-platform for the defaults relied on."],
});
