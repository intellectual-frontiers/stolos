/**
 * Spec 080: the tables the risk register and the vendor inventory add to the
 * estate graph, declared once in spec 089's schema language. Every name is a
 * cited standard's term: `risk` and `poam_item` are OSCAL's (a risk, and a
 * plan of action item: an accepted risk is a deviation approved until a
 * date); `data_classification` is OCSF's (what kind of data a vendor holds).
 * Vendors themselves are the estate's own UDM parties: an `organization`
 * with the `party_role` supplier, joined to what revealed it by an `edge`
 * (`supplies`).
 *
 * ```mermaid
 * erDiagram
 *   risk ||--o{ poam_item : "accepted (json)"
 *   organization ||--o| data_classification : "triage (vendors.ts)"
 *   organization ||--o{ party_role : "supplier"
 *   organization ||--o{ edge : "supplies"
 * ```
 *
 * @module
 */

import { type AnyTable, defineTable, schemaDoc, schemaSql } from "../schema/define.ts";
import { LEVELS, TREATMENTS } from "./register.ts";

/** One risk in the register (OSCAL risk), from fleets/<fleet>/risks.ts. */
export const risk: AnyTable = defineTable({
  name: "risk",
  terms: [{ from: "oscal", term: "risk" }],
  doc: "One risk in the register (fleets/<fleet>/risks.ts), with its NIST SP 800-30 Rev 1 levels.",
  columns: {
    risk_uid: { type: "text", doc: "Its id in risks.ts.", required: true },
    title: { type: "text", doc: "What could happen.", required: true },
    description: { type: "text", doc: "How, and what it would do.", required: true },
    likelihood: {
      type: "text",
      doc: "SP 800-30 Rev 1 likelihood (Table G-5).",
      required: true,
      values: LEVELS,
    },
    impact: {
      type: "text",
      doc: "SP 800-30 Rev 1 impact (Table H-3).",
      required: true,
      values: LEVELS,
    },
    level: {
      type: "text",
      doc: "SP 800-30 Rev 1 level of risk (Table I-2).",
      required: true,
      values: LEVELS,
    },
    owner: { type: "text", doc: "Its owner's work email.", required: true, index: true },
    treatment: {
      type: "text",
      doc: "accept, mitigate, transfer, or avoid (SP 800-39).",
      required: true,
      values: TREATMENTS,
    },
    scf_controls: { type: "json", doc: "The SCF controls it relates to.", required: true },
    accepted: {
      type: "json",
      doc: "The accepted risks it stands behind (poam_item uids).",
      required: true,
    },
    next_review: { type: "text", doc: "When it is reviewed next (YYYY-MM-DD).", required: true },
    status: {
      type: "text",
      doc: "open or closed.",
      required: true,
      values: ["open", "closed"],
    },
  },
  key: ["risk_uid"],
});

/** An accepted risk (OSCAL POA&M item: a deviation approved until a date). */
export const poamItem: AnyTable = defineTable({
  name: "poam_item",
  terms: [{ from: "oscal", term: "poam_item" }],
  doc: "An accepted risk: a check that may fail, why, who said so, and until when (controls/accepted.ts, or an adopted machine's).",
  columns: {
    poam_item_uid: {
      type: "text",
      doc: "<pack>/<control> (controls/accepted.ts), or <machine>:<policy> (an adopted machine's).",
      required: true,
    },
    policy_id: { type: "text", doc: "The check it accepts.", required: true },
    scope: {
      type: "text",
      doc: 'Where it applies: "fleet", or the adopted machine.',
      required: true,
    },
    reason: { type: "text", doc: "Why.", required: true },
    accepted_by: { type: "text", doc: "Who accepted it.", required: true },
    until: { type: "text", doc: "Until when (YYYY-MM-DD).", required: true },
  },
  key: ["poam_item_uid"],
});

/** What a vendor holds and how critical it is (OCSF data classification), from vendors.ts. */
export const dataClassification: AnyTable = defineTable({
  name: "data_classification",
  terms: [{ from: "ocsf", term: "data_classification" }],
  doc: "A vendor's triage (fleets/<fleet>/vendors.ts): its FIPS 199 criticality and the OCSF data categories it holds.",
  columns: {
    party_uid: { type: "text", doc: "The vendor (an organization party).", required: true },
    criticality: {
      type: "text",
      doc: "FIPS 199 potential impact if it failed or leaked: low, moderate, high; or unassessed.",
      required: true,
      values: ["low", "moderate", "high", "unassessed"],
    },
    categories: {
      type: "json",
      doc: "The OCSF data_classification categories it holds (Personal, Financial, ...).",
      required: true,
    },
    owner: { type: "text", doc: "Who looks after the relationship (a work email)." },
  },
  key: ["party_uid"],
});

/** The tables spec 080 adds to the estate graph. */
export const RISK_SCHEMA: readonly AnyTable[] = [risk, poamItem, dataClassification];

/** Their canonical SQL. */
export function riskSchemaSql(): string {
  return schemaSql("the risk register and vendor inventory (spec 080)", RISK_SCHEMA);
}

/** Their documentation, with the ER diagram. */
export function riskSchemaDoc(): string {
  return schemaDoc("The risk register and vendor inventory", RISK_SCHEMA);
}
