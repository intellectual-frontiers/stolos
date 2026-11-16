/**
 * 037-smb: archon fs smb on | off | status. SMB is an opt-in service (spec
 * 040): on and off are the shared switch (the host's own archon.sql (opt-in smb)). SMB
 * uses each account's own Linux username and password: PAM keeps Samba's copy
 * in step whenever the password is typed on the server.
 *
 * @module
 */
// Spec: 037-smb

import { proc } from "@intellectual-frontiers/commons/ts/runtime";
import { getRecord } from "../state/store.ts";

import { P } from "../core/paths.ts";
import { run } from "../core/exec.ts";
import { ui } from "../core/ui.ts";
import { loadFleet, loadHosts } from "../model/load.ts";
import type { DataClass, FleetDef, HostDef } from "../model/types.ts";
import { SMB, smbName, smbUsers } from "./config.ts";

/** The host's SMB switch record (spec 040's opt-in record). */
export interface SmbRecord {
  /** Whether SMB is on. */
  enabled: boolean;
  /** Who last turned it on or off. */
  by: string;
  /** When (ISO 8601). */
  at: string;
}

/** The host's SMB switch record in archon.sql, or `undefined` when it was never turned on. */
export async function readRecord(host: string, root = P.state): Promise<SmbRecord | undefined> {
  return (await getRecord<SmbRecord>(host, "optin", SMB.switch, root))?.body;
}

/** Who asked: the person behind sudo, else the current user. */
const caller = (): string => proc.env.get("SUDO_USER") ?? proc.env.get("USER") ?? "root";

async function server(name: string): Promise<{ fleet: FleetDef; host: HostDef }> {
  const fleet = await loadFleet();
  const host = (await loadHosts()).find((h) => h.name === name);
  if (!host) throw new Error(`no host ${name} in the model`);
  if (host.kind === "workstation") throw new Error("SMB is for servers, not workstations");
  return { fleet, host };
}

/** How to connect, for the person who just turned it on (or asked). */
export function howToConnect(name: string, user = "<you>"): string[] {
  return [
    `Windows: File Explorer, This PC, Map network drive: \\\\${name}\\shared (your folder: \\\\${name}\\${user})`,
    `macOS:   Finder, Go, Connect to Server: smb://${name}/shared`,
    `Linux:   your file manager: smb://${name}/shared`,
    `Sign in with your Linux username and password (the same as for Cockpit or sudo).`,
  ];
}

// On and off are the shared opt-in switch (spec 040).
/**
 * `archon fs smb on`: turn SMB on with the forced data choice (spec 044).
 * `confirm` is the `--confirm-destroy` value. Resolves to the exit code.
 */
export const smbOn = async (host: string, data: DataClass, confirm?: unknown): Promise<number> =>
  (await import("../optin/optin.ts")).setOptIn(host, "smb", true, { data, confirm });
/** `archon fs smb off`: turn SMB off (its data is kept). Resolves to the exit code. */
export const smbOff = async (host: string): Promise<number> =>
  (await import("../optin/optin.ts")).setOptIn(host, "smb", false);

/**
 * `archon fs smb status`: the switch, smbd and port 445, the shares, and who
 * has an SMB password (as root). Returns 1 when a check failed, else 0.
 */
export async function smbStatus(hostName: string): Promise<number> {
  const { fleet, host } = await server(hostName);
  const plan = (await import("../model/resolve.ts")).resolvePlan(host, fleet);
  const rec = await readRecord(host.name);
  const name = smbName(fleet, host);
  const s = ui.phase("SMB");
  const active = (await run(["systemctl", "is-active", SMB.unit])).stdout.trim();
  const listening = (await run(["ss", "-Hltn", "sport = :445"])).stdout.trim().length > 0;
  const on = rec?.enabled === true;
  const when = rec ? `${rec.at.slice(0, 16).replace("T", " ")} UTC by ${rec.by}` : "";
  if (on && active !== "active") {
    s.fail(`turned on (${when}) but smbd is ${active}`, `journalctl -u ${SMB.unit} -n 30`);
  } else if (!on && active === "active") {
    s.warn("turned off, but smbd is running", "sudo archon apply");
  }
  s.done(
    on
      ? `on since ${when} · smbd ${active} · port 445 ${listening ? "listening" : "not listening"}`
      : `off${rec ? ` since ${when}` : " (never turned on)"} · turn it on: archon fs smb on`,
  );
  const sh = ui.phase("Shares");
  const users = smbUsers(plan.users);
  ui.say(`\\\\${name}\\shared   ${SMB.shared} · for ${users.join(", ") || "nobody yet"}`);
  ui.say(`\\\\${name}\\<username>   each account's own home folder`);
  // Who has an SMB password (root only: Samba's database is private).
  const pdb = await run(["pdbedit", "-L"]);
  const withPw = pdb.ok
    ? pdb.stdout
        .split("\n")
        .map((l) => l.split(":")[0] ?? "")
        .filter(Boolean)
    : undefined;
  sh.done(
    withPw
      ? `ready (password known to Samba): ${
          withPw.filter((u) => users.includes(u)).join(", ") || "nobody yet"
        }${
          users.some((u) => !withPw.includes(u))
            ? ` · not yet: ${users
                .filter((u) => !withPw.includes(u))
                .join(", ")} (type the Linux password once on the server: Cockpit, sudo, or passwd)`
            : ""
        }`
      : "run as root (sudo) to see who has an SMB password",
  );
  if (on) ui.next.push(...howToConnect(name, caller()));
  return ui.problems.some((x) => x.level === "fail") ? 1 : 0;
}
