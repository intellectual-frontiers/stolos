/**
 * Spec 067: the policy pack for adopted machines. Each policy reads an
 * observation and says pass, fail, or unknown, with the fix in plain words
 * for that operating system, and names the Secure Controls Framework (SCF)
 * controls it gives evidence for (specs 068 and 071 reach each framework
 * from those through the SCF Council's own mappings).
 *
 * @module
 */

import type { AdoptedDef, Observed } from "./adopt.ts";

/** One policy's result for one machine. */
export interface PolicyResult {
  /** The policy's id. */
  id: string;
  /** What it requires, for people. */
  title: string;
  /** The SCF controls it gives evidence for. */
  scf: string[];
  /** pass, fail, unknown (cannot tell), warn (not required, but worth doing), or accepted (fails, by a recorded decision). */
  status: "pass" | "fail" | "warn" | "unknown" | "accepted";
  /** What was found. */
  detail: string;
  /** How to make it pass, on this machine's OS. */
  fix?: string;
}

const mac = (o: Observed) => o.os.family === "macos";
const win = (o: Observed) => o.os.family === "windows";

/** Whether this OS version is still supported by its maker (a starter table). */
export function supportedOs(o: Observed): boolean | undefined {
  const v = parseFloat(o.os.version);
  const f = o.os.family.split(" ")[0];
  if (f === "macos") return v >= 14;
  // Windows: the build number. 11 24H2 (26100) and later; 10 and older 11 releases are past their end.
  if (f === "windows") return Number(o.os.version) >= 26100;
  if (f === "ubuntu") return ["22.04", "24.04", "26.04"].includes(o.os.version);
  if (f === "debian") return v >= 12;
  if (f === "fedora") return v >= 41;
  if (f === "arch" || o.os.version === "rolling") return true;
  return undefined;
}

/** Failing policies the owner accepted (until a date) become "accepted", with who, why, and until when. */
export function accept(m: AdoptedDef, rs: PolicyResult[], now = Date.now()): PolicyResult[] {
  const today = new Date(now).toISOString().slice(0, 10);
  return rs.map((r) => {
    const a = (m.accepted ?? []).find((x) => x.policy === r.id);
    if (!a || r.status === "pass" || r.status === "unknown") return r;
    if (a.until < today) return { ...r, detail: `${r.detail}; the accepted risk ended ${a.until}` };
    return {
      ...r,
      status: "accepted",
      detail: `${r.detail}; accepted by ${a.by} until ${a.until}: ${a.reason}`,
    };
  });
}

