/**
 * Spec 095-proposals: change sessions. Observations are grouped by sudo
 * session (the same person, each command within 30 minutes of the previous)
 * into one **intent**, so "installed nginx, edited its site, enabled it, and
 * opened 443" is one item to decide, not four. A recording (`archon record`)
 * wins: everything seen while it ran is one intent, with its reason.
 *
 * ```mermaid
 * flowchart TD
 *   item["a drift item"] --> rec{"seen while a recording ran?"}
 *   rec -->|yes| r["the recording's intent (its reason)"]
 *   rec -->|no| cmd{"a sudo command names it?"}
 *   cmd -->|yes| s["that command's session"]
 *   cmd -->|no| near{"its person's session at that time?"}
 *   near -->|yes| s
 *   near -->|no| day["the day's other changes"]
 * ```
 *
 * @module
 */

import { explains } from "./drift.ts";
import type { DriftItem, Intent, Observation } from "./types.ts";

/** Commands further apart than this start a new session. */
export const SESSION_GAP_MS = 30 * 60_000;

/** A recording: `archon record "reason"` until `archon record done`. */
export interface Recording {
  /** Its id: `r-<yyyymmddhhmm>`. */
  id: string;
  /** The reason the person gave. */
  reason: string;
  /** Who started it. */
  by: string;
  /** When it started (ISO). */
  start: string;
  /** When it ended (ISO); unset while it runs. */
  end?: string;
}

const stamp = (iso: string) => iso.slice(0, 16).replace(/[-:T]/g, "");

/** Sudo sessions: each person's commands, split where they are more than 30 minutes apart. */
export function sessions(observations: Observation[]): Array<Intent & { obs: Observation[] }> {
  const byWho = new Map<string, Observation[]>();
  for (const o of observations) {
    if (o.source !== "sudo" || !o.who) continue;
    byWho.set(o.who, [...(byWho.get(o.who) ?? []), o]);
  }
  const out: Array<Intent & { obs: Observation[] }> = [];
  for (const [who, list] of byWho) {
    list.sort((a, b) => a.at.localeCompare(b.at));
    let cur: Observation[] = [];
    const close = (): void => {
      const first = cur[0];
      const last = cur.at(-1);
      if (!first || !last) return;
      out.push({
        id: `s-${who}-${stamp(first.at)}`,
        who,
        from: first.at,
        to: last.at,
        commands: cur.map((o) => o.name),
        items: [],
        obs: cur,
      });
      cur = [];
    };
    for (const o of list) {
      const last = cur[cur.length - 1];
      if (last && Date.parse(o.at) - Date.parse(last.at) > SESSION_GAP_MS) close();
      cur.push(o);
    }
    close();
  }
  return out.sort((a, b) => a.from.localeCompare(b.from));
}

/** Group drift items into intents: by recording, by the command that names them, by person and time, else by day. */
export function groupItems(
  items: DriftItem[],
  observations: Observation[],
  recordings: Recording[] = [],
  now: Date = new Date(),
): Intent[] {
  const ss = sessions(observations);
  const intents = new Map<string, Intent>();
  const put = (i: Intent, key: string) => {
    const have = intents.get(i.id) ?? { ...i, items: [] };
    have.items.push(key);
    intents.set(i.id, have);
  };
  for (const it of items) {
    const t = Date.parse(it.at);
    const r = recordings.find(
      (x) => t >= Date.parse(x.start) && t <= Date.parse(x.end ?? now.toISOString()),
    );
    if (r) {
      put(
        {
          id: r.id,
          who: r.by,
          from: r.start,
          to: r.end ?? now.toISOString(),
          commands: ss
            .filter((s) => s.from >= r.start && s.from <= (r.end ?? now.toISOString()))
            .flatMap((s) => s.commands),
          items: [],
          reason: r.reason,
        },
        it.key,
      );
      continue;
    }
    const named = ss.find((s) => s.obs.some((o) => explains(o, it.kind, it.name)));
    const near =
      named ??
      ss.find(
        (s) =>
          (!it.who || s.who === it.who) &&
          t >= Date.parse(s.from) - SESSION_GAP_MS &&
          t <= Date.parse(s.to) + SESSION_GAP_MS,
      );
    if (near) {
      const { obs: _obs, ...intent } = near;
      put(intent, it.key);
      continue;
    }
    const day = it.at.slice(0, 10);
    put(
      {
        id: `d-${it.who ?? "unknown"}-${day.replaceAll("-", "")}`,
        ...(it.who ? { who: it.who } : {}),
        from: it.at,
        to: it.at,
        commands: [],
        items: [],
      },
      it.key,
    );
  }
  for (const i of intents.values()) i.items.sort();
  return [...intents.values()].sort((a, b) => a.from.localeCompare(b.from));
}
