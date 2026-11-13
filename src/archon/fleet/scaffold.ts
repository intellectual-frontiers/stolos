// A new fleet repository's files (spec 046-engine-instance): what `archon
// fleet init <id>` writes into a repository that has none of them yet. Each
// file is written only when missing; an existing one is never changed.

import { join } from "../core/path.ts";
import { exists } from "../core/fsx.ts";
import { ENGINE_ENTRY, ENGINE_ENTRY_TEXT } from "./upgrade.ts";

/** Where released engines are served from; the tag is appended. */
export const ENGINE_BASE = "https://raw.githubusercontent.com/intellectual-frontiers/stolos/";

export function denoJsonText(tag: string, base = ENGINE_BASE): string {
  return JSON.stringify(
    {
      imports: { "@stolos/": `${base}${tag}/src/` },
      tasks: {
        archon: "deno run -A --frozen archon.ts",
        boot:
          "OTEL_DENO=true OTEL_SERVICE_NAME=archon-boot OTEL_EXPORTER_OTLP_PROTOCOL=http/json OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4319 deno run -A --frozen boot.ts",
      },
      compilerOptions: { strict: true },
      fmt: { lineWidth: 100, exclude: ["out/"] },
      lint: { exclude: ["out/"] },
    },
    null,
    2,
  ) + "\n";
}

export const ARCHON_ENTRY_TEXT =
  `// The \`archon\` command for this repository's fleets: runs the engine pinned in
// deno.json (\`@stolos/\`), checked against deno.lock. Hosts run this file from
// /srv/archon through /usr/local/bin/archon.
import { run } from "@stolos/archon/main.ts";

await run();
`;

export const BOOT_ENTRY_TEXT =
  `// The boot server for this repository's fleets (\`deno task boot serve --fleet <id>\`),
// from the engine pinned in deno.json (\`@stolos/\`).
import { run } from "@stolos/archon-boot/main.ts";

await run();
`;

export const GITIGNORE_TEXT = `# Rendered by archon build on each machine; never committed.
out/
*.log
`;

/** The files of a fleet repository, by path relative to its root. */
export function scaffoldFiles(tag: string, base = ENGINE_BASE): Record<string, string> {
  return {
    "deno.json": denoJsonText(tag, base),
    "archon.ts": ARCHON_ENTRY_TEXT,
    "boot.ts": BOOT_ENTRY_TEXT,
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
