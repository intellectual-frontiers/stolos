/**
 * Spec 100 FR-001: the Stolos Console's names on the site's network. With the fleet's
 * `web.domain` (for example `lab.example.net`), `stolos.lab.example.net` names the primary
 * controller and `<pc>.stolos.lab.example.net` each controller (`<pc>` is its `controllerName()`).
 * The label `stolos` is `fleet.stolos.console.name`; the primary is `fleet.stolos.console.primary`
 * (unset: the only controller, this one).
 *
 * @example
 * ```ts
 * import { consoleNames } from "./names.ts";
 * const n = consoleNames({ web: { domain: "lab.example.net" } }, "alice-pc");
 * n?.own; // "alice-pc.stolos.lab.example.net"
 * n?.certNames; // ["alice-pc.stolos.lab.example.net", "*.stolos.lab.example.net", "stolos.lab.example.net"]
 * ```
 *
 * @module
 */

import type { FleetDef, StolosFleetDef } from "../model/types.ts";

/** The console's label under the web domain unless the fleet names another. */
export const DEFAULT_CONSOLE_NAME = "stolos";

/** The TXT record's first label: `_stolos-console.<label>.<domain>` holds the live heartbeat. */
export const HEARTBEAT_LABEL = "_stolos-console";

const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/** Every name the console uses on one controller. */
export interface ConsoleNames {
  /** The fleet's web domain (`lab.example.net`): also the WebAuthn relying party's ID. */
  domain: string;
  /** The label (`stolos`). */
  label: string;
  /** The primary's name: `stolos.lab.example.net`. */
  base: string;
  /** This controller's own name: `<pc>.stolos.lab.example.net`. */
  own: string;
  /** This controller (its controllerName()). */
  pc: string;
  /** Whether this controller answers as the base name. */
  primary: boolean;
  /** The primary controller's name, when the fleet names one. */
  primaryName?: string;
  /** The names this controller answers on (its own; the base too on the primary). */
  served: string[];
  /** The names its certificate covers: its own, the wildcard, and the base on the primary. */
  certNames: string[];
  /** The heartbeat's TXT record name. */
  heartbeat: string;
  /** Whether the fleet says to serve on the LAN (`lan: true`). */
  lan: boolean;
}

/** The console's names on controller `pc`, or undefined when the fleet has no web domain. */
export function consoleNames(
  fleet: Pick<FleetDef, "web" | "stolos">,
  pc: string,
): ConsoleNames | undefined {
  const domain = fleet.web?.domain;
  if (!domain) return undefined;
  const c = fleet.stolos?.console ?? {};
  const label = c.name ?? DEFAULT_CONSOLE_NAME;
  const base = `${label}.${domain}`;
  const own = `${pc}.${base}`;
  const primary = c.primary === undefined || c.primary === pc;
  return {
    domain,
    label,
    base,
    own,
    pc,
    primary,
    ...(c.primary ? { primaryName: c.primary } : {}),
    served: primary ? [own, base] : [own],
    certNames: primary ? [own, `*.${base}`, base] : [own, `*.${base}`],
    heartbeat: `${HEARTBEAT_LABEL}.${base}`,
    lan: c.lan === true,
  };
}

/** One problem with the console's settings (where, what, the fix), as validate reports them. */
export interface StolosProblem {
  /** The fleet path. */
  where: string;
  /** What is wrong. */
  message: string;
  /** How to fix it. */
  fix: string;
}

/** Problems with `fleet.stolos` (validation, Article 10). */
export function stolosProblems(fleet: Pick<FleetDef, "web" | "stolos">): StolosProblem[] {
  const out: StolosProblem[] = [];
  const c = fleet.stolos?.console;
  if (!c) return out;
  if (c.name !== undefined && !LABEL.test(c.name)) {
    out.push({
      where: "fleet.stolos.console.name",
      message: `'${c.name}' is not a DNS label`,
      fix: 'lowercase letters, digits and hyphens, for example "stolos"',
    });
  }
  if (c.primary !== undefined && !LABEL.test(c.primary)) {
    out.push({
      where: "fleet.stolos.console.primary",
      message: `'${c.primary}' is not a controller's name`,
      fix: "the controller PC's name as Stolos records it (its hostname as a DNS label)",
    });
  }
  if (c.lan !== undefined && typeof c.lan !== "boolean") {
    out.push({
      where: "fleet.stolos.console.lan",
      message: "lan is true or false",
      fix: "lan: true",
    });
  }
  if (!fleet.web) {
    out.push({
      where: "fleet.stolos.console",
      message: "the console's names live under fleet.web.domain, which is not set",
      fix: 'add web: { domain: "lab.example.net" } to fleets/<fleet>/fleet.ts',
    });
  }
  return out;
}

/** The settings `stolos console --lan` proposes: the default label, this PC as the primary, on. */
export function proposedSettings(
  fleet: Pick<FleetDef, "stolos">,
  pc: string,
): Required<NonNullable<StolosFleetDef["console"]>> {
  const c = fleet.stolos?.console ?? {};
  return { name: c.name ?? DEFAULT_CONSOLE_NAME, primary: c.primary ?? pc, lan: true };
}

/**
 * `fleet.ts`'s text with the console's settings added (a person's file: only an insertion, before
 * the fleet literal's closing brace, nothing else touched); undefined when it already has
 * `stolos:` or its shape is not the usual `export const fleet ... = { ... };`.
 */
export function withStolosSettings(
  source: string,
  s: Required<NonNullable<StolosFleetDef["console"]>>,
): string | undefined {
  if (/^\s*stolos\s*:/m.test(source)) return undefined;
  const start = source.search(/export const fleet\b[^=]*=\s*\{/);
  if (start < 0) return undefined;
  const close = source.lastIndexOf("};");
  if (close < start) return undefined;
  const before = source.slice(0, close).replace(/\s*$/, "");
  const comma = before.endsWith(",") || before.endsWith("{") ? "" : ",";
  const block = [
    "  // Spec 100: the Stolos Console on the LAN, as stolos.<web domain> (this primary controller)",
    "  // and <pc>.stolos.<web domain> (each controller); bun run stolos console --lan serves it.",
    "  stolos: {",
    "    console: {",
    `      name: ${JSON.stringify(s.name)},`,
    `      primary: ${JSON.stringify(s.primary)},`,
    `      lan: ${s.lan ? "true" : "false"},`,
    "    },",
    "  },",
  ].join("\n");
  return `${before}${comma}\n${block}\n${source.slice(close)}`;
}
