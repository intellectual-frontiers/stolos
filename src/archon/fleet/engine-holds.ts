/**
 * Staged rollouts (spec 115-compatibility FR-013 to FR-015): hold one host, or a group of hosts chosen by tags, at an engine tag while the
 * rest of the fleet moves. A hold is a decision typed in the model (`enginePin` in a host's `host.ts`, `engineHolds` in `fleet.ts`): the tag
 * in the form `stolos-v<major>.<minor>.<patch>`, a reason and an end date, at most 180 days away. A host's own hold wins over a group's, and
 * the first group that chooses a host over the later ones; a hold past its date is ignored and said.
 *
 * This release records, validates, shows and checks a hold (`git ls-remote --tags` of the engine's repository, with a time limit); it does
 * not install the held engine on the machine: the words say so, and `specs/115-compatibility/tasks.md` holds the design and the blocker.
 *
 * ```mermaid
 * flowchart LR
 *   h["enginePin (host.ts)"] --> r["resolve"]
 *   g["engineHolds (fleet.ts)<br/>select: env:lab"] --> r
 *   t["tags of the host"] --> r
 *   r --> d{"past its date?"}
 *   d -->|yes| i["ignored, and said"]
 *   d -->|no| s["held at stolos-v0.150.0<br/>(fleet pin stolos-v0.152.0)"]
 *   s --> c["stolos compat: the tag exists?<br/>git ls-remote --tags"]
 * ```
 *
 * @example A hold, and when it ends
 * ```ts
 * import { holdProblems } from "./engine-holds.ts";
 *
 * const today = new Date("2026-11-17T00:00:00Z");
 * console.log(holdProblems({ tag: "stolos-v0.150.0", reason: "a pilot", until: "2026-12-31" }, today).length); // 0
 * console.log(holdProblems({ tag: "v0.150.0" as never, reason: "", until: "soon" }, today).length > 0); // true
 * ```
 *
 * @module
 */
// Spec: 115-compatibility FR-013, FR-014, FR-015

import type { EngineHold, EngineHoldBy, HoldFleet, HoldHost } from "../model/holds.ts";
import { matches, parseSelection, type Selection, selectionProblems } from "../model/tags.ts";
import type { TagSet } from "../model/tags.ts";
import type { Problem } from "../model/validate.ts";
import { run } from "../core/exec.ts";
import { TAG_PREFIX } from "../version.ts";
import { compare, parseTag, type Pin } from "./upgrade.ts";

/** The longest a hold may run from the day the model is validated. */
export const HOLD_MAX_DAYS = 180;

/** The form of an engine tag: `stolos-v<major>.<minor>.<patch>` (spec 114-release-record). */
export const ENGINE_TAG = new RegExp(`^${TAG_PREFIX}\\d+\\.\\d+\\.\\d+$`);

const DAY = 86_400_000;

/** `YYYY-MM-DD` as the start of that day (UTC), or undefined where it is not a real date. */
function dayStart(text: string): number | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return undefined;
  const t = Date.parse(`${text}T00:00:00Z`);
  return Number.isNaN(t) || new Date(t).toISOString().slice(0, 10) !== text ? undefined : t;
}

/** What is wrong with one hold, in words (empty when it is sound): the tag, the reason, the date and its distance. */
export function holdProblems(hold: EngineHold, now: Date = new Date()): string[] {
  const out: string[] = [];
  if (typeof hold.tag !== "string" || !ENGINE_TAG.test(hold.tag)) {
    out.push(
      `the tag ${JSON.stringify(hold.tag)} is not an engine tag (${TAG_PREFIX}<major>.<minor>.<patch>)`,
    );
  }
  if (typeof hold.reason !== "string" || hold.reason.trim().length < 3) {
    out.push("a hold needs a reason, in words an auditor reads");
  }
  const until = typeof hold.until === "string" ? dayStart(hold.until) : undefined;
  if (until === undefined)
    out.push(`until ${JSON.stringify(hold.until)} is not a date (YYYY-MM-DD)`);
  else if (
    until - Date.parse(`${now.toISOString().slice(0, 10)}T00:00:00Z`) >
    HOLD_MAX_DAYS * DAY
  ) {
    out.push(`until ${hold.until} is more than ${HOLD_MAX_DAYS} days away: a hold is short-lived`);
  }
  return out;
}

/** Whether a hold has ended (its day is before today). A hold with no valid date counts as ended. */
export function holdExpired(hold: EngineHold, now: Date = new Date()): boolean {
  const until = typeof hold.until === "string" ? dayStart(hold.until) : undefined;
  return until === undefined || until < Date.parse(`${now.toISOString().slice(0, 10)}T00:00:00Z`);
}

/** A hold as it applies to one host. */
export interface ResolvedHold {
  /** The tag the host is held at. */
  tag: string;
  /** Why. */
  reason: string;
  /** Until when (YYYY-MM-DD). */
  until: string;
  /** Its own `enginePin`, or the fleet's `engineHolds` group that chose it. */
  source: "host" | "group";
  /** The group's tag expression (a `group` hold). */
  select?: string;
  /** The hold has ended: it is not applied, and the PC says so. */
  expired: boolean;
}

