/**
 * 010-tools: the tool catalog, its apt packages, and the weekly tools sync.
 *
 * @module
 */

import type { Capability } from "../model/types.ts";
import { TOOLS } from "../tools/catalog.ts";
import { ppaOrigin } from "../apply/ppa.ts";
import { archonService, timer } from "../render/systemd.ts";

const SPEC = "010-tools" as const;

/** The tool catalog, its apt packages, and the weekly tools sync (spec 010). */
export const tools = (): Capability => ({ host }) => ({
  spec: SPEC,
  // The agent layer is a workstation's (spec 030): servers never get it.
  tools: TOOLS.filter((t) =>
    (!t.workstationOnly || host.kind === "workstation") &&
    (!t.serverOnly || host.kind !== "workstation")
  ),
  packages: TOOLS.filter((t) => t.source === "apt").map((t) => ({
    name: t.package!,
    ...(t.ppa ? { ppa: t.ppa } : {}),
    ...(t.repo ? { repo: t.repo.id } : {}),
    spec: SPEC,
  })),
  aptRepos: TOOLS.flatMap((t) => t.repo ? [t.repo] : []),
  files: [{
    // unattended-upgrades also follows the maintainers' PPAs and the vendors'
    // repositories, so git, fish, and gh stay at their newest release.
    path: "/etc/apt/apt.conf.d/52archon-ppas",
    content: `// Archon (spec 010): unattended-upgrades also follows these maintainers' PPAs\n` +
      `// and vendors' apt repositories.\n` +
      `Unattended-Upgrade::Allowed-Origins {\n${
        TOOLS.filter((t) => t.ppa).map((t) => `  "${ppaOrigin(t.ppa!)}:\${distro_codename}";\n`)
          .join("")
      }};\n` +
      `Unattended-Upgrade::Origins-Pattern {\n${
        TOOLS.flatMap((t) => t.repo ? [`  "site=${t.repo.site}";\n`] : []).join("")
      }};\n`,
    mode: "0644",
    owner: "root",
    spec: SPEC,
  }],
  units: [
    {
      unitName: "archon-tools-sync.service",
      managed: true,
      content: archonService({
        description: "Archon: upgrade user-tier tools and write the weekly report",
        argv: ["tools", "sync"],
        spec: SPEC,
      }),
      state: "ignore",
      verify: "systemctl cat archon-tools-sync.service",
      spec: SPEC,
    },
    {
      unitName: "archon-tools-sync.timer",
      managed: true,
      content: timer({
        description: "Archon: weekly tools sync",
        onCalendar: "Mon *-*-* 04:00:00",
        randomizedDelay: "1h",
        spec: SPEC,
      }),
      state: "enabled",
      onCalendar: "Mon *-*-* 04:00:00",
      verify: "systemctl is-enabled archon-tools-sync.timer",
      spec: SPEC,
    },
  ],
  notes: [
    "git and fish come from their maintainers' PPAs (git-core/ppa, fish-shell/release-4) and gh from GitHub's apt repository (key pinned), all kept current by unattended-upgrades; tmux from Ubuntu. Deno, chezmoi, and oh-my-posh are their newest upstream binary releases under /opt/tools/<tool>/<version>, checksum-verified and linked into /usr/local/bin.",
    host.kind === "workstation"
      ? "The agent layer (spec 030) is the workstation's own choice of MCP client; .mcp.json lists every server."
      : "No agent runs here (spec 030): workstations reach this server as ops through archon mcp over SSH.",
  ],
});
