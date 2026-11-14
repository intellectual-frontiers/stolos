/**
 * `stolos fleet use <id>`: which fleet of this repository every `archon`
 * command in this checkout is for, remembered in `.git/stolos/fleet` (never
 * committed, so each checkout chooses its own). It takes effect at once, in
 * every terminal, on every system: no environment variable to set and no new
 * window to open. `--fleet <id>` (or ARCHON_FLEET) still wins for one command.
 *
 * @module
 */

import { join } from "../core/path.ts";
import { exists, readTextOr } from "../core/fsx.ts";
import { fleetChoiceFile, listFleets, P, resetRoots } from "../core/paths.ts";
import { ui } from "../core/ui.ts";

/** Remember `id` as this checkout's fleet; "same" when it already was. */
export async function chooseFleet(
  id: string,
  repo = P.repo,
): Promise<"chosen" | "same" | "no-git"> {
  if (!(await exists(join(repo, ".git")))) return "no-git";
  const file = fleetChoiceFile(repo);
  if ((await readTextOr(file))?.trim() === id) return "same";
  await Deno.mkdir(join(file, ".."), { recursive: true });
  await Deno.writeTextFile(file, id + "\n");
  resetRoots();
  return "chosen";
}

/** `stolos fleet use <id>`: check the fleet exists here, then remember it. */
export async function fleetUse(id: string): Promise<number> {
  const all = listFleets(P.repo);
  if (!all.includes(id)) {
    console.error(
      `no fleet ${id} in ${P.repo} (here: ${
        all.join(", ") || "none"
      }); to create it: deno task stolos fleet init ${id}`,
    );
    return 1;
  }
  const r = await chooseFleet(id);
  if (r === "no-git") {
    console.error(`${P.repo} is not a Git checkout: set ARCHON_FLEET=${id} instead`);
    return 1;
  }
  const env = Deno.env.get("ARCHON_FLEET");
  console.log(
    `${ui.emoji ? "✅ " : ""}${
      r === "same" ? "already using" : "now using"
    } fleet ${id} for every archon command in ${P.repo}`,
  );
  if (env && env.trim() !== id) {
    console.log(
      `   but ARCHON_FLEET=${env} is set in this terminal and wins: remove it, or open a terminal without it`,
    );
  }
  console.log("next: deno task stolos");
  return 0;
}
