/**
 * A new fleet repository's files (spec 046-engine-instance): what `archon
 * fleet init <id>` writes into a repository that has none of them yet. Each
 * file is written only when missing; an existing one is never changed.
 *
 * @module
 */

import { fs, path as paths, proc } from "@intellectual-frontiers/ifc-ts/runtime";
import type { RunResult } from "../core/exec.ts";
import { bootstrapFiles, repoSlug } from "./bootstrap.ts";
import { ENGINE_PACKAGE, ENGINE_RELEASES, tarballUrl } from "./upgrade.ts";
import { installDependencies } from "../install/bun.ts";
import { IMPACT_WORKFLOW_PATH, IMPACT_WORKFLOW_TEXT } from "../compliance/workflow.ts";

/**
 * A fleet repository's package.json (spec 096 FR-006): the engine pinned by its release's tarball
 * (bun.lock holds its integrity), and the commands `bun run stolos ...` and `bun run archon ...`.
 */
export function packageJsonText(tag: string, base: string = ENGINE_RELEASES): string {
  return (
    JSON.stringify(
      {
        name: "fleet",
        private: true,
        type: "module",
        scripts: { stolos: "bun stolos.ts", archon: "bun archon.ts" },
        dependencies: { [ENGINE_PACKAGE]: tarballUrl(tag, base) },
      },
      null,
      2,
    ) + "\n"
  );
}

/** A fleet repository's archon.ts: each machine's archon, from the pinned engine. */
export const ARCHON_ENTRY_TEXT = `// Each machine's \`archon\` command: the engine package.json pins, as bun.lock holds it.
// Servers and workstations run this file from /srv/archon through /usr/local/bin/archon
// (Bun, or Node where Bun is not installed). On your PC, use \`bun run stolos\`.
import { run } from "${ENGINE_PACKAGE}/archon/main";

await run();
`;

/** A fleet repository's stolos.ts: the fleet's command on your PC (spec 059). */
export const STOLOS_ENTRY_TEXT = `// The fleet's command on your PC: \`bun run stolos ...\` (with no arguments: where
// you are, and what to do next). The engine package.json pins, as bun.lock holds it.
import { run } from "${ENGINE_PACKAGE}/stolos/main";

await run();
`;

/** A fleet repository's .gitignore. */
export const GITIGNORE_TEXT = `# Rendered by stolos build on each machine; never committed.
out/
*.log
# The engine, installed from package.json and bun.lock (bun install --frozen-lockfile).
node_modules/
`;

/**
 * VS Code for a fleet repository: its own TypeScript checks the fleet's files against the installed
 * engine's types (node_modules); every text file LF, ending with one newline.
 */
export const VSCODE_SETTINGS_TEXT: string =
  JSON.stringify(
    {
      "files.eol": "\n",
      "files.insertFinalNewline": true,
      "files.trimFinalNewlines": true,
      "files.trimTrailingWhitespace": true,
      "files.exclude": { "node_modules/": true },
    },
    null,
    2,
  ) + "\n";

/** VS Code's suggested extensions: Mermaid in Markdown previews, GitHub Actions, YAML. */
export const VSCODE_EXTENSIONS_TEXT =
  '{\n  "recommendations": [\n    "bierner.markdown-mermaid",\n    "github.vscode-github-actions",\n    "redhat.vscode-yaml"\n  ],\n  "unwantedRecommendations": [\n    "esbenp.prettier-vscode",\n    "dbaeumer.vscode-eslint"\n  ]\n}\n';

/**
 * Line endings Git keeps whatever the PC (spec 062): every text file LF, as
 * stolos and bun fmt write them. Git for Windows would otherwise check files
 * out with CRLF: a shell script would not run on Linux or macOS, and a file in
 * stolos's fixed form (signers.ts, registration.ts) would not read back as it.
 */
export const GITATTRIBUTES_TEXT = `# Written by stolos (spec 062): every text file keeps LF on every system, as stolos
# and bun fmt write them (Git for Windows would otherwise check them out with CRLF).
* text=auto eol=lf
`;

/**
 * The files of a fleet repository, by path relative to its root; `slug` is its GitHub owner/name.
 * `bun.lock` is not among them: `bun install` writes it (scaffoldRepository's caller runs it).
 */
export function scaffoldFiles(
  tag: string,
  base: string = ENGINE_RELEASES,
  slug = "",
): Record<string, string> {
  return {
    ...bootstrapFiles(slug),
    ".gitattributes": GITATTRIBUTES_TEXT,
    "package.json": packageJsonText(tag, base),
    "archon.ts": ARCHON_ENTRY_TEXT,
    "stolos.ts": STOLOS_ENTRY_TEXT,
    ".gitignore": GITIGNORE_TEXT,
    ".vscode/settings.json": VSCODE_SETTINGS_TEXT,
    ".vscode/extensions.json": VSCODE_EXTENSIONS_TEXT,
    // Spec 074: each pull request's compliance impact, as one comment; the gate as a check.
    [IMPACT_WORKFLOW_PATH]: IMPACT_WORKFLOW_TEXT,
  };
}

/** Write the missing ones; returns the paths written. */
export async function scaffoldRepository(
  repo: string,
  tag: string,
  base: string = ENGINE_RELEASES,
): Promise<string[]> {
  const written: string[] = [];
  const slug = await repoSlug(repo);
  for (const [rel, text] of Object.entries(scaffoldFiles(tag, base, slug))) {
    const p = paths.join(repo, rel);
    if (await fs.exists(p)) continue;
    await fs.mkdir(paths.join(p, ".."), { recursive: true });
    await fs.writeTextFile(p, text);
    if (rel.endsWith(".sh") && proc.build.os !== "windows") await fs.chmod(p, 0o755);
    written.push(rel);
  }
  return written;
}

/**
 * Install the engine the checkout pins, exactly as bun.lock holds it (`bun install
 * --frozen-lockfile`): what runs `bun run stolos`, and what VS Code reads to check fleet.ts.
 * Returns why not, if not (an integrity error is E046-LOCK-INTEGRITY).
 */
export async function installEngine(repo: string): Promise<{ ok: boolean; why?: string }> {
  if (!(await fs.exists(paths.join(repo, "package.json")))) return { ok: true }; // not a fleet repository
  const r: RunResult = await installDependencies(repo);
  const why = r.stderr.trim().split("\n").pop() ?? `exit ${r.code}`;
  return r.ok ? { ok: true } : { ok: false, why };
}
