/**
 * Spec 088: the registry probe. `stolos connector add` and `connector test`
 * run this module in its own Deno process, with no network but the
 * connector's own host (for its imports), no files, and only the few
 * environment variables the engine reads for its paths: it imports the
 * connector, reads its declaration, runs its recorded-fixture tests, and
 * prints one line, `STOLOS-PROBE <json>`. The engine judges what it says
 * (`registry.ts`); nothing the connector does here can reach the vault, the
 * fleet repository, or the network.
 *
 * ```mermaid
 * sequenceDiagram
 *   participant S as stolos connector add
 *   participant P as probe (deno run, restricted)
 *   participant H as the connector's host
 *   S->>P: the module's pinned URL
 *   P->>H: import (allow-import: that host only)
 *   P->>P: declare: id, labels, OCSF, SCF, fields; run fixtures (recorded answers)
 *   P-->>S: STOLOS-PROBE {declaration}
 *   S->>S: checks: id, labels, SCF ids, engine range, fixtures
 * ```
 *
 * @module
 */

import { declare } from "./registry-contract.ts";

/** The line's prefix. */
export const PROBE_PREFIX = "STOLOS-PROBE ";

/** Import a module and print its declaration (or why it could not be read). */
export async function probe(url: string): Promise<string> {
  try {
    const mod = await import(url) as Record<string, unknown>;
    return PROBE_PREFIX + JSON.stringify(await declare(mod));
  } catch (e) {
    return PROBE_PREFIX + JSON.stringify({ error: (e as Error).message.split("\n")[0] });
  }
}

if (import.meta.main) console.log(await probe(Deno.args[0]));
