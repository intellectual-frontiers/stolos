/**
 * Spec 063: before a machine is armed, check that what it will run is there.
 * A new server clones the fleet's branch from GitHub at its first boot and
 * runs it only when the tip is signed by one of the fleet's signers (spec
 * 047), and it needs its own model (`fleets/<fleet>/hosts/<host>/host.ts`) in
 * that commit. Either one missing used to surface only after a full install,
 * as "the repository tip is not signed by a fleet signer: nothing was run".
 * `boot arm` refuses, and `boot serve` warns, before anything boots, each with
 * the fix (`deno task stolos apply`).
 *
 * ```mermaid
 * flowchart LR
 *   fetch["git fetch origin &lt;branch&gt;"] --> sig{"tip signed by<br/>a fleet signer?"}
 *   sig -- no --> fix1["stolos apply<br/>(a signed commit on top)"]
 *   sig -- yes --> model{"host.ts in<br/>that commit?"}
 *   model -- no --> fix2["stolos apply -m '004-install: add host'"]
 *   model -- yes --> ok["arm"]
 * ```
 *
 * @module
 */

import { join, relative } from "../core/path.ts";
import { run } from "../core/exec.ts";
import { P } from "../core/paths.ts";

/** One reason a new server could not run the fleet's branch, with its fix. */
export interface RunnableProblem {
  /** What is wrong, in plain words. */
  what: string;
  /** The command that fixes it. */
  fix: string;
  /** For `stolos explain`. */
  code: "E063-TIP-UNSIGNED" | "E063-HOST-NOT-PUSHED";
}

/** What a new server would find on the fleet's branch. */
export interface Runnable {
  /** The branch's tip, as checked (absent when it could not be read at all). */
  tip?: string;
  /** Who signed it, when a fleet signer did. */
  signer?: string;
  /** Why GitHub could not be asked (the last known tip was checked instead, if any). */
  unreachable?: string;
  /** Empty: a server installed now would run it. */
  problems: RunnableProblem[];
}

/**
 * Check the fleet's branch as a server would see it for `hosts`. Asks GitHub
 * (`git fetch`); offline, it checks the last fetched tip, and says so. A fleet
 * not on GitHub (the end-to-end lab) is not checked.
 */
export async function checkRunnable(hosts: string[], repo = P.repo): Promise<Runnable> {
  const { loadFleet } = await import("../model/load.ts");
  const { onGitHub } = await import("../render/autoinstall.ts");
  const fleet = await loadFleet();
  if (!onGitHub(fleet)) return { problems: [] };
  const branch = fleet.repository.branch ?? "main";
  const git = (args: string[]) => run(["git", "-C", repo, ...args]);
  const out: Runnable = { problems: [] };
  const f = await git(["fetch", "-q", "origin", branch]);
  if (!f.ok) out.unreachable = f.stderr.trim().split("\n").pop() || "git fetch failed";
  const tip = (await git(["rev-parse", "-q", "--verify", `refs/remotes/origin/${branch}`])).stdout
    .trim();
  if (!tip) return out;
  out.tip = tip;
  const short = tip.slice(0, 10);

  // Signed by a fleet signer, as servers check it (spec 047).
  const { allowedSignersText, checkTip, loadSigners } = await import("../identity/signers.ts");
  const dir = await Deno.makeTempDir({ prefix: "stolos-runnable-" });
  try {
    const allowed = join(dir, "allowed_signers");
    await Deno.writeTextFile(allowed, allowedSignersText(await loadSigners()));
    const t = await checkTip(repo, tip, "", allowed);
    if (t.ok) out.signer = t.signer;
    else {
      out.problems.push({
        what: `GitHub's ${branch} (${short}) is not signed by a fleet signer (${
          t.reason ?? t.code
        }): a server installed now would refuse to run it`,
        fix: `deno task stolos apply (one commit, signed by your key, on top), then arm again`,
        code: "E063-TIP-UNSIGNED",
      });
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }

  // Each host's own model, in that commit.
  for (const h of hosts) {
    const rel = relative(repo, join(P.hosts, h, "host.ts")).replace(/\\/g, "/");
    if (!(await git(["cat-file", "-e", `${tip}:${rel}`])).ok) {
      out.problems.push({
        what:
          `${h}'s model (${rel}) is not on GitHub's ${branch} yet: its first boot would find no ${h}`,
        fix: `deno task stolos apply -m "004-install: add host ${h}", then arm again`,
        code: "E063-HOST-NOT-PUSHED",
      });
    }
  }
  return out;
}
