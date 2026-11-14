/**
 * A new fleet repository's files (spec 046-engine-instance): what `archon
 * fleet init <id>` writes into a repository that has none of them yet. Each
 * file is written only when missing; an existing one is never changed.
 *
 * @module
 */

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

/** The files of a fleet repository, by path relative to its root. */
export function scaffoldFiles(tag: string, base = ENGINE_BASE): Record<string, string> {
  return {
    "deno.json": denoJsonText(tag, base),
    "archon.ts": ARCHON_ENTRY_TEXT,
    "stolos.ts": STOLOS_ENTRY_TEXT,
    [ENGINE_ENTRY]: ENGINE_ENTRY_TEXT,
    ".gitignore": GITIGNORE_TEXT,
  };
}

/** Write the missing ones; returns the paths written. */
export async function scaffoldRepository(
  repo: string,
  tag: string,
  base = ENGINE_BASE,
): Promise<string[]> {
  const written: string[] = [];
  for (const [rel, text] of Object.entries(scaffoldFiles(tag, base))) {
    const p = join(repo, rel);
    if (await exists(p)) continue;
    await Deno.writeTextFile(p, text);
    written.push(rel);
  }
  return written;
}
