// `archon reboot [--netboot]` (spec 004): for a re-install, boot from the
// network once (UEFI BootNext) and then reboot. The boot order itself never
// changes, so ordinary reboots never wait for a network boot. The install
// recorded the firmware entry it network-booted from; without that record
// (a host installed by hand) the first PXE or HTTP IPv4 entry is used.

import { readTextOr } from "../core/fsx.ts";
import { run } from "../core/exec.ts";
import { ui } from "../core/ui.ts";

export const NETBOOT_ENTRY = "/etc/archon/netboot-entry";

export interface BootEntry {
  id: string;
  label: string;
}

export function parseEfibootmgr(out: string): { current?: string; entries: BootEntry[] } {
  const current = out.match(/^BootCurrent:\s*([0-9A-Fa-f]{4})/m)?.[1];
  const entries = [...out.matchAll(/^Boot([0-9A-Fa-f]{4})\*?\s+(.*)$/gm)].map((m) => ({
    id: m[1],
    label: m[2].split("\t")[0].trim(),
  }));
  return { current, entries };
}

/** The recorded entry if it still exists, else the best-looking network entry. */
export function pickNetbootEntry(entries: BootEntry[], recorded?: string): BootEntry | undefined {
  const r = recorded?.trim().toUpperCase();
  const byId = r ? entries.find((e) => e.id.toUpperCase() === r) : undefined;
  if (byId) return byId;
  const net = entries.filter((e) => /PXE|HTTP|Network|IPv4|NIC|LAN/i.test(e.label));
  return net.find((e) => /PXE/i.test(e.label) && /IPv4|IP4/i.test(e.label)) ??
    net.find((e) => /IPv4|IP4/i.test(e.label)) ?? net[0];
}

export async function reboot(opts: { netboot: boolean }): Promise<number> {
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
    const e = pickNetbootEntry(entries, await readTextOr(NETBOOT_ENTRY));
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
