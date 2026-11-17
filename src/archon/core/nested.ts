/**
 * A run nested in another, in the same process (spec 106-one-passphrase-speed FR-006). `update`
 * runs `apply`, `keys` and the boot doctor as phases of its own run (spec 105-calm-output FR-005);
 * where the engine did not change they run here, not in a process of their own: no start-up, no
 * second load of the model, no second `git fetch`, and the passphrase stays in this process's
 * memory. The command line (a rung above) registers how a command is run; a command it cannot run
 * here (one that needs `sudo`, or one it does not know) is left to a child process.
 *
 * @module
 */
// Spec: 106-one-passphrase-speed FR-006

import type { RunSummary } from "./ui.ts";
import { ui } from "./ui.ts";

/** How the application runs a command here: its exit code, or undefined where it must be a child process. */
export type NestedRunner = (argv: readonly string[]) => Promise<number | undefined>;

let runner: NestedRunner | undefined;

/** The application tells where commands are run (once, at start-up). */
export function setNestedRunner(r: NestedRunner | undefined): void {
  runner = r;
}

/** What a nested run came to. */
export interface NestedResult {
  /** The exit code. */
  code: number;
  /** What it found, to be merged into the parent's phase. */
  summary: RunSummary;
}

/**
 * `stolos <argv>` as a phase of this run, in this process; undefined where this process cannot
 * (no runner registered, or the runner says the command needs a process of its own).
 */
export async function runNested(argv: readonly string[]): Promise<NestedResult | undefined> {
  const r = runner;
  if (!r) return undefined;
  let ran = false;
  const { value, summary } = await ui.nestedRun(async () => {
    const code = await r(argv);
    ran = code !== undefined;
    return code;
  });
  if (!ran || value === undefined) return undefined;
  ui.log(`   nested (in process): ${argv.join(" ")}`);
  return { code: value, summary };
}
