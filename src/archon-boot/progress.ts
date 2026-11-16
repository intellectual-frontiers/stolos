/**
 * Install and first-boot progress in the boot server's window (spec 004).
 * Ubuntu's installer reports every step to a webhook (autoinstall `reporting`);
 * most are noise, so a few milestones are shown, plus anything that failed.
 * The first boot reports each Archon phase itself.
 *
 * @module
 */
// Spec: 004-install

import type { ArchonEvent } from "../archon/telemetry/events.ts";

/** One report posted to the boot server: from Ubuntu's installer (`reporting` webhook) or from Archon's first boot. */
export interface InstallerEvent {
  /** The installer's step name, for example "subiquity/Install/install/curthooks". */
  name?: string;
  /** The installer's description of the step. */
  description?: string;
  /** "start" or "finish". */
  event_type?: string;
  /** For a finish: "SUCCESS", "WARN", or "FAIL". */
  result?: string;
  /** "archon" for first-boot events; absent for the installer's. */
  origin?: string;
  /** First-boot events (origin "archon"). */
  phase?: string;
  /** First-boot events: "ok", "warn", or "fail". */
  level?: string;
  /** First-boot events: the phase's one-line result. */
  summary?: string;
}

/** Installer milestones, matched on the event name, in order. */
const MILESTONES: Array<[RegExp, string]> = [
  [/stage-partitioning|partitioning/, "partitioning the disk"],
  [/stage-extract|extract/, "copying Ubuntu to the disk"],
  [/installing-kernel/, "installing the kernel"],
  [/system-upgrade/, "installing updates"],
  [/curthooks/, "configuring the installed system"],
  [/postinstall|late/, "finishing the install"],
];

/** What the window and the log record get from one progress report (spec 049). */
export type ProgressEvent = Pick<ArchonEvent, "name" | "message" | "severity" | "attrs">;

/** One event for a progress report, or undefined for one not worth recording. */
export function describe(e: InstallerEvent, seen: Set<string>): ProgressEvent | undefined {
  if (e.origin === "archon") {
    const phase = e.phase ?? "";
    const severity = e.level === "fail" ? "error" : e.level === "warn" ? "warn" : "info";
    if (phase === "Ready") {
      return { name: "boot.ready", message: `Ready: ${e.summary ?? ""}`.trim() };
    }
    if (phase === "Done with problems") {
      return { name: "boot.done-with-problems", message: `Done with problems: ${e.summary ?? ""}` };
    }
    return {
      name: "boot.firstboot.phase",
      severity,
      message: `${phase}: ${e.summary ?? ""}`.trim(),
      attrs: { phase },
    };
  }
  const name = e.name ?? "";
  if (e.event_type === "finish" && e.result && e.result !== "SUCCESS") {
    // Subiquity also reports failures of unnamed internal steps it recovers
    // from (the install goes on); without a name there is nothing to act on.
    const what = (e.description ?? "").trim() || name.trim();
    if (!what) return undefined;
    return {
      name: "boot.installer.failed",
      message: `installer: ${what} (${e.result})`,
      attrs: { step: name, result: e.result },
    };
  }
  if (e.event_type !== "start") return undefined;
  for (const [re, text] of MILESTONES) {
    if (re.test(name) && !seen.has(text)) {
      seen.add(text);
      return { name: "boot.installer.step", message: `installer: ${text}`, attrs: { step: name } };
    }
  }
  return undefined;
}
