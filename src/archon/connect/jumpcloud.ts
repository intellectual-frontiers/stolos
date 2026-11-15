/**
 * Spec 091: JumpCloud (directory, SSO, and device management), read-only:
 * its users (active, suspended, and whether they have enrolled a second
 * factor), its console administrators (and whether they use one), and its
 * devices (operating system, serial number, disk encryption, last contact).
 * Evidence for MFA (SCF IAC-37), least privilege (IAC-30), account
 * management (IAC-08), and encryption at rest (CRY-07).
 *
 * Credential: the API key of a dedicated administrator with JumpCloud's
 * Read Only role (the key acts with that administrator's rights).
 *
 * @module
 */

import { check, type Connector, fresh } from "./connector.ts";
import { HARDWARE_DEVICE, USER_ACCOUNT } from "./labels.ts";
import { type Ctx, defineConnector } from "./sdk.ts";

interface SystemUser {
  _id: string;
  username: string;
  email?: string;
  activated?: boolean;
  suspended?: boolean;
  state?: string;
  account_locked?: boolean;
  totp_enabled?: boolean;
  mfa?: { configured?: boolean };
  mfaEnrollment?: { overallStatus?: string };
}

interface Admin {
  _id: string;
  email: string;
  enableMultiFactor?: boolean;
  totpEnrolled?: boolean;
  roleName?: string;
  suspended?: boolean;
}

interface JcSystem {
  _id: string;
  displayName?: string;
  hostname?: string;
  os?: string;
  version?: string;
  serialNumber?: string;
  lastContact?: string | null;
  fde?: { active?: boolean } | null;
}

const FIELDS = {
  host: { secret: false, hint: "console.jumpcloud.com (or console.eu.jumpcloud.com)" },
  key: { secret: true, hint: "the API key of a Read Only administrator" },
};

/** The console's address (console.jumpcloud.com, or console.eu.jumpcloud.com). */
const base = (host: string) =>
  `https://${(host || "console.jumpcloud.com").replace(/^https?:\/\//, "").replace(/\/$/, "")}`;

/** Every item of a JumpCloud v1 list (`limit` and `skip`, `{ totalCount, results }`). */
function skipPages<T>(ctx: Ctx<typeof FIELDS>, path: string): AsyncGenerator<T> {
  const at = (skip: number) => `${base(ctx.cred.host)}${path}?limit=100&skip=${skip}`;
  return ctx.cursorPages<{ totalCount?: number; results?: T[] }, T>(
    at(0),
    (b) => b.results,
    (b, url) => {
      const skip = Number(new URL(url).searchParams.get("skip")) + 100;
      return (b.results?.length ?? 0) === 100 && skip < (b.totalCount ?? Infinity)
        ? at(skip)
        : undefined;
    },
  );
}

const userActive = (u: SystemUser) =>
  u.activated !== false && !u.suspended && u.state !== "SUSPENDED" && u.state !== "STAGED";
const userMfa = (u: SystemUser) =>
  u.mfaEnrollment?.overallStatus === "ENROLLED" || u.mfa?.configured === true ||
  u.totp_enabled === true;

