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

/** What a machine recorded about itself (archon state; MCP archon_state). */
export interface HostState {
  /** Its name. */
  host: string;
  /** Its install record. */
  install?: { at: string; body: Record<string, unknown> };
  /** Its latest verify. */
  verify?: RecordedVerify;
  /** Spec 051: what the machine is, as it reports itself. */
  inventory?: Inventory;
  /** Opt-ins and their records. */
  optIns: Record<string, unknown>;
  /** Its data class (Article 23). */
  data: { class: string; reasons: string[] };
  /** Spec 066: the commit this host applies now (its checkout's HEAD). */
  applied?: { commit: string; subject: string; at: string };
  /** Spec 066: what its last pull did (and why it could not, when it could not). */
  sync?: import("../reconcile/reconcile.ts").SyncStatus;
  /** When this was read. */
  at: string;
}

/** The checkout's HEAD and the last pull's record, when there are any. */
async function applied(): Promise<Pick<HostState, "applied" | "sync">> {
  const { P } = await import("../core/paths.ts");
  const { run } = await import("../core/exec.ts");
  const { readTextOr } = await import("../core/fsx.ts");
  const { SYNC_STATUS } = await import("../reconcile/reconcile.ts");
  const g = await run([
    "git",
    "-c",
    `safe.directory=${P.repo}`,
    "-C",
    P.repo,
    "log",
    "-1",
    "--format=%h%x09%s%x09%cI",
  ]);
  const [commit, subject, at] = g.ok ? g.stdout.trim().split("\t") : [];
  let sync;
  try {
    sync = JSON.parse((await readTextOr(SYNC_STATUS)) ?? "null") ?? undefined;
  } catch {
    sync = undefined; // a half-written file: the next pull writes it again
  }
  return { ...(commit ? { applied: { commit, subject, at } } : {}), ...(sync ? { sync } : {}) };
}

/** Read it from archon.sql. */
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
    ...(await applied()),
    at: new Date().toISOString(),
  };
}

/** archon state: show it. */
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
