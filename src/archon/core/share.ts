/**
 * The shared checkout (specs 001, 016): /srv/archon belongs to its owner
 * (ops) and the archon-ops group, group-writable, so every operator can run
 * archon and git there. Files a command writes (state/, out/, prov) must stay
 * that way: as root they would otherwise be root-owned and read-only to the
 * group, and a later `archon capture` as yourself fails with EACCES.
 *
 * @module
 */

import { P } from "./paths.ts";
import { currentUser, isRoot, run } from "./exec.ts";

/** Give back to the checkout's owner and group whatever this run created. */
export async function shareCheckout(repo = P.repo): Promise<void> {
  const st = await run(["stat", "-c", "%U:%G", repo]);
  if (!st.ok) return;
  const [owner, group] = st.stdout.trim().split(":");
  const me = isRoot() ? "root" : currentUser();
  if (!me || (me !== "root" && me !== owner && !(await inGroup(group)))) return;
  if (me === "root" && owner !== "root") {
    await run([
      "find",
      repo,
      "-xdev",
      "-user",
      "root",
      "-exec",
      "chown",
      "-h",
      `${owner}:${group}`,
      "{}",
      "+",
    ]);
  }
  // Only files this account may change: its own (all of them, as root).
  const mine = me === "root" ? [] : ["-user", me];
  await run([
    "find",
    repo,
    "-xdev",
    ...mine,
    "!",
    "-type",
    "l",
    "!",
    "-perm",
    "-g+w",
    "-exec",
    "chmod",
    "g+w",
    "{}",
    "+",
  ]);
}

async function inGroup(group: string): Promise<boolean> {
  return (await run(["id", "-nG"])).stdout.trim().split(/\s+/).includes(group);
}
