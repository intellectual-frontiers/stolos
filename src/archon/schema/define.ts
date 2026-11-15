/**
 * Spec 089: the schema language. A table, a view, or a label is declared
 * once, in typed TypeScript, and everything else is generated from it: the
 * canonical SQL (tables, indexes, views), the upsert statement and its
 * parameters, the row type, the OCSF view, and the documentation with its
 * Mermaid diagram. Names follow the vocabularies in `vocabulary.ts`: singular
 * lower_snake_case, never an SQL keyword, and each part a cited standard's
 * term.
 *
 * ```mermaid
 * flowchart LR
 *   decl["defineTable / defineView / defineLabel"] --> sql["canonical SQL: tables, indexes, views"]
 *   decl --> upsert["upsert SQL and parameters"]
 *   decl --> types["row types (TypeScript)"]
 *   decl --> docs["docs and Mermaid ER diagram"]
 *   decl --> names["naming check: vocabularies"]
 * ```
 *
 * @module
 */

import { nameProblems, type TermRef } from "./vocabulary.ts";

/** A column's SQL type; booleans are stored as 0 and 1, JSON as text. */
export type ColumnType = "text" | "integer" | "real" | "boolean" | "json";

/** One column. */
export interface Column {
  /** Its type. */
  type: ColumnType;
  /** What it holds, for people (it becomes the docs). */
  doc: string;
  /** NOT NULL. */
  required?: boolean;
  /** Index it. */
  index?: boolean;
  /** The table whose key it references. */
  references?: string;
  /** The values it may take (a CHECK constraint). */
  values?: readonly string[];
}

/** The TypeScript type of a column's value. */
export type ValueOf<C extends Column> = C["type"] extends "integer" | "real" ? number
  : C["type"] extends "boolean" ? boolean
  : C["type"] extends "json" ? unknown
  : C["values"] extends readonly string[] ? C["values"][number]
  : string;

/** The columns of a table that are required (NOT NULL). */
export type RequiredKeys<C extends Record<string, Column>> = {
  [K in keyof C]: C[K]["required"] extends true ? K : never;
}[keyof C];

/** A row of a table: required columns required, the rest optional. */
export type RowOf<C extends Record<string, Column>> =
  & { [K in RequiredKeys<C>]: ValueOf<C[K]> }
  & { [K in Exclude<keyof C, RequiredKeys<C>>]?: ValueOf<C[K]> | null };

/** A table, as declared. */
export interface TableDef<C extends Record<string, Column> = Record<string, Column>> {
  /** "table". */
  kind: "table";
  /** Its name. */
  name: string;
  /** The standard terms its name is made of. */
  terms: readonly TermRef[];
  /** What it holds. */
  doc: string;
  /** Its columns, in order. */
  columns: C;
  /** Its primary key. */
  key: readonly (keyof C & string)[];
}

/**
 * A view's column with its type (spec 094): the REST API and its OpenAPI
 * document read the type. A column given only as its doc (a string) is text.
 */
export interface ViewColumn {
  /** Its type, as the SELECT yields it (booleans 0 and 1, JSON as text). */
  type: ColumnType;
  /** What it holds, for people. */
  doc: string;
  /** Never null. */
  required?: boolean;
  /** The values it takes. */
  values?: readonly string[];
}

/** A view, as declared. */
export interface ViewDef {
  /** "view". */
  kind: "view";
  /** Its name. */
  name: string;
  /** The standard terms its name is made of. */
  terms: readonly TermRef[];
  /** What it shows. */
  doc: string;
  /** Its columns: what each holds (text), or its type with that (spec 094). */
  columns: Record<string, string | ViewColumn>;
  /** Its SELECT. */
  select: string;
  /** The tables and views it reads. */
  reads: readonly string[];
}

/** Declare a table. */
export function defineTable<C extends Record<string, Column>>(
  d: Omit<TableDef<C>, "kind">,
): TableDef<C> {
  return { kind: "table", ...d };
}

/** Declare a view. */
export function defineView(d: Omit<ViewDef, "kind">): ViewDef {
  return { kind: "view", ...d };
}

/** A label: a typed view over the graph's nodes that carry it (props kept as JSON in node.props). */
export interface LabelDef<P extends Record<string, Column> = Record<string, Column>> {
  /** The label, and the view's name. */
  name: string;
  /** The standard terms its name is made of. */
  terms: readonly TermRef[];
  /** What it is. */
  doc: string;
  /** Its properties. */
  props: P;
}

/**
 * The graph tables a label view reads: node (node_uid, tenant_uid,
 * native_id, display_name, props) and node_label (node_uid, label), with
 * tenant (tenant_uid, connector). Spec 090 declares them.
 */
export const GRAPH = { node: "node", label: "node_label", tenant: "tenant" } as const;

/** A label's generated view, with its declaration. */
export type LabelView<P extends Record<string, Column> = Record<string, Column>> = ViewDef & {
  label: LabelDef<P>;
};

