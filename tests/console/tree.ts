/**
 * JSON as the tests read it: a parsed document is `unknown`, and a value deep inside it is read by
 * its path (object keys and array indexes), so a test checks what a document says without casting
 * it to a type it has not proven.
 *
 * @example
 * ```ts
 * import { at, parse } from "./tree.ts";
 * at(parse('{"a":[{"b":1}]}'), "a", 0, "b"); // 1
 * ```
 *
 * @module
 */

/** Text as JSON, unread (`JSON.parse`, typed as what it is: not known yet). */
export function parse(text: string): unknown {
  return JSON.parse(text) as unknown;
}

/** The value at `path` in `v`: each step a key of an object or an index of an array; undefined where there is none. */
export function at(v: unknown, ...path: readonly (string | number)[]): unknown {
  let cur: unknown = v;
  for (const step of path) {
    if (Array.isArray(cur) && typeof step === "number") cur = (cur as unknown[])[step];
    else if (typeof cur === "object" && cur !== null && typeof step === "string") {
      cur = (cur as Record<string, unknown>)[step];
    } else return undefined;
  }
  return cur;
}

/** The text at `path` ("" where it is not text). */
export function text(v: unknown, ...path: readonly (string | number)[]): string {
  const t = at(v, ...path);
  return typeof t === "string" ? t : "";
}

/** The list at `path` (empty where it is not a list). */
export function list(v: unknown, ...path: readonly (string | number)[]): unknown[] {
  const l = at(v, ...path);
  return Array.isArray(l) ? (l as unknown[]) : [];
}

/** The keys of the object at `path` (none where it is not an object). */
export function keys(v: unknown, ...path: readonly (string | number)[]): string[] {
  const o = at(v, ...path);
  return typeof o === "object" && o !== null && !Array.isArray(o) ? Object.keys(o) : [];
}

/** The value, where it is there; a test that needs it fails with `what` where it is not. */
export function must<T>(v: T | undefined | null, what = "a value the test needs"): T {
  if (v === undefined || v === null) throw new Error(`missing: ${what}`);
  return v;
}
