/**
 * Spec 051: the blank-disk guard. Before Ubuntu's installer touches a disk, it
 * reports the machine's own facts (from its firmware tables, /proc, and its
 * disks) to this boot server, which answers "ok" or "stop: why". The install
 * goes on by itself only when every disk is blank, when a person confirmed
 * with --confirm-destroy <host>, or when the machine is this host already (it
 * installed as this host, or boot reinstall reached it over SSH). Anything
 * else stops before a byte is written, and the boot window says what the
 * machine holds and the one command that lets it go on.
 *
 * ```mermaid
 * flowchart TD
 *   facts["the installer reports the machine's facts<br/>(before any disk is touched)"] --> disks{"any disk?"}
 *   disks -->|no| stop1["stop: no disk to install to"]
 *   disks -->|yes| blank{"every disk blank?<br/>(wipefs, partitions)"}
 *   blank -->|yes| go["ok: install"]
 *   blank -->|no| confirmed{"--confirm-destroy &lt;host&gt;<br/>for this install?"}
 *   confirmed -->|yes| go
 *   confirmed -->|no| same{"this host's own machine?<br/>(installed MAC, or boot reinstall)"}
 *   same -->|yes| go
 *   same -->|no| stop2["stop before writing, power off<br/>(E051-DISK-NOT-BLANK)"]
 *   noanswer["no answer from the boot server"] --> stop3["no install"]
 * ```
 *
 * @module
 */

import type { InstallToken } from "../archon/core/secrets.ts";
import type { HostRegistration } from "../archon/model/types.ts";

/**
 * Run by the installer (early-commands) with the host's install URL. Facts
 * only, as key=value lines; the decision is the boot server's. It fails
 * closed: no answer, no install.
 */
export const GUARD_SCRIPT = `#!/bin/sh
# archon-boot (spec 051): before any disk is touched, report this machine's
# facts to the boot server and do what it answers. Nothing here writes a disk.
B="$1"
F=/tmp/archon-facts
{
  for k in sys_vendor product_name product_serial board_vendor board_name; do
    echo "$k=$(cat /sys/class/dmi/id/$k 2>/dev/null)"
  done
  echo "mem_kib=$(awk '/^MemTotal:/ { print $2 }' /proc/meminfo)"
  echo "cpus=$(nproc 2>/dev/null)"
  # Disks (not RAM disks, loops, or optical drives, by their fixed majors; zram by
  # name: its major, like virtio's and NVMe's, is assigned at boot).
  lsblk -dnbro NAME,SIZE,TYPE,TRAN -e 1,7,11 2>/dev/null |
    awk '$3 == "disk" && $1 !~ /^zram/ { print "disk=" $1 " " $2 " " $4 }'
  # What is on them, probed on the disks themselves (wipefs): udev's database,
  # which lsblk reads, is not filled in yet this early. Any partition the kernel
  # sees counts too. A disk that cannot be probed counts as not blank.
  for d in $(lsblk -dnro NAME,TYPE -e 1,7,11 2>/dev/null | awk '$2 == "disk" && $1 !~ /^zram/ { print "/dev/" $1 }'); do
    command -v wipefs >/dev/null || { echo "signature=$d unchecked (no wipefs)"; continue; }
    for x in $d $(lsblk -nrpo NAME,TYPE "$d" 2>/dev/null | awk '$2 == "part" { print $1 }'); do
      [ "$x" = "$d" ] || echo "signature=$x partition"
      wipefs -n --noheadings -O DEVICE,TYPE "$x" 2>/dev/null | awk 'NF > 1 { print "signature=" $1 " " $2 }' ||
        echo "signature=$x unchecked"
    done
  done
} >"$F"
A=$(curl -fsS --noproxy "*" -m 30 -X POST -H 'content-type: text/plain' --data-binary @"$F" "\${B}facts") ||
  A="stop: the boot server did not answer, so nothing was erased (is deno task boot serve running?)"
case "$A" in
  ok*) exit 0 ;;
esac
echo "archon: $A" | tee /dev/console
echo "archon: nothing was written to any disk; this machine powers off in 30 seconds." | tee /dev/console
sleep 30
poweroff -f
`;

