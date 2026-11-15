/**
 * Spec 065: the console's HTML, as typed TypeScript. `html` is a tagged
 * template that escapes every value it is given, except another `Html` (a
 * piece already built this way) or `raw()` (markup the engine wrote itself).
 * So a username, a command's output, or a value from a form can never become
 * markup.
 *
 * @module
 */

/** A piece of HTML that is safe to put in a page as it is. */
export class Html {
  /** The markup. */
  readonly s: string;
  /** Wrap markup built by {@link html} or {@link raw}. */
  constructor(s: string) {
    this.s = s;
  }
  /** The markup. */
  toString(): string {
    return this.s;
  }
}

const ENTITIES: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/** Any value as text: strings as they are, numbers and booleans written out, objects as JSON, nothing as "". */
export function text(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "bigint" || typeof v === "boolean") return String(v);
  if (typeof v === "symbol") return v.toString();
  if (typeof v === "function") return "[function]";
  return JSON.stringify(v);
}

/** A form field's value as text ("" for a missing one or an uploaded file). */
export function formText(v: FormDataEntryValue | null): string {
  return typeof v === "string" ? v : "";
}

/** Text made safe for HTML content and double- or single-quoted attributes. */
export function esc(v: unknown): string {
  return text(v).replace(/[&<>"']/g, (c) => ENTITIES[c] ?? c);
}

/** Markup the engine itself wrote (never a value from outside). */
export function raw(s: string): Html {
  return new Html(s);
}

function part(v: unknown): string {
  if (v instanceof Html) return v.s;
  if (Array.isArray(v)) return v.map(part).join("");
  if (v === undefined || v === null || v === false) return "";
  return esc(v);
}

/** Build HTML: every interpolated value is escaped unless it is `Html` (arrays are joined). */
export function html(strings: TemplateStringsArray, ...values: unknown[]): Html {
  let out = strings[0] ?? "";
  for (let i = 0; i < values.length; i++) out += part(values[i]) + (strings[i + 1] ?? "");
  return new Html(out);
}
