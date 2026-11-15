/**
 * Spec 089: the vocabularies Stolos names its tables, views, and columns
 * from. No name is Stolos's own: each table or view cites the standard each
 * part of its name comes from, and a test checks the term is in that
 * standard. OCSF's object and class names and MITRE D3FEND's artifact names
 * are generated from their published schemas (`bun run ocsf`); the others
 * are short lists, each with its source.
 *
 * @module
 */

import { OCSF_CLASSES, OCSF_OBJECT_NAMES } from "../ocsf/classes.ts";
import { D3FEND_ARTIFACTS } from "./d3fend.auto.ts";

/** A vocabulary a name may come from. */
export type Vocabulary = "udm" | "ocsf" | "d3fend" | "gql" | "iso22123" | "prov" | "oscal";

/** Each vocabulary: what it is, and where it is published. */
export const VOCABULARIES: Record<Vocabulary, { title: string; source: string }> = {
  udm: {
    title: "The Universal Data Model (Len Silverston)",
    source:
      "The Data Model Resource Book, Volume 1, Revised Edition (Wiley, 2001): parties, roles, relationships, contact mechanisms, fixed assets",
  },
  ocsf: {
    title: "Open Cybersecurity Schema Framework 1.9.0",
    source: "https://schema.ocsf.io/1.9.0 (Linux Foundation, Apache-2.0)",
  },
  d3fend: {
    title: "MITRE D3FEND artifacts",
    source: "https://d3fend.mitre.org (MIT license)",
  },
  gql: {
    title: "ISO/IEC 39075:2024 GQL (property graphs)",
    source: "https://www.iso.org/standard/76120.html",
  },
  iso22123: {
    title: "ISO/IEC 22123-1:2023 Cloud computing vocabulary",
    source: "https://www.iso.org/standard/82758.html",
  },
  prov: {
    title: "W3C PROV-O: The PROV Ontology",
    source: "https://www.w3.org/TR/prov-o/",
  },
  oscal: {
    title: "NIST OSCAL 1.2.3",
    source: "https://pages.nist.gov/OSCAL/",
  },
};

/** The terms of the curated vocabularies (the generated ones come from their schemas). */
const CURATED: Record<Exclude<Vocabulary, "ocsf" | "d3fend">, readonly string[]> = {
  udm: [
    "party",
    "person",
    "organization",
    "party_role",
    "role_type",
    "party_relationship",
    "party_relationship_type",
    "contact_mechanism",
    "party_contact_mechanism",
    "electronic_address",
    "fixed_asset",
    "fixed_asset_type",
    "party_fixed_asset_assignment",
    "facility",
  ],
  gql: ["graph", "node", "edge", "label", "property", "path"],
  iso22123: ["tenant", "cloud_service", "cloud_service_customer", "cloud_service_provider"],
  prov: ["entity", "activity", "agent", "provenance", "derivation", "attribution"],
  oscal: [
    "observation",
    "finding",
    "risk",
    "poam_item",
    "component",
    "inventory_item",
    "control",
    "evidence",
  ],
};

/** Every term in a vocabulary, lower_snake_case. */
export function terms(v: Vocabulary): ReadonlySet<string> {
  if (v === "ocsf") return new Set([...OCSF_OBJECT_NAMES, ...Object.keys(OCSF_CLASSES)]);
  if (v === "d3fend") return new Set(D3FEND_ARTIFACTS);
  return new Set(CURATED[v]);
}

/** A reference to a term in a vocabulary. */
export interface TermRef {
  /** The vocabulary. */
  from: Vocabulary;
  /** The term, lower_snake_case, as the vocabulary has it. */
  term: string;
}

/**
 * SQLite's keywords (https://sqlite.org/lang_keywords.html), and the SQL
 * standard's and PostgreSQL's reserved words a table might collide with when
 * the canonical SQL is loaded elsewhere.
 */
export const SQL_KEYWORDS: ReadonlySet<string> = new Set(
  `abort action add after all alter always analyze and as asc attach autoincrement before begin between by cascade case cast check collate column commit conflict constraint create cross current current_date current_time current_timestamp database default deferrable deferred delete desc detach distinct do drop each else end escape except exclude exclusive exists explain fail filter first following for foreign from full generated glob group groups having if ignore immediate in index indexed initially inner insert instead intersect into is isnull join key last left like limit match materialized natural no not nothing notnull null nulls of offset on or order others outer over partition plan pragma preceding primary query raise range recursive references regexp reindex release rename replace restrict returning right rollback row rows savepoint select set table temp temporary then ties to transaction trigger unbounded union unique update using vacuum values view virtual when where window with without user current_user session_user authorization grant role analyse array asymmetric both leading trailing only placing symmetric variadic`.split(
    /\s+/,
  ),
);

const SNAKE = /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/;

/** Problems with a table, view, or column name, each in words (none: it is fine). */
export function nameProblems(name: string, parts?: readonly TermRef[]): string[] {
  const out: string[] = [];
  if (!SNAKE.test(name)) out.push(`${name}: not lower_snake_case`);
  if (SQL_KEYWORDS.has(name)) out.push(`${name}: an SQL keyword`);
  if (!parts) return out;
  // Tables and views are singular (status, access, and dns end in s and are singular).
  if (/s$/.test(name) && !/(ss|us|is|dns)$/.test(name)) {
    out.push(`${name}: plural (use the singular)`);
  }
  if (parts.map((p) => p.term).join("_") !== name) {
    out.push(`${name}: not the terms it cites (${parts.map((p) => p.term).join(" + ")})`);
  }
  for (const p of parts) {
    if (!terms(p.from).has(p.term)) out.push(`${name}: "${p.term}" is not a ${p.from} term`);
  }
  return out;
}
