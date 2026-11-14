/**
 * One archon run at a time per host (specs 012, 017). The reconcile timer
 * applies every 15 minutes; without this it could apply, or fetch, in the
 * middle of someone's `archon update` or bootstrap. Children of a run that
 * holds the lock (bootstrap and update hand-offs, reconcile's apply) inherit
 * it through ARCHON_LOCK_HELD instead of waiting for their own parent.
 *
 * @module
 */

/** The host lock file (an advisory lock; the holder's details sit beside it in `<path>.holder`). */
export const LOCK_PATH = "/run/archon.lock";

/** Who holds the lock (written by the holder, read by whoever waits). */
export interface Holder {
  /** The holder's process ID. */
  pid: number;
  /** The archon command it runs, without options ("reconcile", "update"). */
  command: string;
  /** ARCHON_AGENT: timer, reconciler, mcp, or the person's own terminal. */
  agent?: string;
  /** When it took the lock (ISO 8601). */
  since: string;
}

const holderPath = (lock: string) => `${lock}.holder`;

/** The current holder, if its process still runs. */
export async function readHolder(path = LOCK_PATH): Promise<Holder | undefined> {
  try {
    const h = JSON.parse(await Deno.readTextFile(holderPath(path))) as Holder;
    await Deno.stat(`/proc/${h.pid}`);
    return h;
  } catch {
    return undefined;
  }
}

/** "archon reconcile (pid 4242, the reconcile timer, running for 3m 12s)" */
export function describeHolder(h: Holder, now = Date.now()): string {
  const secs = Math.max(0, Math.round((now - Date.parse(h.since)) / 1000));
  const age = secs >= 60 ? `${Math.floor(secs / 60)}m ${secs % 60}s` : `${secs}s`;
  const who = h.agent === "reconciler"
    ? "the reconcile timer"
    : h.agent === "timer"
    ? "a timer"
    : h.agent === "mcp"
    ? "an agent over MCP"
    : h.agent
    ? h.agent
    : "a terminal";
  return `archon ${h.command} (pid ${h.pid}, ${who}, running for ${age})`;
}

/** A taken host lock. */
export interface Held {
  /** Release the lock (also clears ARCHON_LOCK_HELD); safe to call twice. */
  release(): void;
}

/**
 * Take the host lock. Returns undefined when `wait` is false and another run
 * holds it. `onWait` is called once if the lock is not free within a second.
 */
export async function hostLock(
  opts: { wait: boolean; onWait?: (holder?: Holder) => void },
  path = LOCK_PATH,
): Promise<Held | undefined> {
  if (Deno.env.get("ARCHON_LOCK_HELD") === "1") return { release() {} };
  let file: Deno.FsFile;
  try {
    file = await Deno.open(path, { read: true, write: true, create: true, mode: 0o600 });
  } catch {
    return { release() {} }; // not root, or no /run: nothing to coordinate with
  }
  const locked = file.lock(true).then(() => true);
  const first = await Promise.race([
    locked,
    new Promise<false>((r) => setTimeout(() => r(false), opts.wait ? 1000 : 150)),
  ]);
  if (!first) {
    if (!opts.wait) {
      file.close(); // the pending lock request ends with the descriptor
      return undefined;
    }
    opts.onWait?.(await readHolder(path));
    await locked;
  }
  Deno.env.set("ARCHON_LOCK_HELD", "1");
  try {
    const h: Holder = {
      pid: Deno.pid,
      command: Deno.args.filter((a) => !a.startsWith("-")).slice(0, 3).join(" ") || "archon",
      agent: Deno.env.get("ARCHON_AGENT"),
      since: new Date().toISOString(),
    };
    await Deno.writeTextFile(holderPath(path), JSON.stringify(h) + "\n", { mode: 0o644 });
  } catch { /* advisory only */ }
  return {
    release() {
      Deno.env.delete("ARCHON_LOCK_HELD");
      try {
        file.unlock();
        file.close();
      } catch { /* already closed */ }
    },
  };
}
