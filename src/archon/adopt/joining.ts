/**
 * Spec 107-pairing-and-query: how a machine came to be in the fleet. The ways are the ontology's (`stolos:WayOfJoining`): the
 * controller PC is **auto-adopted** (spec 097: the fleet adopts it by itself, it needs no pairing and is observed by the local
 * probe), a machine adopted through `stolos pair` is **paired**, one adopted by hand (a check-in code, `host adopt`) or a device
 * read over SNMP is **integrated**, a server or workstation Stolos installs is **managed**, and a cloud account's machine is
 * **cloud**. A device a router's controller manages and Stolos adopted through the integration (spec 110-network-assets) joined **via the
 * integration**, with the flag `auto` where a fleet rule adopted it. A machine only discovered has joined nowhere yet. Both consoles and the command line read the mark from here.
 *
 * @module
 */
// Spec: 107-pairing-and-query FR-007, FR-009
// Spec: 110-network-assets FR-002

import { absurd } from "@intellectual-frontiers/core";
import { WAYS_OF_JOINING, type MachineKind, type WayOfJoining } from "../ontology.auto.ts";

export { WAYS_OF_JOINING, type WayOfJoining };

/** What decides a machine's way of joining. */
export interface JoiningFacts {
  /** The machine's kind (the controller is an adopted machine whose role says so). */
  kind: MachineKind;
  /** An adopted machine's role (`controller`: the fleet's own PC). */
  role?: "controller";
  /** What its declaration records (spec 107: written by `stolos pair`). */
  joined?: "paired" | "integrated" | "integration";
}

/** The way a machine joined, or undefined where it has not joined (discovered only). */
export function wayOfJoining(m: JoiningFacts): WayOfJoining | undefined {
  switch (m.kind) {
    case "controller":
      return "auto-adopted";
    case "server":
    case "workstation":
      return "managed";
    case "cloud":
      return "cloud";
    case "device":
      return m.joined ?? "integrated";
    case "adopted":
      return m.role === "controller" ? "auto-adopted" : (m.joined ?? "integrated");
    case "discovered":
      return undefined;
    default:
      return absurd(m.kind);
  }
}

/** The word for a way of joining, as the tables and the filter show it. */
export const JOINED_LABEL: Record<WayOfJoining, string> = {
  "auto-adopted": "Auto-adopted",
  paired: "Paired",
  integrated: "Integrated",
  integration: "Via integration",
  managed: "Managed",
  cloud: "Cloud",
};

/**
 * Spec 110-network-assets FR-002: the badge of a device adopted through an integration, naming the integration (`Adopted via UniFi`, or `Auto-adopted via UniFi` where a fleet rule adopted it).
 */
export function integrationBadge(o: { title: string; auto?: boolean | undefined }): string {
  return `${o.auto ? "Auto-adopted" : "Adopted"} via ${o.title.replace(/ Network$/, "")}`;
}

/** The badge of the controller: what its mark says in full. */
export const CONTROLLER_BADGE = "Auto-adopted, controller";

/** Why the controller needs no pairing, and cannot be released or removed from here (the console says it beside the disabled actions). */
export const CONTROLLER_NOTE =
  "This PC is the fleet's controller: it is auto-adopted, needs no pairing, and is observed by the local probe. It is not released or removed here: nothing was installed on it to take away, and it holds the fleet's keys.";

/** A one-line mark for the command line: `auto-adopted (the controller: needs no pairing, observed by the local probe)`. */
export function joinedMark(way: WayOfJoining | undefined): string {
  if (way === undefined) return "not joined yet";
  if (way === "integration") return "adopted via an integration (read, never probed)";
  return way === "auto-adopted"
    ? "auto-adopted (the controller: needs no pairing, observed by the local probe)"
    : way;
}
