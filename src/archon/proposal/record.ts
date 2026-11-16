/**
 * Spec 095-proposals: recording mode and reminders. `archon record "nginx
 * for the app"`, then the work, then `archon record done`: everything
 * observed in between is one intent, with that reason, ready for `archon
 * propose --intent <id>`. And so nothing waits forever, the daily report and
 * `archon doctor` count drift not proposed and proposals not decided; after 3
 * days the daily report mails a reminder (at most every 3 days).
 *
 * ```mermaid
 * sequenceDiagram
 *   participant A as a person (sudo)
 *   participant S as archon
 *   A->>S: archon record "nginx for the app"
 *   A->>S: sudo apt install nginx, edit, enable ...
 *   A->>S: archon record done
 *   S->>S: collect; everything seen in between is intent r-...
 *   A->>S: sudo archon propose --intent r-...
 * ```
 *
 * @module
 */

import { stdio } from "@intellectual-frontiers/commons/ts/runtime";
import { asRoot, P } from "../core/paths.ts";
import { getRecord, putRecord, removeRecords } from "../state/store.ts";
import type { HostDef } from "../model/types.ts";
import type { Event } from "../notify/notify.ts";
import type { DriftView } from "./server.ts";
import { unproposed } from "./drift.ts";
import type { Recording } from "./group.ts";
import { REMIND_DAYS } from "./types.ts";

const stamp = (iso: string) => iso.slice(0, 16).replace(/[-:T]/g, "");

/** Start a recording; throws while another runs. */
export async function startRecording(
  host: string,
  reason: string,
  by: string,
  dir: string = P.state,
  now: Date = new Date(),
): Promise<Recording> {
  const cur = await getRecord<Recording>(host, "recording", "current", dir);
  if (cur) {
    throw new Error(
      `a recording is running since ${cur.body.start
        .slice(0, 16)
        .replace("T", " ")} UTC (${cur.body.by}: "${cur.body.reason}"): archon record done first`,
    );
  }
  if (!reason.trim()) throw new Error('say why: archon record "nginx for the app"');
  const r: Recording = {
    id: `r-${stamp(now.toISOString())}`,
    reason: reason.trim(),
    by,
    start: now.toISOString(),
  };
  await putRecord(host, "recording", "current", r, dir, r.start);
  return r;
}

/** End the running recording; it is kept under its id. */
export async function endRecording(
  host: string,
  dir: string = P.state,
  now: Date = new Date(),
): Promise<Recording> {
  const cur = await getRecord<Recording>(host, "recording", "current", dir);
  if (!cur) throw new Error('no recording is running: archon record "reason" starts one');
  const done: Recording = { ...cur.body, end: now.toISOString() };
  await putRecord(host, "recording", done.id, done, dir, done.start);
  await removeRecords(host, "recording", "current", dir);
  return done;
}

/** `archon record ["reason" | done]`: start, end (then collect and show the intent), or show the running one. */
export async function recordCommand(
  host: HostDef,
  arg: string | undefined,
  by: string,
): Promise<number> {
  if (!arg) {
    const cur = await getRecord<Recording>(host.name, "recording", "current");
    stdio.stdout.writeSync(
      `${
        cur
          ? `recording ${cur.body.id} since ${cur.body.start
              .slice(0, 16)
              .replace(
                "T",
                " ",
              )} UTC, by ${cur.body.by}: "${cur.body.reason}" (archon record done ends it)`
          : 'no recording is running (archon record "reason" starts one)'
      }\n`,
    );
    return 0;
  }
  if (arg === "done") {
    const r = await endRecording(host.name);
    stdio.stdout.writeSync(`recording ${r.id} ended: "${r.reason}"\n`);
    if (asRoot()) {
      const { collect } = await import("./collect.ts");
      await collect(host);
    }
    const { loadDrift } = await import("./server.ts");
    const { groupItems } = await import("./group.ts");
    const v = await loadDrift(host);
    const intent = groupItems(unproposed(v.items), v.observations, [r]).find((i) => i.id === r.id);
    if (!intent?.items.length) {
      stdio.stdout.writeSync(
        "nothing changed outside Stolos while it ran (archon drift shows all drift)\n",
      );
      return 0;
    }
    stdio.stdout.writeSync(`${intent.items.length} change(s) in it:\n`);
    for (const k of intent.items) stdio.stdout.writeSync(`  ${k}\n`);
    stdio.stdout.writeSync(
      `propose them: sudo archon propose --intent ${r.id}   (its reason is the recording's)\n`,
    );
    return 0;
  }
  const r = await startRecording(host.name, arg, by);
  stdio.stdout.writeSync(
    `recording ${r.id}: "${r.reason}". Do the work, then: archon record done\n`,
  );
  return 0;
}

