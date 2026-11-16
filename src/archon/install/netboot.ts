/**
 * `archon reboot [--netboot]` (spec 004): for a re-install, boot from the
 * network once (UEFI BootNext) and then reboot. The boot order itself never
 * changes, so ordinary reboots never wait for a network boot. The install
 * recorded the firmware entry it network-booted from; without that record
 * (a host installed by hand) the first PXE or HTTP IPv4 entry is used.
 *
 * @module
 */

import { fs } from "@intellectual-frontiers/commons/ts/runtime";
import { run } from "../core/exec.ts";
import { ui } from "../core/ui.ts";

/** Where the install recorded the firmware entry it network-booted from. */
export const NETBOOT_ENTRY = "/etc/archon/netboot-entry";

/** One UEFI boot entry. */
export interface BootEntry {
  /** Its id (hex). */
  id: string;
  /** Its label. */
  label: string;
}

/** efibootmgr's output, parsed. */
export function parseEfibootmgr(out: string): { current?: string; entries: BootEntry[] } {
  const current = out.match(/^BootCurrent:\s*([0-9A-Fa-f]{4})/m)?.[1];
  const entries = [...out.matchAll(/^Boot([0-9A-Fa-f]{4})\*?\s+(.*)$/gm)].map((m) => ({
    id: m[1] ?? "",
    label: (m[2] ?? "").split("\t")[0]?.trim() ?? "",
  }));
  return { ...(current === undefined ? {} : { current }), entries };
}

/** The recorded entry if it still exists, else the best-looking network entry. */
export function pickNetbootEntry(entries: BootEntry[], recorded?: string): BootEntry | undefined {
  const r = recorded?.trim().toUpperCase();
  const byId = r ? entries.find((e) => e.id.toUpperCase() === r) : undefined;
  if (byId) return byId;
  const net = entries.filter((e) => /PXE|HTTP|Network|IPv4|NIC|LAN/i.test(e.label));
  return (
    net.find((e) => /PXE/i.test(e.label) && /IPv4|IP4/i.test(e.label)) ??
    net.find((e) => /IPv4|IP4/i.test(e.label)) ??
    net[0]
  );
}

/** archon reboot (and poweroff): wait for apt and dpkg, then reboot (once from the network, with --netboot) or shut down. */
export async function reboot(opts: {
  netboot: boolean;
  now?: boolean;
  poweroff?: boolean;
}): Promise<number> {
  // Spec 054: never in the middle of apt or dpkg (it can break dpkg's state).
  if (!opts.now) {
    const w = ui.phase("Packages");
    const { waitForPackages } = await import("./apt-busy.ts");
    const quiet = await waitForPackages((what, s) =>
      w.status(`waiting for ${what.join(", ")} to finish (${s}s; Ctrl+C is safe)`),
    );
    if (!quiet) {
      w.fail(
        "apt or dpkg is still changing packages after 15 minutes",
        `see what it does: journalctl -u unattended-upgrades -u apt-daily-upgrade -f; then run it again (or --now, if you accept the risk to dpkg's state)`,
        "E009-APT-BUSY",
      );
      return 1;
    }
    w.done("nothing is changing packages");
  }
  if (opts.poweroff) {
    const p = ui.phase("Power off");
    const { notify } = await import("../notify/events.ts");
    await notify({
      event: "⏻ powering off",
      level: "warn",
      what: "archon poweroff: this host is shutting down; it stays off until someone powers it on.",
      key: `poweroff:${new Date().toISOString().slice(0, 16)}`,
    });
    const r = await run([
      "systemd-run",
      "--quiet",
      "--on-active=5",
      "--timer-property=AccuracySec=1s",
      "systemctl",
      "poweroff",
    ]);
    if (!r.ok) {
      p.fail(`could not schedule the power-off: ${(r.stderr || r.stdout).trim()}`);
      return 1;
    }
    p.done("powering off in 5s (a clean shutdown)");
    return 0;
  }
  const p = ui.phase("Reboot");
  if (opts.netboot) {
    const list = await run(["efibootmgr"]);
    if (!list.ok) {
      p.fail(
        "efibootmgr cannot read the firmware's boot entries",
        "this host may not boot with UEFI; pick network boot from its boot menu instead",
      );
      return 1;
    }
    const { entries } = parseEfibootmgr(list.stdout);
    const e = pickNetbootEntry(entries, await fs.readTextOr(NETBOOT_ENTRY));
    if (!e) {
      p.fail(
        "no network boot entry found in the firmware",
        "enable the network stack (PXE) in the BIOS, or pick network boot from its boot menu",
      );
      return 1;
    }
    const set = await run(["efibootmgr", "--quiet", "--bootnext", e.id]);
    if (!set.ok) {
      p.fail(`efibootmgr --bootnext ${e.id}: ${(set.stderr || set.stdout).trim()}`);
      return 1;
    }
    p.change(`next boot only: Boot${e.id} ${e.label}`);
  }
  // Spec 025: every reboot is reported (queued; sent before or after it).
  const { notify } = await import("../notify/events.ts");
  await notify({
    event: opts.netboot ? "↻ rebooting from the network (re-install if armed)" : "↻ rebooting",
    level: "warn",
    what: opts.netboot
      ? "archon reboot --netboot: this host boots from the network once; if the boot machine armed it, it is re-installed."
      : "archon reboot: this host is rebooting.",
    key: `reboot:${new Date().toISOString().slice(0, 16)}`,
  });
  // A few seconds' delay, so the command (often over SSH) returns cleanly first.
  const r = await run([
    "systemd-run",
    "--quiet",
    "--on-active=5",
    "--timer-property=AccuracySec=1s",
    "systemctl",
    "reboot",
  ]);
  if (!r.ok) {
    p.fail(`could not schedule the reboot: ${(r.stderr || r.stdout).trim()}`);
    return 1;
  }
  p.done(opts.netboot ? "rebooting in 5s, from the network once" : "rebooting in 5s");
  return 0;
}
