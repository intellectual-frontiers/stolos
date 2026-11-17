/**
 * Spec 107-pairing-and-query: ask every machine one question, all at once. `fleet query` and the Stolos Console's "Ask every machine"
 * page share this: every machine (the managed servers, over their MCP servers, and the adopted machines, through their probes, the
 * controller PC's among them) is asked at the same time, at most {@link QUERY_CAP} at a time, each with a time limit of its own
 * ({@link QUERY_TIMEOUT_S} seconds unless `--timeout` says another). Each answer is handed on the moment it arrives, so a page can
 * draw one merged table that fills in; a machine that fails or does not answer in time still gets an answer, with its reason, so no
 * machine is missing from the table, and the count says "N of M answered".
 *
 * ```mermaid
 * flowchart LR
 *   t["every machine<br/>(managed, adopted, the controller)"] --> pool["at most 8 at a time<br/>each with its own time limit"]
 *   pool -->|"answered | failed | timed out"| a["onAnswer, as it arrives"]
 *   a --> table["one merged table<br/>(a row per answer, a row per failure)"]
 * ```
 *
 * @example
 * ```ts
 * import { askAll } from "./query.ts";
 * const answers = await askAll(
 *   [{ machine: "alpha", kind: "managed", ask: () => Promise.resolve([{ version: "26.04" }]) }],
 *   { timeoutMs: 1000 },
 * );
 * answers[0]?.state; // "answered"
 * ```
 *
 * @module
 */
// Spec: 107-pairing-and-query FR-010, FR-011
// Spec: 108-tags FR-013

import type { AnswerState } from "../ontology.auto.ts";
import type { ResolvedTag, Selection } from "../model/tags.ts";
import { tagLine } from "../fleet/tags.ts";

export { queryRefusal } from "../state/query.ts";

/** How many machines are asked at the same time. */
export const QUERY_CAP = 8;

/** How long each machine has to answer, in seconds, unless `--timeout` says another. */
export const QUERY_TIMEOUT_S = 15;

/** A tag of a machine that was asked (spec 108-tags FR-013): its id, whether it is defined or custom, and its origin. */
export type QueryTag = Pick<ResolvedTag, "id" | "standing" | "origin"> & {
  from?: string;
  /** Spec 112-machine-reported-tags: for a claim the machine made, what the fleet does with it (`hint` or `accept`). */
  trust?: NonNullable<ResolvedTag["trust"]>;
};

/** One machine's answer to a question to every machine. */
export interface QueryAnswer {
  /** The machine. */
  machine: string;
  /** managed or adopted (the controller is an adopted machine). */
  kind: "managed" | "adopted";
  /** Where it is (`stolos:AnswerState`): answered, failed, or timed out (asking, before its answer comes). */
  state: AnswerState;
  /** Its rows, when it answered. */
  rows?: Array<Record<string, unknown>>;
  /** Why it did not answer (failed, timed out). */
  error?: string;
  /** How long it took, in milliseconds. */
  ms?: number;
  /** The machine's tags (spec 108-tags FR-013), when the fleet gives it any: custom ones are marked as such. */
  tags?: QueryTag[];
}

/** A machine to ask, and how: `ask` gives its rows, throws with its reason, and should stop when `signal` aborts. */
export interface AskTarget {
  /** The machine. */
  machine: string;
  /** managed or adopted. */
  kind: "managed" | "adopted";
  /** Ask it: its rows, or a thrown error whose message is the reason. `limitMs` is the time it has. */
  ask: (signal: AbortSignal, limitMs: number) => Promise<Array<Record<string, unknown>>>;
}

/** How a question to every machine goes. */
export interface AskOptions {
  /** How many are asked at the same time (8 by default). */
  cap?: number;
  /** The time limit of each machine, in milliseconds (15 s by default). */
  timeoutMs?: number;
  /** Called with all the machines before any is asked. */
  onStart?: (machines: ReadonlyArray<Pick<AskTarget, "machine" | "kind">>) => void;
  /** Called with each answer as it arrives (any order). */
  onAnswer?: (a: QueryAnswer) => void;
  /** Spec 108-tags FR-013: ask only the machines whose tags this chooses (`askFleet` reads it; `askAll` asks the targets it is given). */
  selection?: Selection;
  /** Spec 112-machine-reported-tags FR-011: choose by the hints machines reported too (`--reported`). */
  reported?: boolean;
}

/** One machine, asked within its time limit: always an answer, never a throw. */
async function askOne(t: AskTarget, limitMs: number): Promise<QueryAnswer> {
  const began = Date.now();
  const ctl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<"late">((ok) => {
    timer = setTimeout(() => {
      ctl.abort();
      ok("late");
    }, limitMs);
  });
  const done = (o: Omit<QueryAnswer, "machine" | "kind" | "ms">): QueryAnswer => ({
    machine: t.machine,
    kind: t.kind,
    ...o,
    ms: Date.now() - began,
  });
  try {
    const r = await Promise.race([t.ask(ctl.signal, limitMs), late]);
    if (r === "late") {
      return done({
        state: "timed-out",
        error: `no answer in ${Math.max(1, Math.round(limitMs / 1000))} s`,
      });
    }
    return done({ state: "answered", rows: r });
  } catch (e) {
    return ctl.signal.aborted
      ? done({
          state: "timed-out",
          error: `no answer in ${Math.max(1, Math.round(limitMs / 1000))} s`,
        })
      : done({
          state: "failed",
          error: (e instanceof Error ? e.message : String(e)) || "no answer",
        });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Ask every target at once (at most `cap` at a time), each within its own limit, handing each answer on as it arrives. Resolves with
 * every answer, by machine name, once the last has come: one answer per target, whatever happened to it.
 */
export async function askAll(
  targets: readonly AskTarget[],
  o: AskOptions = {},
): Promise<QueryAnswer[]> {
  const cap = Math.max(1, Math.min(o.cap ?? QUERY_CAP, targets.length || 1));
  const limit = o.timeoutMs ?? QUERY_TIMEOUT_S * 1000;
  o.onStart?.(targets.map((t) => ({ machine: t.machine, kind: t.kind })));
  const answers: QueryAnswer[] = [];
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const t = targets[next++];
      if (!t) return;
      const a = await askOne(t, limit);
      answers.push(a);
      o.onAnswer?.(a);
    }
  };
  await Promise.all(Array.from({ length: cap }, worker));
  return answers.sort((a, b) => a.machine.localeCompare(b.machine));
}

/** "N of M answered": the count a table's line says (a machine that failed or timed out has not answered). */
export function answeredLine(answers: readonly QueryAnswer[], total = answers.length): string {
  return `${answers.filter((a) => a.state === "answered").length} of ${total} answered`;
}

/** The rows of a table for answers: a row for each result row, and one for each machine without rows (its state and reason). */
export function tableRows(answers: readonly QueryAnswer[]): Array<Record<string, unknown>> {
  return answers.flatMap((a) =>
    a.state === "answered" && a.rows?.length
      ? a.rows.map((r) => ({ machine: a.machine, answer: a.state, ...tagCell(a), ...r }))
      : [
          {
            machine: a.machine,
            answer: a.state,
            ...tagCell(a),
            reason: a.state === "answered" ? "no rows" : (a.error ?? ""),
          },
        ],
  );
}

/** A machine's tags as one cell (`env:lab role:nas · custom: pilot`): the custom ones apart, labelled. Nothing where it has none. */
export function tagCell(a: Pick<QueryAnswer, "tags">): { tags?: string } {
  return a.tags?.length ? { tags: tagLine(a.tags) } : {};
}
