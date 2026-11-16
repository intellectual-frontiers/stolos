/**
 * The guides: each is the `@module` documentation of the module beside the
 * code it explains (so IFC Docs renders it, with its Mermaid diagrams, and it
 * changes in the same commit as the code). The build extracts each one into
 * the engine's assets as `docs/<name>.md`, so the man pages, the welcome page,
 * both consoles, `explain`, and `stolos docs` read the same text offline.
 *
 * ```mermaid
 * flowchart LR
 *   mod["src/archon/pg/mod.ts<br/>@module JSDoc: the guide"] --> pages["ifc-docs: the area's overview<br/>on GitHub Pages"]
 *   mod --> gen["bun run gen: assets.auto.ts<br/>docs/pg.md"]
 *   gen --> man["man pages"] & web["welcome page and consoles"] & cli["stolos docs pg"]
 *   mod --- code["src/archon/pg/*.ts: the code it explains"]
 * ```
 *
 * @module
 */

import { VERSION } from "../version.ts";

/** One guide: its name, its title, who reads it, and the module whose documentation it is. */
export interface GuideDef {
  /** Its name: `stolos docs <name>`, `/guide/<name>`, `docs/<name>.md` in the assets. */
  name: string;
  /** Its title. */
  title: string;
  /** What it is for, in one line. */
  why: string;
  /** The module (repository path) whose `@module` JSDoc is the guide. */
  module: string;
}

/** Every guide, in reading order. */
export const GUIDES: GuideDef[] = [
  {
    name: "guide",
    title: "Your Archon server: a guide for newcomers",
    why: "What is on a server, and how to use it.",
    module: "src/archon/guide/mod.ts",
  },
  {
    name: "fleet-repository",
    title: "The fleet repository",
    why: "Versions, upgrading, signing, troubleshooting.",
    module: "src/archon/fleet/mod.ts",
  },
  {
    name: "boot-machine",
    title: "The boot machine",
    why: "Tools, firewall, router, mail, the secrets vault.",
    module: "src/archon-boot/mod.ts",
  },
  {
    name: "hosts",
    title: "Hosts",
    why: "Adding, installing, re-installing, and retiring machines.",
    module: "src/archon/model/mod.ts",
  },
  {
    name: "install-timeline",
    title: "What happens during an install",
    why: "The eleven steps, and where to look when one fails.",
    module: "src/archon/install/mod.ts",
  },
  {
    name: "daily-use",
    title: "Working on a host",
    why: "Commands, observing, updates.",
    module: "src/archon/commands/mod.ts",
  },
  {
    name: "workstation",
    title: "Your PC's Ubuntu (WSL) as a workstation",
    why: "A managed workstation beside Windows.",
    module: "src/archon/install/workstation-guide.ts",
  },
  {
    name: "console",
    title: "The Stolos Console",
    why: "The fleet in your browser, on your PC.",
    module: "src/archon/console/mod.ts",
  },
  {
    name: "adopted",
    title: "Adopted machines, devices, and clouds",
    why: "Laptops, printers, and cloud accounts: observed, never changed.",
    module: "src/archon/adopt/mod.ts",
  },
  {
    name: "compliance",
    title: "Compliance",
    why: "SCF controls; SOC 2, HIPAA, PCI DSS, CMMC, NIST, and FedRAMP; OSCAL exports.",
    module: "src/archon/compliance/mod.ts",
  },
  {
    name: "controls",
    title: "Custom controls",
    why: "Your own controls in TypeScript: packs in the fleet repository, tested like code.",
    module: "src/archon/controls/mod.ts",
  },
  {
    name: "risks",
    title: "Risks and vendors",
    why: "The risk register and vendor inventory as code, reviewed through signed pull requests.",
    module: "src/archon/risk/mod.ts",
  },
  {
    name: "connectors",
    title: "The connector registry",
    why: "Add a connector Stolos does not ship, pinned and locked like the engine; write your own.",
    module: "src/archon/connect/registry-guide.ts",
  },
  {
    name: "people",
    title: "People controls",
    why: "Joiners and leavers, access reviews, policies, training, and screening, as code.",
    module: "src/archon/people/mod.ts",
  },
  {
    name: "evidence",
    title: "Evidence bundles",
    why: "A period's evidence, signed, for an auditor to check offline.",
    module: "src/archon/evidence/mod.ts",
  },
  {
    name: "trust",
    title: "Trust Center",
    why: "A status page for customers, built from a verified evidence bundle.",
    module: "src/archon/trust/mod.ts",
  },
  {
    name: "audit",
    title: "The auditor portal",
    why: "Engagements, populations, reproducible samples, verifiable evidence, an audit trail.",
    module: "src/archon/audit/mod.ts",
  },
  {
    name: "clients",
    title: "Clients: one PC, many client fleets",
    why: "For providers: setting up clients, what stays apart, what the summary shows.",
    module: "src/archon/clients/mod.ts",
  },
  {
    name: "web",
    title: "HTTPS on every server",
    why: "Publishing services, certificates, the Archon Console.",
    module: "src/archon/web/mod.ts",
  },
  {
    name: "proposals",
    title: "Proposals: changes made on a server",
    why: "A change made by hand on a server, signed and mailed, becomes a model change.",
    module: "src/archon/proposal/mod.ts",
  },
  {
    name: "telemetry",
    title: "Telemetry",
    why: "Where logs, metrics, and traces go.",
    module: "src/archon/telemetry/mod.ts",
  },
  {
    name: "agent",
    title: "The agent layer",
    why: "AI agents and other MCP clients, limited by each server.",
    module: "src/archon/mcp/mod.ts",
  },
  {
    name: "pg",
    title: "PostgreSQL databases",
    why: "Instances, connections, backups.",
    module: "src/archon/pg/mod.ts",
  },
  {
    name: "s3",
    title: "S3 object storage",
    why: "Buckets on a server.",
    module: "src/archon/s3/mod.ts",
  },
  {
    name: "smb",
    title: "File shares (SMB)",
    why: "Windows, macOS, and Linux file sharing.",
    module: "src/archon/smb/mod.ts",
  },
  {
    name: "sql",
    title: "SQL over your infrastructure",
    why: "osquery and DuckDB, on one machine or every one.",
    module: "src/archon/state/mod.ts",
  },
  {
    name: "dotfiles",
    title: "Dotfiles",
    why: "How they work, and how to change them.",
    module: "src/archon/dotfiles/mod.ts",
  },
  {
    name: "disaster-recovery",
    title: "Disaster recovery",
    why: "Losing the boot machine, a key, a server.",
    module: "src/archon/vault/mod.ts",
  },
  {
    name: "troubleshooting",
    title: "Troubleshooting",
    why: "Symptoms, causes, and fixes.",
    module: "src/archon/doctor/mod.ts",
  },
  {
    name: "releasing",
    title: "Changing and releasing the engine",
    why: "For the engine's own developers.",
    module: "src/releasing.ts",
  },
];

