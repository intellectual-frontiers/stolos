/**
 * Spec 080: the risk register, as TypeScript. A fleet keeps it in
 * `fleets/<fleet>/risks.ts`, one {@link RiskDef} per risk, so a change to a
 * risk is a commit, reviewed and signed like any other.
 *
 * Likelihood and impact use the qualitative scale of NIST SP 800-30 Rev 1
 * (Guide for Conducting Risk Assessments, Appendices G and H: very low,
 * low, moderate, high, very high), and the risk level is that publication's
 * Table I-2. Treatment uses the four standard risk responses (NIST SP 800-39
 * section 3.3 and ISO 31000: accept, mitigate, transfer, avoid).
 *
 * ```mermaid
 * flowchart LR
 *   file["fleets/&lt;fleet&gt;/risks.ts: defineRisks([...])"] --> load["loadRisks"]
 *   load --> problems["riskProblems: ids, dates, owners, SCF ids"]
 *   load --> level["riskLevel: SP 800-30 Table I-2"]
 *   load --> estate[("the estate graph: risk table")]
 *   estate --> controls["risk controls: review, owner, accepted risks"]
 *   load --> poam["OSCAL POA&M: risks"]
 * ```
 *
 * @example A risk register
 * ```ts
 * import { defineRisks } from "./register.ts";
 *
 * export const risks = defineRisks([{
 *   id: "laptop-theft",
 *   title: "A laptop with customer data is stolen",
 *   description: "Laptops travel; one holds a copy of the customer list.",
 *   likelihood: "moderate",
 *   impact: "high",
 *   owner: "alice@example.org",
 *   treatment: "mitigate",
 *   scf: ["CRY-07"],
 *   nextReview: "2027-02-15",
 * }]);
 * ```
 *
 * @module
 */

import type { ScfId } from "../compliance/scf.ts";
import { isScfId } from "../compliance/scf.ts";
import { exists } from "../core/fsx.ts";
import { join, toFileUrl } from "../core/path.ts";
import { P } from "../core/paths.ts";

/** NIST SP 800-30 Rev 1's qualitative values (Appendices G, H, and I), lowest first. */
export const LEVELS = ["very low", "low", "moderate", "high", "very high"] as const;

/** A qualitative value on NIST SP 800-30 Rev 1's scale. */
export type Level = typeof LEVELS[number];

/** The four standard risk responses (NIST SP 800-39 section 3.3; ISO 31000 risk treatment). */
export const TREATMENTS = ["accept", "mitigate", "transfer", "avoid"] as const;

/** How a risk is treated. */
export type Treatment = typeof TREATMENTS[number];

/** One risk in the register. */
export interface RiskDef {
  /** Its id: lower case letters, digits, and hyphens; unique in the register. */
  id: string;
  /** What could happen, in one line. */
  title: string;
  /** How, and what it would do to the organization. */
  description: string;
  /** Likelihood of occurrence (SP 800-30 Rev 1 Table G-5: the overall likelihood). */
  likelihood: Level;
  /** Level of impact (SP 800-30 Rev 1 Table H-3). */
  impact: Level;
  /** Who owns it: a person's work email (on the roster: the HR system or identity provider). */
  owner: string;
  /** How it is treated: accept, mitigate, transfer, or avoid. */
  treatment: Treatment;
  /** The SCF controls it relates to (ids Stolos knows: a wrong one fails type checking). */
  scf: readonly ScfId[];
  /**
   * The accepted risks it stands behind: a control pack's result (`<pack>/<control>`, from
   * controls/accepted.ts) or an adopted machine's (`<machine>:<policy>`).
   */
  accepted?: readonly string[];
  /** When it is reviewed next (YYYY-MM-DD); after it, the review is overdue and fails. */
  nextReview: string;
  /** How many days a review moves the next one on (default 90). */
  reviewEveryDays?: number;
  /** open (default) or closed (no longer a risk: kept for its history). */
  status?: "open" | "closed";
}

/** A risk, with its level and status filled in. */
export interface Risk extends RiskDef {
  /** Its level (SP 800-30 Rev 1 Table I-2). */
  level: Level;
  /** open or closed. */
  status: "open" | "closed";
}

const L = (s: string) => LEVELS.indexOf(s as Level);

