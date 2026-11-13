// 011-shell: per-user chezmoi data from personas, so `chezmoi apply` never
// prompts. The dotfiles live in home/ (fish, oh-my-posh with the Archon
// status segment, tmux, git).

import type { Capability, UserDef } from "../model/types.ts";
import { expandPersonas, featuresFor } from "../personas/mod.ts";
import { homeOf } from "../model/load.ts";
import { composedDir } from "../dotfiles/layers.ts";
import { dotfilesMotd } from "../render/motd.ts";

const SPEC = "011-shell" as const;

export function chezmoiConfig(u: UserDef, hostName: string, workstation = false): string {
  return JSON.stringify(
    {
      // Composed from the repository's layers by archon apply (spec 031).
      sourceDir: composedDir(u.name),
      // A fixed umask (022: files 644, folders 755), so chezmoi wants the same modes
      // whoever runs it: root (umask 022) in apply and verify, or the person
      // (Ubuntu's 002) in their own shell.
      umask: 0o022,
      data: {
        archon: {
          host: hostName,
          // The agent layer's dotfiles apply on workstations only (spec 030).
          workstation,
          user: u.name,
          fullName: u.fullName,
          email: u.email ?? "",
          personas: expandPersonas(u.personas),
          features: featuresFor(u.personas),
        },
      },
    },
    null,
    2,
  ) + "\n";
}

/** Spec 031: the login banner reminds everyone how their dotfiles work. */
export { dotfilesMotd };

export const shell = (): Capability => ({ host, users }) => ({
  spec: SPEC,
  files: [
    ...users.map((u) => ({
      path: `${homeOf(u)}/.config/chezmoi/chezmoi.json`,
      content: chezmoiConfig(u, host.name, host.kind === "workstation"),
      mode: "0600",
      owner: u.name,
      group: u.name,
      spec: SPEC,
    })),
    {
      path: "/etc/update-motd.d/71-archon-dotfiles",
      content: dotfilesMotd(),
      mode: "0755",
      owner: "root",
      spec: "031-dotfile-layers" as const,
    },
  ],
  // Spec 031: each home directory matches its composed dotfiles (as root, any
  // user; otherwise only your own).
  checks: users.map((u) => ({
    name: `dotfiles of ${u.name} match the repository`,
    command:
      `sh -c 'c=/usr/local/bin/chezmoi; [ -x $c ] || exit 0; if [ "$(id -u)" = 0 ]; then cd / && runuser -u ${u.name} -- $c verify --no-tty; elif [ "$(id -un)" = ${u.name} ]; then $c verify --no-tty; fi'`,
    level: "warn" as const,
    fix: `archon dotfiles --user ${u.name}; chezmoi diff as ${u.name}; sudo archon apply`,
    spec: "031-dotfile-layers" as const,
  })),
  notes: [
    "Login shells stay bash; developer and operator personas start fish for interactive sessions.",
  ],
});