/** What a machine says about itself, before its install (from its firmware tables, /proc, and its disks). */
export interface MachineFacts {
  /** Its maker (firmware filler such as "To Be Filled By O.E.M." is dropped). */
  vendor?: string;
  /** Its model. */
  model?: string;
  /** Its serial number. */
  serial?: string;
  /** Its memory, in KiB. */
  memKiB?: number;
  /** Its CPUs. */
  cpus?: number;
  /** Its disks: name, size in bytes, and how attached (nvme, sata, usb, virtio). */
  disks: Array<{ name: string; bytes: number; transport?: string }>;
  /** Partition tables and filesystems found: "/dev/sda gpt", "/dev/sda2 ext4". */
  signatures: string[];
}

/** The script's key=value lines. Unknown keys are ignored; firmware filler is dropped. */
export function parseFacts(text: string): MachineFacts {
  const f: MachineFacts = { disks: [], signatures: [] };
  const filler =
    /^(to be filled by o\.e\.m\.|default string|system (product name|manufacturer|serial number)|not specified|none|0+|)$/i;
  const clean = (v: string) => (filler.test(v.trim()) ? undefined : v.trim());
  for (const line of text.split("\n")) {
    const i = line.indexOf("=");
    if (i < 0) continue;
    const k = line.slice(0, i).trim();
    const v = line.slice(i + 1).trim();
    if (k === "sys_vendor") f.vendor = clean(v);
    else if (k === "board_vendor") f.vendor ??= clean(v);
    else if (k === "product_name") f.model = clean(v);
    else if (k === "board_name") f.model ??= clean(v);
    else if (k === "product_serial") f.serial = clean(v);
    else if (k === "mem_kib" && /^\d+$/.test(v)) f.memKiB = Number(v);
    else if (k === "cpus" && /^\d+$/.test(v)) f.cpus = Number(v);
    else if (k === "disk") {
      const [name, bytes, transport] = v.split(/\s+/);
      if (name && /^\d+$/.test(bytes ?? "")) {
        f.disks.push({ name, bytes: Number(bytes), ...(transport ? { transport } : {}) });
      }
    } else if (k === "signature" && v) f.signatures.push(v.replace(/\s+/g, " "));
  }
  return f;
}

const gb = (bytes: number) =>
  bytes >= 1e12 ? `${(bytes / 1e12).toFixed(1)} TB` : `${Math.round(bytes / 1e9)} GB`;

/** One line, as the machine describes itself. */
export function describeFacts(f: MachineFacts): string {
  const who = [f.vendor, f.model].filter(Boolean).join(" ") ||
    "a machine that does not name itself";
  const ram = f.memKiB ? `${(f.memKiB / 1048576).toFixed(1)} GiB RAM` : "RAM unknown";
  const disks =
    f.disks.map((d) => `${d.name} ${gb(d.bytes)}${d.transport ? ` ${d.transport}` : ""}`)
      .join(", ") || "no disks";
  return `${who}${f.serial ? `, serial ${f.serial}` : ""}, ${f.cpus ?? "?"} CPUs, ${ram}, ${disks}`;
}

/** The guard's answer: go (and why), or stop (why, and the command that lets it go on). */
export type GuardDecision =
  | { go: true; why: string }
  | { go: false; why: string; fix: string };

/** Whether this install may go on (see the header). */
export function guardDecision(
  host: string,
  f: MachineFacts,
  t: Pick<InstallToken, "confirmDestroy" | "reinstall" | "mac">,
  bootMac: string | undefined,
  reg?: Pick<HostRegistration, "mac" | "macSource">,
): GuardDecision {
  if (!f.disks.length) {
    return {
      go: false,
      why: "the installer sees no disk to install to",
      fix:
        "check the machine's disks and its storage controller setting (AHCI, not RAID) in its firmware",
    };
  }
  if (!f.signatures.length) return { go: true, why: "every disk is blank" };
  if (t.confirmDestroy) {
    return { go: true, why: `erasing as confirmed (--confirm-destroy ${host})` };
  }
  if (bootMac && reg?.mac === bootMac && reg.macSource === "installed") {
    return {
      go: true,
      why: `this machine installed as ${host} before (${bootMac}): reinstalling it`,
    };
  }
  if (bootMac && t.reinstall && t.mac === bootMac) {
    return {
      go: true,
      why: `boot reinstall reached ${host} on this machine (${bootMac}): reinstalling it`,
    };
  }
  return {
    go: false,
    why: `its disks are not blank (${
      f.signatures.join("; ")
    }), so the install stopped before writing anything`,
    fix:
      `if this is the machine you mean and its disks may be erased: deno task boot arm ${host} --claim --confirm-destroy ${host} (or --mac-address ${
        bootMac ?? "<mac>"
      } instead of --claim), then network-boot it again`,
  };
}
