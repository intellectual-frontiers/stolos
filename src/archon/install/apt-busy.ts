// Spec 054: powering a machine off while apt or dpkg runs can break dpkg's
// state (the lab did it: dpkg's files were left empty). Right after an install,
// Ubuntu's unattended-upgrades often runs for minutes. archon reboot and
// archon poweroff wait for it, and archon state says it is running.

import { run } from "../core/exec.ts";

/**
 * What changes packages, by program name. Ubuntu servers always run
 * unattended-upgrade-shutdown (it waits for a shutdown signal), and process
 * names are cut to 15 characters ("unattended-upgr" for both it and a real
 * run), so the full command line is what tells them apart.
 */
const PACKAGE_TOOLS = new Set(["apt", "apt-get", "aptitude", "dpkg", "unattended-upgrade"]);

/** What is changing packages now, from `ps -eo args=` output; empty when nothing is. */
export function packageWork(psArgs: string): string[] {
  const seen = new Set<string>();
  for (const line of psArgs.split("\n")) {
    // The program, or the script an interpreter runs (python3 /usr/bin/unattended-upgrade).
    const words = line.trim().split(/\s+/).slice(0, 2);
    for (const w of words) {
      const name = w.split("/").pop() ?? "";
      if (PACKAGE_TOOLS.has(name)) seen.add(name);
    }
  }
  return [...seen].sort();
}

/** What is changing packages on this machine now (empty: nothing). */
export async function packagesBusy(): Promise<string[]> {
  const r = await run(["ps", "-eo", "args="]);
  return r.ok ? packageWork(r.stdout) : [];
}

/** Wait until nothing changes packages (up to maxMs); true when it is quiet. */
export async function waitForPackages(
  onWait: (what: string[], waitedS: number) => void,
  maxMs = 15 * 60_000,
  stepMs = 5000,
): Promise<boolean> {
  const start = Date.now();
  for (;;) {
    const busy = await packagesBusy();
    if (!busy.length) return true;
    if (Date.now() - start >= maxMs) return false;
    onWait(busy, Math.round((Date.now() - start) / 1000));
    await new Promise((r) => setTimeout(r, stepMs));
  }
}
