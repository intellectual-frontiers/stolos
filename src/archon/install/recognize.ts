/**
 * Spec 051: how a machine becomes a host when it network-boots. A person
 * chooses, every time, exactly one of:
 *
 *   --claim                the next unknown machine to network-boot (within 30
 *                          minutes) becomes the host; its MAC is learned from it;
 *   --mac-address <mac>    only that network card is the host.
 *
 * There is no default: a choice made without thinking is how the wrong machine
 * gets erased. The one exception is a host that already installed: the MAC its
 * own machine reported (registration.ts, macSource "installed") is a fact, so
 * `boot arm` may use it without either option.
 *
 * ```mermaid
 * flowchart TD
 *   start["host add / boot arm"] --> q{"--claim or<br/>--mac-address?"}
 *   q -->|neither or both| refuse["refused, both commands shown<br/>(E051-NO-RECOGNITION)"]
 *   q -->|--claim| claim["the next unknown machine<br/>in 30 minutes becomes the host"]
 *   q -->|--mac-address| mac["only that network card"]
 *   q -->|"neither, but its machine<br/>reported its MAC"| own["its own machine again"]
 *   claim --> learned["MAC learned at install:<br/>registration.ts, macSource installed"]
 *   mac --> learned
 * ```
 *
 * @module
 */

import { parseMac } from "../fleet/registration.ts";
import type { HostRegistration } from "../model/types.ts";

/** How a machine becomes the host: claimed, by a typed MAC, or its own installed MAC. */
export type Recognition =
  | { kind: "claim" }
  | { kind: "mac"; mac: string }
  | { kind: "installed"; mac: string };

/** How long a claim waits for an unknown machine to network-boot. */
export const CLAIM_MINUTES = 30;

/** The choice, or why it is refused (with the commands that would work). */
export function recognition(
  host: string,
  o: { claim?: boolean; macAddress?: string; command: string },
  registration?: Pick<HostRegistration, "mac" | "macSource">,
): Recognition | { refusal: string } {
  const both = o.claim && o.macAddress !== undefined;
  if (both) {
    return {
      refusal:
        `choose one: --claim (the next unknown machine becomes ${host}) or --mac-address <mac> (only that network card), not both`,
    };
  }
  if (o.macAddress !== undefined) {
    const mac = parseMac(o.macAddress);
    if (!mac) {
      return {
        refusal: `--mac-address ${
          JSON.stringify(o.macAddress)
        } is not a MAC address: six pairs of hex digits, for example 52:54:00:12:34:56 (the machine's firmware setup or a sticker on it shows it)`,
      };
    }
    return { kind: "mac", mac };
  }
  if (o.claim) return { kind: "claim" };
  if (registration?.mac && registration.macSource === "installed") {
    return { kind: "installed", mac: registration.mac };
  }
  return {
    refusal: [
      `say how ${host}'s machine will be recognized when it network-boots:`,
      `  ${o.command} ${host} --claim                         the next unknown machine to network-boot in ${CLAIM_MINUTES} minutes becomes ${host}`,
      `  ${o.command} ${host} --mac-address aa:bb:cc:dd:ee:ff   only the network card with that address`,
    ].join("\n"),
  };
}

/** One line on what the choice means, for the person who made it. */
export function describeRecognition(host: string, r: Recognition): string {
  switch (r.kind) {
    case "claim":
      return `the next unknown machine to network-boot in ${CLAIM_MINUTES} minutes becomes ${host}`;
    case "mac":
      return `${host} is the machine whose network card is ${r.mac}`;
    case "installed":
      return `${host} is its own machine again (${r.mac}, as it reported when it installed)`;
  }
}
