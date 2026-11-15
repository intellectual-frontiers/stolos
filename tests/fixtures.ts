/**
 * Shared test fixtures: a valid fleet and host of the example lab.
 *
 * @module
 */

import { foundation } from "../src/archon/capabilities/mod.ts";
import type { FleetDef, HostDef } from "../src/archon/model/types.ts";

/** An example SSH public key (not a real one). */
export const KEY: string =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIKexampleexampleexampleexampleexampleexam me@laptop";

/** Fields that replace a fixture's own; a field given as `undefined` is left out. */
export type Overrides<T> = { [K in keyof T]?: T[K] | undefined };

/** `base` with `over` applied (see {@link Overrides}). */
function withOverrides<T extends object>(base: T, over: Overrides<T>): T {
  const out = new Map<string, unknown>(Object.entries(base));
  for (const [k, v] of Object.entries(over)) {
    if (v === undefined) out.delete(k);
    else out.set(k, v);
  }
  // Every field of T is there, or was left out on purpose (an optional one).
  return Object.fromEntries(out) as T;
}

/** A valid fleet, with the fields given in `over` replacing its own. */
export function fleet(over: Overrides<FleetDef> = {}): FleetDef {
  return withOverrides<FleetDef>(
    {
      id: "lab",
      title: "Test fleet",
      repository: { slug: "example/fleet", url: "https://github.com/example/fleet" },
      ubuntu: { release: "26.04", codename: "resolute" },
      timezone: "America/New_York",
      locale: "en_US.UTF-8",
      keyboard: "us",
      admin: {
        user: "alice",
        uid: 1000,
        github: {
          login: "alice",
          id: 1000001,
          name: "Alice Example",
          email: "1000001+alice@users.noreply.github.com",
          sshKeys: [KEY],
        },
      },
    },
    over,
  );
}

/** A valid host, with the fields given in `over` replacing its own. */
export function host(over: Overrides<HostDef> = {}): HostDef {
  return withOverrides<HostDef>(
    {
      name: "alpha",
      mac: "1c:83:41:30:25:f2",
      arch: "amd64",
      disk: { match: "largest", layout: "lvm" },
      capabilities: foundation(),
      spec: "004-install",
    },
    over,
  );
}

/** The value at a path inside parsed JSON (an object's key, an array's index), or undefined. */
export function at(value: unknown, ...path: ReadonlyArray<string | number>): unknown {
  let v: unknown = value;
  for (const k of path) {
    if (typeof v !== "object" || v === null) return undefined;
    v = Reflect.get(v, k);
  }
  return v;
}

/** Parsed JSON as an array, or an empty one. */
export function list(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? (value as unknown[]) : [];
}
