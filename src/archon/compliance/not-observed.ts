/**
 * Spec 117-adopted-in-status: "no evidence" is not a failure. A control that went from no evidence to a failing status, where nothing
 * of it was observed (or only something stale), is waiting for an observation: it is shown as not observed yet (the hourglass, the
 * "not set up yet" class of spec 105-calm-output), with the one command that observes it, never as a warning that says it failed. This
 * decides and words it; it never changes the evidence, a control's status, a requirement's status or the gate (the display only).
 *
 * @module
 */
// Spec: 117-adopted-in-status FR-006, FR-008, FR-009, FR-010

import type { ControlChange } from "./drift.ts";

/** The check of the result an unobserved adopted machine or device carries (spec 067-adopt): it says nothing was observed. */
export const NEVER_OBSERVED_CHECK = "Observed by Stolos";

/** The explain code of a waiting observation (`stolos explain P117-NO-EVIDENCE`). */
export const NO_EVIDENCE_CODE = "P117-NO-EVIDENCE";

/** The title of the adopted machines' disk policy, whose reason (the probe's fact) the fix says. */
export const DISK_CHECK = "The disk is encrypted";

/** Why the disk's encryption is not observed where it is not: the probe's fact (spec 117-adopted-in-status FR-008). */
export const DISK_REASON =
  "the disk's encryption needs the probe's disk_encryption fact (BitLocker on Windows, FileVault on macOS, LUKS on Linux): ";

/**
 * Whether a control's change is "no evidence" rather than a failure: it went from no evidence to a failing status and none of its
 * changed evidence is a current failure (a check observed within its service level that failed). An empty list of evidence, a stale
 * observation and the never-observed result all wait for an observation.
 */
export function isNotObserved(c: ControlChange): boolean {
  return (
    c.from === "no evidence" &&
    c.to === "fail" &&
    !c.evidence.some((e) => e.to === "fail" && !e.stale && e.check !== NEVER_OBSERVED_CHECK)
  );
}

/** The command that observes what one source of evidence looks at. */
function observeCommand(source: string, subject: string): string {
  switch (source) {
    case "adopted":
      return `bun run stolos host observe ${subject}`;
    case "managed":
      return "bun run stolos fleet status";
    case "device":
      return `bun run stolos device observe ${subject}`;
    case "cloud":
      return "bun run stolos estate observe";
    default:
      return "bun run stolos compliance";
  }
}

/** What a waiting control says: `not observed yet` (or `not observed recently`, where all that exists is stale), and the one fix line. */
export function notObservedWords(c: ControlChange): { text: string; fix: string } {
  const stale = c.evidence.length > 0 && c.evidence.every((e) => e.stale);
  const commands = [
    ...new Set(
      c.evidence.length
        ? c.evidence.map((e) => observeCommand(e.source, e.subject))
        : ["bun run stolos host observe"],
    ),
  ];
  const disk = c.evidence.some((e) => e.check === DISK_CHECK) ? DISK_REASON : "";
  return {
    text: `${c.id} ${c.name}: ${stale ? "not observed recently" : "not observed yet"}`,
    fix: `${disk}${commands.slice(0, 3).join(", then ")}`,
  };
}