/** A guide by name. */
export function guideDef(name: string): GuideDef | undefined {
  return GUIDES.find((g) => g.name === name);
}

/** The engine's documentation online (GitHub Pages, spec 055). */
export const PAGES = "https://intellectual-frontiers.github.io/stolos/";

/**
 * The area of the documentation site a module opens (spec 070 FR-002): `docs.config.ts` makes each
 * guide's module the first entry point of the area of this name, so IFC Docs shows the guide as that
 * area's overview, at `api/<area>/index.html`. The name is the module's path under `src/` with `/`
 * as `-` and without `/mod.ts` or `.ts`; the overview module (`src/mod.ts`) opens `overview`.
 *
 * @example
 * ```ts
 * import { docsArea } from "./guides.ts";
 * const pg: string = docsArea("src/archon/pg/mod.ts"); // "archon-pg"
 * const boot: string = docsArea("src/archon-boot/mod.ts"); // "archon-boot"
 * const ws: string = docsArea("src/archon/install/workstation-guide.ts"); // "archon-install-workstation-guide"
 * ```
 */
export function docsArea(module: string): string {
  const rest = module
    .replace(/^src\//, "")
    .replace(/(^|\/)mod\.ts$/, "")
    .replace(/\.ts$/, "");
  return rest === "" ? "overview" : rest.replace(/\//g, "-");
}

/** A guide's page online, for this engine's version: its area's overview. */
export function guideUrl(name: string, version: string = VERSION): string {
  const g = guideDef(name);
  return g !== undefined
    ? `${PAGES}v${version}/api/${docsArea(g.module)}/index.html`
    : `${PAGES}v${version}/`;
}

/** How a message points to a guide: the command that shows it, here and offline. */
export function guideRef(name: string): string {
  return `bun run stolos docs ${name}`;
}

/**
 * A module's `@module` JSDoc as Markdown: its first doc comment, without the
 * leading ` * ` and the tags. `*\/` in it (which would end the comment) is
 * written escaped in the source and restored here.
 */
export function guideMarkdown(source: string): string {
  const doc = /\/\*\*([\s\S]*?)\*\//.exec(source)?.[1];
  if (doc === undefined || !/@module\b/.test(doc)) throw new Error("no @module documentation");
  const lines = doc.split("\n").map((l) => l.replace(/^\s*\* ?/, "").replace(/^\s*\*$/, ""));
  const body = lines.filter((l) => !/^@(module|example)\b/.test(l.trim())).join("\n");
  return body.replace(/\*\\\//g, "*/").trim() + "\n";
}

/** A guide's Markdown as a doc comment (the reverse of {@link guideMarkdown}). */
export function guideComment(markdown: string): string {
  const body = markdown
    .trim()
    .replace(/\*\//g, "*\\/")
    .split("\n")
    .map((l) => (l !== "" ? ` * ${l}` : " *"));
  return `/**\n${body.join("\n")}\n *\n * @module\n */\n`;
}
