/**
 * Spec 095-proposals, the owner's decision 1: **the reconcile hold**. The
 * timer applies every 15 minutes and would undo a hand edit to a managed
 * file (or a managed unit enabled, disabled, or masked by hand) before anyone
 * could propose it. So before each apply, archon reads sudo's journal: an
 * item the plan manages, that differs from the plan, and that a person's sudo
 * command named, is **held**. Apply leaves it as it is, for up to 7 days, or
 * until its proposal is decided in Git (accepted or rejected), whichever comes
 * first; a revert ends it at once. Then the model in Git wins.
 *
 * ```mermaid
 * stateDiagram-v2
 *   [*] --> held: a person changed a managed item under sudo
 *   held --> proposed: archon propose (adopt)
 *   held --> ended: 7 days
 *   held --> ended: archon propose (revert)
 *   proposed --> ended: proposals.ts says accepted or rejected
 *   proposed --> ended: 7 days
 *   ended --> [*]: apply converges it to the model
 * ```
 *
 * An ended hold is kept, so the same sudo command never holds the item again;
 * a newer one does.
 *
 * @module
 */
// Spec: 095-proposals

import { fs } from "@intellectual-frontiers/system";
import { P } from "../core/paths.ts";
import { run } from "../core/exec.ts";
import { journal } from "../core/log.ts";
import { listRecords, putRecord } from "../state/store.ts";
import type { HostPlan } from "../model/types.ts";
import type { Hold } from "./drift.ts";
import { commandTargets, parseSudoJournal, type SudoEntry, unitOn } from "./parse.ts";
import { HOLD_DAYS, type ProposalDecisions } from "./types.ts";

/** A hold as stored: active until it ends (`ended`). */
export type StoredHold = Hold;

/** How a managed item is now, for the hold (tests pass their own). */
export interface HostLook {
  /** A file's content now, or undefined. */
  file: (path: string) => Promise<string | undefined>;
  /** A unit's `systemctl is-enabled` answer. */
  unit: (name: string) => Promise<string>;
  /** sudo's journal entries since a time. */
  sudo: (since: string) => Promise<SudoEntry[]>;
}

/** The real host. */
export const realLook: HostLook = {
  file: (path) => fs.readTextOr(path),
  unit: async (name) => (await run(["systemctl", "is-enabled", name])).stdout.trim(),
  sudo: async (since) =>
    parseSudoJournal(
      (
        await run([
          "journalctl",
          "-o",
          "json",
          "--no-pager",
          "SYSLOG_IDENTIFIER=sudo",
          `--since=@${Math.floor(Date.parse(since) / 1000)}`,
        ])
      ).stdout,
    ),
};

/** Whether a unit's state is what the plan wants. */
function unitAsPlanned(want: string, now: string): boolean {
  if (want === "masked") return now === "masked";
  if (want === "enabled") return unitOn(now) || now === "static";
  return !unitOn(now);
}

/** Why a hold ends now, or undefined while it lasts. */
export function holdEnds(
  h: StoredHold,
  decisions: ProposalDecisions,
  now: Date,
): string | undefined {
  if (h.until <= now.toISOString()) return "expired (7 days): the model wins";
  const d = h.proposal ? decisions[h.proposal] : undefined;
  if (d) return `proposal ${h.proposal} ${d.decision}`;
  return undefined;
}

/**
 * Before an apply: end the holds that are over, and hold each managed item a
 * person changed under sudo in the last 7 days that still differs from the
 * plan. Returns the active holds, by key.
 */
export async function refreshHolds(
  plan: HostPlan,
  opts: { dir?: string; now?: Date; look?: HostLook; decisions?: ProposalDecisions } = {},
): Promise<Map<string, StoredHold>> {
  const dir = opts.dir ?? P.state;
  const now = opts.now ?? new Date();
  const look = opts.look ?? realLook;
  const host = plan.host.name;
  // Only the real host's journal hears about holds (tests look at their own fixtures).
  const say = (m: string) => (look === realLook ? journal("archon-hold", m) : Promise.resolve());
  const decisions =
    opts.decisions ?? (await (await import("./decisions.ts")).loadProposalDecisions(host));
  const all = new Map(
    (await listRecords<StoredHold>(host, "hold", dir)).map((r) => [r.name, r.body]),
  );
  for (const [key, h] of all) {
    if (h.ended) continue;
    const why = holdEnds(h, decisions, now);
    if (!why) continue;
    const ended = { ...h, ended: why, endedAt: now.toISOString() };
    all.set(key, ended);
    await putRecord(host, "hold", key, ended, dir, h.since);
    await say(`${key}: hold ended, ${why}`);
  }
  const since = new Date(now.getTime() - HOLD_DAYS * 86_400_000).toISOString();
  const entries = (await look.sudo(since)).filter(
    (e) => e.at >= since && e.at <= now.toISOString(),
  );
  const files = new Map(
    plan.files.filter((f) => f.content !== undefined && !f.symlink).map((f) => [f.path, f]),
  );
  const units = new Map(plan.units.filter((u) => u.state !== "ignore").map((u) => [u.unitName, u]));
  for (const e of entries.sort((a, b) => a.at.localeCompare(b.at))) {
    for (const t of commandTargets(e.command)) {
      let key: string | undefined;
      const file = t.kind === "file" ? files.get(t.name) : undefined;
      const unit = t.kind === "unit" ? units.get(t.name) : undefined;
      if (file) {
        const cur = await look.file(t.name);
        if (cur !== undefined && cur !== file.content) key = `file:${t.name}`;
      } else if (unit) {
        if (!unitAsPlanned(unit.state, await look.unit(t.name))) {
          key = `unit:${t.name}`;
        }
      }
      if (!key) continue;
      const have = all.get(key);
      // Active already, or ended for this command or a later one: no new hold.
      if (have && (!have.ended || have.since >= e.at)) continue;
      const h: StoredHold = {
        key,
        by: e.who,
        since: e.at,
        until: new Date(Date.parse(e.at) + HOLD_DAYS * 86_400_000).toISOString(),
        command: e.command,
      };
      if (holdEnds(h, decisions, now)) continue;
      all.set(key, h);
      await putRecord(host, "hold", key, h, dir, h.since);
      await say(`${key}: held for ${e.who} until ${h.until} (${e.command})`);
    }
  }
  return new Map([...all].filter(([, h]) => !h.ended));
}

/** The active holds as stored (a check reads them; it never changes them). */
export async function activeHolds(
  host: string,
  dir: string = P.state,
): Promise<Map<string, StoredHold>> {
  const now = new Date().toISOString();
  return new Map(
    (await listRecords<StoredHold>(host, "hold", dir))
      .filter((r) => !r.body.ended && r.body.until > now)
      .map((r) => [r.name, r.body]),
  );
}

/** One line for apply: why it leaves an item alone. */
export function heldLine(h: Hold): string {
  return `held: ${h.by} changed it under sudo (${h.command.slice(0, 60)}); kept until ${h.until
    .slice(0, 16)
    .replace("T", " ")} UTC or its proposal is decided (archon drift; spec 095)`;
}
