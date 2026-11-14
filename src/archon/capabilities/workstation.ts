/**
 * 020-workstation: Ubuntu on WSL (or a desktop) as an Archon workstation.
 * Only the user-level parts of a host apply: the tools at their newest
 * releases, the dotfiles (fish, oh-my-posh, tmux, git), .mcp.json for
 * the operator's own MCP client (spec 030), the archon command, and Ubuntu's daily updates. Nothing that belongs to a
 * server: no installer, netplan, firewall, SSH hardening, ops account,
 * converge timers, or backups. The checkout is /srv/archon, owned by the
 * workstation's user.
 *
 * @module
 */

import { doctor } from "./doctor.ts";
import type { Capability } from "../model/types.ts";
import { header } from "../render/systemd.ts";
import { accounts } from "./accounts.ts";
import { updates } from "./updates.ts";
import { tools } from "./tools.ts";
import { shell } from "./shell.ts";
import { cli } from "./cli.ts";
import { observability } from "./observability.ts";
import { MICROSOFT_KEY } from "../tools/keys/microsoft.ts";
import { expandPersonas } from "../personas/mod.ts";

/**
 * Spec 036: VS Code on a workstation with a graphical desktop, for a user with
 * the developer persona: Microsoft's "code" package from its apt repository
 * (key pinned, Article 12), kept current by apt and unattended-upgrades.
 * WSL and headless machines get nothing: VS Code there runs on the computer
 * in front of you (Remote - SSH, or the WSL extension on Windows).
 */
export const vscode = (): Capability => ({ host, users }) => {
  const dev = users.some((u) => expandPersonas(u.personas).includes("developer"));
  if (host.kind !== "workstation" || !host.desktop || !dev) return { spec: "036-cli-comforts" };
  return {
    spec: "036-cli-comforts",
    aptRepos: [{
      id: "vscode",
      uri: "https://packages.microsoft.com/repos/code",
      suites: "stable",
      components: "main",
      key: MICROSOFT_KEY,
      site: "packages.microsoft.com",
      spec: "036-cli-comforts",
    }],
    packages: [{ name: "code", repo: "vscode", spec: "036-cli-comforts" }],
    files: [{
      // unattended-upgrades keeps VS Code current too.
      path: "/etc/apt/apt.conf.d/52archon-vscode",
      content:
        `// Archon (spec 036): unattended-upgrades also follows Microsoft's VS Code repository.\n` +
        `Unattended-Upgrade::Origins-Pattern {\n  "site=packages.microsoft.com";\n};\n`,
      mode: "0644",
      owner: "root",
      spec: "036-cli-comforts",
    }],
    notes: ["VS Code from Microsoft's apt repository (a desktop workstation)."],
  };
};

const SPEC = "020-workstation" as const;

/** A workstation's base: its packages, its files, and the checks that apply to it (spec 020). */
export const workstationBase = (): Capability => ({ host, fleet, users }) => ({
  spec: SPEC,
  packages: ["git", "curl", "unzip", "software-properties-common"].map((name) => ({
    name,
    spec: SPEC,
  })),
  units: [{
    // WSL runs systemd when /etc/wsl.conf says so (Ubuntu's WSL images do).
    unitName: "systemd-journald.service",
    managed: false,
    state: "ignore",
    verify: "systemctl is-active systemd-journald.service",
    spec: SPEC,
  }],
  files: [
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
          "d /var/lib/archon/status 2775 root archon-ops -",
          "d /var/log/archon 2750 root archon-ops 30d",
          `z /srv/archon 2775 ${users[0].name} archon-ops -`,
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
  notes: [
    "A workstation: tools, dotfiles, and the archon command for one existing account; no server parts.",
  ],
});

/** What every workstation carries (spec 020). */
export function workstation(): Capability[] {
  return [
    workstationBase(),
    accounts(),
    updates(),
    tools(),
    shell(),
    cli(),
    observability(),
    doctor(),
    vscode(),
  ];
}
