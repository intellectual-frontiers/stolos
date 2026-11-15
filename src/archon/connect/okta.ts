/**
 * Spec 086, declared with spec 091's SDK: Okta, read-only: its users
 * (active, suspended, deprovisioned), who holds an administrator role, and
 * who has enrolled a second factor. Evidence for account management and MFA
 * (SCF IAC-37, IAC-08, IAC-30). Spec 080: its app integrations, so the
 * vendors people sign in to are discovered.
 *
 * @module
 */

import { check, type Connector, fresh } from "./connector.ts";
import { bearer, defineConnector } from "./sdk.ts";
import { APPLICATION, USER_ACCOUNT } from "./labels.ts";

interface OktaUser {
  id: string;
  status: string;
  lastLogin?: string | null;
  profile: { login: string; email?: string };
  /** Added here: whether they hold an administrator role (undefined: the roles could not be read). */
  admin?: boolean;
  /** Added here: whether they have an active second factor (undefined: not read). */
  mfa?: boolean;
}

/** An Okta app integration (GET /api/v1/apps). */
interface OktaApp {
  id: string;
  /** Its catalog name (salesforce, slack, or <org>_<app>_1 for a custom one). */
  name: string;
  /** Its name for people. */
  label: string;
  status: string;
  signOnMode?: string;
}

/** Okta's own apps (its dashboard, admin console, browser plugin, workflows): not vendors. */
const oktaOwn = (name: string) => /^(okta_|saasure$|flow$)/.test(name);

const ACTIVE = new Set(["ACTIVE", "PASSWORD_EXPIRED", "RECOVERY", "LOCKED_OUT"]);
const base = (domain: string) => `https://${domain.replace(/^https?:\/\//, "").replace(/\/$/, "")}`;

/** Okta. */
export const okta: Connector = defineConnector({
  id: "okta",
  title: "Okta",
  logo: "okta",
  serviceModels: ["SaaS"],
  markets: ["access-management"],
  connectHelp: [
    "Okta Admin Console > Security > Administrators > Add administrator: a dedicated user with the Read-Only Administrator role",
    "Signed in as that user: Security > API > Tokens > Create token (it acts with that user's read-only rights)",
    "Copy the token, and your Okta domain (for example example.okta.com)",
  ],
  recipe: {},
  fields: {
    domain: { secret: false, hint: "your Okta domain (example.okta.com)" },
    token: { secret: true, hint: "the API token of a Read-Only Administrator" },
  },
  auth: (cred) => Promise.resolve(bearer(cred.token, "SSWS")),
  account: (cred) => cred.domain,
  resources: {
    users: {
      label: USER_ACCOUNT,
      ocsf: "user_inventory",
      async *list(ctx) {
        const b = base(ctx.cred.domain);
        const users: OktaUser[] = [];
        for await (const u of ctx.linkPages<OktaUser>(`${b}/api/v1/users?limit=200`)) users.push(u);
        const admins = await ctx.orGap(
          "administrators",
          undefined as Set<string> | undefined,
          async () => {
            const ids = new Set<string>();
            for await (
              const a of ctx.linkPages<{ id: string }>(`${b}/api/v1/iam/assignees/users?limit=200`)
            ) {
              ids.add(a.id);
            }
            return ids;
          },
        );
        for (const [i, u] of users.entries()) {
          const active = ACTIVE.has(u.status);
          let mfa: boolean | undefined;
          if (active && i < 1000) {
            mfa = await ctx.orGap("factors", undefined as boolean | undefined, async () => {
              for await (
                const f of ctx.linkPages<{ status: string }>(`${b}/api/v1/users/${u.id}/factors`)
              ) {
                if (f.status === "ACTIVE") return true;
              }
              return false;
            });
          }
          yield {
            ...u,
            ...(admins ? { admin: admins.has(u.id) } : {}),
            ...(mfa !== undefined ? { mfa } : {}),
          };
        }
      },
      map: (u: OktaUser) => ({
        native_id: u.id,
        display_name: u.profile.login,
        props: {
          email: (u.profile.email ?? u.profile.login).toLowerCase(),
          active: ACTIVE.has(u.status),
          ...(u.admin !== undefined ? { admin: u.admin } : {}),
          ...(u.mfa !== undefined ? { mfa: u.mfa } : {}),
          ...(u.lastLogin ? { last_login: u.lastLogin } : {}),
        },
      }),
      asset: (u: OktaUser) => ({ kind: "user", facts: { status: u.status, admin: !!u.admin } }),
    },
    // Spec 080: the app integrations people sign in to (a Read-Only Administrator may list them),
    // so the vendors behind them are discovered. Okta's own apps (its dashboard, its admin
    // console, its browser plugin) are not vendors.
    apps: {
      label: APPLICATION,
      ocsf: "cloud_resources_inventory_info",
      async *list(ctx) {
        const b = base(ctx.cred.domain);
        for await (const a of ctx.linkPages<OktaApp>(`${b}/api/v1/apps?limit=200`)) {
          if (!oktaOwn(a.name)) yield a;
        }
      },
      map: (a: OktaApp) => ({
        native_id: a.id,
        display_name: a.label,
        props: {
          catalog_name: a.name,
          active: a.status === "ACTIVE",
          ...(a.signOnMode ? { sign_on_mode: a.signOnMode } : {}),
        },
      }),
      asset: (a: OktaApp) => ({
        kind: "sso-application",
        facts: { status: a.status, signOn: a.signOnMode ?? "?" },
      }),
    },
  },
  posture(all) {
    const records = all.filter((r) => r.label === USER_ACCOUNT.name);
    const active = records.filter((r) => r.props.active);
    const mfaKnown = active.some((r) => r.props.mfa !== undefined);
    const adminKnown = records.some((r) => r.props.admin !== undefined);
    return {
      activeUsers: active.length,
      ...(mfaKnown ? { activeWithoutMfa: active.filter((r) => r.props.mfa === false).length } : {}),
      ...(adminKnown ? { admins: records.filter((r) => r.props.admin).length } : {}),
    };
  },
  policies(o, now) {
    return [
      fresh(o, now, "okta"),
      check(o, {
        id: "okta-mfa",
        title: "Every active user has a second factor",
        scf: ["IAC-37"],
        fact: "activeWithoutMfa",
        want: (v) => v === 0,
        show: (v) => `${v} of ${o.posture.activeUsers} active users without one`,
        fix: "Okta > Security > Authenticators > Enrollment: require a second factor for everyone",
      }),
      check(o, {
        id: "okta-admins",
        title: "Two to four administrators",
        scf: ["IAC-30"],
        fact: "admins",
        want: (v) => typeof v === "number" && v >= 2 && v <= 4,
        fix: "Okta > Security > Administrators: remove roles nobody needs",
        warnOnly: true,
      }),
    ];
  },
});
