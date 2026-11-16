/**
 * Spec 086, declared with spec 091's SDK: Google Workspace, read-only, through the Admin SDK Directory
 * API: its users (suspended or not, administrators, enrolled in 2-Step
 * Verification, last sign-in). It signs in as a service account with
 * domain-wide delegation for one read-only scope, impersonating an
 * administrator; the JWT is signed here (RS256, WebCrypto), with no SDK.
 * Evidence for MFA, account management, and least privilege (SCF IAC-37,
 * IAC-08, IAC-30).
 *
 * @module
 */
// Spec: 086-wave1-connectors

import { http } from "@intellectual-frontiers/commons/ts/runtime";
import { check, type Connector, fresh } from "./connector.ts";
import { defineConnector, sendJson } from "./sdk.ts";
import { USER_ACCOUNT } from "./labels.ts";

const TOKEN = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/admin.directory.user.readonly";

const b64url = (b: Uint8Array | string) =>
  btoa(typeof b === "string" ? unescape(encodeURIComponent(b)) : String.fromCharCode(...b))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

/** A signed JWT assertion for Google's token endpoint (RS256). */
export async function serviceAccountJwt(
  key: { client_email: string; private_key: string },
  subject: string,
  scope: string,
  now: Date,
): Promise<string> {
  const iat = Math.floor(now.getTime() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(
    JSON.stringify({
      iss: key.client_email,
      sub: subject,
      scope,
      aud: "https://oauth2.googleapis.com/token",
      iat,
      exp: iat + 3600,
    }),
  );
  const pem = key.private_key.replace(/-----[A-Z ]+-----/g, "").replace(/\s+/g, "");
  const der = Uint8Array.from(atob(pem), (c) => c.charCodeAt(0));
  const k = await crypto.subtle.importKey(
    "pkcs8",
    der,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = new Uint8Array(
    await crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      k,
      new TextEncoder().encode(`${header}.${claims}`),
    ),
  );
  return `${header}.${claims}.${b64url(sig)}`;
}

interface GUser {
  id: string;
  primaryEmail: string;
  suspended?: boolean;
  archived?: boolean;
  isAdmin?: boolean;
  isDelegatedAdmin?: boolean;
  isEnrolledIn2Sv?: boolean;
  isEnforcedIn2Sv?: boolean;
  lastLoginTime?: string;
}

/** Google Workspace. */
export const google: Connector = defineConnector({
  id: "google",
  title: "Google Workspace",
  logo: "google",
  serviceModels: ["SaaS"],
  markets: ["access-management"],
  connectHelp: [
    "console.cloud.google.com > a project for Stolos > APIs & Services: enable the Admin SDK API",
    "IAM & Admin > Service accounts > Create (no roles) > Keys > Add key > JSON: a key file downloads",
    `admin.google.com > Security > Access and data control > API controls > Domain-wide delegation > Add new: the service account's client ID, scope ${SCOPE} (read only)`,
    "The email of an administrator for it to act as (it only reads)",
  ],
  recipe: {
    open: {
      href: "https://admin.google.com/ac/owl/domainwidedelegation",
      label: "Open domain-wide delegation",
    },
  },
  fields: {
    admin: {
      secret: false,
      hint: "an administrator's email (the service account reads as them)",
    },
    key: {
      secret: true,
      file: true,
      hint: "the service account's JSON key file (its path)",
    },
  },
  tokenEndpoints: () => [TOKEN],
  async auth(cred, t, now) {
    const key = JSON.parse(cred.key) as { client_email: string; private_key: string };
    const assertion = await serviceAccountJwt(key, cred.admin, SCOPE, now);
    const tok = await sendJson<{ access_token: string }>(
      t,
      TOKEN,
      { "Content-Type": "application/x-www-form-urlencoded" },
      "POST",
      new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion,
      }).toString(),
    );
    return http.bearer(tok.access_token);
  },
  account: (cred) => cred.admin.split("@")[1] ?? "Google Workspace",
  resources: {
    users: {
      label: USER_ACCOUNT,
      ocsf: "user_inventory",
      required: true,
      async *list(ctx) {
        let page: string | undefined;
        for (let i = 0; i < 50; i++) {
          const r = await ctx.json<{ users?: GUser[]; nextPageToken?: string }>(
            `https://admin.googleapis.com/admin/directory/v1/users?customer=my_customer&maxResults=500${
              page ? `&pageToken=${encodeURIComponent(page)}` : ""
            }`,
          );
          yield* r.users ?? [];
          if (!(page = r.nextPageToken)) break;
        }
      },
      map: (u: GUser) => ({
        native_id: u.id,
        display_name: u.primaryEmail,
        props: {
          email: u.primaryEmail.toLowerCase(),
          active: !u.suspended && !u.archived,
          admin: !!u.isAdmin,
          mfa: !!u.isEnrolledIn2Sv,
          mfa_enforced: !!u.isEnforcedIn2Sv,
          ...(u.lastLoginTime && !u.lastLoginTime.startsWith("1970")
            ? { last_login: u.lastLoginTime }
            : {}),
        },
      }),
      asset: (u: GUser) => ({
        kind: "user",
        facts: { suspended: !!u.suspended, admin: !!u.isAdmin, twoStep: !!u.isEnrolledIn2Sv },
      }),
    },
  },
  posture(records) {
    const active = records.filter((r) => r.props["active"]);
    return {
      activeUsers: active.length,
      activeWithout2sv: active.filter((r) => !r.props["mfa"]).length,
      activeNotEnforced2sv: active.filter((r) => !r.props["mfa_enforced"]).length,
      superAdmins: active.filter((r) => r.props["admin"]).length,
    };
  },
  policies(o, now) {
    const of = (v: string | number | boolean) => `${v} of ${o.posture["activeUsers"]} active users`;
    return [
      fresh(o, now, "google"),
      check(o, {
        id: "gws-2sv-enrolled",
        title: "Every active user uses 2-Step Verification",
        scf: ["IAC-37"],
        fact: "activeWithout2sv",
        want: (v) => v === 0,
        show: (v) => `${of(v)} not enrolled`,
        fix: "ask each person to turn on 2-Step Verification (myaccount.google.com/security)",
      }),
      check(o, {
        id: "gws-2sv-enforced",
        title: "2-Step Verification is enforced",
        scf: ["IAC-37"],
        fact: "activeNotEnforced2sv",
        want: (v) => v === 0,
        show: (v) => `${of(v)} not enforced`,
        fix: "admin.google.com > Security > Authentication > 2-Step Verification: Enforcement on",
        warnOnly: true,
      }),
      check(o, {
        id: "gws-super-admins",
        title: "Two to four super administrators",
        scf: ["IAC-30"],
        fact: "superAdmins",
        want: (v) => typeof v === "number" && v >= 2 && v <= 4,
        fix: "admin.google.com > Account > Admin roles > Super Admin: remove those who do not need it",
        warnOnly: true,
      }),
    ];
  },
});
