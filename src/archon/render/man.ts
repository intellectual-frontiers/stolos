// Man pages and fish completions generated from the command registry and from
// the constitution and personas (Article 6). Installed into
// /usr/local/share/man and fish's vendor completions directory by spec 012.

import { EVENTS } from "../telemetry/events.ts";
import { ATTRIBUTES, METRICS, RESOURCE, SPANS } from "../telemetry/signals.ts";
import { esc, inline, markdownToRoff, th } from "./roff.ts";
import { COMMANDS } from "../commands/registry.ts";
import { type Command, GLOBAL_ARGS, type Tier } from "../core/registry-types.ts";

import { engineFile } from "../core/assets.ts";

import { PERSONAS } from "../personas/mod.ts";
import type { FileDef } from "../model/types.ts";
import { renderFishCompletions } from "./fish.ts";

/** A fixed date keeps rendered pages stable across builds; bump with releases. */
export const MAN_DATE = "2026-11-09";

const TIER_TEXT: Record<Tier, string> = {
  read: "read-only: changes nothing.",
  repo: "changes only the repository working tree.",
  mutate: "changes the host; elevates through sudo; an agent asks the operator first (spec 030).",
  destructive:
    "destructive; requires an approve: destructive marker in the governing spec and is never served over MCP.",
};

export function pageName(cmd: Command): string {
  return `archon-${cmd.name.replace(/ /g, "-")}`;
}

function synopsis(cmd: Command): string {
  const parts = [`\\fBarchon ${esc(cmd.name)}\\fR`];
  for (const a of cmd.args) {
    if (a.positional) parts.push(a.required ? `\\fI${a.name}\\fR` : `[\\fI${a.name}\\fR]`);
    else {parts.push(
        a.type === "boolean"
          ? `[\\fB\\-\\-${a.name}\\fR]`
          : `[\\fB\\-\\-${a.name}\\fR \\fIvalue\\fR]`,
      );}
  }
  return parts.join(" ");
}

export function commandPage(cmd: Command): string {
  const L = [th(pageName(cmd), 1, MAN_DATE).trimEnd()];
  L.push(".SH NAME", `${esc(pageName(cmd))} \\- ${esc(cmd.summary)}`);
  L.push(".SH SYNOPSIS", synopsis(cmd));
  L.push(".SH DESCRIPTION");
  for (const para of cmd.description.split(/\n\s*\n/)) {
    L.push(".PP", inline(para.replace(/\s+/g, " ").trim()));
  }
  L.push(".PP", `Permission tier: ${esc(TIER_TEXT[cmd.tier])}`);
  if (cmd.readOnlyWith) L.push(".PP", `With \\fB\\-\\-${cmd.readOnlyWith}\\fR it is read-only.`);
  if (cmd.mutateWith) {
    L.push(
      ".PP",
      `With \\fB\\-\\-${cmd.mutateWith}\\fR it changes the host and elevates through sudo.`,
    );
  }
  const args = [...cmd.args, ...GLOBAL_ARGS];
  L.push(".SH OPTIONS");
  for (const a of args) {
    L.push(
      ".TP",
      a.positional
        ? `\\fI${a.name}\\fR`
        : `\\fB\\-\\-${a.name}\\fR${a.type === "string" ? " \\fIvalue\\fR" : ""}`,
    );
    L.push(inline(a.description + (a.default !== undefined ? ` Default: ${a.default}.` : "")));
  }
  if (cmd.examples?.length) {
    L.push(".SH EXAMPLES");
    for (const e of cmd.examples) L.push(".TP", `\\fB${esc(e.cmd)}\\fR`, inline(e.text));
  }
  L.push(
    ".SH MCP",
    `Available to agents as the MCP tool \\fBarchon_${
      cmd.name.replace(/ /g, "_")
    }\\fR (archon mcp, within the fleet's tier).`,
  );
  L.push(
    ".SH SEE ALSO",
    ["archon(1)", ...(cmd.seeAlso ?? [])].map((s) =>
      `\\fB${esc(s.replace(/\(.*/, ""))}\\fR${esc(s.match(/\(.*\)/)?.[0] ?? "")}`
    ).join(", "),
  );
  return L.join("\n") + "\n";
}

