/**
 * Spec 088: the registry probe. `stolos connector add` and `connector test`
 * run this module in a process of its own, with none of the environment but
 * the few variables the engine reads for its paths (so none of your
 * secrets), and no standard input: it imports the connector, reads its
 * declaration, runs its recorded-fixture tests, and prints one line,
 * `STOLOS-PROBE <json>`. The engine judges what it says (`registry.ts`).
 * Bun and Node give the process no permission sandbox: the connector's code
 * is read before it is added, as the engine's is.
 *
 * ```mermaid
 * sequenceDiagram
 *   participant S as stolos connector add
 *   participant P as probe (its own process, no secrets)
 *   S->>P: the module's path (fetched at its pin)
 *   P->>P: declare: id, labels, OCSF, SCF, fields; run fixtures (recorded answers)
 *   P-->>S: STOLOS-PROBE {declaration}
 *   S->>S: checks: id, labels, SCF ids, engine range, fixtures
 * ```
 *
 * @module
 */

import { path, proc, stdio } from "@intellectual-frontiers/commons/ts/runtime";
import { declare } from "./registry-contract.ts";

/** The line's prefix. */
export const PROBE_PREFIX = "STOLOS-PROBE ";

/** Import a module (a path or a file URL) and give its declaration line (or why it could not be read). */
export async function probe(module: string): Promise<string> {
  try {
    const url = /^[a-z]+:/.test(module) ? module : path.toFileUrl(path.resolve(module)).href;
    const mod: unknown = await import(url);
    const exports: Record<string, unknown> =
      typeof mod === "object" && mod !== null ? { ...mod } : {};
    return PROBE_PREFIX + JSON.stringify(await declare(exports));
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return PROBE_PREFIX + JSON.stringify({ error: message.split("\n")[0] });
  }
}

if (import.meta.main) stdio.stdout.writeSync(`${await probe(proc.args[0] ?? "")}\n`);
