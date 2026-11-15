/**
 * Spec 065: who is signed in to the console, and what they may do.
 *
 * - A session is a random id in an HttpOnly, Secure, SameSite=Strict cookie,
 *   held in memory (a restart signs everyone out), ended after 8 idle hours.
 * - The accounts are the server's own (PAM): people with a home under the
 *   normal user range. root and ops (Archon's service account) never sign in
 *   here, as Cockpit refuses root.
 * - Roles: an operator (in `sudo` or `archon-ops`) may run commands that
 *   change the server; everyone else may look. Destroying data also needs the
 *   password again and the command's typed confirmation.
 * - Five failed sign-ins in a minute from one address pause that address.
 *
 * @module
 */

import { run } from "../core/exec.ts";
import type { Tier } from "../core/registry-types.ts";

/** What a signed-in person may do. */
export type Role = "viewer" | "operator";

/** One signed-in person. */
export interface Session {
  /** The cookie's value (random, 32 bytes). */
  id: string;
  /** Their username. */
  user: string;
  /** Their full name, from the account (GECOS), else the username. */
  name: string;
  /** Their groups. */
  groups: string[];
  /** What they may do. */
  role: Role;
  /** When they signed in (ms). */
  created: number;
  /** When they last did anything (ms). */
  seen: number;
  /** Where they signed in from. */
  from: string;
}

/** How long an idle session lasts (8 hours). */
export const IDLE_MS = 8 * 3600_000;

/** The session cookie's name. */
export const COOKIE = "archon_session";

/** The groups whose members may change the server from the console. */
export const OPERATOR_GROUPS = ["sudo", "archon-ops"];

/** Accounts that never sign in to the console. */
export const NEVER = new Set(["root", "ops"]);

/** An operator, from the person's groups. */
export function roleOf(groups: string[]): Role {
  return groups.some((g) => OPERATOR_GROUPS.includes(g)) ? "operator" : "viewer";
}

/** Whether a role may run a command of this tier from the console. */
export function mayRun(role: Role, tier: Tier): boolean {
  if (tier === "read") return true;
  if (tier === "mutate" || tier === "destructive") return role === "operator";
  return false; // repo: a fleet repository's commands belong on the PC (stolos)
}

/** A person's account: full name and groups; undefined when they may not sign in here. */
export interface Account {
  /** Their username. */
  user: string;
  /** Their full name (GECOS), else the username. */
  name: string;
  /** Their groups. */
  groups: string[];
}

/** Looks up accounts: the system's on a server, a fake in tests. */
export type AccountLookup = (user: string) => Promise<Account | undefined>;

/** A username that can be one (letters, digits, `.`, `_`, `-`; not starting with `-`). */
export const USERNAME = /^[a-z_][a-z0-9_.-]{0,31}$/;

/** The system's accounts: `getent passwd` and `id -nG`; people only (uid 1000 to 59999). */
export const systemAccounts: AccountLookup = async (user): Promise<Account | undefined> => {
  if (!USERNAME.test(user) || NEVER.has(user)) return undefined;
  const p = await run(["getent", "passwd", user]);
  if (!p.ok) return undefined;
  const f = p.stdout.trim().split(":");
  const uid = Number(f[2]);
  if (!(uid >= 1000 && uid < 60000)) return undefined;
  const g = await run(["id", "-nG", user]);
  return {
    user,
    name: (f[4] ?? "").split(",")[0] || user,
    groups: g.ok ? g.stdout.trim().split(/\s+/) : [],
  };
};

/** The signed-in people, in memory. */
export class Sessions {
  #all = new Map<string, Session>();
  #now: () => number;
  /** No one signed in yet; `now` is the clock (tests move it). */
  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  /** Start a session for an account, from an address. */
  create(a: Account, from: string): Session {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    const id = btoa(String.fromCharCode(...bytes))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    const t = this.#now();
    const s: Session = {
      id,
      user: a.user,
      name: a.name,
      groups: a.groups,
      role: roleOf(a.groups),
      created: t,
      seen: t,
      from,
    };
    this.#all.set(id, s);
    return s;
  }

  /** The live session with this id (and mark it used), or undefined. */
  get(id: string | undefined): Session | undefined {
    if (!id) return undefined;
    const s = this.#all.get(id);
    if (!s) return undefined;
    if (this.#now() - s.seen > IDLE_MS) {
      this.#all.delete(id);
      return undefined;
    }
    s.seen = this.#now();
    return s;
  }

  /** Sign out. */
  end(id: string | undefined): void {
    if (id) this.#all.delete(id);
  }
}

/** Five failed sign-ins in a minute from one address pause that address. */
export class Throttle {
  #fails = new Map<string, number[]>();
  #now: () => number;
  #limit: number;
  #windowMs: number;
  /** `limit` failures per address in `windowMs`; `now` is the clock (tests move it). */
  constructor(now: () => number = Date.now, limit = 5, windowMs = 60_000) {
    this.#now = now;
    this.#limit = limit;
    this.#windowMs = windowMs;
  }

  /** Whether this address may try now. */
  allowed(from: string): boolean {
    const t = this.#now();
    const recent = (this.#fails.get(from) ?? []).filter((x) => t - x < this.#windowMs);
    this.#fails.set(from, recent);
    return recent.length < this.#limit;
  }

  /** Record a failed try. */
  failed(from: string): void {
    this.#fails.set(from, [...(this.#fails.get(from) ?? []), this.#now()]);
  }

  /** A good sign-in forgets this address's failures. */
  succeeded(from: string): void {
    this.#fails.delete(from);
  }
}

/** The value of one cookie in a Cookie header. */
export function cookieOf(header: string | null, name: string): string | undefined {
  for (const part of (header ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return undefined;
}

/** The Set-Cookie value for a session (or for signing out, with no session). */
export function sessionCookie(s: Session | undefined): string {
  return s
    ? `${COOKIE}=${s.id}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${IDLE_MS / 1000}`
    : `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
}
