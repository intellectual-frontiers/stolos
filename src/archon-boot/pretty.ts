/**
 * The boot server's window (spec 004, Article 19; spec 049): a rendering of
 * structured events, never their source. Each event (telemetry/events.ts) is
 * one line: an icon and tone chosen by its name (and, for boot files, which
 * file), the time and address dimmed, the host's name highlighted, success
 * green and problems red. Debug events (GRUB's harmless probing) are kept out
 * unless verbose; the same event within a few seconds is shown once. boot.log
 * and the OTLP log records hold every event.
 *
 * @module
 */
// Spec: 049-telemetry

import { ui } from "../archon/core/ui.ts";
import { type ArchonEvent, type EventName, severityOf } from "../archon/telemetry/events.ts";

interface Style {
  icon: string;
  ascii: string;
  tone?: "ok" | "fail" | "warn";
}

const STYLE: Partial<Record<EventName, Style>> = {
  "boot.file.substituted": { icon: "⚠️ ", ascii: "!", tone: "warn" },
  "boot.http.missing": { icon: "⚠️ ", ascii: "!", tone: "warn" },
  "boot.uri.unknown": { icon: "❌", ascii: "!!", tone: "fail" },
  "boot.menu": { icon: "🧭", ascii: ">" },
  "boot.claimed": { icon: "🧭", ascii: ">" },
  "boot.recognized": { icon: "🧭", ascii: ">" },
  "boot.unknown": { icon: "🧭", ascii: ">" },
  "boot.starting": { icon: "🎯", ascii: ">" },
  "boot.own-disk": { icon: "💽", ascii: ">" },
  "boot.site-ca": { icon: "🔐", ascii: ">" },
  "boot.image": { icon: "💿", ascii: ">" },
  "boot.config": { icon: "🔑", ascii: ">" },
  "boot.machine": { icon: "🖥️", ascii: ">" },
  "boot.guard": { icon: "🛡️", ascii: ">" },
  "boot.guarded": { icon: "🛑", ascii: "!" },
  "boot.mismatch": { icon: "❓", ascii: "!" },
  "boot.stalled": { icon: "⏳", ascii: "!" },
  "boot.learned": { icon: "📝", ascii: ">" },
  "boot.refused": { icon: "❌", ascii: "!!", tone: "fail" },
  "boot.installer.step": { icon: "📦", ascii: ">" },
  "boot.installer.failed": { icon: "❌", ascii: "!!", tone: "fail" },
  "boot.firstboot.phase": { icon: "✅", ascii: "ok", tone: "ok" },
  "boot.ready": { icon: "🎉", ascii: "**", tone: "ok" },
  "boot.done-with-problems": { icon: "❌", ascii: "!!", tone: "fail" },
  "boot.next": { icon: "👉", ascii: ">>" },
  "boot.finished": { icon: "🏁", ascii: ">", tone: "ok" },
  "boot.hostkeys": { icon: "🔐", ascii: ">" },
  "boot.not-found": { icon: "❌", ascii: "!!", tone: "fail" },
  "boot.error": { icon: "❌", ascii: "!!", tone: "fail" },
  "boot.firewall": { icon: "⚠️ ", ascii: "!", tone: "warn" },
  "boot.armed": { icon: "🎯", ascii: ">" },
  "boot.reboot": { icon: "🔁", ascii: ">" },
  "boot.certificate": { icon: "🔐", ascii: ">" },
};

/** Boot files by what they are (an attribute, not the text). */
function fileStyle(e: ArchonEvent): Style {
  const f = String(e.attrs?.["file"] ?? "");
  if (/^(bootx64|grubx64)\.efi$/.test(f)) return { icon: "🥾", ascii: ">" };
  if (/^(linux|initrd)$/.test(f)) return { icon: "🐧", ascii: ">" };
  return e.attrs?.["via"] === "TFTP" ? { icon: "📡", ascii: ">" } : { icon: "🌐", ascii: ">" };
}

function styleOf(e: ArchonEvent): Style {
  if (e.name === "boot.file" || e.name === "boot.file.probe") return fileStyle(e);
  // A first-boot phase that warned or failed says so in its severity.
  const sev = severityOf(e);
  const base = STYLE[e.name] ?? { icon: "•", ascii: "-" };
  if (sev === "error") return { ...base, icon: "❌", ascii: "!!", tone: "fail" };
  if (sev === "warn") return { ...base, icon: "⚠️ ", ascii: "!", tone: "warn" };
  return base;
}

let last = { key: "", at: 0 };

/** One event's line for the window, or undefined to keep it out (it is still recorded). */
export function render(e: ArchonEvent, verbose = ui.verbose): string | undefined {
  const now = e.time ?? Date.now();
  if (!verbose && severityOf(e) === "debug") return undefined;
  // The same event again within 3 seconds (the shim fetches bootx64.efi twice).
  const key = `${e.name}|${e.host}|${e.address}|${e.message}`;
  if (key === last.key && now - last.at < 3000) return undefined;
  last = { key, at: now };

  const time = ui.dim(
    new Date(now).toLocaleTimeString("en-GB", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }),
  );
  // "Next:" steps: indented under the Ready line, one per line, no icon.
  if (e.name === "boot.next" && e.attrs?.["step"]) {
    return `${" ".repeat(12)}${ui.dim("│")} ${nextStep(e.message)}`;
  }
  const s = styleOf(e);
  const icon = ui.emoji ? s.icon : s.ascii;
  const tone = (t: string) =>
    s.tone === "ok"
      ? ui.green(t)
      : s.tone === "fail"
        ? ui.red(t)
        : s.tone === "warn"
          ? ui.yellow(t)
          : t;
  // Who: the host once it is known (its address after the message), else the address.
  const who = e.host
    ? ui.bold(ui.cyan(e.host.padEnd(14)))
    : ui.dim((e.address ?? "boot server").padEnd(14));
  return `${time}  ${icon} ${who} ${tone(e.message)}${
    e.host && e.address ? ui.dim(`  ${e.address}`) : ""
  }`;
}

/** "connect   ssh alpha   (or ...)" -> the label dimmed, the command bold. */
function nextStep(s: string): string {
  const m = s.match(/^(\S+)\s{2,}(.*?)(\s{2,}.*)?$/);
  if (!m) return s;
  const [, label = "", command = "", rest] = m;
  return `${ui.dim(label.padEnd(9))} ${ui.bold(command)}${rest ? ui.dim(rest) : ""}`;
}

/** For tests. */
export function resetPretty(): void {
  last = { key: "", at: 0 };
}
