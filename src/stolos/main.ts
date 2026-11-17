/**
 * `stolos` (spec 059): the fleet's command, on your PC, in the fleet
 * repository (`bun run stolos ...`). Everything about the fleet as a whole:
 * creating it, keys and signers, adding and installing machines (`stolos boot
 * ...`, the boot server), backups, and keeping this checkout up to date. Each
 * machine has its own command, `archon`, for itself.
 *
 * ```mermaid
 * flowchart LR
 *   pc["your PC<br/>bun run stolos ..."] -->|"stolos apply (signed)"| gh["GitHub"]
 *   pc -->|"stolos boot serve:<br/>network installs"| m["each machine<br/>archon ..."]
 *   gh -->|"every 15 minutes"| m
 * ```
 *
 * @module
 */
// Spec: 059-stolos-and-archon
// Spec: 106-one-passphrase-speed FR-002, FR-006

import { proc } from "@intellectual-frontiers/commons/ts/runtime";
import { main, runCommandNested } from "../archon/main.ts";
import { setNestedRunner } from "../archon/core/nested.ts";
import { setLogProgram, ui } from "../archon/core/ui.ts";
import { wipePassphrases } from "../archon/core/passphrase.ts";

/**
 * The stolos CLI: `boot ...` is the boot server (its telemetry is IFC TypeScript's, started in
 * this process: spec 096); everything else is a fleet command.
 */
export async function stolosMain(argv: readonly string[]): Promise<number> {
  setLogProgram("stolos"); // logs and hints name stolos, on every system
  // Spec 106-one-passphrase-speed FR-006: a run nested in this one (update's apply, keys, boot
  // doctor) is run here, as a phase of it, where the engine has not changed.
  setNestedRunner(async (nested) => {
    const i = nested.findIndex((a) => !a.startsWith("-"));
    if (nested[i] === "boot") {
      const { bootNested } = await import("../archon-boot/main.ts");
      return await bootNested([...nested.slice(0, i), ...nested.slice(i + 1)]);
    }
    return await runCommandNested(nested, "pc");
  });
  const at = argv.findIndex((a) => !a.startsWith("-"));
  if (at >= 0 && argv[at] === "boot") {
    const { bootMain } = await import("../archon-boot/main.ts");
    return await bootMain([...argv.slice(0, at), ...argv.slice(at + 1)]);
  }
  return await main(argv, "pc");
}

/** Run as a program and exit: from this file, or from a fleet repository's stolos.ts. */
export async function run(argv: readonly string[] = proc.args): Promise<never> {
  const code = await stolosMain(argv);
  ui.printPanel(); // spec 029: a secret changed and is not backed up yet
  await wipePassphrases();
  return proc.exit(code);
}

if (import.meta.main) await run();