/**
 * NIST SP 800-30 Rev 1 Table I-2 (level of risk, a combination of
 * likelihood and impact): rows are likelihood, columns impact, lowest first.
 */
export const RISK_MATRIX: ReadonlyArray<ReadonlyArray<Level>> = [
  ["very low", "very low", "very low", "low", "low"],
  ["very low", "low", "low", "low", "moderate"],
  ["very low", "low", "moderate", "moderate", "high"],
  ["very low", "low", "moderate", "high", "very high"],
  ["very low", "low", "moderate", "high", "very high"],
];

/** The level of risk for a likelihood and an impact (SP 800-30 Rev 1 Table I-2). */
export function riskLevel(likelihood: Level, impact: Level): Level {
  return RISK_MATRIX[L(likelihood)]?.[L(impact)] ?? "moderate";
}

const ID = /^[a-z0-9][a-z0-9-]*$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** Whether a string is a real day, YYYY-MM-DD. */
export function isDay(s: string): boolean {
  return DAY.test(s ?? "") && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) &&
    new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;
}

/** Why a register is malformed (none: it is fine). */
export function riskProblems(list: readonly RiskDef[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const r of list) {
    const at = `risk ${r.id || "(no id)"}`;
    if (!ID.test(r.id ?? "")) out.push(`${at}: its id must be lower case letters, digits, hyphens`);
    if (seen.has(r.id)) out.push(`${at}: two risks have this id`);
    seen.add(r.id);
    if (!r.title?.trim()) out.push(`${at}: it needs a title`);
    if (!r.description?.trim()) out.push(`${at}: it needs a description`);
    if (L(r.likelihood) < 0) out.push(`${at}: likelihood must be one of ${LEVELS.join(", ")}`);
    if (L(r.impact) < 0) out.push(`${at}: impact must be one of ${LEVELS.join(", ")}`);
    if (!EMAIL.test(r.owner ?? "")) out.push(`${at}: its owner must be a person's work email`);
    if (!TREATMENTS.includes(r.treatment)) {
      out.push(`${at}: treatment must be one of ${TREATMENTS.join(", ")}`);
    }
    if (!r.scf?.length) out.push(`${at}: it needs at least one SCF control`);
    for (const x of r.scf ?? []) {
      if (!isScfId(x)) out.push(`${at}: ${x} is not an SCF control Stolos knows`);
    }
    if (!isDay(r.nextReview)) out.push(`${at}: nextReview must be a day, YYYY-MM-DD`);
    if (
      r.reviewEveryDays !== undefined &&
      (!Number.isInteger(r.reviewEveryDays) || r.reviewEveryDays < 1)
    ) {
      out.push(`${at}: reviewEveryDays must be a whole number of days`);
    }
    if (r.status !== undefined && r.status !== "open" && r.status !== "closed") {
      out.push(`${at}: status must be open or closed`);
    }
  }
  return out;
}

/** Define the register: checked now (ids, scales, owners, dates), returned unchanged. */
export function defineRisks<const R extends readonly RiskDef[]>(list: R): R {
  const p = riskProblems(list);
  if (p.length) throw new Error(p.join("; "));
  return list;
}

/** A risk with its level and status. */
export function withLevel(r: RiskDef): Risk {
  return { ...r, level: riskLevel(r.likelihood, r.impact), status: r.status ?? "open" };
}

/** Where the fleet's register is. */
export function risksFile(dir: string = P.fleetDir): string {
  return join(dir, "risks.ts");
}

/** The fleet's register (fleets/<fleet>/risks.ts, exporting `risks`), or undefined when there is none. */
export async function loadRisks(file: string = risksFile()): Promise<Risk[] | undefined> {
  if (!(await exists(file))) return undefined;
  const mod = await import(toFileUrl(file).href + `?t=${Date.now()}`);
  const list = (mod.risks ?? mod.default) as RiskDef[] | undefined;
  if (!Array.isArray(list)) {
    throw new Error("risks.ts exports no risks (export const risks = defineRisks([...]))");
  }
  const p = riskProblems(list);
  if (p.length) throw new Error(p.join("; "));
  return list.map(withLevel);
}

/** A day (YYYY-MM-DD) plus some days. */
export function addDays(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

/** Today (YYYY-MM-DD, UTC). */
export function today(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}
