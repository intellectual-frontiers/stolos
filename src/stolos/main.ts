/**
 * `stolos` (spec 059): the fleet's command, on your PC, in the fleet
 * repository (`deno task stolos ...`). Everything about the fleet as a whole:
 * creating it, keys and signers, adding and installing machines (`stolos boot
 * ...`, the boot server), backups, and keeping this checkout up to date. Each
 * machine has its own command, `archon`, for itself.
 *
 * ```mermaid
 * flowchart LR
 *   pc["your PC<br/>deno task stolos ..."] -->|"git push (signed)"| gh["GitHub"]
 *   pc -->|"stolos boot serve:<br/>network installs"| m["each machine<br/>archon ..."]
 *   gh -->|"every 15 minutes"| m
 * ```
 *
 * @module
 */

import { main } from "../archon/main.ts";
import { setLogProgram, ui } from "../archon/core/ui.ts";
import { exists } from "../archon/core/fsx.ts";

/** The boot server's telemetry settings (spec 023): set for `stolos boot ...` only. */
export const BOOT_OTEL: Record<string, string> = {
  OTEL_DENO: "true",
  OTEL_SERVICE_NAME: "stolos-boot",
  OTEL_EXPORTER_OTLP_PROTOCOL: "http/json",
  OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:4319",
};

/**
 * `stolos boot ...` runs again in a process with the boot server's telemetry
 * on (Deno reads it at start); every other command runs without it.
 */
async function bootAgain(argv: string[]): Promise<number> {
  const frozen = (await exists("deno.lock")) && (await exists("deno.json"));
  const r = await new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", ...(frozen ? ["--frozen"] : []), Deno.mainModule, ...argv],
    env: BOOT_OTEL,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  }).output();
  return r.code;
}

/** The stolos CLI: `boot ...` is the boot server; everything else is a fleet command. */
export async function stolosMain(argv: string[]): Promise<number> {
  setLogProgram("stolos"); // logs and hints name stolos, on every system
  const at = argv.findIndex((a) => !a.startsWith("-"));
  if (argv[at] === "boot") {
    if (Deno.env.get("OTEL_DENO") !== "true") return await bootAgain(argv);
    const { bootMain } = await import("../archon-boot/main.ts");
    return await bootMain([...argv.slice(0, at), ...argv.slice(at + 1)]);
  }
  return await main(argv, "pc");
}

/** Run as a program and exit: from this file, or from a fleet repository's stolos.ts. */
export async function run(argv: string[] = Deno.args): Promise<never> {
  const code = await stolosMain(argv);
  ui.printPanel(); // spec 029: a secret changed and is not backed up yet
  Deno.exit(code);
}

if (import.meta.main) await run();
