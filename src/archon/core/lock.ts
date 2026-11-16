/**
 * One archon run at a time per host (specs 012, 017), on IFC TypeScript's `lock`. The reconcile
 * timer applies every 15 minutes; without this it could apply, or fetch, in the middle of someone's
 * `archon update` or bootstrap. Children of a run that holds the lock (bootstrap and update
 * hand-offs, reconcile's apply) inherit it through `ARCHON_LOCK_HELD` instead of waiting for their
 * own parent. The lock file says who holds it: the command, and who started it (`ARCHON_AGENT`: the
 * reconcile timer, an agent over MCP, a terminal), so a waiting run can say what it waits for.
 *
 * @example
 * ```ts
 * import { hostLock } from "./lock.ts";
 * const held = await hostLock({ wait: false });
 * if (held === undefined) console.log("another archon run is in progress");
 * else held.release();
 * ```
 *
 * @module
 */
import { lock, proc } from "@intellectual-frontiers/ifc-ts/runtime";
import { onHost } from "./paths.ts";

/** The host lock file. */
export const LOCK_PATH = "/run/archon.lock";

/** The variable a run that holds the lock sets for its children. */
export const LOCK_HELD_ENV = "ARCHON_LOCK_HELD";

/** Who started a run, from `ARCHON_AGENT`, as a person reads it. */
export function agentOf(agent: string | undefined): string {
  switch (agent) {
    case "reconciler":
      return "the reconcile timer";
    case "timer":
      return "a timer";
    case "mcp":
      return "an agent over MCP";
    case undefined:
    case "":
      return "a terminal";
    default:
      return agent;
  }
}

/** What the lock file says this run is: `archon reconcile, the reconcile timer`. */
export function holderCommand(
  args: readonly string[] = proc.args,
  agent: string | undefined = proc.env.get("ARCHON_AGENT"),
): string {
  const command = args
    .filter((a) => !a.startsWith("-"))
    .slice(0, 3)
    .join(" ");
  return `archon${command === "" ? "" : ` ${command}`}, ${agentOf(agent)}`;
}

/**
 * Take the host lock. Undefined when `wait` is false and another run holds it; `onWait` is called
 * once, with the holder, when the lock is not free. Where the lock file cannot be made at all (not
 * root, no `/run`), there is nothing to coordinate with, and a lock that releases nothing is given.
 */
export async function hostLock(
  opts: { readonly wait: boolean; readonly onWait?: (holder: lock.Holder | undefined) => void },
  path: string = onHost(LOCK_PATH),
): Promise<lock.Held | undefined> {
  const options: lock.LockOptions = {
    wait: opts.wait,
    command: holderCommand(),
    inheritEnv: LOCK_HELD_ENV,
    ...(opts.onWait === undefined ? {} : { onWait: opts.onWait }),
  };
  try {
    return await lock.acquireLock(path, options);
  } catch {
    const holder: lock.Holder = {
      pid: proc.pid,
      command: options.command ?? "archon",
      since: new Date().toISOString(),
      token: "",
    };
    return { holder, release: () => {} };
  }
}