/** Any table, whatever its columns. */
export interface AnyTable {
  /** "table". */
  kind: "table";
  /** Its name. */
  name: string;
  /** The standard terms its name is made of. */
  terms: readonly TermRef[];
  /** What it holds. */
  doc: string;
  /** Its columns. */
  columns: Record<string, Column>;
  /** Its primary key. */
  key: readonly string[];
}

/** Declare a label; its view is generated. */
export function defineLabel<P extends Record<string, Column>>(d: LabelDef<P>): LabelView<P> {
  const cols = Object.keys(d.props);
  return {
    kind: "view",
    name: d.name,
    terms: d.terms,
    doc: d.doc,
    columns: {
      [`${d.name}_uid`]: {
        type: "text",
        doc: `The node's uid ("<connector>:<tenant>:<native id>").`,
        required: true,
      },
      connector: { type: "text", doc: "The connector it came from.", required: true },
      tenant_uid: { type: "text", doc: "The tenant it belongs to.", required: true },
      native_id: { type: "text", doc: "Its id in the source system.", required: true },
      display_name: "Its name for people.",
      ...Object.fromEntries(cols.map((c): [string, ViewColumn] => {
        const p = d.props[c];
        return [c, { type: p.type, doc: p.doc, ...(p.values ? { values: p.values } : {}) }];
      })),
    },
    select: [
      `SELECT n.node_uid AS ${d.name}_uid, t.connector, n.tenant_uid, n.native_id, n.display_name`,
      ...cols.map((c) => `  , json_extract(n.props, '$.${c}') AS ${c}`),
      `FROM ${GRAPH.node} n`,
      `JOIN ${GRAPH.label} l ON l.node_uid = n.node_uid AND l.label = '${d.name}'`,
      `JOIN ${GRAPH.tenant} t ON t.tenant_uid = n.tenant_uid`,
    ].join("\n"),
    reads: [GRAPH.node, GRAPH.label, GRAPH.tenant],
    label: d,
  };
}

const SQL_TYPE: Record<ColumnType, string> = {
  text: "TEXT",
  integer: "INTEGER",
  real: "REAL",
  boolean: "INTEGER",
  json: "TEXT",
};

/** A table's CREATE TABLE and CREATE INDEX statements. */
export function tableSql(t: AnyTable): string {
  const lines = Object.entries(t.columns).map(([n, c]) => {
    const parts = [`  ${n} ${SQL_TYPE[c.type]}`];
    if (c.required || t.key.includes(n)) parts.push("NOT NULL");
    if (c.references) parts.push(`REFERENCES ${c.references}`);
    if (c.values) parts.push(`CHECK (${n} IN (${c.values.map((v) => `'${v}'`).join(", ")}))`);
    if (c.type === "boolean") parts.push(`CHECK (${n} IN (0, 1))`);
    return `${parts.join(" ")}, -- ${c.doc.replace(/\n/g, " ")}`;
  });
  lines.push(`  PRIMARY KEY (${t.key.join(", ")})`);
  const idx = Object.entries(t.columns).filter(([, c]) => c.index).map(([n]) =>
    `CREATE INDEX IF NOT EXISTS ${t.name}_${n}_idx ON ${t.name} (${n});`
  );
  return [
    `-- ${t.doc.replace(/\n/g, " ")}`,
    `CREATE TABLE IF NOT EXISTS ${t.name} (`,
    ...lines,
    `);`,
    ...idx,
  ].join("\n");
}

/** A view's CREATE VIEW statement. */
export function viewSql(v: ViewDef): string {
  return [
    `-- ${v.doc.replace(/\n/g, " ")}`,
    `CREATE VIEW IF NOT EXISTS ${v.name} AS`,
    `${v.select};`,
  ]
    .join("\n");
}

/** Tables in an order where each comes after the tables it references, then views likewise. */
export function ordered(defs: ReadonlyArray<AnyTable | ViewDef>): Array<AnyTable | ViewDef> {
  const byName = new Map(defs.map((d) => [d.name, d]));
  const deps = (d: AnyTable | ViewDef) =>
    d.kind === "table"
      ? Object.values(d.columns).flatMap((c) =>
        c.references ? [c.references.split("(")[0].trim()] : []
      )
      : [...d.reads];
  const out: Array<AnyTable | ViewDef> = [];
  const state = new Map<string, "visiting" | "done">();
  const visit = (d: AnyTable | ViewDef) => {
    if (state.get(d.name) === "done") return;
    if (state.get(d.name) === "visiting") throw new Error(`${d.name}: a cycle of references`);
    state.set(d.name, "visiting");
    for (const n of deps(d)) {
      const x = byName.get(n);
      if (x && x !== d) visit(x);
    }
    state.set(d.name, "done");
    out.push(d);
  };
  for (const d of defs.filter((x) => x.kind === "table")) visit(d);
  for (const d of defs.filter((x) => x.kind === "view")) visit(d);
  return out;
}

