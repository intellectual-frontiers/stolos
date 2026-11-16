/**
 * Spec 087: Slack, read-only, for one workspace: its people (active, owner
 * or admin, guest, whether they have two-factor authentication on), and its
 * channels shared with other organizations (Slack Connect). Evidence for MFA
 * (SCF IAC-37), least privilege (IAC-30), account management (IAC-08), and
 * data protection (DCH-02).
 *
 * Every Slack Web API method used here accepts GET; Slack answers a denied
 * call with HTTP 200 and `ok: false`, so that is turned into a gap here.
 * Slack shows a member's two-factor status only to an admin's or owner's
 * token, and has no API for the workspace's "require two-factor" setting
 * outside Enterprise Grid: the policy is that every member has it on.
 *
 * @module
 */

import { http } from "@intellectual-frontiers/commons/ts/runtime";
import { AccessDenied, check, type Connector, fresh } from "./connector.ts";
import { type Ctx, defineConnector } from "./sdk.ts";
import { ORGANIZATION, USER_ACCOUNT } from "./labels.ts";

/** Slack's Web API. */
export const SLACK_API = "https://slack.com/api";

const FIELDS = {
  token: {
    secret: true,
    hint: "the app's User OAuth Token (xoxp-...), installed by a workspace admin or owner",
  },
};

/** Slack errors that mean the token may not read this. */
const DENIED = new Set([
  "missing_scope",
  "not_allowed_token_type",
  "not_authed",
  "invalid_auth",
  "account_inactive",
  "token_revoked",
  "no_permission",
  "team_access_not_granted",
  "ekm_access_denied",
  "access_denied",
]);

interface SlackBody {
  ok: boolean;
  error?: string;
  needed?: string;
  response_metadata?: { next_cursor?: string };
}

/** A Web API method by GET; `ok: false` is AccessDenied (a denial) or an Error. */
async function slackGet<B>(
  ctx: Ctx<typeof FIELDS>,
  method: string,
  params: Record<string, string> = {},
): Promise<B & SlackBody> {
  const q = new URLSearchParams(params).toString();
  const url = `${SLACK_API}/${method}${q ? `?${q}` : ""}`;
  const b = await ctx.json<B & SlackBody>(url);
  if (!b.ok) {
    const why = `${b.error ?? "error"}${b.needed ? ` (needs ${b.needed})` : ""}`;
    if (DENIED.has(b.error ?? "")) throw new AccessDenied(`${method}: ${why}`);
    throw new Error(`${method}: ${why}`);
  }
  return b;
}

/** Every item of a Slack list method, following `response_metadata.next_cursor`. */
async function* slackPages<T>(
  ctx: Ctx<typeof FIELDS>,
  method: string,
  key: string,
  params: Record<string, string>,
): AsyncGenerator<T> {
  let cursor = "";
  for (let i = 0; i < 200; i++) {
    const b = await slackGet<Record<string, unknown>>(ctx, method, {
      ...params,
      limit: "200",
      ...(cursor ? { cursor } : {}),
    });
    yield* (b[key] as T[] | undefined) ?? [];
    cursor = b.response_metadata?.next_cursor ?? "";
    if (!cursor) return;
  }
}

interface Team {
  id: string;
  name: string;
  domain?: string;
}

interface SlackUser {
  id: string;
  name?: string;
  deleted?: boolean;
  is_bot?: boolean;
  is_app_user?: boolean;
  is_admin?: boolean;
  is_owner?: boolean;
  is_restricted?: boolean;
  is_ultra_restricted?: boolean;
  has_2fa?: boolean;
  profile?: { email?: string; real_name?: string };
}

interface Channel {
  id: string;
  name?: string;
  is_ext_shared?: boolean;
  is_pending_ext_shared?: boolean;
  is_private?: boolean;
}

const NO_2FA = "two-factor status (an admin's or owner's token can read this)";

