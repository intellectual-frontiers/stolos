// The boot server's window (spec 004, Article 19): each event on one line,
// with an icon for what happened, the time and address dimmed, the host's name
// highlighted, success green and problems red. GRUB's harmless probing for
// files it does not need is kept out of the window (it stays in boot.log),
// and a line repeated within a few seconds is shown once.

import { ui } from "../archon/core/ui.ts";

const IP = /^(\d{1,3}(?:\.\d{1,3}){3}) (.*)$/;

/** Files GRUB and the shim look for and do without (not found is normal). */
const NOISE = [
  /^TFTP \/?revocations\.efi: not found$/,
  /^TFTP \/grub\/x86_64-efi\/[a-z]+\.lst: not found$/,
  /^TFTP \/?grub\/grub\.cfg-[0-9a-f-]+: not found$/i,
];

interface Kind {
  test: RegExp;
  icon: string;
  ascii: string;
  tone?: "ok" | "fail" | "warn" | "info";
}

const KINDS: Kind[] = [
  { test: /: (ready|installed, with problems)\. Next:$/, icon: "👉", ascii: ">>" },
  { test: /✓ Ready/, icon: "🎉", ascii: "**", tone: "ok" },
  { test: /^[a-z0-9-]+: ✗|✗ |refused |: not found$|error/i, icon: "❌", ascii: "!!", tone: "fail" },
  { test: /^warning:|⚠/, icon: "⚠️ ", ascii: "!", tone: "warn" },
  { test: /^[a-z0-9-]+: ✓ /, icon: "✅", ascii: "ok", tone: "ok" },
  { test: /^TFTP (bootx64|grubx64)\.efi$/, icon: "🥾", ascii: ">" },
  { test: /^TFTP (linux|initrd)$/, icon: "🐧", ascii: ">" },
  { test: /^TFTP /, icon: "📡", ascii: ">" },
  { test: /GRUB menu|claimed by/, icon: "🧭", ascii: ">" },
  { test: /: armed, starting its install|: armed for one install/, icon: "🎯", ascii: ">" },
  { test: /: rebooting from the network/, icon: "🔁", ascii: ">" },
  { test: /installer image/, icon: "💿", ascii: ">" },
  { test: /install config sent/, icon: "🔑", ascii: ">" },
  { test: /: meta-data|: user-data/, icon: "📄", ascii: ">" },
  { test: /installer: /, icon: "📦", ascii: ">" },
  { test: /install finished/, icon: "🏁", ascii: ">", tone: "ok" },
  { test: /trusts its SSH host keys/, icon: "🔐", ascii: ">" },
  { test: /First boot:/, icon: "🚀", ascii: ">" },
  { test: /Boot URI|HTTP /, icon: "🌐", ascii: ">" },
];

let last = { text: "", at: 0 };

/** One event for the window, or undefined to keep it out (it is still in boot.log). */
export function pretty(line: string, now = Date.now(), verbose = ui.verbose): string | undefined {
  const m = line.match(IP);
  const from = m?.[1];
  const msg = m ? m[2] : line;
  if (!verbose && NOISE.some((re) => re.test(msg))) return undefined;
  // The same line again within 3 seconds (the shim fetches bootx64.efi twice).
  if (line === last.text && now - last.at < 3000) return undefined;
  last = { text: line, at: now };

  const time = ui.dim(
    new Date(now).toLocaleTimeString("en-GB", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }),
  );
  // "Next:" steps that follow a Ready line: indented under it, no icon.
  if (/^ {2}\S/.test(msg)) return `${" ".repeat(12)}${ui.dim("│")} ${nextStep(msg.trim())}`;

  const k = KINDS.find((x) => x.test.test(msg));
  const icon = ui.emoji ? (k?.icon ?? "•") : (k?.ascii ?? "-");
  // "alpha: ..." -> the host's name in its own column, highlighted.
  const hm = msg.match(/^(?!warning:)([a-z0-9-]+): (.*)$/);
  const text = (hm ? hm[2] : msg.replace(/^warning: /, "")).replace(/^[✓✗⚠] /, "");
  const tone = (s: string) =>
    k?.tone === "ok"
      ? ui.green(s)
      : k?.tone === "fail"
      ? ui.red(s)
      : k?.tone === "warn"
      ? ui.yellow(s)
      : s;
  // Who: the host once it is known (its address after the message), else the address.
  const who = hm ? ui.bold(ui.cyan(hm[1].padEnd(14))) : ui.dim((from ?? "boot server").padEnd(14));
  return `${time}  ${icon} ${who} ${tone(text)}${hm && from ? ui.dim(`  ${from}`) : ""}`;
}

/** "connect   ssh alpha   (or ...)" -> the label dimmed, the command bold. */
function nextStep(s: string): string {
  const m = s.match(/^(\S+)\s{2,}(.*?)(\s{2,}.*)?$/);
  if (!m) return s;
  return `${ui.dim(m[1].padEnd(9))} ${ui.bold(m[2])}${m[3] ? ui.dim(m[3]) : ""}`;
}

/** For tests. */
export function resetPretty() {
  last = { text: "", at: 0 };
}
