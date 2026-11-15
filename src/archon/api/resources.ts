/**
 * Spec 094: the estate's tables and views as REST resources. Each resource,
 * its columns, and their types come from the declarations in
 * `../estate/schema.ts` (spec 090), the same ones the SQL is generated from.
 * A request's filters and paging become a SELECT whose names are only
 * declared ones and whose values are bound parameters: nothing a request
 * sends is ever written into the SQL.
 *
 * | Column type | In JSON |
 * | --- | --- |
 * | text | string |
 * | integer | integer |
 * | real | number |
 * | boolean | true or false (stored as 1 and 0) |
 * | json | object (stored as text) |
 *
 * @module
 */

import type { Estate } from "../estate/graph.ts";
import { ESTATE_SCHEMA } from "../estate/schema.ts";
import { type AnyTable, type TypedColumn, typedColumns, type ViewDef } from "../schema/define.ts";

/** Rows a page holds when the request does not say. */
export const DEFAULT_LIMIT = 100;

/** The most rows one page holds. */
export const MAX_LIMIT = 1000;

/** One estate table or view, as the API serves it. */
export interface Resource {
  /** Its name: the path is `/v1/<name>`. */
  name: string;
  /** A table or a view. */
  kind: "table" | "view";
  /** What it holds. */
  doc: string;
  /** Its columns, typed. */
  columns: TypedColumn[];
  /** Its order: a table's key, or a view's columns in order (stable pages). */
  order: string[];
}

/** A resource from its declaration. */
export function resourceOf(d: AnyTable | ViewDef): Resource {
  const columns = typedColumns(d);
  return {
    name: d.name,
    kind: d.kind,
    doc: d.doc,
    columns,
    order: d.kind === "table" ? [...d.key] : columns.map((c) => c.name),
  };
}

/** Every estate table and view, in declaration order. */
export const RESOURCES: readonly Resource[] = ESTATE_SCHEMA.map(resourceOf);

/** A resource by name, or undefined. */
export function resourceNamed(name: string): Resource | undefined {
  return RESOURCES.find((r) => r.name === name);
}

/** A page of rows, and how many rows match in all. */
export interface Page<T = Record<string, unknown>> {
  /** The rows. */
  items: T[];
  /** The page size asked for. */
  limit: number;
  /** Rows skipped before this page. */
  offset: number;
  /** Rows that match, across every page. */
  total: number;
}

/** A list request, checked: its paging and its filters (bound values, by declared column). */
export interface ListQuery {
  /** The page size. */
  limit: number;
  /** Rows skipped. */
  offset: number;
  /** Each filtered column and its value, as SQLite stores it. */
  filters: Array<{ column: string; value: string | number }>;
}

const INTEGER = /^(0|[1-9][0-9]{0,8})$/;

/** A filter value as SQLite stores the column's type, or why it cannot be one. */
export function filterValue(c: TypedColumn, raw: string): { value: string | number } | {
  error: string;
} {
  switch (c.type) {
    case "boolean":
      if (raw === "true" || raw === "1") return { value: 1 };
      if (raw === "false" || raw === "0") return { value: 0 };
      return { error: `${c.name} is true or false` };
    case "integer":
      return /^-?[0-9]{1,15}$/.test(raw)
        ? { value: Number(raw) }
        : { error: `${c.name} is an integer` };
    case "real": {
      const n = Number(raw);
      return raw.trim() !== "" && Number.isFinite(n)
        ? { value: n }
        : { error: `${c.name} is a number` };
    }
    case "json":
      return { error: `${c.name} holds JSON and cannot be filtered on` };
    default:
      if (c.values && !c.values.includes(raw)) {
        return { error: `${c.name} is one of ${c.values.join(", ")}` };
      }
      return { value: raw };
  }
}

/** A list request's query string, checked against the resource's declared columns. */
export function listQuery(r: Resource, params: URLSearchParams): ListQuery | { error: string } {
  const one = (k: string) => {
    const all = params.getAll(k);
    return all.length > 1 ? null : all[0];
  };
  const out: ListQuery = { limit: DEFAULT_LIMIT, offset: 0, filters: [] };
  for (const k of new Set(params.keys())) {
    const v = one(k);
    if (v === null) return { error: `${k}: one value only` };
    if (v === undefined) continue;
    if (k === "limit") {
      if (!INTEGER.test(v) || Number(v) < 1 || Number(v) > MAX_LIMIT) {
        return { error: `limit is an integer from 1 to ${MAX_LIMIT}` };
      }
      out.limit = Number(v);
    } else if (k === "offset") {
      if (!INTEGER.test(v)) return { error: "offset is an integer from 0" };
      out.offset = Number(v);
    } else if (k === "format") {
      continue; // the handler checks it
    } else {
      const c = r.columns.find((x) => x.name === k);
      if (!c) {
        return {
          error: `${r.name} has no column ${k} (its columns: ${
            r.columns.map((x) => x.name).join(", ")
          })`,
        };
      }
      const f = filterValue(c, v);
      if ("error" in f) return f;
      out.filters.push({ column: c.name, value: f.value });
    }
  }
  return out;
}

/** A row as JSON: booleans as true and false, JSON columns parsed, integers as numbers. */
export function jsonRow(r: Resource, row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const c of r.columns) {
    const v = row[c.name];
    if (v === null || v === undefined) out[c.name] = null;
    else if (c.type === "boolean") out[c.name] = Number(v) !== 0;
    else if (c.type === "json") {
      try {
        out[c.name] = typeof v === "string" ? JSON.parse(v) : v;
      } catch {
        out[c.name] = null;
      }
    } else if (typeof v === "bigint") out[c.name] = Number(v);
    else if (c.type === "text") out[c.name] = String(v);
    else out[c.name] = v;
  }
  return out;
}

/** One page of a resource's rows: names from the declaration, values bound. */
export function listRows(e: Estate, r: Resource, q: ListQuery): Page {
  const where = q.filters.length
    ? ` WHERE ${q.filters.map((f) => `${f.column} = ?`).join(" AND ")}`
    : "";
  const values = q.filters.map((f) => f.value);
  const total = Number(
    (e.db.prepare(`SELECT count(*) AS n FROM ${r.name}${where}`).get(...values) as {
      n: number | bigint;
    }).n,
  );
  const rows = e.db.prepare(
    `SELECT ${r.columns.map((c) => c.name).join(", ")} FROM ${r.name}${where} ORDER BY ${
      r.order.join(", ")
    } LIMIT ? OFFSET ?`,
  ).all(...values, q.limit, q.offset) as Array<Record<string, unknown>>;
  return {
    items: rows.map((x) => jsonRow(r, x)),
    limit: q.limit,
    offset: q.offset,
    total,
  };
}
