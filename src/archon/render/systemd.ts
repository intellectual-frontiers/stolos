/**
 * Render systemd unit files (and other INI-style systemd configuration) from
 * TypeScript objects. Article IV: the unit is code; the INI file is output.
 *
 * @module
 */

export type Value = string | number | boolean | undefined | Array<string | number>;
export type Section = Record<string, Value>;

export function header(spec: string): string {
  return `# Rendered by archon from spec ${spec}. Do not edit: change the model in /srv/archon.\n`;
}

export function ini(sections: Record<string, Section>, spec?: string): string {
  const out: string[] = [];
  if (spec) out.push(header(spec).trimEnd());
  for (const [name, entries] of Object.entries(sections)) {
    if (out.length) out.push("");
    out.push(`[${name}]`);
    for (const [k, v] of Object.entries(entries)) {
      if (v === undefined) continue;
      const vals = Array.isArray(v) ? v : [v];
      for (const one of vals) {
        out.push(`${k}=${typeof one === "boolean" ? (one ? "yes" : "no") : one}`);
      }
    }
  }
  return out.join("\n") + "\n";
}

/** A oneshot service that runs an archon subcommand. */
export function archonService(
  opts: { description: string; argv: string[]; spec: string; user?: string; after?: string[] },
): string {
  return ini({
    Unit: {
      Description: opts.description,
      Documentation: "man:archon(1)",
      After: opts.after ?? ["network-online.target"],
      Wants: "network-online.target",
    },
    Service: {
      Type: "oneshot",
      ExecStart: ["/usr/local/bin/archon", ...opts.argv].join(" "),
      User: opts.user,
      Environment: "ARCHON_AGENT=timer",
      StateDirectory: "archon",
      Nice: 10,
    },
  }, opts.spec);
}

export function timer(
  opts: { description: string; onCalendar: string; spec: string; randomizedDelay?: string },
): string {
  return ini({
    Unit: { Description: opts.description, Documentation: "man:archon(1)" },
    Timer: {
      OnCalendar: opts.onCalendar,
      Persistent: true,
      RandomizedDelaySec: opts.randomizedDelay ?? "10min",
    },
    Install: { WantedBy: "timers.target" },
  }, opts.spec);
}