/**
 * The hold that applies to a host (spec 115-compatibility FR-014): its own `enginePin` first, then the first `engineHolds` of the fleet
 * whose expression chooses its tags. A hold that has ended is returned with `expired`, so it can be said; the caller does not apply it.
 */
export function holdFor(
  host: Pick<HoldHost, "enginePin">,
  fleet: HoldFleet | undefined,
  tagIds: ReadonlySet<string>,
  now: Date = new Date(),
): ResolvedHold | undefined {
  const own = host.enginePin;
  if (own) return { ...pick(own), source: "host", expired: holdExpired(own, now) };
  for (const g of fleet?.engineHolds ?? []) {
    let sel: Selection;
    try {
      sel = parseSelection(g.select);
    } catch {
      continue;
    }
    if (matches(sel, tagIds)) {
      return { ...pick(g), source: "group", select: g.select, expired: holdExpired(g, now) };
    }
  }
  return undefined;
}

const pick = (h: EngineHold) => ({ tag: h.tag, reason: h.reason, until: h.until });

/** A hold in plain words: `held at stolos-v0.150.0 (fleet pin stolos-v0.152.0)`; and, until the install side exists, that it is not enforced. */
export function describeHold(hold: ResolvedHold, fleetPin: string | undefined): string {
  return hold.expired
    ? `its hold at ${hold.tag} ended ${hold.until}: it follows the fleet pin${fleetPin ? ` ${fleetPin}` : ""} again`
    : `held at ${hold.tag}${fleetPin ? ` (fleet pin ${fleetPin})` : ""} until ${hold.until}: ${hold.reason} (recorded; not enforced on the machine yet)`;
}

/**
 * The problems of every hold of a fleet, for `stolos build` (spec 115-compatibility FR-013): a hold that is not typed right, a group's
 * expression that does not parse or names a tag the fleet does not define. A hold that has ended is not a problem of the model: it is ignored
 * and said wherever the PC says a machine's engine ({@link describeHold}).
 */
export function engineHoldProblems(
  fleet: HoldFleet,
  hosts: readonly Pick<HoldHost, "name" | "enginePin">[],
  set: Pick<TagSet, "dimensions"> | undefined,
  now: Date = new Date(),
): Problem[] {
  const out: Problem[] = [];
  const check = (where: string, h: EngineHold) => {
    for (const m of holdProblems(h, now)) {
      out.push({
        where,
        message: m,
        fix: `write it as { tag: "${TAG_PREFIX}0.150.0", reason: "why", until: "YYYY-MM-DD" } (at most ${HOLD_MAX_DAYS} days away)`,
      });
    }
  };
  for (const h of hosts) if (h.enginePin) check(`hosts/${h.name}.enginePin`, h.enginePin);
  (fleet.engineHolds ?? []).forEach((g: EngineHoldBy, i) => {
    const where = `fleet.engineHolds[${i}]`;
    check(where, g);
    try {
      for (const m of selectionProblems(parseSelection(g.select), set)) {
        out.push({ where, message: `select: ${m}`, fix: "name only tags that tags.ts defines" });
      }
    } catch (e) {
      out.push({
        where,
        message: `select ${JSON.stringify(g.select)} is not a tag expression: ${(e as Error).message}`,
        fix: "use tags, and, or, not and parentheses: env:lab and not role:db",
      });
    }
  });
  return out;
}

/** Whether a tag exists in the engine's repository: yes, no, or not checked (GitHub unreachable, or a timeout). */
export type TagExists = "exists" | "missing" | "not-checked";

/** The URL `git ls-remote` asks about a pin's engine: GitHub for a `github:` source, the URL itself for a `git+` source. */
export function engineUrl(pin: Pin): string | undefined {
  const gh = pin.source.match(/^github:([^/]+\/[^/]+)$/)?.[1];
  if (gh) return `https://github.com/${gh}.git`;
  return pin.source.startsWith("git+") ? pin.source.slice(4) : undefined;
}

/**
 * Whether each tag exists in the engine's repository, by `git ls-remote --tags --refs <url>` (spec 115-compatibility FR-014), with a
 * time limit. An unreachable repository says `not-checked` for every tag, never `missing`.
 */
export async function checkEngineTags(
  tags: readonly string[],
  url: string,
  timeoutMs = 20_000,
): Promise<Map<string, TagExists>> {
  const out = new Map<string, TagExists>();
  const r = await run(["git", "ls-remote", "--tags", "--refs", url], {
    env: { GIT_TERMINAL_PROMPT: "0" },
    signal: AbortSignal.timeout(timeoutMs),
  }).catch(() => undefined);
  const known = r?.ok
    ? new Set([...r.stdout.matchAll(/refs\/tags\/(\S+)$/gm)].map((m) => m[1] ?? ""))
    : undefined;
  for (const t of tags)
    out.set(t, known === undefined ? "not-checked" : known.has(t) ? "exists" : "missing");
  return out;
}

/** The newer of two engine tags, for a sentence that says which way a hold goes: `older`, `newer` or `same` than the fleet's pin. */
export function holdDirection(
  hold: string,
  fleetPin: string | undefined,
): "older" | "newer" | "same" | undefined {
  const a = parseTag(hold);
  const b = fleetPin ? parseTag(fleetPin) : undefined;
  if (!a || !b) return undefined;
  const c = compare(a, b);
  return c === 0 ? "same" : c < 0 ? "older" : "newer";
}