/** Slack (a workspace). */
export const slack: Connector = defineConnector({
  id: "slack",
  title: "Slack",
  logo: "",
  serviceModels: ["SaaS"],
  markets: ["workstream-collaboration"],
  connectHelp: [
    "api.slack.com/apps > Create New App > From scratch: name it (Stolos read-only) and pick the workspace",
    "OAuth & Permissions > User Token Scopes, all read-only: users:read, users:read.email, team:read, channels:read, groups:read",
    "Install to Workspace, signed in as a workspace admin or owner (Slack shows each member's two-factor status only to an admin's or owner's token)",
    "Copy the User OAuth Token (xoxp-...)",
    "Private channels are listed only when that person is in them; guests need a paid plan; Slack has no API for the require-two-factor setting outside Enterprise Grid",
  ],
  recipe: {
    open: { href: "https://api.slack.com/apps", label: "Make a Slack app with read-only scopes" },
  },
  fields: FIELDS,
  auth: (cred) => Promise.resolve(http.bearer(cred.token)),
  account: (_cred, records) =>
    records.find((r) => r.label === ORGANIZATION.name)?.display_name ?? "slack",
  resources: {
    workspace: {
      label: ORGANIZATION,
      ocsf: "cloud_resources_inventory_info",
      required: true,
      async *list(ctx) {
        yield (await slackGet<{ team: Team }>(ctx, "team.info")).team;
        // Channels shared with other organizations are counted, not kept: posture reads the facts.
        await ctx.orGap("shared channels", undefined, async () => {
          let shared = 0;
          let pending = 0;
          for await (const c of slackPages<Channel>(ctx, "conversations.list", "channels", {
            types: "public_channel,private_channel",
            exclude_archived: "true",
          })) {
            if (c.is_ext_shared) shared++;
            else if (c.is_pending_ext_shared) pending++;
          }
          ctx.fact("externalChannels", shared);
          ctx.fact("pendingExternalChannels", pending);
        });
      },
      map: (t: Team) => ({
        native_id: t.id,
        display_name: t.domain ? `${t.domain}.slack.com` : t.name,
        props: {},
      }),
      asset: () => undefined,
    },
    users: {
      label: USER_ACCOUNT,
      ocsf: "user_inventory",
      required: true,
      async *list(ctx) {
        const users: SlackUser[] = [];
        for await (const u of slackPages<SlackUser>(ctx, "users.list", "members", {})) {
          if (u.id !== "USLACKBOT") users.push(u);
        }
        const people = users.filter((u) => !u.deleted && !u.is_bot && !u.is_app_user);
        ctx.fact("guests", people.filter((u) => u.is_restricted).length);
        if (people.length && people.every((u) => u.has_2fa === undefined)) {
          await ctx.orGap(NO_2FA, undefined, () => {
            throw new AccessDenied("users.list: has_2fa is shown to admins and owners only");
          });
        }
        yield* users;
      },
      map: (u: SlackUser) => ({
        native_id: u.id,
        display_name: u.profile?.email || u.name || u.id,
        props: {
          ...(u.profile?.email ? { email: u.profile.email.toLowerCase() } : {}),
          active: !u.deleted,
          admin: !!(u.is_admin || u.is_owner),
          ...(u.has_2fa !== undefined ? { mfa: u.has_2fa } : {}),
          ...(u.is_bot || u.is_app_user ? { service: true } : {}),
        },
      }),
      asset: (u: SlackUser) => ({
        kind: "user",
        facts: {
          admin: !!(u.is_admin || u.is_owner),
          owner: !!u.is_owner,
          guest: !!u.is_restricted,
        },
      }),
    },
  },
  posture(records, _cred, { gaps }) {
    const people = records.filter(
      (r) => r.label === USER_ACCOUNT.name && r.props["active"] && !r.props["service"],
    );
    const read = (what: string) => !gaps.some((g) => g.startsWith(`${what}: `));
    return {
      members: people.length,
      admins: people.filter((r) => r.props["admin"]).length,
      ...(read(NO_2FA) && people.some((r) => typeof r.props["mfa"] === "boolean")
        ? { membersWithout2fa: people.filter((r) => r.props["mfa"] === false).length }
        : {}),
    };
  },
  policies(o, now) {
    return [
      fresh(o, now, "slack"),
      check(o, {
        id: "slack-2fa",
        title: "Every member has two-factor authentication on",
        scf: ["IAC-37"],
        fact: "membersWithout2fa",
        want: (v) => v === 0,
        show: (v) => `${v} of ${o.posture["members"]} members without it`,
        fix: "Slack > Workspace settings > Authentication > Two-factor authentication: require it for everyone (or sign in through your identity provider)",
      }),
      check(o, {
        id: "slack-admins",
        title: "Two to four owners and admins",
        scf: ["IAC-30"],
        fact: "admins",
        want: (v) => typeof v === "number" && v >= 2 && v <= 4,
        fix: "Slack > Manage members: change the account type of those who need no admin rights",
        warnOnly: true,
      }),
      check(o, {
        id: "slack-external",
        title: "No channel is shared with outside organizations (or each one is reviewed)",
        scf: ["DCH-02"],
        fact: "externalChannels",
        want: (v) => v === 0,
        show: (v) => `${v} channel(s) shared with outside organizations`,
        fix: "review each Slack Connect channel and disconnect those no longer needed; Admin > Slack Connect: require admin approval for new ones",
        warnOnly: true,
      }),
    ];
  },
});
