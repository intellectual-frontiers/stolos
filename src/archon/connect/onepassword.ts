/**
 * Spec 087: 1Password (Business or Enterprise Password Manager), read-only,
 * for one account: its people (active, suspended, or not yet joined), read
 * with the 1Password Users API and an OAuth application that holds only the
 * `users.view` scope. The estate graph joins them to the roster: every
 * active person has a 1Password account (coverage), and nobody who left
 * still has an active one. Evidence for account management (SCF IAC-08).
 *
 * 1Password's limits: the Users API shows neither who is an owner or
 * administrator, nor two-factor status, nor vaults and who can open them
 * (1Password keeps those in its admin console, its command line tool, and
 * its SDKs, which act with a person's or a service account's own access,
 * never read-only). It is in public preview, works with Business and
 * Enterprise accounts only, and not alongside automated provisioning (SCIM).
 *
 * @module
 */

import { check, type Connector, fresh, type Observation } from "./connector.ts";
import { clientCredentials, defineConnector } from "./sdk.ts";
import { USER_ACCOUNT } from "./labels.ts";

const FIELDS = {
  region: {
    secret: false,
    hint: "where the account is: 1password.com, 1password.ca, 1password.eu, or ent.1password.com",
  },
  account: { secret: false, hint: "the account ID (26 letters and digits, in Settings)" },
  client_id: { secret: false, hint: "the OAuth application's client ID" },
  client_secret: { secret: true, hint: "the OAuth application's client secret (users.view only)" },
};

/**
 * The Users API base for where the account is: 1password.com, 1password.ca,
 * 1password.eu, or ent.1password.com (a sign-in address such as
 * example.1password.eu works too).
 */
export function onePasswordApi(region: string): string {
  const r = region
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "");
  const known = ["ent.1password.com", "1password.ca", "1password.eu", "1password.com"];
  const hit = known.find((k) => r === k || r.endsWith(`.${k}`));
  return `https://api.${hit ?? "1password.com"}`;
}

interface OpUser {
  id: string;
  email?: string;
  display_name?: string;
  state?: string;
  create_time?: string;
}

/** 1Password (an account). */
export const onepassword: Connector = defineConnector({
  id: "onepassword",
  title: "1Password",
  logo: "1password",
  serviceModels: ["SaaS"],
  markets: ["secrets-management"],
  connectHelp: [
    "Needs 1Password Business or Enterprise Password Manager, without automated provisioning (SCIM): 1Password's Users API does not work alongside it",
    "Sign in to 1Password.com as an owner or administrator > Integrations (or Directory) > OAuth Application",
    "Grant type: Client credentials; name it Stolos read-only; scopes: users.view only (read; leave users.suspend and users.reactivate off)",
    "Copy the client ID and secret (the secret is shown once), your account ID, and where the account is (1password.com, 1password.ca, 1password.eu, ent.1password.com)",
    "1Password's Users API is in preview, and it does not show roles, two-factor status, or vaults: check those in the admin console (Policies > Two-factor authentication; Reports). The estate graph checks that every active person has an account",
  ],
  recipe: {
    open: {
      href: "https://start.1password.com/integrations/directory",
      label: "Make an OAuth application with users.view only",
    },
  },
  fields: FIELDS,
  tokenEndpoints: (cred) => [`${onePasswordApi(cred.region)}/v1/oauth/token`],
  auth: (cred, http) =>
    clientCredentials(
      http,
      `${onePasswordApi(cred.region)}/v1/oauth/token`,
      cred.client_id,
      cred.client_secret,
    ),
  account: (cred) => cred.account,
  resources: {
    users: {
      label: USER_ACCOUNT,
      ocsf: "user_inventory",
      async *list(ctx) {
        const first = `${onePasswordApi(ctx.cred.region)}/v1/accounts/${encodeURIComponent(
          ctx.cred.account,
        )}/users?max_page_size=1000`;
        let pending = 0;
        for await (const u of ctx.cursorPages<
          { results?: OpUser[]; next_page_token?: string },
          OpUser
        >(
          first,
          (b) => b.results,
          (b) =>
            b.next_page_token
              ? `${first}&page_token=${encodeURIComponent(b.next_page_token)}`
              : undefined,
        )) {
          // No state: invited and not yet joined, or in account recovery.
          if (!u.state) pending++;
          yield u;
        }
        ctx.fact("pendingMembers", pending);
      },
      map: (u: OpUser) => ({
        native_id: u.id,
        display_name: u.email || u.display_name || u.id,
        props: {
          ...(u.email ? { email: u.email.toLowerCase() } : {}),
          active: u.state === "ACTIVE",
        },
      }),
      asset: (u: OpUser) => ({
        kind: "user",
        facts: { state: (u.state ?? "pending").toLowerCase() },
      }),
    },
  },
  posture(records, _cred, { gaps }): Observation["posture"] {
    if (gaps.some((g) => g.startsWith("users: "))) return {};
    const users = records.filter((r) => r.label === USER_ACCOUNT.name);
    return { activeMembers: users.filter((r) => r.props["active"]).length, members: users.length };
  },
  policies(o, now) {
    return [
      fresh(o, now, "onepassword"),
      check(o, {
        id: "onepassword-members",
        title: "The account has active members",
        scf: ["IAC-08"],
        fact: "activeMembers",
        want: (v) => typeof v === "number" && v > 0,
        fix: "invite your people to 1Password (Admin console > People), or check the account ID",
      }),
      check(o, {
        id: "onepassword-pending",
        title: "Everyone invited has joined (or the invitation is withdrawn)",
        scf: ["IAC-08"],
        fact: "pendingMembers",
        want: (v) => v === 0,
        show: (v) => `${v} not yet joined (or in recovery)`,
        fix: "1Password > People: resend or remove each pending invitation",
        warnOnly: true,
      }),
    ];
  },
});
