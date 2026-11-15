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

/**
 * Spec 090: read a value {@link tsLiteral} wrote, without running it (so a past
 * version from `git show` can be read safely): objects with bare or quoted keys,
 * arrays, double-quoted strings, numbers, true, false, null; trailing commas.
 * Anything else is refused. Returns the value and where it ended.
 */
export function parseTsLiteral(text: string, start = 0): { value: unknown; end: number } {
  let i = start;
  const ws = () => {
    for (;;) {
      while (i < text.length && /\s/.test(text[i])) i++;
      if (text.startsWith("//", i)) { while (i < text.length && text[i] !== "\n") i++; }
      else return;
    }
  };
  const fail = (what: string): never => {
    throw new Error(`not a TypeScript literal at ${i}: ${what}`);
  };
  const str = (): string => {
    const m = /^"(?:[^"\\\n]|\\.)*"/.exec(text.slice(i));
    if (!m) return fail("an unterminated string");
    i += m[0].length;
    return JSON.parse(m[0]) as string;
  };
  const value = (): unknown => {
    ws();
    const c = text[i];
    if (c === "{") {
      i++;
      const o: Record<string, unknown> = {};
      for (;;) {
        ws();
        if (text[i] === "}") return i++, o;
        let k: string;
        if (text[i] === '"') k = str();
        else {
          const m = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(text.slice(i));
          if (!m) return fail("a key");
          k = m[0];
          i += k.length;
        }
        ws();
        if (text[i++] !== ":") fail("a colon");
        o[k] = value();
        ws();
        if (text[i] === ",") i++;
        else if (text[i] !== "}") fail("a comma or }");
      }
    }
    if (c === "[") {
      i++;
      const a: unknown[] = [];
      for (;;) {
        ws();
        if (text[i] === "]") return i++, a;
        a.push(value());
        ws();
        if (text[i] === ",") i++;
        else if (text[i] !== "]") fail("a comma or ]");
      }
    }
    if (c === '"') return str();
    const m = /^(-?\d+(\.\d+)?([eE][+-]?\d+)?|true|false|null)/.exec(text.slice(i));
    if (!m) return fail("a value");
    i += m[0].length;
    return JSON.parse(m[0]);
  };
  const v = value();
  return { value: v, end: i };
}

/** The value of `export const <name>[: Type] = <literal>;` in a file {@link tsLiteral} wrote. */
export function exportedLiteral(source: string, name: string): unknown {
  const m = new RegExp(`export const ${name}(?:\\s*:\\s*[A-Za-z_$][\\w$.<>, \\[\\]]*)?\\s*=\\s*`)
    .exec(
      source,
    );
  if (!m) throw new Error(`no export const ${name}`);
  return parseTsLiteral(source, m.index + m[0].length).value;
}