export function mainPage(commands: Command[]): string {
  const L = [th("archon", 1, MAN_DATE).trimEnd()];
  L.push(
    ".SH NAME",
    "archon \\- the thinnest layer on Ubuntu Server LTS for converged, verified hosts",
  );
  L.push(".SH SYNOPSIS", "\\fBarchon\\fR \\fIcommand\\fR [\\fIoptions\\fR]");
  L.push(".SH DESCRIPTION");
  L.push(
    ".PP",
    inline(
      "Archon treats its Git repository (checked out at `/srv/archon`) as the server. Hosts are modeled in TypeScript, validated against SHACL shapes, rendered into native configuration, and converged by `archon apply`. No agent runs on a server: an agent on the operator's workstation (Claude Code by default) reaches each server as ops over SSH, through the same commands served as MCP tools by `archon mcp`, limited by the server to the fleet's tier.",
    ),
  );
  L.push(".SH COMMANDS");
  for (const c of commands) {
    L.push(
      ".TP",
      `\\fBarchon ${esc(c.name)}\\fR`,
      `${esc(c.summary)} See \\fB${esc(pageName(c))}\\fR(1).`,
    );
  }
  L.push(".SH FILES");
  for (
    const [f, d] of [
      ["/srv/archon", "the repository: model, specs, rendered output"],
      ["/var/lib/archon", "runtime state written by timers: reports, prov, snapshots"],
      ["/opt/tools", "side-by-side installs of user-tier tools"],
    ]
  ) L.push(".TP", `\\fI${f}\\fR`, esc(d));
  L.push(
    ".SH SEE ALSO",
    "\\fBarchon\\-constitution\\fR(7), \\fBarchon\\-dotfiles\\fR(7), \\fBarchon\\-personas\\fR(7), \\fBsystemd.directives\\fR(7)",
  );
  return L.join("\n") + "\n";
}