/** JumpCloud. */
export const jumpcloud: Connector = defineConnector({
  id: "jumpcloud",
  title: "JumpCloud",
  logo: "",
  serviceModels: ["SaaS"],
  markets: ["access-management"],
  connectHelp: [
    "JumpCloud Admin Portal > Settings > Administrators > add a dedicated administrator with the Read Only role",
    "Signed in as that administrator: your name (top right) > My API Key > Generate New API Key (it acts with the Read Only role's rights)",
    "Copy the key, and your console's address (console.jumpcloud.com, or console.eu.jumpcloud.com in the EU)",
  ],
  recipe: {
    open: { href: "https://console.jumpcloud.com", label: "JumpCloud Admin Portal" },
  },
  fields: FIELDS,
  auth: (cred) => Promise.resolve({ "x-api-key": cred.key, Accept: "application/json" }),
  account: (cred) => cred.host || "console.jumpcloud.com",
  resources: {
    users: {
      label: USER_ACCOUNT,
      ocsf: "user_inventory",
      list: (ctx) => skipPages<SystemUser>(ctx, "/api/systemusers"),
      map: (u: SystemUser) => ({
        native_id: u._id,
        display_name: u.username,
        props: {
          ...(u.email ? { email: u.email.toLowerCase() } : {}),
          active: userActive(u),
          admin: false,
          mfa: userMfa(u),
        },
      }),
      asset: (u: SystemUser) => ({
        kind: "user",
        facts: { state: u.state ?? (u.suspended ? "SUSPENDED" : "ACTIVATED"), mfa: userMfa(u) },
      }),
    },
    administrators: {
      label: USER_ACCOUNT,
      ocsf: "user_inventory",
      list: (ctx) => skipPages<Admin>(ctx, "/api/users"),
      map: (a: Admin) => ({
        native_id: `admin:${a._id}`,
        display_name: a.email,
        props: {
          email: a.email.toLowerCase(),
          active: !a.suspended,
          admin: true,
          mfa: a.totpEnrolled ?? a.enableMultiFactor === true,
        },
      }),
      asset: (a: Admin) => ({
        kind: "administrator",
        facts: { role: a.roleName ?? "", mfa: a.totpEnrolled ?? a.enableMultiFactor === true },
      }),
    },
    devices: {
      label: HARDWARE_DEVICE,
      ocsf: "inventory_info",
      list: (ctx) => skipPages<JcSystem>(ctx, "/api/systems"),
      map: (s: JcSystem) => ({
        native_id: s._id,
        display_name: s.displayName || s.hostname || s._id,
        props: {
          ...(s.os ? { os_name: [s.os, s.version].filter(Boolean).join(" ") } : {}),
          ...(s.serialNumber ? { serial_number: s.serialNumber } : {}),
          ...(s.fde && typeof s.fde.active === "boolean" ? { encrypted: s.fde.active } : {}),
          ...(s.lastContact ? { last_seen: s.lastContact } : {}),
        },
      }),
      asset: (s: JcSystem) => ({
        kind: "device",
        facts: { os: s.os ?? "", encrypted: s.fde?.active === true },
      }),
    },
  },
  posture(records) {
    const users = records.filter((r) => r.label === "user_account" && !r.props.admin);
    const admins = records.filter((r) => r.label === "user_account" && r.props.admin);
    const active = users.filter((r) => r.props.active);
    const devices = records.filter((r) => r.label === "hardware_device");
    const fdeKnown = devices.filter((d) => d.props.encrypted !== undefined);
    return {
      activeUsers: active.length,
      ...(users.length ? { activeWithoutMfa: active.filter((r) => !r.props.mfa).length } : {}),
      ...(admins.length
        ? {
          admins: admins.filter((r) => r.props.active).length,
          adminsWithoutMfa: admins.filter((r) => r.props.active && !r.props.mfa).length,
        }
        : {}),
      devices: devices.length,
      ...(fdeKnown.length
        ? { devicesUnencrypted: fdeKnown.filter((d) => d.props.encrypted === false).length }
        : {}),
    };
  },
  policies(o, now) {
    return [
      fresh(o, now, "jumpcloud"),
      check(o, {
        id: "jumpcloud-mfa",
        title: "Every active user has a second factor",
        scf: ["IAC-37"],
        fact: "activeWithoutMfa",
        want: (v) => v === 0,
        show: (v) => `${v} of ${o.posture.activeUsers} active users without one`,
        fix:
          "JumpCloud > User Management > Users: require MFA for the User Portal and in a Conditional Access policy, and ask each user to enroll",
      }),
      check(o, {
        id: "jumpcloud-admin-mfa",
        title: "Every administrator uses a second factor",
        scf: ["IAC-37"],
        fact: "adminsWithoutMfa",
        want: (v) => v === 0,
        show: (v) => `${v} of ${o.posture.admins} administrators without one`,
        fix: "JumpCloud > Settings > Administrators: require MFA for each administrator",
      }),
      check(o, {
        id: "jumpcloud-admins",
        title: "Two to four administrators",
        scf: ["IAC-30"],
        fact: "admins",
        want: (v) => typeof v === "number" && v >= 2 && v <= 4,
        fix: "JumpCloud > Settings > Administrators: remove administrators nobody needs",
        warnOnly: true,
      }),
      check(o, {
        id: "jumpcloud-disk-encryption",
        title: "Every device encrypts its disk",
        scf: ["CRY-07"],
        fact: "devicesUnencrypted",
        want: (v) => v === 0,
        show: (v) => `${v} of ${o.posture.devices} devices unencrypted`,
        fix:
          "JumpCloud > Device Management > Policy Management: add the FileVault (macOS) and BitLocker (Windows) policies to every device",
      }),
    ];
  },
});