/** Every policy, for one machine. */
export function policies(m: AdoptedDef, o: Observed | undefined, now = Date.now()): PolicyResult[] {
  if (!o) {
    return [{
      id: "observed",
      title: "Observed by Stolos",
      scf: ["AST-04"],
      status: "fail",
      detail: "never observed",
      fix: `deno task stolos host observe ${m.name}`,
    }];
  }
  const days = (now - Date.parse(o.at)) / 86_400_000;
  const out: PolicyResult[] = [];
  const add = (r: PolicyResult) => out.push(r);
  add({
    id: "observed",
    title: "Observed in the last 7 days",
    scf: ["AST-04", "MON-02"],
    status: days <= 7 ? "pass" : "fail",
    detail: `last observed ${o.at.slice(0, 10)}`,
    fix: `deno task stolos host observe ${m.name}`,
  });
  add({
    id: "disk-encryption",
    title: "The disk is encrypted",
    scf: ["CRY-07"],
    status: o.security.diskEncryption === "on"
      ? "pass"
      : o.security.diskEncryption === "off"
      ? "fail"
      : "unknown",
    detail: `disk encryption: ${o.security.diskEncryption}`,
    fix: win(o)
      ? "Settings > Privacy & security > Device encryption (or BitLocker: Control Panel > BitLocker Drive Encryption > Turn on)"
      : mac(o)
      ? "System Settings > Privacy & Security > FileVault > Turn On"
      : "Linux encrypts at installation (LUKS): reinstall with encryption, or record why this machine holds nothing sensitive",
  });
  add({
    id: "firewall",
    title: "The firewall is on",
    scf: ["END-07", "NET-02"],
    status: o.security.firewall === "on"
      ? "pass"
      : o.security.firewall === "off"
      ? "fail"
      : "unknown",
    detail: `firewall: ${o.security.firewall}`,
    fix: win(o)
      ? "Windows Security > Firewall & network protection: turn on every network"
      : mac(o)
      ? "System Settings > Network > Firewall > On"
      : o.os.family.includes("arch")
      ? "sudo pacman -S ufw && sudo systemctl enable --now ufw && sudo ufw enable"
      : "sudo ufw enable (Ubuntu, Debian) or sudo systemctl enable --now firewalld (Fedora)",
  });
  add({
    id: "auto-updates",
    title: "Security updates install by themselves",
    scf: ["VPM-08"],
    status: o.security.autoUpdates === "on"
      ? "pass"
      : o.security.autoUpdates === "manual"
      ? "warn"
      : o.security.autoUpdates === "off"
      ? "fail"
      : "unknown",
    detail: `automatic updates: ${o.security.autoUpdates}${
      o.software.pendingUpdates !== undefined ? `; ${o.software.pendingUpdates} waiting` : ""
    }`,
    fix: win(o)
      ? "Settings > Windows Update (and remove the policy that turns automatic updates off)"
      : mac(o)
      ? "System Settings > General > Software Update > Automatic Updates: all on"
      : o.security.autoUpdates === "manual"
      ? "a rolling distribution updates by hand: run sudo pacman -Syu (Omarchy: Update in its menu) at least weekly"
      : "sudo apt install unattended-upgrades && sudo dpkg-reconfigure -plow unattended-upgrades",
  });
  if (o.software.pendingUpdates !== undefined) {
    add({
      id: "updates-waiting",
      title: "Few updates waiting",
      scf: ["VPM-08"],
      status: o.software.pendingUpdates <= 20 ? "pass" : "warn",
      detail: `${o.software.pendingUpdates} updates waiting`,
      fix: mac(o)
        ? "System Settings > General > Software Update"
        : "install them with the system's updater",
    });
  }
  const sup = supportedOs(o);
  add({
    id: "supported-os",
    title: "The operating system is still supported",
    scf: ["AST-39"],
    status: sup === true ? "pass" : sup === false ? "fail" : "unknown",
    detail: `${o.os.name} ${o.os.version}`.trim(),
    fix: "upgrade to a supported release",
  });
  if (o.security.sshPasswordAuth !== undefined) {
    add({
      id: "ssh-keys-only",
      title: "SSH accepts keys, not passwords",
      scf: ["IAC-14", "CFG-04"],
      status: o.security.sshPasswordAuth === "no" ? "pass" : "warn",
      detail: `PasswordAuthentication ${o.security.sshPasswordAuth}`,
      fix: "PasswordAuthentication no in /etc/ssh/sshd_config, then restart sshd",
    });
  }
  if (o.security.antivirus !== undefined) {
    add({
      id: "antivirus",
      title: "Anti-malware protection is on",
      scf: ["END-04"],
      status: o.security.antivirus === "on"
        ? "pass"
        : o.security.antivirus === "off"
        ? "fail"
        : "unknown",
      detail: `real-time protection: ${o.security.antivirus}`,
      fix: "Windows Security > Virus & threat protection > Real-time protection: on",
    });
  }
  add({
    id: "few-admins",
    title: "At most three administrators",
    scf: ["IAC-30"],
    status: o.security.admins.length === 0
      ? "unknown"
      : o.security.admins.length <= 3
      ? "pass"
      : "warn",
    detail: o.security.admins.length
      ? `administrators: ${o.security.admins.join(", ")}`
      : "administrators: unknown",
    fix: "remove administrator rights from accounts that do not need them",
  });
  add({
    id: "osquery",
    title: "osquery is installed (fleet-wide SQL questions)",
    scf: ["MON-02"],
    status: o.software.osquery ? "pass" : "warn",
    detail: o.software.osquery ? `osquery ${o.software.osquery}` : "osquery is not installed",
    fix: win(o)
      ? "integrate.windows.ps1 --adopt --osquery (installs osquery's MSI)"
      : mac(o)
      ? "brew install --cask osquery"
      : o.os.family.includes("arch")
      ? "osquery is in the AUR: yay -S osquery-bin"
      : "install osquery from osquery.io's apt or yum repository",
  });
  if (m.until) {
    add({
      id: "adoption-current",
      title: "Adoption has not ended",
      scf: ["AST-04"],
      status: m.until >= new Date(now).toISOString().slice(0, 10) ? "pass" : "fail",
      detail: `adopted until ${m.until}`,
      fix: `deno task stolos host release ${m.name}, or extend until in machine.ts`,
    });
  }
  return accept(m, out, now);
}