export function constitutionPage(): string {
  const md = engineFile(".specify/memory/constitution.md");
  return th("archon-constitution", 7, MAN_DATE) +
    ".SH NAME\narchon\\-constitution \\- the articles that govern every Archon change\n.SH DESCRIPTION\n" +
    markdownToRoff(md.replace(/^# .*\n/, ""));
}

/** Spec 035: the newcomer's guide, from docs/guide.md (also on the welcome page). */
export function guidePage(): string {
  const md = engineFile("docs/guide.md");
  return th("archon-guide", 7, MAN_DATE) +
    ".SH NAME\narchon\\-guide \\- your Archon server, for newcomers\n.SH DESCRIPTION\n" +
    markdownToRoff(md.replace(/^# .*\n/, "")) +
    ".SH SEE ALSO\n\\fBarchon\\fR(1), \\fBarchon\\-guide\\fR(1), \\fBarchon\\-dotfiles\\fR(7), \\fBarchon\\-constitution\\fR(7)\n";
}

/** Spec 031: how dotfiles work, from docs/dotfiles.md (one source for both). */
export function dotfilesPage(): string {
  const md = engineFile("docs/dotfiles.md");
  return th("archon-dotfiles", 7, MAN_DATE) +
    ".SH NAME\narchon\\-dotfiles \\- how your dotfiles are composed, applied, and changed\n.SH DESCRIPTION\n" +
    markdownToRoff(md.replace(/^# .*\n/, "").replace(/\nSee also .*\n?$/, "\n")) +
    ".SH SEE ALSO\n\\fBarchon\\fR(1), \\fBarchon\\-dotfiles\\fR(1), \\fBarchon\\-personas\\fR(7), \\fBchezmoi\\fR(1)\n";
}

/** Spec 038: PostgreSQL instances, from docs/pg.md (also served at /guide/pg). */
export function pgPage(): string {
  const md = engineFile("docs/pg.md");
  return th("archon-pg", 7, MAN_DATE) +
    ".SH NAME\narchon\\-pg \\- PostgreSQL instances on an Archon server\n.SH DESCRIPTION\n" +
    markdownToRoff(md.replace(/^# .*\n/, "")) +
    ".SH SEE ALSO\n\\fBarchon\\fR(1), \\fBpg_lsclusters\\fR(1), \\fBpg_createcluster\\fR(1), \\fBpsql\\fR(1)\n";
}

/** Spec 042: SQL over infrastructure, from docs/sql.md (also served at /guide/sql). */
export function sqlPage(): string {
  const md = engineFile("docs/sql.md");
  return th("archon-sql", 7, MAN_DATE) +
    ".SH NAME\narchon\\-sql \\- SQL over your infrastructure: osquery, DuckDB, jc, Steampipe\n.SH DESCRIPTION\n" +
    markdownToRoff(md.replace(/^# .*\n/, "")) +
    ".SH SEE ALSO\n\\fBarchon\\fR(1), \\fBarchon\\-pg\\fR(7), \\fBosqueryi\\fR(1), \\fBduckdb\\fR(1)\n";
}

/** Spec 049: every signal Archon emits, from telemetry/signals.ts. */
export function telemetryMarkdown(): string {
  const L: string[] = [
    "Every archon run reports through Deno's built-in OpenTelemetry to the host's local Collector (127.0.0.1:4318): a trace per command with a span per phase, and the metrics below. Logs: what archon writes to the journal (identifiers archon-*) reaches the Collector through its journald receiver; what it prints through the console (errors, --json) is exported as logs linked to the trace. A run continues a trace begun elsewhere when TRACEPARENT is set (MCP calls and SSH commands from the boot machine pass it). Nothing secret is ever sent (Article 13).",
    "",
    "## Metrics",
    "",
  ];
  for (const [name, m] of Object.entries(METRICS)) {
    const attrs = m.attributes.length ? ` Attributes: ${m.attributes.join(", ")}.` : "";
    L.push(
      `- \`${name}\` (${m.kind}${
        "unit" in m ? `, ${m.unit}` : ""
      }; ${m.group}): ${m.description}${attrs}`,
    );
  }
  L.push("", "## Spans", "");
  for (const [name, d] of Object.entries(SPANS)) L.push(`- \`${name}\`: ${d}`);
  L.push("", "## Attributes", "");
  for (const [name, d] of Object.entries(ATTRIBUTES)) L.push(`- \`${name}\`: ${d}`);
  L.push("", "## Events (log records)", "");
  L.push(
    "Events are structured at their source and recorded as OpenTelemetry log records (attribute archon.event); the boot server's window and boot.log are renderings of them.",
    "",
  );
  for (const [name, e] of Object.entries(EVENTS)) {
    L.push(`- \`${name}\` (${e.severity}): ${e.description}`);
  }
  L.push("", "## Resource attributes", "");
  for (const [name, d] of Object.entries(RESOURCE)) L.push(`- \`${name}\`: ${d}`);
  return L.join("\n") + "\n";
}

export function telemetryPage(): string {
  return th("archon-telemetry", 7, MAN_DATE) +
    ".SH NAME\narchon\\-telemetry \\- the traces, metrics, and logs every archon run reports\n.SH DESCRIPTION\n" +
    markdownToRoff(telemetryMarkdown()) +
    ".SH SEE ALSO\n\\fBarchon\\fR(1), \\fBarchon observe\\fR(1)\n";
}

export function personasPage(): string {
  const L = [th("archon-personas", 7, MAN_DATE).trimEnd()];
  L.push(".SH NAME", "archon\\-personas \\- composable user personas");
  L.push(
    ".SH DESCRIPTION",
    ".PP",
    inline(
      "Personas are defined in `src/archon/personas/mod.ts` and emitted as the SKOS concept scheme `scheme:personas`. A user's personas decide groups, sudo scope, and which dotfiles chezmoi applies. Personas compose: each implies the ones listed under IMPLIES.",
    ),
  );
  L.push(".SH PERSONAS");
  for (const p of Object.values(PERSONAS)) {
    L.push(".TP", `\\fB${p.id}\\fR (${esc(p.label)})`, inline(p.definition));
    L.push(
      ".RS",
      `IMPLIES: ${esc(p.implies.join(", ") || "nothing")}`,
      ".br",
      `GROUPS: ${esc(p.groups.join(", "))}`,
      ".br",
    );
    L.push(
      `FEATURES: ${
        esc(
          Object.entries(p.features).filter(([, v]) => v).map(([k]) => k).join(", ") || "none",
        )
      }`,
      ".RE",
    );
  }
  L.push(".SH SEE ALSO", "\\fBarchon\\fR(1), \\fBarchon\\-host\\-init\\fR(1), \\fBchezmoi\\fR(1)");
  return L.join("\n") + "\n";
}

export function renderManPages(): Map<string, string> {
  const pages = new Map<string, string>();
  pages.set("man1/archon.1", mainPage(COMMANDS));
  for (const c of COMMANDS) pages.set(`man1/${pageName(c)}.1`, commandPage(c));
  pages.set("man7/archon-constitution.7", constitutionPage());
  pages.set("man7/archon-personas.7", personasPage());
  pages.set("man7/archon-dotfiles.7", dotfilesPage());
  pages.set("man7/archon-pg.7", pgPage());
  pages.set("man7/archon-sql.7", sqlPage());
  pages.set("man7/archon-guide.7", guidePage());
  pages.set("man7/archon-telemetry.7", telemetryPage());
  return pages;
}

/** Spec 012: install man pages and completions on the host. */
export function docsFiles(): FileDef[] {
  const files: FileDef[] = [];
  const pages = renderManPages();
  for (const [rel, content] of pages) {
    files.push({
      path: `/usr/local/share/man/${rel}`,
      content,
      mode: "0644",
      owner: "root",
      spec: "012-cli-mcp",
      onChange: [{ kind: "run", argv: ["mandb", "-q"] }],
    });
  }
  files.push({
    path: "/usr/local/share/fish/vendor_completions.d/archon.fish",
    content: renderFishCompletions(COMMANDS),
    mode: "0644",
    owner: "root",
    spec: "012-cli-mcp",
  });
  return files;
}
