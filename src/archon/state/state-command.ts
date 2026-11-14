/**
 * `archon state` (spec 048): what this machine recorded about itself (its
 * install, its latest verify, the operators' switches) and whether it holds
 * durable data, from its own archon.sql. Fleet status asks each server for
 * this over MCP; nothing is pushed.
 *
 * @module
 */

import { ui } from "../core/ui.ts";
import { loadHosts } from "../model/load.ts";
import { describeData, hostData } from "../model/durable.ts";
import { getRecord, listRecords, STATE_SQL, stateDir } from "./store.ts";
import type { RecordedVerify } from "./verify.ts";
import { describeInventory, type Inventory } from "./inventory.ts";

export interface HostState {
  host: string;
  install?: { at: string; body: Record<string, unknown> };
  verify?: RecordedVerify;
  /** Spec 051: what the machine is, as it reports itself. */
  inventory?: Inventory;
  optIns: Record<string, unknown>;
  data: { class: string; reasons: string[] };
  at: string;
}

export async function hostState(hostName: string, dir = stateDir()): Promise<HostState> {
  const host = (await loadHosts()).find((h) => h.name === hostName);
  const install = await getRecord<Record<string, unknown>>(hostName, "install", "install", dir);
  const verify = (await getRecord<RecordedVerify>(hostName, "verify", "latest", dir))?.body;
  const inventory = (await getRecord<Inventory>(hostName, "inventory", "latest", dir))?.body;
  const optIns = Object.fromEntries(
    (await listRecords(hostName, "optin", dir)).map((r) => [r.name, r.body]),
  );
  const d = host ? hostData(host) : { class: "durable", reasons: ["not in the model"] };
  return {
    host: hostName,
    ...(install ? { install: { at: install.at, body: install.body } } : {}),
    ...(verify ? { verify } : {}),
    ...(inventory ? { inventory } : {}),
    optIns,
    data: { class: d.class, reasons: d.reasons },
    at: new Date().toISOString(),
  };
}

export async function stateCommand(hostName: string, json: boolean): Promise<number> {
  const s = await hostState(hostName);
  if (json) {
    console.log(JSON.stringify(s, null, 2));
    return 0;
  }
  const p = ui.phase(`State of ${hostName}`);
  const i = s.install;
  p.note(
    i
      ? `installed ${i.at.slice(0, 16).replace("T", " ")} · Archon ${i.body.archon ?? "?"} · ${
        i.body.ok === false ? "with problems" : "ok"
      }`
      : "no install record (installed by hand, or before spec 048)",
  );
  if (s.inventory) p.note(`machine: ${describeInventory(s.inventory)}`);
  // Spec 054: say so while packages change (powering off now can break dpkg).
  const { packagesBusy } = await import("../install/apt-busy.ts");
  const busy = await packagesBusy();
  if (busy.length) {
    p.warn(
      `${busy.join(", ")} is changing packages now: do not power this machine off`,
      "wait for it, or turn it off with archon poweroff (it waits for apt)",
      "E009-APT-BUSY",
    );
  }
  if (s.verify) {
    p.note(
      `verify: ${s.verify.passed}/${s.verify.total} checks since ${
        s.verify.since.slice(0, 16).replace("T", " ")
      }`,
    );
    for (const f of s.verify.failed) p.warn(`failing: ${f}`);
  }
  for (const [name, r] of Object.entries(s.optIns)) {
    const o = r as { enabled?: boolean; by?: string; data?: string };
    p.note(`${name}: ${o.enabled ? "on" : "off"}${o.data ? ` (${o.data})` : ""} by ${o.by ?? "?"}`);
  }
  p.done(`${describeData(s.data as never)} · ${stateDir()}/${STATE_SQL}`);
  return ui.finish();
}
