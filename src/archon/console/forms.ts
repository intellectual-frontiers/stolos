/**
 * Specs 065 and 066: every command a console offers is a form, generated from
 * the command registry (the source of `archon help`, the man pages, and the
 * MCP tools), so the web and the CLI cannot drift. A form's values become an
 * argument list for that command alone: each value is one argument (never a
 * shell), checked against the command's own definition.
 *
 * @module
 */

import { COMMANDS, offeredOn } from "../commands/registry.ts";
import {
  type ArgSpec,
  type Command,
  effectiveTier,
  type Parsed,
  type Tier,
} from "../core/registry-types.ts";
import { type Html, html } from "./html.ts";
import type { Role } from "./auth.ts";
import { mayRun } from "./auth.ts";

/**
 * Commands a console never offers, though their place matches: interactive
 * ones (a terminal UI, psql), the services themselves, and the internals.
 */
export const NOT_IN_CONSOLE: Set<string> = new Set([
  "pg connect",
  "observe tui",
  "first-boot",
  "reconcile",
  "mcp",
  "web serve",
  "shell emit",
  "notify watch",
  "console exec",
  "guide",
  "boot serve",
]);

/** The commands a console offers where `place` runs ("machine": archon; "pc": stolos). */
export function consoleCommands(place: "machine" | "pc"): Command[] {
  return COMMANDS.filter((c) => offeredOn(c, place) && !c.noMcp && !NOT_IN_CONSOLE.has(c.name));
}

/** An argument list as a person would type it in a shell (quoted where needed). */
export function shellWords(argv: string[]): string {
  return argv.map((a) => /^[A-Za-z0-9_@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`)
    .join(" ");
}

/** A tier in plain words, for people. */
export function tierWords(t: Tier): string {
  return t === "read"
    ? "looks only"
    : t === "repo"
    ? "changes the repository"
    : t === "mutate"
    ? "changes the server"
    : "destroys data";
}

/** A tier as a pill. */
export function tierPill(t: Tier): Html {
  const cls = t === "destructive" ? "bad" : t === "mutate" || t === "repo" ? "warn" : "tier";
  return html`<span class="pill ${cls}">${tierWords(t)}</span>`;
}

/** The result of reading a command's form: its argument list and tier, or why not. */
export type FormResult =
  | { argv: string[]; args: Parsed; tier: Tier }
  | { error: string };

/**
 * A form's values as `cmd`'s argument list. Positional arguments first, in
 * order, then the options; a flag is present when its box is ticked. Values
 * may not start with "-" (they would read as options). Required ones must be
 * there. Unknown fields are ignored.
 */
export function argvFor(cmd: Command, form: Record<string, string | undefined>): FormResult {
  const words = cmd.name.split(" ");
  const positional: string[] = [];
  const options: string[] = [];
  const args: Parsed = {};
  for (const a of cmd.args) {
    const v = form[a.name];
    if (a.type === "boolean") {
      if (v === "on" || v === "true") {
        options.push(`--${a.name}`);
        args[a.name] = true;
      }
      continue;
    }
    const value = (v ?? "").trim();
    if (!value) {
      if (a.required) return { error: `${a.name} is required` };
      continue;
    }
    if (value.startsWith("-")) return { error: `${a.name} may not start with "-"` };
    if (/[\0\r\n]/.test(value)) return { error: `${a.name} must be one line` };
    // A check-in code (spec 069) is long; every other value is short.
    if (value.length > (a.name === "check-in" || a.name === "import" ? 100_000 : 2000)) {
      return { error: `${a.name} is too long` };
    }
    if (a.choices && !a.choices.includes(value)) {
      return { error: `${a.name} is one of: ${a.choices.join(", ")}` };
    }
    args[a.name] = value;
    if (a.positional) positional.push(value);
    else options.push(`--${a.name}`, value);
  }
  return { argv: [...words, ...positional, ...options], args, tier: effectiveTier(cmd, args) };
}

/** One argument's field. */
function field(a: ArgSpec, value?: string): Html {
  const id = `f-${a.name}`;
  if (a.type === "boolean") {
    return html`
      <label
        class="check"><input type="checkbox" id="${id}" name="${a.name}" ${value === "on"
          ? "checked"
          : ""}> <span><span class="mono">--${a.name}</span> <span class="sub">${a
          .description}</span></span></label>
    `;
  }
  const label = a.positional ? a.name : `--${a.name}`;
  if (a.choices) {
    return html`
      <label
        class="field"><span><span class="mono">${label}</span>${a.required
          ? " (required)"
          : ""} <span class="sub">${a.description}</span></span><select id="${id}" name="${a
          .name}">${a.required ? "" : html`<option value="">(none)</option>`}${a.choices.map((c) =>
            html`<option value="${c}" ${c === value ? "selected" : ""}>${c}</option>`
          )}</select></label>
    `;
  }
  const placeholder = a.name === "confirm-destroy"
    ? "type the name it destroys, to confirm"
    : a.default !== undefined
    ? String(a.default)
    : "";
  return html`
    <label
      class="field"><span><span class="mono">${label}</span>${a.required
        ? " (required)"
        : ""} <span class="sub">${a
        .description}</span></span><input type="text" id="${id}" name="${a.name}" value="${value ??
        ""}" placeholder="${placeholder}" autocomplete="off"></label>
  `;
}

/** How a console's forms differ (the Stolos Console: the person at the PC may run everything). */
export interface FormOptions {
  /** Whether the person may run a tier (default: the Archon Console's roles). */
  may?: (t: Tier) => boolean;
  /** Ask for the password again before destroying data (default: yes). */
  password?: boolean;
  /** The line beside the Run button. */
  footnote?: string;
}

/**
 * A command's form: what it does, its fields, and the run button. People who
 * may not run it see why; destroying data asks for the password again.
 * Datastar posts it and streams the output into #output.
 */
export function commandForm(
  cmd: Command,
  role: Role,
  post: string,
  values: Record<string, string> = {},
  o: FormOptions = {},
): Html {
  const tier = cmd.tier;
  const allowed = (o.may ?? ((t: Tier) => mayRun(role, t)))(tier);
  const destroy = tier === "destructive" || cmd.args.some((a) => a.name === "confirm-destroy");
  return html`<form class="card stack" id="cmdform" data-on:submit="@post('${post}', {contentType: 'form'})">
  <input type="hidden" name="command" value="${cmd.name}">
  <div class="row spread"><h2 class="mono">${cmd.name}</h2>${tierPill(tier)}</div>
  <p class="sub" style="margin:0">${cmd.summary}</p>
  ${cmd.args.map((a) => field(a, values[a.name]))}
  ${
    destroy && allowed && o.password !== false
      ? html`
        <label
          class="field"><span>Your password, again <span class="sub">(only to destroy data)</span></span><input type="password" name="password" autocomplete="current-password"></label>
      `
      : ""
  }
  <div class="row">
    ${
    allowed
      ? html`<button class="btn${
        tier === "destructive" ? " danger" : ""
      }" type="submit">Run</button>`
      : html`<span class="notice bad">Only operators (members of sudo or archon-ops) may run this.</span>`
  }
    <span class="sub">${
    o.footnote ??
      `Runs as you; recorded in Activity${
        tier === "read" ? "" : ", and mailed to the fleet's mailbox"
      }.`
  }</span>
  </div>
  <details><summary class="sub">About this command</summary><div class="sub" style="white-space:pre-wrap">${cmd.description}</div></details>
</form>`;
}
