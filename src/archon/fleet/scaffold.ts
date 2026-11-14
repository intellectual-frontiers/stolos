/**
 * A new fleet repository's files (spec 046-engine-instance): what `archon
 * fleet init <id>` writes into a repository that has none of them yet. Each
 * file is written only when missing; an existing one is never changed.
 *
 * @module
 */

import { bootstrapFiles, repoSlug } from "./bootstrap.ts";
import { join } from "../core/path.ts";
import { exists } from "../core/fsx.ts";
import { ENGINE_ENTRY, ENGINE_ENTRY_TEXT } from "./upgrade.ts";

/** Where released engines are served from; the tag is appended. */
export const ENGINE_BASE = "https://raw.githubusercontent.com/intellectual-frontiers/stolos/";

/** A fleet repository's deno.json: the engine pinned at tag, and the stolos task (run frozen; spec 059). */
export function denoJsonText(tag: string, base = ENGINE_BASE): string {
  return JSON.stringify(
    {
      imports: { "@stolos/": `${base}${tag}/src/` },
      tasks: {
        stolos: "deno run -A --frozen stolos.ts",
      },
      compilerOptions: { strict: true },
      fmt: { lineWidth: 100, exclude: ["out/"] },
      lint: { exclude: ["out/"] },
    },
    null,
    2,
  ) + "\n";
}

/** A fleet repository's archon.ts: each machine's archon, from the pinned engine. */
export const ARCHON_ENTRY_TEXT =
  `// Each machine's \`archon\` command: the engine pinned in deno.json (\`@stolos/\`),
// checked against deno.lock. Servers and workstations run this file from
// /srv/archon through /usr/local/bin/archon. On your PC, use \`deno task stolos\`.
import { run } from "@stolos/archon/main.ts";

await run();
`;

/** A fleet repository's stolos.ts: the fleet's command on your PC (spec 059). */
export const STOLOS_ENTRY_TEXT =
  `// The fleet's command on your PC: \`deno task stolos ...\` (with no arguments: where
// you are, and what to do next). The engine pinned in deno.json (\`@stolos/\`),
// checked against deno.lock.
import { run } from "@stolos/stolos/main.ts";

await run();
`;

/** A fleet repository's .gitignore. */
export const GITIGNORE_TEXT = `# Rendered by stolos build on each machine; never committed.
out/
*.log
`;

/**
 * VS Code for a fleet repository: Deno for TypeScript (checks, lint; the engine's
 * files downloaded when a file that imports them is saved) and as the
 * formatter, on save, for everything deno fmt formats (TypeScript, JavaScript,
 * JSON, Markdown, YAML, CSS, HTML), with the fleet's deno.json settings.
 */
export const VSCODE_SETTINGS_TEXT: string = JSON.stringify(
  {
    "deno.enable": true,
    "deno.lint": true,
    // Saving a file downloads what it imports (the engine's types, for fleet.ts).
    "deno.cacheOnSave": true,
    "editor.formatOnSave": true,
    "editor.defaultFormatter": "denoland.vscode-deno",
    ...Object.fromEntries(
      [
        "typescript",
        "typescriptreact",
        "javascript",
        "javascriptreact",
        "json",
        "jsonc",
        "markdown",
        "yaml",
        "css",
        "scss",
        "less",
        "html",
      ]
        .map((l) => [`[${l}]`, { "editor.defaultFormatter": "denoland.vscode-deno" }]),
    ),
    "files.eol": "\n",
    "files.insertFinalNewline": true,
    "files.trimFinalNewlines": true,
    "files.trimTrailingWhitespace": true,
  },
  null,
  2,
) + "\n";

/** VS Code's suggested extensions: Deno, Mermaid in Markdown previews, GitHub Actions, YAML. */
export const VSCODE_EXTENSIONS_TEXT =
  '{\n  "recommendations": [\n    "denoland.vscode-deno",\n    "bierner.markdown-mermaid",\n    "github.vscode-github-actions",\n    "redhat.vscode-yaml"\n  ],\n  "unwantedRecommendations": [\n    "esbenp.prettier-vscode",\n    "dbaeumer.vscode-eslint"\n  ]\n}\n';

/**
 * Line endings Git keeps whatever the PC (spec 062): every text file LF, as
 * stolos and deno fmt write them. Git for Windows would otherwise check files
 * out with CRLF: a shell script would not run on Linux or macOS, and a file in
 * stolos's fixed form (signers.ts, registration.ts) would not read back as it.
 */
export const GITATTRIBUTES_TEXT =
  `# Written by stolos (spec 062): every text file keeps LF on every system, as stolos
# and deno fmt write them (Git for Windows would otherwise check them out with CRLF).
* text=auto eol=lf
`;

/** The files of a fleet repository, by path relative to its root; `slug` is its GitHub owner/name. */
export function scaffoldFiles(tag: string, base = ENGINE_BASE, slug = ""): Record<string, string> {
  return {
    ...bootstrapFiles(slug),
    ".gitattributes": GITATTRIBUTES_TEXT,
    "deno.json": denoJsonText(tag, base),
    "archon.ts": ARCHON_ENTRY_TEXT,
    "stolos.ts": STOLOS_ENTRY_TEXT,
    [ENGINE_ENTRY]: ENGINE_ENTRY_TEXT,
    ".gitignore": GITIGNORE_TEXT,
    ".vscode/settings.json": VSCODE_SETTINGS_TEXT,
    ".vscode/extensions.json": VSCODE_EXTENSIONS_TEXT,
  };
}

/** Write the missing ones; returns the paths written. */
export async function scaffoldRepository(
  repo: string,
  tag: string,
  base = ENGINE_BASE,
): Promise<string[]> {
  const written: string[] = [];
  const slug = await repoSlug(repo);
  for (const [rel, text] of Object.entries(scaffoldFiles(tag, base, slug))) {
    const p = join(repo, rel);
    if (await exists(p)) continue;
    await Deno.mkdir(join(p, ".."), { recursive: true });
    await Deno.writeTextFile(p, text);
    if (rel.endsWith(".sh") && Deno.build.os !== "windows") await Deno.chmod(p, 0o755);
    written.push(rel);
  }
  return written;
}

/**
 * Download every engine file the pin names, checked against deno.lock, into
 * Deno's cache: what VS Code's Deno extension reads to check fleet.ts. Running
 * a command downloads only what it runs; a type-only import (fleet.ts imports
 * the engine's types) would otherwise never be fetched. Returns why not, if not.
 */
export async function cacheEngine(repo: string): Promise<{ ok: boolean; why?: string }> {
  if (!(await exists(join(repo, "deno.lock")))) return { ok: true }; // an engine checkout
  const entries: string[] = [];
  for (const f of ["archon.ts", "stolos.ts", ENGINE_ENTRY]) {
    if (await exists(join(repo, f))) entries.push(f);
  }
  const r = await new Deno.Command(Deno.execPath(), {
    args: ["cache", "--frozen", "--allow-import", ...entries],
    cwd: repo,
    stdout: "piped",
    stderr: "piped",
  }).output();
  const err = new TextDecoder().decode(r.stderr).trim().split("\n").pop() ?? "";
  return r.success ? { ok: true } : { ok: false, why: err };
}
