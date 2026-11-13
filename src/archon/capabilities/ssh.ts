// 007-ssh: OpenSSH hardening as a drop-in (Ubuntu reads sshd_config.d).
// Keys from anywhere; passwords as well only from local networks (the private
// address ranges by default, fleet.ssh.passwordFrom), through an OpenSSH
// Match block. Root never logs in.

import type { Capability } from "../model/types.ts";
import { header } from "../render/systemd.ts";
import { GITHUB_KNOWN_HOSTS } from "../render/autoinstall.ts";

const SPEC = "007-ssh" as const;

/** Local networks: IPv4 private ranges, IPv6 unique-local and link-local. */
export const LOCAL_NETWORKS = [
  "10.0.0.0/8",
  "172.16.0.0/12",
  "10.0.0.0/16",
  "fc00::/7",
  "fe80::/10",
];

/** The fleet's local networks: where passwords, Cockpit, and mDNS are allowed (spec 007). */
export function localNetworks(fleet: { ssh?: { passwordFrom?: string[] } }): string[] {
  return fleet.ssh?.passwordFrom ?? LOCAL_NETWORKS;
}

export function sshdConfig(passwordFrom: string[]): string {
  const lines = [
    "PermitRootLogin no",
    "PasswordAuthentication no",
    "KbdInteractiveAuthentication no",
    "AuthenticationMethods publickey",
  ];
  if (passwordFrom.length) {
    lines.push(
      "",
      "# Local networks: a password works as well as a key (spec 007).",
      "# The Match block ends with this file.",
      `Match Address ${passwordFrom.join(",")}`,
      "    PasswordAuthentication yes",
      "    AuthenticationMethods publickey password",
    );
  }
  return lines.join("\n") + "\n";
}

export const ssh = (): Capability => ({ fleet }) => ({
  spec: SPEC,
  packages: [{ name: "openssh-server", spec: SPEC }],
  ports: [{ port: 22, protocol: "tcp", spec: SPEC }],
  files: [{
    // GitHub's published host key for every account (api.github.com/meta), so
    // no one is asked to trust github.com by hand.
    path: "/etc/ssh/ssh_known_hosts",
    content: GITHUB_KNOWN_HOSTS,
    mode: "0644",
    owner: "root",
    spec: SPEC,
  }, {
    path: "/etc/ssh/sshd_config.d/50-archon.conf",
    content: header(SPEC) + sshdConfig(localNetworks(fleet)),
    mode: "0644",
    owner: "root",
    spec: SPEC,
    postValidate: ["sshd", "-t"],
    onChange: [{ kind: "reload-or-restart", unit: "ssh.service" }],
  }],
  units: [{
    unitName: "ssh.service",
    managed: false,
    state: "ignore",
    verify: "systemctl is-enabled ssh.socket ssh.service",
    spec: SPEC,
  }],
});
