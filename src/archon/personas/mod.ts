/**
 * Personas (spec 006). A persona is a bundle of groups and dotfile features;
 * personas compose through `implies` (transitively).
 *
 * @module
 */

import type { Persona, PersonaId } from "../model/types.ts";

/** Every persona by its id: its label, definition, implied personas, groups, and dotfile features. */
export const PERSONAS: Record<PersonaId, Persona> = {
  standard: {
    id: "standard",
    label: "Standard user",
    definition: "A non-technical account: bash with a simple prompt and no developer tooling.",
    implies: [],
    groups: ["archon"],
    features: {
      fish: false,
      tmux: false,
      devTools: false,
    },
  },
  developer: {
    id: "developer",
    label: "Developer",
    definition: "Builds software on the host: fish, tmux, Deno, and git configuration.",
    implies: ["standard"],
    groups: ["archon", "archon-dev"],
    features: {
      fish: true,
      tmux: true,
      devTools: true,
    },
  },
  operator: {
    id: "operator",
    label: "Operator",
    definition:
      "Operates the host through Archon: journal access, LXD through the lxd group, and passwordless sudo for archon only.",
    implies: ["developer"],
    groups: ["archon", "archon-dev", "archon-ops", "adm", "systemd-journal", "lxd"],
    features: {
      fish: true,
      tmux: true,
      devTools: true,
    },
  },
};

/** Expand personas through `implies` (transitively), most specific first. */
export function expandPersonas(ids: PersonaId[]): PersonaId[] {
  const out: PersonaId[] = [];
  const visit = (id: PersonaId) => {
    if (out.includes(id)) return;
    out.push(id);
    for (const p of PERSONAS[id].implies) visit(p);
  };
  ids.forEach(visit);
  return out;
}

/** The sorted, deduplicated groups of these personas and every persona they imply. */
export function groupsFor(ids: PersonaId[]): string[] {
  return [...new Set(expandPersonas(ids).flatMap((p) => PERSONAS[p].groups))].sort();
}

/** The dotfile features of these personas: a feature is on when any expanded persona turns it on. */
export function featuresFor(ids: PersonaId[]): Persona["features"] {
  const f = { ...PERSONAS.standard.features };
  for (const p of expandPersonas(ids)) {
    for (const [k, v] of Object.entries(PERSONAS[p].features)) {
      if (v) f[k as keyof Persona["features"]] = true;
    }
  }
  return f;
}

/** Groups Archon itself creates through sysusers.d. */
export const ARCHON_GROUPS = [
  { name: "archon", description: "Archon: read access to /srv/archon" },
  { name: "archon-dev", description: "Archon developer persona" },
  { name: "archon-ops", description: "Archon operator persona" },
];
