/**
 * `stolos docs [name]` and `archon docs [name]`: the engine's guides, offline
 * and at this engine's version. Without a name, every guide with its page
 * online; with one, the guide itself (its diagrams are drawn online).
 *
 * @module
 */

import { stdio } from "@intellectual-frontiers/system";
import { engineFileOr } from "../core/assets.ts";
import { guideDef, GUIDES, guideUrl } from "../core/guides.ts";
import { ui } from "../core/ui.ts";

/** Print a guide, or the list of them. */
export function docsCommand(name?: string, json = false): number {
  if (!name) {
    if (json) {
      stdio.stdout.writeSync(
        `${JSON.stringify(
          GUIDES.map((g) => ({ ...g, url: guideUrl(g.name) })),
          null,
          2,
        )}\n`,
      );
      return 0;
    }
    const w = Math.max(...GUIDES.map((g) => g.name.length));
    for (const g of GUIDES) stdio.stdout.writeSync(`  ${g.name.padEnd(w)}  ${g.title}: ${g.why}\n`);
    stdio.stdout.writeSync(
      `\n  Read one: docs <name>. Online, with diagrams: ${guideUrl("guide").replace(
        /archon\/guide.*$/,
        "",
      )}\n`,
    );
    return 0;
  }
  const g = guideDef(name);
  const md = g ? engineFileOr(`docs/${g.name}.md`) : undefined;
  if (!g || !md) {
    ui.phase("Docs").fail(`no guide ${name}`, `one of: ${GUIDES.map((x) => x.name).join(", ")}`);
    return 1;
  }
  // Diagrams are Mermaid: in a terminal, say where they are drawn instead of printing their source.
  const text = md.replace(/```mermaid\n[\s\S]*?```/g, `(a diagram: ${guideUrl(g.name)})`);
  if (json)
    stdio.stdout.writeSync(
      `${JSON.stringify({ ...g, url: guideUrl(g.name), markdown: md }, null, 2)}\n`,
    );
  else stdio.stdout.writeSync(`${text}\n`);
  return 0;
}
