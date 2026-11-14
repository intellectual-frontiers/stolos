/**
 * 017-guests: LXD (Ubuntu's native container and VM manager, a snap) with
 * its default bridge (lxdbr0) and a directory storage pool, initialized once
 * from a rendered preseed. Instances come from the host model.
 *
 * @module
 */

import type { Capability, GuestDef } from "../model/types.ts";

const SPEC = "017-guests" as const;

/** LXD's preseed: its bridge and storage pool, used once by lxd init. */
export const LXD_PRESEED = `# Rendered by archon from spec ${SPEC}. Used once by lxd init --preseed.
config: {}
networks:
- name: lxdbr0
  type: bridge
  config:
    ipv4.address: auto
    ipv6.address: auto
storage_pools:
- name: default
  driver: dir
profiles:
- name: default
  devices:
    eth0:
      name: eth0
      network: lxdbr0
      type: nic
    root:
      path: /
      pool: default
      type: disk
`;

/** One line per guest, so a change to any guest triggers a sync. */
export function guestsManifest(guests: GuestDef[]): string {
  return [
    `# Rendered by archon from spec ${SPEC}. Do not edit.`,
    ...guests.map((g) => JSON.stringify(g)),
    "",
  ].join("\n");
}

/**
 * Spec 032: <guest>.lxd resolves on the host through systemd-resolved, from
 * LXD's own DNS on lxdbr0 (LXD's documented integration), so the proxy can
 * reach guests by name.
 */
export const LXD_DNS_UNIT = `# Rendered by archon from spec ${SPEC}. Do not edit.
[Unit]
Description=Archon: LXD guest names (.lxd) through systemd-resolved
BindsTo=sys-subsystem-net-devices-lxdbr0.device
After=sys-subsystem-net-devices-lxdbr0.device snap.lxd.daemon.service

[Service]
Type=oneshot
ExecStart=/bin/sh -c 'a=$(/snap/bin/lxc network get lxdbr0 ipv4.address | cut -d/ -f1); resolvectl dns lxdbr0 "$a"; resolvectl domain lxdbr0 "~lxd"'
ExecStopPost=/usr/bin/resolvectl revert lxdbr0
RemainAfterExit=yes

[Install]
WantedBy=sys-subsystem-net-devices-lxdbr0.device
`;

/** LXD and the host's guests (spec 017). */
export const guests = (): Capability => ({ host }) => {
  const list = host.guests ?? [];
  if (!list.length) return { spec: SPEC };
  return {
    spec: SPEC,

    packages: [{ name: "lxd", source: "snap", spec: SPEC }],
    files: [
      {
        path: "/etc/archon/lxd-preseed.yaml",
        content: LXD_PRESEED,
        mode: "0644",
        owner: "root",
        spec: SPEC,
        // Only on a host where LXD was never initialized (no storage pool yet).
        onChange: [{
          kind: "run",
          argv: [
            "sh",
            "-c",
            "lxc storage list -f csv 2>/dev/null | grep -q . || lxd init --preseed < /etc/archon/lxd-preseed.yaml",
          ],
        }],
      },
      {
        path: "/etc/archon/guests",
        content: guestsManifest(list),
        mode: "0644",
        owner: "root",
        spec: SPEC,
        onChange: [{ kind: "run", argv: ["/usr/local/bin/archon", "guest", "sync"] }],
      },
    ],
    units: [
      {
        unitName: "snap.lxd.daemon.service",
        managed: false,
        state: "ignore",
        verify: "lxc list --format csv",
        spec: SPEC,
      },
      ...(list.some((g) => g.web)
        ? [{
          unitName: "archon-lxd-dns.service",
          managed: true,
          content: LXD_DNS_UNIT,
          state: "enabled" as const,
          start: true,
          verify: "systemctl is-active archon-lxd-dns.service",
          spec: SPEC,
        }]
        : []),
    ],
    notes: [
      "Guests are reached from the host over lxdbr0; a guest with web: { port } is published as <guest>.<host>.<domain> through the proxy (spec 032).",
    ],
  };
};
