/**
 * Spec 082: running in one client's scope. A scope is three environment
 * variables (ARCHON_REPO, ARCHON_FLEET, ARCHON_CLIENT): every path Stolos
 * resolves (`P`: the repository, the fleet, this PC's state, secrets, and key
 * store) follows them. `--client <id>` enters a scope for the whole run; the
 * provider's console and `clients summary` enter one client at a time with
 * `withClient`, which lets work for one client run only when no other
 * client's work is in progress, so two clients' paths are never live at once.
 *
 * @module
 */

import { proc } from "@intellectual-frontiers/ifc-ts/runtime";
import { resetRoots } from "../core/paths.ts";
import type { Client } from "./registry.ts";

/** The variables that make a scope. */
export const SCOPE_VARS = ["ARCHON_REPO", "ARCHON_FLEET", "ARCHON_CLIENT"] as const;

/** A client's scope, as environment variables (also for a command run in its checkout). */
export function clientEnv(c: Client): Record<(typeof SCOPE_VARS)[number], string> {
  return { ARCHON_REPO: c.path, ARCHON_FLEET: c.fleet, ARCHON_CLIENT: c.id };
}

/** Enter a client's scope for the rest of this process (undefined: leave every scope). */
export function enterClient(c: Client | undefined): void {
  for (const k of SCOPE_VARS) proc.env.delete(k);
  if (c) {
    for (const [k, v] of Object.entries(clientEnv(c))) proc.env.set(k, v);
  }
  resetRoots();
}

let current: string | undefined;
let holders = 0;
let saved: Record<string, string | undefined> = {};
let waiting: Array<() => void> = [];

/**
 * Run `fn` in client `c`'s scope. Work for the same client may overlap (a
 * page and the facts it reads); work for another client waits until none is
 * left. When the last holder leaves, the scope before it is restored.
 */
export async function withClient<T>(c: Client, fn: () => Promise<T>): Promise<T> {
  while (holders > 0 && current !== c.id) {
    await new Promise<void>((r) => waiting.push(r));
  }
  if (holders === 0) {
    saved = Object.fromEntries(SCOPE_VARS.map((k) => [k, proc.env.get(k)]));
    current = c.id;
    enterClient(c);
  }
  holders++;
  try {
    return await fn();
  } finally {
    holders--;
    if (holders === 0) {
      for (const k of SCOPE_VARS) {
        const v = saved[k];
        if (v === undefined) proc.env.delete(k);
        else proc.env.set(k, v);
      }
      resetRoots();
      current = undefined;
      const go = waiting;
      waiting = [];
      for (const r of go) r();
    }
  }
}

/** The client whose scope is live now (for tests), or undefined. */
export function activeClient(): string | undefined {
  return current;
}