/** The canonical SQL for a schema: every table, index, and view. */
export function schemaSql(title: string, defs: ReadonlyArray<AnyTable | ViewDef>): string {
  return [
    `-- GENERATED from its TypeScript declarations (spec 089): ${title}. Never edit by hand.`,
    "PRAGMA foreign_keys = ON;",
    "",
    ...ordered(defs).map((d) => (d.kind === "table" ? tableSql(d) : viewSql(d)) + "\n"),
  ].join("\n");
}

/** The upsert for a table: insert, or update every non-key column on a key conflict. */
export function upsertSql(t: AnyTable): string {
  const cols = Object.keys(t.columns);
  const rest = cols.filter((c) => !t.key.includes(c));
  return `INSERT INTO ${t.name} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})` +
    ` ON CONFLICT (${t.key.join(", ")}) ` +
    (rest.length
      ? `DO UPDATE SET ${rest.map((c) => `${c} = excluded.${c}`).join(", ")}`
      : "DO NOTHING");
}

/** A row's parameters for {@link upsertSql}, in column order; refuses a missing required value. */
export function rowParams<C extends Record<string, Column>>(
  t: TableDef<C>,
  row: RowOf<C>,
): Array<string | number | null> {
  return Object.entries(t.columns).map(([n, c]) => {
    const v = (row as Record<string, unknown>)[n];
    if (v === undefined || v === null) {
      if (c.required || t.key.includes(n)) throw new Error(`${t.name}.${n} is required`);
      return null;
    }
    if (c.type === "boolean") return v ? 1 : 0;
    if (c.type === "json") return JSON.stringify(v);
    if (c.values && !c.values.includes(String(v))) {
      throw new Error(`${t.name}.${n}: "${v}" is not one of ${c.values.join(", ")}`);
    }
    return v as string | number;
  });
}

/** Every naming problem in a schema (none: it follows the rules). */
export function schemaProblems(defs: ReadonlyArray<AnyTable | ViewDef>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const d of defs) {
    if (seen.has(d.name)) out.push(`${d.name}: declared twice`);
    seen.add(d.name);
    out.push(...nameProblems(d.name, d.terms));
    for (const c of Object.keys(d.columns)) {
      out.push(...nameProblems(c).map((p) => `${d.name}.${p}`));
    }
    if (d.kind === "table") {
      for (const k of d.key) if (!(k in d.columns)) out.push(`${d.name}: key ${k} is not a column`);
      for (const [n, c] of Object.entries(d.columns)) {
        const ref = c.references?.split("(")[0].trim();
        if (ref && !defs.some((x) => x.name === ref)) {
          out.push(`${d.name}.${n}: references ${ref}, which is not declared`);
        }
      }
    }
  }
  return out;
}

/** One column of a table or a view, typed. */
export interface TypedColumn {
  /** Its name. */
  name: string;
  /** Its type. */
  type: ColumnType;
  /** What it holds. */
  doc: string;
  /** Never null (a table's key or required column, or a view's required column). */
  required: boolean;
  /** The values it takes, when declared. */
  values?: readonly string[];
}

/** The typed columns of a table or a view, in order; a view's column given only as its doc is text (spec 094). */
export function typedColumns(d: AnyTable | ViewDef): TypedColumn[] {
  return Object.entries(d.columns).map(([name, c]): TypedColumn => {
    if (typeof c === "string") return { name, type: "text", doc: c, required: false };
    return {
      name,
      type: c.type,
      doc: c.doc,
      required: Boolean(c.required) || (d.kind === "table" && d.key.includes(name)),
      ...(c.values ? { values: c.values } : {}),
    };
  });
}

/** The schema's documentation: each table and view, its columns, and an ER diagram. */
export function schemaDoc(title: string, defs: ReadonlyArray<AnyTable | ViewDef>): string {
  const er = ["erDiagram"];
  for (const d of ordered(defs).filter((x) => x.kind === "table") as AnyTable[]) {
    er.push(`  ${d.name} {`);
    for (const [n, c] of Object.entries(d.columns)) {
      er.push(`    ${c.type} ${n}${d.key.includes(n) ? " PK" : c.references ? " FK" : ""}`);
    }
    er.push("  }");
    for (const c of Object.values(d.columns)) {
      const ref = c.references?.split("(")[0].trim();
      if (ref) er.push(`  ${ref} ||--o{ ${d.name} : ""`);
    }
  }
  const sections = ordered(defs).map((d) =>
    [
      `### ${d.name} (${d.kind})`,
      "",
      d.doc,
      "",
      `Named from: ${d.terms.map((t) => `${t.term} (${t.from})`).join(" + ")}.`,
      "",
      "| Column | Holds |",
      "| --- | --- |",
      ...Object.entries(d.columns).map(([n, c]) =>
        `| \`${n}\` | ${(typeof c === "string" ? c : c.doc).replace(/\|/g, "\\|")} |`
      ),
      "",
    ].join("\n")
  );
  return [`## ${title}`, "", "```mermaid", ...er, "```", "", ...sections].join("\n");
}
