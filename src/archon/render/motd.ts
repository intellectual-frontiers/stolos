/**
 * The login banner (update-motd) lines Archon adds, in the same calm,
 * colored, emoji style as archon's own output (Article 19). Ubuntu's pam_motd
 * runs these scripts as root at each login and shows their output as is; the
 * colors are plain ANSI escapes, which every terminal shows.
 *
 * @module
 */

import type { FleetDef, HostDef } from "../model/types.ts";
import type { HostData } from "../model/durable.ts";
import { fqdn } from "../web/config.ts";

/** Shell lines that define the colors: bold, dim, cyan, yellow, reset. */
const COLORS = [
  `b=$(printf '\\033[1m'); d=$(printf '\\033[2m'); c=$(printf '\\033[36m')`,
  `y=$(printf '\\033[33m'); g=$(printf '\\033[32m'); r=$(printf '\\033[0m')`,
];

function script(spec: string, body: string[]): string {
  return [
    "#!/bin/sh",
    `# Rendered by archon from spec ${spec}. Do not edit.`,
    ...COLORS,
    // Unquoted: ${b}, ${c}, ... expand; nothing else in the text does.
    "cat <<EOF",
    "",
    ...body,
    "EOF",
  ].join("\n") + "\n";
}

/** 70-archon (specs 021, 022, 032): this server, how to observe it, where it answers. */
export function archonMotd(fleet: FleetDef, host: HostDef, cockpitFromLan: boolean): string {
  const name = fqdn(fleet, host);
  return script("022-cockpit", [
    ` 🛰️  \${b}Archon\${r} \${d}·\${r} \${b}${host.name}\${r} \${d}managed from the fleet repository (${fleet.repository.slug})\${r}`,
    ...(name
      ? [
        `    🌐 \${c}https://${name}\${r}   \${d}welcome page, services, health\${r}`,
      ]
      : []),
    ...(cockpitFromLan
      ? [
        `    🖥️  \${c}${
          name ? `https://cockpit.${name}` : `https://${host.name}:9090`
        }\${r}   \${d}Cockpit: system, services, logs, metric history\${r}`,
      ]
      : []),
    `    📊 \${c}archon observe\${r} \${d}·\${r} \${c}btop\${r} \${d}·\${r} \${c}archon observe tui\${r}   \${d}logs, metrics, limits\${r}`,
    `    ✅ \${c}archon verify\${r} \${d}·\${r} \${c}archon web status\${r}   \${d}every check, with a fix for each\${r}`,
    `    📘 \${c}archon guide\${r}   \${d}what's here, how to use it, and how to manage it with an AI agent\${r}`,
  ]);
}

/** 71-archon-dotfiles (spec 031): how dotfiles work here, and what not to do. */
export function dotfilesMotd(): string {
  return script("031-dotfile-layers", [
    ` 🏠 \${b}Your dotfiles\${r} \${d}come from the fleet repository, applied by chezmoi\${r}`,
    `    🔎 \${c}archon dotfiles\${r}        \${d}where each of your files comes from\${r}`,
    `    👀 \${c}chezmoi diff\${r}           \${d}what the next converge would change in your home\${r}`,
    `    ✏️  \${g}to change one:\${r} edit the file \${c}archon dotfiles\${r} names, commit, push`,
    `    💻 \${g}this machine only:\${r} \${c}~/.bashrc.local\${r}, \${c}~/.config/fish/local.fish\${r} \${d}(never touched)\${r}`,
    `    🚫 \${y}not here:\${r} chezmoi add, edit, init, update   📖 \${c}man archon-dotfiles\${r}`,
  ]);
}

/** 72-archon-data (spec 044, Article 23): durable or ephemeral, why, and the home-directory rule. */
export function dataMotd(d: HostData): string {
  return script("044-durable", [
    d.class === "durable"
      ? ` 🛡️  \${b}\${y}durable\${r} \${d}·\${r} ${
        d.reasons.join(", ")
      } \${d}holds data that exists nowhere else: reinstalls and wipes need --confirm-destroy\${r}`
      : ` 🫧 \${b}ephemeral\${r} \${d}·\${r} \${d}nothing here holds end users' data that exists nowhere else\${r}`,
    `    🏠 \${d}your home directory is not kept across a reinstall: keep data in a share, a bucket, or a database\${r}   \${c}archon data\${r}`,
  ]);
}
