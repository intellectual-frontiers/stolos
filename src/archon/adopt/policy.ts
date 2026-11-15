/**
 * Spec 067: the policy pack for adopted machines. Each policy reads an
 * observation and says pass, fail, or unknown, with the fix in plain words
 * for that operating system, and names the Secure Controls Framework (SCF)
 * controls it gives evidence for (specs 068 and 071 reach each framework
 * from those through the SCF Council's own mappings). Spec 078: the pack is
 * written on the control SDK ({@link ADOPTED_CONTROLS}), as a fleet's own
 * controls are.
 *
 * @module
 */

import type { AdoptedDef, Observed } from "./adopt.ts";
import {
  type CheckStatus,
  defineControl,
  type ObservationControl,
  type ObservationInputs,
} from "../controls/define.ts";
import { acceptRisks, runObservations } from "../controls/core.ts";

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
  return acceptRisks(m.accepted ?? [], rs, now);
}

type In = ObservationInputs["adopted"];
const os = (i: In) => i.observed;
const onOff = (v: string, warn?: string): CheckStatus =>
  v === "on"
    ? "pass"
    : v === "off"
      ? "fail"
      : warn !== undefined && v === warn
        ? "warn"
        : "unknown";

/** The adopted-machine policy pack, as controls (spec 078), in the order results are shown. */
export const ADOPTED_CONTROLS: ObservationControl<"adopted">[] = [
  defineControl({
    id: "observed",
    title: "Observed in the last 7 days",
    scf: ["AST-04", "MON-02"],
    subject: "observation",
    of: "adopted",
    assert: ({ observed: o, now }) => ({
      status: (now - Date.parse(o.at)) / 86_400_000 <= 7 ? "pass" : "fail",
      detail: `last observed ${o.at.slice(0, 10)}`,
    }),
    fix: ({ machine }) => `bun run stolos host observe ${machine.name}`,
  }),
  defineControl({
    id: "disk-encryption",
    title: "The disk is encrypted",
    scf: ["CRY-07"],
    subject: "observation",
    of: "adopted",
    assert: ({ observed: o }) => ({
      status: onOff(o.security.diskEncryption),
      detail: `disk encryption: ${o.security.diskEncryption}`,
    }),
    fix: (i) =>
      win(os(i))
        ? "Settings > Privacy & security > Device encryption (or BitLocker: Control Panel > BitLocker Drive Encryption > Turn on)"
        : mac(os(i))
          ? "System Settings > Privacy & Security > FileVault > Turn On"
          : "Linux encrypts at installation (LUKS): reinstall with encryption, or record why this machine holds nothing sensitive",
  }),
  defineControl({
    id: "firewall",
    title: "The firewall is on",
    scf: ["END-07", "NET-02"],
    subject: "observation",
    of: "adopted",
    assert: ({ observed: o }) => ({
      status: onOff(o.security.firewall),
      detail: `firewall: ${o.security.firewall}`,
    }),
    fix: (i) =>
      win(os(i))
        ? "Windows Security > Firewall & network protection: turn on every network"
        : mac(os(i))
          ? "System Settings > Network > Firewall > On"
          : os(i).os.family.includes("arch")
            ? "sudo pacman -S ufw && sudo systemctl enable --now ufw && sudo ufw enable"
            : "sudo ufw enable (Ubuntu, Debian) or sudo systemctl enable --now firewalld (Fedora)",
  }),
  defineControl({
    id: "auto-updates",
    title: "Security updates install by themselves",
    scf: ["VPM-08"],
    subject: "observation",
    of: "adopted",
    assert: ({ observed: o }) => ({
      status: onOff(o.security.autoUpdates, "manual"),
      detail: `automatic updates: ${o.security.autoUpdates}${
        o.software.pendingUpdates !== undefined ? `; ${o.software.pendingUpdates} waiting` : ""
      }`,
    }),
    fix: (i) =>
      win(os(i))
        ? "Settings > Windows Update (and remove the policy that turns automatic updates off)"
        : mac(os(i))
          ? "System Settings > General > Software Update > Automatic Updates: all on"
          : os(i).security.autoUpdates === "manual"
            ? "a rolling distribution updates by hand: run sudo pacman -Syu (Omarchy: Update in its menu) at least weekly"
            : "sudo apt install unattended-upgrades && sudo dpkg-reconfigure -plow unattended-upgrades",
  }),
  defineControl({
    id: "updates-waiting",
    title: "Few updates waiting",
    scf: ["VPM-08"],
    subject: "observation",
    of: "adopted",
    assert: ({ observed: o }) =>
      o.software.pendingUpdates === undefined
        ? undefined
        : {
            status: o.software.pendingUpdates <= 20 ? "pass" : "warn",
            detail: `${o.software.pendingUpdates} updates waiting`,
          },
    fix: (i) =>
      mac(os(i))
        ? "System Settings > General > Software Update"
        : "install them with the system's updater",
  }),
  defineControl({
    id: "supported-os",
    title: "The operating system is still supported",
    scf: ["AST-39"],
    subject: "observation",
    of: "adopted",
    assert: ({ observed: o }) => {
      const sup = supportedOs(o);
      return {
        status: sup === true ? "pass" : sup === false ? "fail" : "unknown",
        detail: `${o.os.name} ${o.os.version}`.trim(),
      };
    },
    fix: "upgrade to a supported release",
  }),
  defineControl({
    id: "ssh-keys-only",
    title: "SSH accepts keys, not passwords",
    scf: ["IAC-14", "CFG-04"],
    subject: "observation",
    of: "adopted",
    assert: ({ observed: o }) =>
      o.security.sshPasswordAuth === undefined
        ? undefined
        : {
            status: o.security.sshPasswordAuth === "no" ? "pass" : "warn",
            detail: `PasswordAuthentication ${o.security.sshPasswordAuth}`,
          },
    fix: "PasswordAuthentication no in /etc/ssh/sshd_config, then restart sshd",
  }),
  defineControl({
    id: "antivirus",
    title: "Anti-malware protection is on",
    scf: ["END-04"],
    subject: "observation",
    of: "adopted",
    assert: ({ observed: o }) =>
      o.security.antivirus === undefined
        ? undefined
        : {
            status: onOff(o.security.antivirus),
            detail: `real-time protection: ${o.security.antivirus}`,
          },
    fix: "Windows Security > Virus & threat protection > Real-time protection: on",
  }),
  defineControl({
    id: "few-admins",
    title: "At most three administrators",
    scf: ["IAC-30"],
    subject: "observation",
    of: "adopted",
    assert: ({ observed: o }) => ({
      status:
        o.security.admins.length === 0
          ? "unknown"
          : o.security.admins.length <= 3
            ? "pass"
            : "warn",
      detail: o.security.admins.length
        ? `administrators: ${o.security.admins.join(", ")}`
        : "administrators: unknown",
    }),
    fix: "remove administrator rights from accounts that do not need them",
  }),
  defineControl({
    id: "osquery",
    title: "osquery is installed (fleet-wide SQL questions)",
    scf: ["MON-02"],
    subject: "observation",
    of: "adopted",
    assert: ({ observed: o }) => ({
      status: o.software.osquery ? "pass" : "warn",
      detail: o.software.osquery ? `osquery ${o.software.osquery}` : "osquery is not installed",
    }),
    fix: (i) =>
      win(os(i))
        ? "integrate.windows.ps1 --adopt --osquery (installs osquery's MSI)"
        : mac(os(i))
          ? "brew install --cask osquery"
          : os(i).os.family.includes("arch")
            ? "osquery is in the AUR: yay -S osquery-bin"
            : "install osquery from osquery.io's apt or yum repository",
  }),
  defineControl({
    id: "adoption-current",
    title: "Adoption has not ended",
    scf: ["AST-04"],
    subject: "observation",
    of: "adopted",
    assert: ({ machine: m, now }) =>
      !m.until
        ? undefined
        : {
            status: m.until >= new Date(now).toISOString().slice(0, 10) ? "pass" : "fail",
            detail: `adopted until ${m.until}`,
          },
    fix: ({ machine: m }) => `bun run stolos host release ${m.name}, or extend until in machine.ts`,
  }),
];

/** Every policy, for one machine: the controls above, then accepted risks. */
export function policies(m: AdoptedDef, o: Observed | undefined, now = Date.now()): PolicyResult[] {
  if (!o) {
    return [
      {
        id: "observed",
        title: "Observed by Stolos",
        scf: ["AST-04"],
        status: "fail",
        detail: "never observed",
        fix: `bun run stolos host observe ${m.name}`,
      },
    ];
  }
  return accept(m, runObservations(ADOPTED_CONTROLS, { machine: m, observed: o, now }), now);
}
