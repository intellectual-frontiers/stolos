// Spec 078: the built-in policies as they were before they were rewritten on the control SDK,
// kept only so tests/controls078_test.ts can show the rewrites give identical results.
import type { AdoptedDef, Observed } from "../src/archon/adopt/adopt.ts";
import type { PolicyResult } from "../src/archon/adopt/policy.ts";
import type { DeviceDef, DeviceObserved } from "../src/archon/device/device.ts";
import type { Estate } from "../src/archon/estate/graph.ts";
import { rowParams, upsertSql } from "../src/archon/schema/define.ts";
import { finding } from "../src/archon/estate/schema.ts";

const mac = (o: Observed) => o.os.family === "macos";
const win = (o: Observed) => o.os.family === "windows";

/** Whether this OS version is still supported by its maker (a starter table). */
function supportedOs(o: Observed): boolean | undefined {
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
function accept(m: AdoptedDef, rs: PolicyResult[], now = Date.now()): PolicyResult[] {
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
export function legacyPolicies(
  m: AdoptedDef,
  o: Observed | undefined,
  now = Date.now(),
): PolicyResult[] {
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

/** A device's policies. */
export function legacyDevicePolicies(
  d: DeviceDef,
  o: DeviceObserved | undefined,
  now = Date.now(),
): PolicyResult[] {
  if (!o) {
    return [{
      id: "observed",
      title: "Observed by Stolos",
      scf: ["AST-04"],
      status: "fail",
      detail: "never observed",
      fix: `deno task stolos device observe ${d.name}`,
    }];
  }
  const days = (now - Date.parse(o.at)) / 86_400_000;
  return [
    {
      id: "observed",
      title: "Observed in the last 7 days",
      scf: ["AST-04", "MON-02"],
      status: days <= 7 ? "pass" : "fail",
      detail: `last observed ${o.at.slice(0, 10)}`,
      fix: `deno task stolos device observe ${d.name}`,
    },
    {
      id: "snmpv3",
      title: "Read only over encrypted SNMPv3 (authPriv)",
      scf: ["CRY-05"],
      status: "pass",
      detail: `user ${d.snmp.user}, ${d.snmp.auth === "sha256" ? "SHA-256" : "SHA-1"} and AES`,
    },
    {
      id: "owner",
      title: "It has an owner and a location",
      scf: ["AST-07.1"],
      status: (d.owner || o.contact) && (d.location || o.location) ? "pass" : "warn",
      detail: `owner: ${d.owner || o.contact || "none"}; location: ${
        d.location || o.location || "none"
      }`,
      fix:
        `set owner and location in fleets/<fleet>/devices/${d.name}/device.ts (or sysContact and sysLocation on the device)`,
    },
    {
      id: "restarted",
      title: "Restarted in the last 400 days (firmware updates restart a device)",
      scf: ["VPM-08"],
      status: o.uptimeDays <= 400 ? "pass" : "warn",
      detail: `up ${o.uptimeDays} days${o.firmware ? `; firmware ${o.firmware}` : ""}`,
      fix: "check the maker's site for firmware updates, and install them",
    },
  ];
}

/** The cross-system policies, on the graph; each result is also written to the finding table. */
export function legacyEstatePolicies(e: Estate, now = new Date()): PolicyResult[] {
  const rows = (sql: string) =>
    (e.db.prepare(sql).all() as Array<Record<string, string>>).map((r) => ({ ...r }));
  const list = (r: Array<Record<string, string>>, f: (x: Record<string, string>) => string) =>
    r.slice(0, 12).map(f).join(", ") + (r.length > 12 ? `, and ${r.length - 12} more` : "");
  const count = (sql: string) => Number((e.db.prepare(sql).get() as { n: number }).n);
  const out: Array<PolicyResult & { subjects: string[] }> = [];
  const people = count("SELECT count(*) AS n FROM person");
  if (people) {
    const leavers = rows(
      `SELECT u.email_addr AS email, t.connector AS system, a.display_name AS name, a.user_account_uid AS uid
       FROM user_inventory u
       JOIN edge e ON e.src_uid = u.uid AND e.verb = 'has_account'
       JOIN user_account a ON a.user_account_uid = e.dst_uid
       JOIN tenant t ON t.tenant_uid = a.tenant_uid
       WHERE u.status = 'terminated' AND a.active = 1 ORDER BY u.email_addr`,
    );
    out.push({
      id: "leavers",
      title: "People who left have no active accounts",
      scf: ["IAC-04"],
      status: leavers.length ? "fail" : "pass",
      detail: leavers.length
        ? `${leavers.length} active account(s) of people who left: ${
          list(leavers, (x) => `${x.email} in ${x.system}`)
        }`
        : `${
          count("SELECT count(*) AS n FROM person WHERE status = 'terminated'")
        } leaver(s), none with an active account`,
      fix:
        "turn the accounts off in each system today; then make offboarding turn them off (identity provider first)",
      subjects: leavers.map((x) => x.uid),
    });
    const orphans = rows(
      `SELECT a.connector AS system, a.display_name AS name, a.user_account_uid AS uid FROM user_account a
       WHERE a.active = 1 AND coalesce(a.service, 0) = 0
       AND NOT EXISTS (SELECT 1 FROM edge e WHERE e.dst_uid = a.user_account_uid AND e.verb = 'has_account')
       ORDER BY a.connector, a.display_name`,
    );
    out.push({
      id: "orphans",
      title: "Every active account belongs to a person on the roster",
      scf: ["IAC-08"],
      status: orphans.length ? "warn" : "pass",
      detail: orphans.length
        ? `${orphans.length} account(s) with no person: ${
          list(orphans, (x) => `${x.name} in ${x.system}`)
        }`
        : "every active account matches a person",
      fix:
        'for each: link it to a person (a login-only system: add it to fleets/<fleet>/estate/links.ts, as "github:alice": "alice@example.org"), or turn it off',
      subjects: orphans.map((x) => x.uid),
    });
    const noDevice = rows(
      `SELECT u.email_addr AS email, u.uid FROM user_inventory u WHERE u.status = 'active'
       AND NOT EXISTS (SELECT 1 FROM party_fixed_asset_assignment a WHERE a.party_uid = u.uid)
       ORDER BY u.email_addr`,
    );
    out.push({
      id: "devices-for-people",
      title: "Every active person has a known device",
      scf: ["AST-04", "AST-07.1"],
      status: noDevice.length ? "warn" : "pass",
      detail: noDevice.length
        ? `${noDevice.length} without a device: ${list(noDevice, (x) => x.email)}`
        : "every active person has a device",
      fix: "adopt each person's laptop (Add a machine), with --owner set to their work email",
      subjects: noDevice.map((x) => x.uid),
    });
  }
  if (count("SELECT count(*) AS n FROM user_account WHERE admin IS NOT NULL AND mfa IS NOT NULL")) {
    const bad = rows(
      `SELECT connector AS system, display_name AS name, user_account_uid AS uid FROM user_account
       WHERE active = 1 AND admin = 1 AND mfa = 0 ORDER BY connector, display_name`,
    );
    out.push({
      id: "admins-mfa",
      title: "Every administrator signs in with a second factor",
      scf: ["IAC-37"],
      status: bad.length ? "fail" : "pass",
      detail: bad.length
        ? `${bad.length} without MFA: ${list(bad, (x) => `${x.name} in ${x.system}`)}`
        : "every administrator has MFA",
      fix: "require MFA for administrators in each system (and register it for these people)",
      subjects: bad.map((x) => x.uid),
    });
  }
  if (count("SELECT count(*) AS n FROM fixed_asset WHERE encrypted IS NOT NULL")) {
    const plain = rows(
      `SELECT hostname AS name, fixed_asset_uid AS uid FROM fixed_asset WHERE encrypted = 0 ORDER BY hostname`,
    );
    out.push({
      id: "devices-encrypted",
      title: "Every device's disk is encrypted",
      scf: ["CRY-07"],
      status: plain.length ? "fail" : "pass",
      detail: plain.length
        ? `${plain.length} not encrypted: ${list(plain, (x) => x.name)}`
        : "every device that says is encrypted",
      fix: "turn on FileVault, BitLocker, or LUKS (or record an accepted risk)",
      subjects: plain.map((x) => x.uid),
    });
  }
  const repos = count("SELECT count(*) AS n FROM code_repository");
  if (repos) {
    const open = rows(
      `SELECT display_name AS name, code_repository_uid AS uid FROM code_repository
       WHERE private = 1 AND protected = 0 ORDER BY display_name`,
    );
    out.push({
      id: "repos-protected",
      title: "Every private repository protects its default branch",
      scf: ["CHG-03"],
      status: open.length ? "fail" : "pass",
      detail: open.length
        ? `${open.length} unprotected: ${list(open, (x) => x.name)}`
        : `${repos} repositories, all protected`,
      fix:
        "protect the default branch: require a pull request, an approving review, and passing checks",
      subjects: open.map((x) => x.uid),
    });
  }
  const at = now.toISOString().replace(/\.\d+Z$/, "Z");
  for (const p of out) {
    for (const control of p.scf) {
      for (const subject of p.subjects.length ? p.subjects : [undefined]) {
        e.db.prepare(upsertSql(finding)).run(...rowParams(finding, {
          finding_uid: `${p.id}:${control}:${subject ?? "all"}`,
          policy_id: p.id,
          subject_uid: subject ?? null,
          scf_control: control,
          status: p.status,
          detail: p.detail,
          fix: p.fix ?? null,
          observed_at: at,
        }));
      }
    }
  }
  return out.map(({ subjects: _, ...p }) => p);
}
