/**
 * Resolve a host into a HostPlan: run every capability, merge contributions,
 * then run derive hooks over the merged plan (spec 002).
 *
 * @module
 */

import type { FileDef, FleetDef, HostDef, HostPlan, SpecId } from "./types.ts";
import { type SiteDef, siteNetwork } from "./site.ts";
import { usersFor } from "./load.ts";

/**
 * A host's plan: its users, then every capability's packages, units, files,
 * ports, tools, apt repositories, checks, routes and notes merged, then the
 * derived files. Throws on conflicting definitions of the same item.
 */
export function resolvePlan(host: HostDef, fleet: FleetDef): HostPlan {
  const users = usersFor(fleet, host);
  const plan: HostPlan = {
    host,
    fleet,
    users,
    packages: [],
    units: [],
    files: [],
    ports: [],
    tools: [],
    aptRepos: [],
    checks: [],
    routes: [],
    notes: {},
    specsUsed: [host.spec, ...users.map((u) => u.spec)],
  };
  const derivers: Array<(p: HostPlan) => FileDef[]> = [];
  for (const cap of host.capabilities) {
    const c = cap({ host, fleet, users });
    plan.specsUsed.push(c.spec);
    // A package that names its maintainers' PPA refines the same package without one
    // (platform needs git; the tools capability says where newer git comes from).
    for (const p of c.packages ?? []) {
      const i = plan.packages.findIndex((x) =>
        (x.source ?? "apt") === (p.source ?? "apt") && x.name === p.name && !!x.ppa !== !!p.ppa
      );
      if (i >= 0 && sameIgnoringSpec({ ...plan.packages[i], ppa: 0 }, { ...p, ppa: 0 })) {
        if (p.ppa) plan.packages[i] = p;
      } else mergeBy(plan.packages, [p], (x) => `${x.source ?? "apt"}:${x.name}`);
    }
    mergeBy(plan.units, c.units, (u) => u.unitName);
    mergeBy(plan.files, c.files, (f) => f.path);
    plan.ports.push(...(c.ports ?? []));
    mergeBy(plan.tools, c.tools, (t) => t.id);
    mergeBy(plan.aptRepos, c.aptRepos, (r) => r.id);
    mergeBy(plan.checks, c.checks, (k) => k.name);
    mergeBy(plan.routes, c.routes, (r) => r.name);
    if (c.notes?.length) plan.notes[c.spec] = [...(plan.notes[c.spec] ?? []), ...c.notes];
    if (c.derive) derivers.push(c.derive);
  }
  for (const d of derivers) mergeBy(plan.files, d(plan), (f) => f.path);
  plan.specsUsed = [...new Set(plan.specsUsed)].sort() as SpecId[];
  plan.files.sort((a, b) => a.path.localeCompare(b.path));
  plan.packages.sort((a, b) => a.name.localeCompare(b.name));
  return plan;
}

/** Append items, keeping the first of each key; conflicting duplicates are errors. */
export function mergeBy<T>(into: T[], items: T[] | undefined, key: (t: T) => string) {
  for (const item of items ?? []) {
    const k = key(item);
    const existing = into.find((x) => key(x) === k);
    if (!existing) into.push(item);
    else if (!sameIgnoringSpec(existing, item)) {
      throw new Error(`conflicting definitions for ${k}`);
    }
  }
}

function sameIgnoringSpec(a: unknown, b: unknown): boolean {
  const strip = (x: unknown) =>
    JSON.stringify(x, (k, v) => (k === "spec" || typeof v === "function" ? undefined : v));
  return strip(a) === strip(b);
}

/** The network properties in force for a host (spec 009): host over fleet over default. */
export function networkOf(
  fleet: { network?: { ipv6?: boolean }; site?: SiteDef },
  host: { network?: string; ipv6?: boolean },
): { ipv6: boolean } {
  // Spec 028: the host's site network decides; a per-host override wins; the
  // fleet's fallback covers hosts outside the site (workstations).
  return {
    ipv6: host.ipv6 ?? siteNetwork(fleet.site, host.network)?.ipv6 ?? fleet.network?.ipv6 ?? true,
  };
}
