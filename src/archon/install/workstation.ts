/**
 * `stolos workstation add` (spec 020): run inside Ubuntu on WSL (or on an
 * Ubuntu desktop), from the checkout in /srv/archon, as your own user. It
 * writes fleets/<fleet>/hosts/<name>/host.ts (kind "workstation") and then, through
 * sudo, converges the user-level parts: tools, dotfiles, the
 * archon command, Ubuntu's daily updates (archon update --no-pull).
 *
 * @module
 */

import { fs, path, proc, stdio } from "@intellectual-frontiers/system";
import { asRoot, P } from "../core/paths.ts";
import { currentUser, run } from "../core/exec.ts";
import { ui } from "../core/ui.ts";
import { hostFile, loadFleet } from "../model/load.ts";

/** The TypeScript source of a new workstation's host.ts (kind "workstation"). */
export function workstationSource(o: { name: string; user: string; desktop?: boolean }): string {
  return `// Workstation ${o.name} (spec 020). Written by \`stolos workstation add\`; edit
// freely, then \`sudo archon update\`. Only the user-level parts apply here.

import type { HostDef } from "@intellectual-frontiers/stolos/archon/model/types";
import { workstation } from "@intellectual-frontiers/stolos/archon/capabilities/mod";

export const host: HostDef = {
  name: ${JSON.stringify(o.name)},
  kind: "workstation",
  user: ${JSON.stringify(o.user)},
  // Spec 036: a graphical desktop (VS Code installs only there); WSL and headless: false.
  desktop: ${o.desktop ? "true" : "false"},
  arch: "amd64",
  capabilities: workstation(),
  spec: "020-workstation",
};
`;
}

/**
 * `stolos workstation add`: checks this machine (Linux, not root, the fleet's
 * Ubuntu release, systemd, the /srv/archon checkout), writes the host model
 * (kept unless `force`), then runs archon update through sudo. Returns the
 * exit code: 1 when a check fails, else update's.
 */
export async function workstationAdd(o: {
  name?: string;
  user?: string;
  force?: boolean;
}): Promise<number> {
  const c = ui.phase("Checks");
  if (proc.build.os !== "linux") {
    c.fail(
      "run this inside Ubuntu (WSL), not on Windows",
      "open Ubuntu from the Start menu, then cd /srv/archon",
    );
    return 1;
  }
  if (asRoot()) {
    c.fail("run this as your own user (it uses sudo itself)", "exit the root shell first");
    return 1;
  }
  const wsl =
    proc.env.get("WSL_DISTRO_NAME") ??
    ((await fs.exists("/proc/sys/fs/binfmt_misc/WSLInterop")) ? "WSL" : undefined);
  const osRelease = (await fs.readTextOr("/etc/os-release")) ?? "";
  const version = osRelease.match(/^VERSION_ID="?([^"\n]+)"?/m)?.[1];
  const fleet = await loadFleet();
  if (version !== fleet.ubuntu.release) {
    c.fail(
      `this is Ubuntu ${version ?? "unknown"}, the fleet is Ubuntu ${fleet.ubuntu.release}`,
      `install "Ubuntu ${fleet.ubuntu.release} LTS" from the Microsoft Store (wsl --list --online shows its name)`,
    );
  }
  if (!(await fs.exists("/run/systemd/system"))) {
    c.fail(
      "systemd is not running here (timers and Ubuntu's daily updates need it)",
      "printf '[boot]\\nsystemd=true\\n' | sudo tee /etc/wsl.conf, then in PowerShell: wsl --shutdown, and reopen Ubuntu",
    );
  }
  if (P.repo !== "/srv/archon") {
    c.fail(
      `the checkout is ${P.repo}; the archon command runs from /srv/archon`,
      "sudo mkdir -p /srv/archon && sudo chown $USER: /srv/archon && git clone https://github.com/example/fleet.git /srv/archon",
    );
  }
  if (ui.problems.some((p) => p.level === "fail")) return 1;
  const name = (o.name ?? proc.hostname().split(".")[0] ?? "").toLowerCase();
  const user = o.user ?? currentUser();
  // A desktop boots to the graphical target and has a display manager (Ubuntu's
  // cloud and server images default to graphical.target too); WSL never counts.
  const desktop =
    !wsl &&
    (await run(["systemctl", "get-default"])).stdout.trim() === "graphical.target" &&
    (await fs.exists("/etc/systemd/system/display-manager.service"));
  c.done(
    `${
      wsl ? `WSL (${wsl})` : desktop ? "Ubuntu desktop" : "Ubuntu (headless)"
    } · Ubuntu ${version} · systemd · /srv/archon`,
  );

  const m = ui.phase("Model");
  const file = hostFile(name);
  await fs.ensureDir(path.join(P.hosts, name));
  if ((await fs.exists(file)) && !o.force) {
    m.done(`fleets/<fleet>/hosts/${name}/host.ts exists (kept; --force rewrites it)`);
  } else {
    await fs.writeTextFile(file, workstationSource({ name, user, desktop }));
    m.done(`fleets/<fleet>/hosts/${name}/host.ts · workstation for ${user}`);
  }

  // The engine bun.lock holds, then converge through sudo with the same runtime (archon is not
  // installed yet).
  const { engineCommand, installDependencies } = await import("./bun.ts");
  const installed = await installDependencies(P.repo);
  if (!installed.ok) {
    m.fail(
      `the engine could not be installed: ${installed.stderr.trim().split("\n").pop() ?? `exit ${installed.code}`}`,
      `in ${P.repo}: bun install --frozen-lockfile (an integrity error: bun run stolos explain E046-LOCK-INTEGRITY)`,
    );
    return 1;
  }
  ui.pause();
  stdio.stderr.writeSync("\nApplying with sudo (it may ask for your password once):\n\n");
  const r = await proc.output(
    [
      "sudo",
      // ARCHON_GITHUB_API: a site's mirror of GitHub's releases API (spec 010).
      "--preserve-env=ARCHON_VERBOSE,ARCHON_PLAIN,NO_COLOR,LANG,LC_ALL,TERM,ARCHON_GITHUB_API",
      ...engineCommand(),
      path.join(P.repo, "archon.ts"),
      "update",
      "--no-pull",
      "--host",
      name,
      // Spec 046: the fleet of this checkout (until /etc/archon/fleet says so).
      "--fleet",
      P.fleetId,
    ],
    { stdin: "inherit", stdout: "inherit", stderr: "inherit" },
  );
  ui.resume();
  ui.quiet = true; // update printed its own summary
  if (r.success) {
    stdio.stderr.writeSync(
      `${[
        "",
        `next: bun run stolos apply -m "020-workstation: add workstation ${name}"`,
        "then: open a new Ubuntu tab (fish with the Archon prompt); later: sudo archon update",
      ].join("\n")}\n`,
    );
  }
  return r.code;
}
