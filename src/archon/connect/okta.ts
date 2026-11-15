/**
 * Spec 086: Okta, read-only: its users (active, suspended, deprovisioned),
 * who holds an administrator role, and who has enrolled a second factor.
 * Evidence for account management and MFA (SCF IAC-37, IAC-08, IAC-30).
 *
 * @module
 */

import { check, type Connector, fresh, type Http, linkPages, orGap } from "./connector.ts";
import type { Account } from "./entities.ts";

interface OktaUser {
  id: string;
  status: string;
  lastLogin?: string | null;
  profile: { login: string; email?: string; firstName?: string; lastName?: string };
}

/** Okta. */
export const okta: Connector = {
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
  fields: [
    { name: "domain", secret: false, hint: "your Okta domain (example.okta.com)" },
    { name: "token", secret: true, hint: "the API token of a Read-Only Administrator" },
  ],
  async observe(cred, http: Http, now) {
    const base = `https://${cred.domain.replace(/^https?:\/\//, "").replace(/\/$/, "")}`;
    const h = { Authorization: `SSWS ${cred.token}`, Accept: "application/json" };
    const gaps: string[] = [];
    const users = await linkPages<OktaUser>(http, `${base}/api/v1/users?limit=200`, h);
    const admins = await orGap(
      gaps,
      "administrators",
      undefined as Array<{ id: string }> | undefined,
      () => linkPages(http, `${base}/api/v1/iam/assignees/users?limit=200`, h),
    );
    const adminIds = new Set((admins ?? []).map((a) => a.id));
    const active = users.filter((u) =>
      u.status === "ACTIVE" || u.status === "PASSWORD_EXPIRED" || u.status === "RECOVERY" ||
      u.status === "LOCKED_OUT"
    );
    const mfa = new Map<string, boolean>();
    for (const u of active.slice(0, 1000)) {
      const f = await orGap(
        gaps,
        "factors",
        undefined as Array<{ status: string }> | undefined,
        () => linkPages(http, `${base}/api/v1/users/${u.id}/factors`, h),
      );
      if (f) mfa.set(u.id, f.some((x) => x.status === "ACTIVE"));
    }
    const accounts: Account[] = users.map((u) => ({
      system: "okta",
      id: u.id,
      name: u.profile.login,
      email: (u.profile.email ?? u.profile.login).toLowerCase(),
      active: active.includes(u),
      ...(admins ? { admin: adminIds.has(u.id) } : {}),
      ...(mfa.has(u.id) ? { mfa: mfa.get(u.id)! } : {}),
      ...(u.lastLogin ? { lastLogin: u.lastLogin } : {}),
    }));
    return {
      at: now.toISOString().replace(/\.\d+Z$/, "Z"),
      provider: "okta",
      account: cred.domain,
      assets: users.map((u) => ({
        kind: "user",
        id: u.id,
        name: u.profile.login,
        facts: { status: u.status, admin: adminIds.has(u.id) },
      })),
      posture: {
        activeUsers: active.length,
        ...(mfa.size
          ? { activeWithoutMfa: active.filter((u) => mfa.get(u.id) === false).length }
          : {}),
        ...(admins ? { admins: admins.length } : {}),
      },
      gaps: [...new Set(gaps)],
      entities: { accounts },
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
};