/** What is waiting: drift not proposed, proposals not decided, and whether a reminder is due. */
export interface Waiting {
  /** Drift items not proposed (nor local, nor rejected). */
  unproposed: number;
  /** When the oldest of them was first seen (ISO). */
  oldestUnproposed?: string;
  /** Proposals sent from here and not decided in Git. */
  waiting: number;
  /** When the oldest of them was sent (ISO). */
  oldestWaiting?: string;
  /** Something has waited more than 3 days. */
  due: boolean;
}

/** Count what waits on a person. */
export function waiting(
  v: Pick<DriftView, "items" | "proposals" | "decisions">,
  now: Date = new Date(),
): Waiting {
  const open = unproposed(v.items)
    .map((i) => i.at)
    .sort();
  const pending = v.proposals
    .filter((p) => !v.decisions[p.id])
    .map((p) => p.at)
    .sort();
  const old = (iso?: string) => !!iso && now.getTime() - Date.parse(iso) > REMIND_DAYS * 86_400_000;
  return {
    unproposed: open.length,
    ...(open.length ? { oldestUnproposed: open[0] } : {}),
    waiting: pending.length,
    ...(pending.length ? { oldestWaiting: pending[0] } : {}),
    due: old(open[0]) || old(pending[0]),
  };
}

/** One line: "3 change(s) outside Stolos not proposed (oldest 2026-11-10); 1 proposal waiting". */
export function waitingLine(w: Waiting): string {
  const parts = [
    w.unproposed
      ? `${w.unproposed} change(s) outside Stolos not proposed (oldest ${(
          w.oldestUnproposed ?? ""
        ).slice(0, 10)})`
      : "no change outside Stolos waiting to be proposed",
    w.waiting
      ? `${w.waiting} proposal(s) waiting for a decision (oldest ${(w.oldestWaiting ?? "").slice(0, 10)})`
      : "no proposal waiting",
  ];
  return parts.join("; ");
}

/**
 * The daily reminder: when something has waited more than 3 days and no
 * reminder went out in the last 3 days, mail one (root only). Returns whether
 * it was sent.
 */
export async function remind(
  host: HostDef,
  w: Waiting,
  dir: string = P.state,
  now: Date = new Date(),
  send?: (ev: Event, host: string) => Promise<string>,
): Promise<boolean> {
  if (!w.due) return false;
  const last = await getRecord<{ at: string }>(host.name, "snapshot", "reminder", dir);
  if (last && now.getTime() - Date.parse(last.body.at) < REMIND_DAYS * 86_400_000) return false;
  const notify = send ?? (await import("../notify/events.ts")).notify;
  await notify(
    {
      event: `⚠ reminder: changes made outside Stolos are waiting`,
      level: "warn",
      what: waitingLine(w),
      todo: `On ${host.name}: archon drift, then sudo archon propose (adopt, revert, or keep local). On your PC: bun run stolos proposal import, then accept or reject. A hand change to a managed item is held 7 days at most; then the model wins.`,
      key: `proposal-reminder:${now.toISOString().slice(0, 10)}`,
    },
    host.name,
  );
  await putRecord(
    host.name,
    "snapshot",
    "reminder",
    { at: now.toISOString() },
    dir,
    now.toISOString(),
  );
  return true;
}
