// Spec 054: powering a machine off while apt or dpkg runs can break dpkg's
// state (the lab did it: dpkg's files were left empty). Right after an install,
// Ubuntu's unattended-upgrades often runs for minutes. archon reboot and
// archon poweroff wait for it, and archon state says it is running.

import { run } from "../core/exec.ts";

const PACKAGE_TOOLS = /^(apt|apt-get|aptitude|dpkg|unattended-upgr|packagekitd)$/;

/** What is changing packages now, from `ps -eo comm=` output; empty when nothing is. */
export function packageWork(psComm: string): string[] {
  const seen = new Set<string>();
  for (const line of psComm.split("\n")) {
    const c = line.trim();
    if (PACKAGE_TOOLS.test(c)) seen.add(c === "unattended-upgr" ? "unattended-upgrades" : c);
  }
  // packagekitd idles in the background; it counts only with another one.
  if (seen.size === 1 && seen.has("packagekitd")) return [];
  return [...seen].sort();
}

/** What is changing packages on this machine now (empty: nothing). */
export async function packagesBusy(): Promise<string[]> {
  const r = await run(["ps", "-eo", "comm="]);
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
