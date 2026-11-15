/**
 * Spec 083: an audit engagement, as a file in the fleet repository:
 * `fleets/<fleet>/audits/<id>/engagement.ts`. It says who audits (the firm
 * and its people), the period, the frameworks and the controls in scope
 * (each tested on one population), the evidence bundle the populations are
 * drawn from (pinned by its SHA-256), and the day the auditor's access ends.
 * `stolos audit open` writes it and `stolos audit close` closes it, each in a
 * signed commit; Stolos reads it as a TypeScript literal (never runs it), so
 * a past version from Git reads the same way.
 *
 * ```mermaid
 * stateDiagram-v2
 *   [*] --> open: stolos audit open (a signed commit)
 *   open --> open: audit bundle, request, respond, sample (signed commits)
 *   open --> expired: access.expires has passed
 *   open --> closed: stolos audit close (a signed commit)
 *   expired --> closed: stolos audit close
 *   closed --> [*]
 * ```
 *
 * @module
 */

import { exportedLiteral, tsLiteral } from "../core/ts-literal.ts";
import { POPULATION_IDS, type PopulationId } from "./populations.ts";

/** One person at the audit firm. */
export interface Auditor {
  /** Their name. */
  name: string;
  /** Their work email, when given. */
  email?: string;
}

/** One control in scope, and the population it is tested on. */
export interface ScopedControl {
  /** The control's id as the auditor names it (a criterion such as "CC6.2", or the company's own id). */
  id: string;
  /** What it is, in words. */
  title: string;
  /** The framework it is from (soc2, iso27001, ...), when it is one framework's. */
  framework?: string;
  /** The SCF controls it maps to, when known. */
  scf?: string[];
  /** The population it is tested on (a typed query over the bundle's items). */
  population: PopulationId;
}

/** The evidence bundle (spec 072) an engagement's populations are drawn from. */
export interface PinnedBundle {
  /** Its file name in this PC's evidence directory. */
  file: string;
  /** Its SHA-256: a different file with that name is refused. */
  sha256: string;
  /** Its manifest's head (the end of its hash chain). */
  head: string;
}

/** An audit engagement: `fleets/<fleet>/audits/<id>/engagement.ts`. */
export interface Engagement {
  /** Its id: the folder's name (lowercase letters, digits, dashes). */
  id: string;
  /** Its name for people ("SOC 2 Type 2, 2026"). */
  title: string;
  /** The audit firm. */
  firm: string;
  /** The firm's people who may see it. */
  auditors: Auditor[];
  /** The period audited (YYYY-MM-DD, both days included). */
  period: { from: string; to: string };
  /** The frameworks in scope (soc2, iso27001, hipaa, pci, ...). */
  frameworks: string[];
  /** The controls in scope. */
  controls: ScopedControl[];
  /** The portal's time box: it refuses every request after this day (YYYY-MM-DD, UTC, the day included). */
  access: { expires: string };
  /** The evidence bundle, once pinned. */
  bundle?: PinnedBundle;
  /** When it was opened (YYYY-MM-DD), and by which fleet signer. */
  opened: { on: string; by: string };
  /** When it was closed (YYYY-MM-DD), and by whom; the portal refuses a closed engagement. */
  closed?: { on: string; by: string };
}

/** An engagement's id: a folder name. */
export const ENGAGEMENT_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Whether a string is a real day (YYYY-MM-DD). */
export function isDay(s: unknown): s is string {
  return typeof s === "string" && DAY.test(s) &&
    new Date(`${s}T00:00:00Z`).toISOString().startsWith(s);
}

/** The engagement folder, relative to the repository. */
export function engagementDir(fleet: string, id: string): string {
  return `fleets/${fleet}/audits/${id}`;
}

/** The engagement file, relative to the repository. */
export function engagementPath(fleet: string, id: string): string {
  return `${engagementDir(fleet, id)}/engagement.ts`;
}

