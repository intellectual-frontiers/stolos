// Spec 051: what this machine is, as it reports itself: make, model, serial,
// CPUs, memory, disks, and network cards, from its firmware tables, /proc, and
// /sys. Recorded in archon.sql (the archon_inventory view) at first boot and on
// every verify that finds it changed, so fleet status and fleet query answer
// from the machine, never from what someone typed.

import { readTextOr } from "../core/fsx.ts";
import { run } from "../core/exec.ts";
import { P } from "../core/paths.ts";
import { getRecord, putRecord } from "./store.ts";

export interface Inventory {
  vendor?: string;
  model?: string;
  serial?: string;
  cpus: number;
  memMiB?: number;
  /** "nvme0n1 1000 GB nvme" */
  disks: string[];
  /** Physical network cards' MACs (not bridges, VLANs, or containers). */
  macs: string[];
}

const FILLER =
  /^(to be filled by o\.e\.m\.|default string|system (product name|manufacturer|serial number)|not specified|none|0+|)$/i;

async function dmi(key: string): Promise<string | undefined> {
  const v = (await readTextOr(`/sys/class/dmi/id/${key}`))?.trim() ?? "";
  return FILLER.test(v) ? undefined : v;
}

export async function collectInventory(): Promise<Inventory> {
  const mem = (await readTextOr("/proc/meminfo"))?.match(/^MemTotal:\s+(\d+) kB/m)?.[1];
  const lsblk = await run(["lsblk", "-dnbro", "NAME,SIZE,TYPE,TRAN", "-e", "1,7,11"]);
  const disks = lsblk.stdout.split("\n").map((l) => l.split(" "))
    .filter((f) => f[2] === "disk" && !f[0].startsWith("zram"))
    .map(([name, bytes, , tran]) =>
      `${name} ${Math.round(Number(bytes) / 1e9)} GB${tran ? ` ${tran}` : ""}`
    );
  const macs: string[] = [];
  try {
    for (const e of Deno.readDirSync("/sys/class/net")) {
      // A physical card has a device behind it.
      try {
        Deno.statSync(`/sys/class/net/${e.name}/device`);
      } catch {
        continue;
      }
      const a = (await readTextOr(`/sys/class/net/${e.name}/address`))?.trim();
      if (a) macs.push(a.toLowerCase());
    }
  } catch { /* no /sys */ }
  return {
    vendor: (await dmi("sys_vendor")) ?? (await dmi("board_vendor")),
    model: (await dmi("product_name")) ?? (await dmi("board_name")),
    serial: await dmi("product_serial"),
    cpus: navigator.hardwareConcurrency,
    ...(mem ? { memMiB: Math.round(Number(mem) / 1024) } : {}),
    disks,
    macs: [...new Set(macs)].sort(),
  };
}

/** One line: "Intel NUC12WSHi7, serial G6WS…, 16 CPUs, 31.1 GiB RAM, nvme0n1 1000 GB nvme". */
export function describeInventory(i: Inventory): string {
  return [
    [i.vendor, i.model].filter(Boolean).join(" ") || "a machine that does not name itself",
    i.serial ? `serial ${i.serial}` : "",
    `${i.cpus} CPUs`,
    i.memMiB ? `${(i.memMiB / 1024).toFixed(1)} GiB RAM` : "",
    i.disks.join(", "),
  ].filter(Boolean).join(", ");
}

/** Record it unless the same is already there; true when written. */
export async function recordInventory(host: string, root = P.state): Promise<boolean> {
  const inv = await collectInventory();
  const prev = (await getRecord<Inventory>(host, "inventory", "latest", root))?.body;
  if (prev && JSON.stringify(prev) === JSON.stringify(inv)) return false;
  await putRecord(host, "inventory", "latest", inv, root);
  return true;
}
