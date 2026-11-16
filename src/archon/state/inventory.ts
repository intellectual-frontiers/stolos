/**
 * Spec 051: what this machine is, as it reports itself: make, model, serial,
 * CPUs, memory, disks, and network cards, from its firmware tables, /proc, and
 * /sys. Recorded in archon.sql (the archon_inventory view) at first boot and on
 * every verify that finds it changed, so fleet status and fleet query answer
 * from the machine, never from what someone typed.
 *
 * @module
 */

import { fs } from "@intellectual-frontiers/commons/ts/runtime";
import { run } from "../core/exec.ts";
import { P } from "../core/paths.ts";
import { getRecord, putRecord } from "./store.ts";

/** What a machine is, as it reports itself. */
export interface Inventory {
  /** Its maker. */
  vendor?: string;
  /** Its model. */
  model?: string;
  /** Its serial (readable by root only: absent otherwise). */
  serial?: string;
  /** Its CPUs. */
  cpus: number;
  /** Its memory, in MiB. */
  memMiB?: number;
  /** "nvme0n1 1000 GB nvme" */
  disks: string[];
  /** Physical network cards' MACs (not bridges, VLANs, or containers). */
  macs: string[];
}

const FILLER =
  /^(to be filled by o\.e\.m\.|default string|system (product name|manufacturer|serial number)|not specified|none|0+|)$/i;

async function dmi(key: string): Promise<string | undefined> {
  // product_serial is readable by root only: without root, the serial is left out.
  const v = (await fs.readTextOr(`/sys/class/dmi/id/${key}`).catch(() => undefined))?.trim() ?? "";
  return FILLER.test(v) ? undefined : v;
}

/** Read the machine's inventory from /sys, /proc, and lsblk. */
export async function collectInventory(): Promise<Inventory> {
  const mem = (await fs.readTextOr("/proc/meminfo").catch(() => undefined))?.match(
    /^MemTotal:\s+(\d+) kB/m,
  )?.[1];
  const lsblk = await run(["lsblk", "-dnbro", "NAME,SIZE,TYPE,TRAN", "-e", "1,7,11"]);
  const disks = lsblk.stdout
    .split("\n")
    .map((l) => l.split(" "))
    .filter((f) => f[2] === "disk" && !(f[0] ?? "").startsWith("zram"))
    .map(
      ([name, bytes, , tran]) =>
        `${name} ${Math.round(Number(bytes) / 1e9)} GB${tran ? ` ${tran}` : ""}`,
    );
  const macs: string[] = [];
  try {
    for (const e of fs.readDirSync("/sys/class/net")) {
      // A physical card has a device behind it.
      try {
        fs.statSync(`/sys/class/net/${e.name}/device`);
      } catch {
        continue;
      }
      const a = (
        await fs.readTextOr(`/sys/class/net/${e.name}/address`).catch(() => undefined)
      )?.trim();
      if (a) macs.push(a.toLowerCase());
    }
  } catch {
    /* no /sys */
  }
  const vendor = (await dmi("sys_vendor")) ?? (await dmi("board_vendor"));
  const model = (await dmi("product_name")) ?? (await dmi("board_name"));
  const serial = await dmi("product_serial");
  return {
    ...(vendor === undefined ? {} : { vendor }),
    ...(model === undefined ? {} : { model }),
    ...(serial === undefined ? {} : { serial }),
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
  ]
    .filter(Boolean)
    .join(", ");
}

/** Record it unless the same is already there; true when written. */
export async function recordInventory(host: string, root = P.state): Promise<boolean> {
  const inv = await collectInventory();
  const prev = (await getRecord<Inventory>(host, "inventory", "latest", root))?.body;
  if (prev && JSON.stringify(prev) === JSON.stringify(inv)) return false;
  await putRecord(host, "inventory", "latest", inv, root);
  return true;
}
