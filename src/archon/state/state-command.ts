/**
 * `archon state` (spec 048): what this machine recorded about itself (its
 * install, its latest verify, the operators' switches) and whether it holds
 * durable data, from its own archon.sql. Fleet status asks each server for
 * this over MCP; nothing is pushed.
 *
 * @module
 */
// Spec: 112-machine-reported-tags FR-005, FR-007
// Spec: 115-compatibility FR-005

import { json } from "@intellectual-frontiers/core";
import { fs, stdio } from "@intellectual-frontiers/commons/ts/runtime";
import { ui } from "../core/ui.ts";
import type { SyncStatus } from "../reconcile/reconcile.ts";
import { loadHosts } from "../model/load.ts";
import { describeData, hostData } from "../model/durable.ts";
import { getRecord, listRecords, STATE_SQL, stateDir } from "./store.ts";
import type { RecordedVerify } from "./verify.ts";
import { describeInventory, type Inventory } from "./inventory.ts";
import { readMachineInfo } from "./reported.ts";
import { listTagRows, type TagBody } from "./tags.ts";

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
  /**
   * Spec 112-machine-reported-tags FR-005, FR-007: what this machine says about itself: its `/etc/machine-info` (as bounded text) and
   * the rows of its own tags table. The PC reads them as untrusted claims (its inventory above carries the firmware facts).
   */
  reported?: { machineInfo?: Record<string, string>; tags: TagBody[] };
  /**
   * Spec 115-compatibility FR-005: the engine this machine runs and the version of each seam it has (`current`, and `minimum`, the
   * oldest PC it reads). The PC compares them with its own contract; the machine reads nothing for it but constants.
   */
  compat?: { engine: string; seams: Record<string, { current: string; minimum: string }> };
  /** Spec 066: the commit this host applies now (its checkout's HEAD). */
  applied?: { commit: string; subject: string; at: string };
  /** Spec 066: what its last pull did (and why it could not, when it could not). */
  sync?: SyncStatus;
  /** When this was read. */
  at: string;
}

/** The checkout's HEAD and the last pull's record, when there are any. */
async function applied(): Promise<Pick<HostState, "applied" | "sync">> {
  const { onHost, P } = await import("../core/paths.ts");
  const { run } = await import("../core/exec.ts");
  const { SYNC_STATUS, syncStatusDecoder } = await import("../reconcile/reconcile.ts");
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
  const [commit, subject = "", at = ""] = g.ok ? g.stdout.trim().split("\t") : [];
  // A missing or half-written file: the next pull writes it again.
  const text = await fs.readTextOr(onHost(SYNC_STATUS));
  const decoded = text === undefined ? undefined : json(text, syncStatusDecoder);
  const sync = decoded?.kind === "ok" ? decoded.value : undefined;
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
  const { onHost } = await import("../core/paths.ts");
  const machineInfo = await readMachineInfo(onHost("/etc/machine-info"));
  const tags = await listTagRows(hostName, dir).catch(() => []);
  return {
    host: hostName,
    reported: { ...(machineInfo ? { machineInfo } : {}), tags },
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
export async function stateCommand(
  hostName: string,
  json: boolean,
  extras: Pick<HostState, "compat"> = {},
): Promise<number> {
  const s = { ...(await hostState(hostName)), ...extras };
  if (json) {
    stdio.stdout.writeSync(`${JSON.stringify(s, null, 2)}\n`);
    return 0;
  }
  const p = ui.phase(`State of ${hostName}`);
  const i = s.install;
  p.note(
    i
      ? `installed ${i.at.slice(0, 16).replace("T", " ")} · Archon ${typeof i.body["archon"] === "string" ? i.body["archon"] : "?"} · ${
          i.body["ok"] === false ? "with problems" : "ok"
        }`
      : "no install record (installed by hand, or before spec 048)",
  );
  if (s.inventory) p.note(`machine: ${describeInventory(s.inventory)}`);
  if (s.compat) {
    p.note(
      `engine ${s.compat.engine} · seams ${Object.entries(s.compat.seams)
        .map(([k, v]) => `${k} ${v.current}`)
        .join(", ")} (minimum of each: stolos compat)`,
    );
  }
  if (s.reported?.tags.length) {
    p.note(
      `its own tags: ${s.reported.tags.map((t) => (t.dimension ? `${t.dimension}:${t.value}` : t.value)).join(" ")} (archon tag list)`,
    );
  }
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
      `verify: ${s.verify.passed}/${s.verify.total} checks since ${s.verify.since
        .slice(0, 16)
        .replace("T", " ")}`,
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