/** What is wrong with an engagement (empty when nothing is). */
export function engagementProblems(e: Engagement): string[] {
  const out: string[] = [];
  if (!ENGAGEMENT_ID.test(e.id ?? "")) out.push(`id "${e.id}": lowercase letters, digits, dashes`);
  if (!e.title?.trim()) out.push("title: say what the engagement is");
  if (!e.firm?.trim()) out.push("firm: the audit firm's name");
  if (!Array.isArray(e.auditors) || !e.auditors.length || e.auditors.some((a) => !a.name?.trim())) {
    out.push("auditors: at least one, each with a name");
  }
  if (!isDay(e.period?.from) || !isDay(e.period?.to) || e.period.from > e.period.to) {
    out.push("period: from and to are days (YYYY-MM-DD), from before to");
  }
  if (!Array.isArray(e.frameworks)) out.push("frameworks: a list");
  if (!Array.isArray(e.controls) || !e.controls.length) out.push("controls: at least one in scope");
  const seen = new Set<string>();
  for (const c of e.controls ?? []) {
    if (!c.id?.trim()) out.push("a control without an id");
    if (seen.has(c.id)) out.push(`control ${c.id}: listed twice`);
    seen.add(c.id);
    if (!POPULATION_IDS.includes(c.population)) {
      out.push(
        `control ${c.id}: population "${c.population}" is not one of ${POPULATION_IDS.join(", ")}`,
      );
    }
  }
  if (!isDay(e.access?.expires)) out.push("access.expires: a day (YYYY-MM-DD)");
  if (e.bundle && !/^[0-9a-f]{64}$/.test(e.bundle.sha256 ?? "")) {
    out.push("bundle.sha256: a SHA-256 in hex");
  }
  if (!isDay(e.opened?.on) || !e.opened?.by) out.push("opened: a day and a signer");
  if (e.closed && (!isDay(e.closed.on) || !e.closed.by)) out.push("closed: a day and a person");
  return out;
}

/** Where an engagement stands at a moment: open, expired (past access.expires), or closed. */
export type EngagementState = "open" | "expired" | "closed";

/** The end of the access day (the first instant after it, UTC). */
export function accessEnds(e: Pick<Engagement, "access">): number {
  return Date.parse(`${e.access.expires}T00:00:00Z`) + 86_400_000;
}

/** Where an engagement stands at `now`. */
export function engagementState(
  e: Pick<Engagement, "access" | "closed">,
  now: Date = new Date(),
): EngagementState {
  if (e.closed) return "closed";
  return now.getTime() >= accessEnds(e) ? "expired" : "open";
}

/** engagement.ts's text: a TypeScript literal, typed, that {@link parseEngagement} reads back. */
export function engagementSource(e: Engagement): string {
  return `// An audit engagement (spec 083), written by stolos audit open and stolos audit close.
// Change it only with those commands: each change is a signed commit the auditor checks.
import type { Engagement } from "@stolos/archon/audit/mod.ts";

export const engagement: Engagement = ${tsLiteral(e)};
`;
}

/** An engagement from engagement.ts's text (read, never run); throws when it is not one. */
export function parseEngagement(text: string): Engagement {
  const e = exportedLiteral(text, "engagement") as Engagement;
  const p = engagementProblems(e);
  if (p.length) throw new Error(`engagement.ts: ${p.join("; ")}`);
  return e;
}

/** A controls option (`CC6.2=leavers,CC8.1=change`, or population ids alone) as controls in scope. */
export function parseControls(
  spec: string,
  titles: Record<string, string>,
  framework?: string,
): ScopedControl[] {
  return spec.split(/[,\n]/).map((x) => x.trim()).filter(Boolean).map((x) => {
    const [id, pop] = x.includes("=") ? x.split("=", 2).map((s) => s.trim()) : [x, x];
    return {
      id,
      title: titles[pop] ?? pop,
      ...(framework ? { framework } : {}),
      population: pop as PopulationId,
    };
  });
}
