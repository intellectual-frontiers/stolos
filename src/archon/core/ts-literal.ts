/**
 * TypeScript object literals for the files archon writes into a fleet
 * repository (fleet.ts, decisions.ts): keys bare where they are identifiers
 * (`timezone: "America/New_York"`), quoted only where they must be
 * (`"otel-ui": ...`); strings in double quotes; two-space indentation and
 * trailing commas, as `deno fmt` leaves them. Easier to read and edit than
 * JSON, and the same data.
 *
 * @module
 */

/** A key that needs no quotes: an identifier (letters, digits, `_`, `$`; not starting with a digit). */
export const BARE_KEY: RegExp = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** A key as TypeScript writes it: bare when it can be, else a double-quoted string. */
export function tsKey(key: string): string {
  return BARE_KEY.test(key) ? key : JSON.stringify(key);
}

/**
 * A value as a TypeScript literal, indented for `depth` (two spaces each).
 * Objects and arrays span lines (empty ones stay `{}` and `[]`); undefined
 * properties are left out, as JSON.stringify does.
 */
export function tsLiteral(value: unknown, depth = 0): string {
  const pad = "  ".repeat(depth + 1);
  const end = "  ".repeat(depth);
  if (value === null) return "null";
  if (Array.isArray(value)) {
    if (!value.length) return "[]";
    return `[\n${value.map((v) => `${pad}${tsLiteral(v, depth + 1)},\n`).join("")}${end}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) =>
      v !== undefined
    );
    if (!entries.length) return "{}";
    return `{\n${
      entries.map(([k, v]) => `${pad}${tsKey(k)}: ${tsLiteral(v, depth + 1)},\n`).join("")
    }${end}}`;
  }
  if (typeof value === "string") return JSON.stringify(value);
  return String(value);
}
