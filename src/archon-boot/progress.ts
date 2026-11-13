// Install and first-boot progress in the boot server's window (spec 004).
// Ubuntu's installer reports every step to a webhook (autoinstall `reporting`);
// most are noise, so a few milestones are shown, plus anything that failed.
// The first boot reports each Archon phase itself.

export interface InstallerEvent {
  name?: string;
  description?: string;
  event_type?: string;
  result?: string;
  origin?: string;
  /** First-boot events (origin "archon"). */
  phase?: string;
  level?: string;
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

/** One line for the window, or undefined for an event not worth showing. */
export function describe(e: InstallerEvent, seen: Set<string>): string | undefined {
  if (e.origin === "archon") {
    const mark = e.level === "fail" ? "✗" : e.level === "warn" ? "⚠" : "✓";
    return `${e.phase === "First boot" ? "" : `${mark} `}${e.phase}: ${e.summary ?? ""}`.trim();
  }
  const name = e.name ?? "";
  if (e.event_type === "finish" && e.result && e.result !== "SUCCESS") {
    // Subiquity also reports failures of unnamed internal steps it recovers
    // from (the install goes on); without a name there is nothing to act on.
    const what = (e.description ?? "").trim() || name.trim();
    if (!what) return undefined;
    return `✗ installer: ${what} (${e.result})`;
  }
  if (e.event_type !== "start") return undefined;
  for (const [re, text] of MILESTONES) {
    if (re.test(name) && !seen.has(text)) {
      seen.add(text);
      return `installer: ${text}`;
    }
  }
  return undefined;
}
