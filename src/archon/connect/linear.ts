/**
 * Spec 087: Linear, read-only: the workspace (whether sign-in goes through
 * SAML), its people (active, admin, guest, last seen), and the last 90 days
 * of issues: each one's identifier, type (change, incident, or other, from
 * its labels and team), status, created and completed times, and the commits
 * and pull requests attached to it (Linear's GitHub, GitLab, and Bitbucket
 * integrations attach them). Evidence for change control (SCF CHG-03), least
 * privilege (IAC-30), and MFA through the identity provider (IAC-37).
 *
 * Linear's API is GraphQL only, and GraphQL is sent by POST: the read-only
 * guard lets POST reach the GraphQL endpoint alone, and this connector sends
 * it queries only (a mutation is refused before it leaves). The key itself
 * is made with Linear's Read permission only.
 *
 * @module
 */

import type { http } from "@intellectual-frontiers/commons/ts/runtime";
import { AccessDenied, check, type Connector, fresh } from "./connector.ts";
import { type Ctx, defineConnector, exchange } from "./sdk.ts";
import { ORGANIZATION, TICKET, USER_ACCOUNT } from "./labels.ts";
import {
  daysBefore,
  devLinks,
  TICKET_DAYS,
  TICKET_MAX,
  ticketPolicies,
  ticketPosture,
  ticketType,
} from "./ticketing.ts";

/** Linear's GraphQL endpoint. */
export const LINEAR_GRAPHQL = "https://api.linear.app/graphql";

const FIELDS = {
  token: { secret: true, hint: "a personal API key with the Read permission only" },
};

/** One GraphQL query (never a mutation); a denial is AccessDenied. */
export async function linearQuery<T>(
  ctx: { http: http.Transport; headers: Record<string, string> },
  query: string,
  variables: Record<string, unknown> = {},
): Promise<T> {
  if (!/^\s*query\b/.test(query)) throw new Error("read-only: only GraphQL queries are sent");
  const r = await exchange(ctx.http, {
    method: "POST",
    url: LINEAR_GRAPHQL,
    headers: { ...ctx.headers, "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  type Body = { data?: T; errors?: Array<{ message?: string; extensions?: { code?: string } }> };
  let b: Body | undefined;
  try {
    b = JSON.parse(r.body) as Body;
  } catch {
    b = undefined;
  }
  const codes = (b?.errors ?? []).map((e) => e.extensions?.code ?? "").join(" ");
  if (r.status === 401 || r.status === 403 || /AUTHENTICATION|FORBIDDEN/.test(codes)) {
    throw new AccessDenied(`graphql: ${r.status} (the key may not read this)`);
  }
  if (r.status >= 400 || !b?.data) {
    throw new Error(`graphql: HTTP ${r.status} ${b?.errors?.[0]?.message ?? ""}`.trim());
  }
  return b.data;
}

/** Every node of a connection, paging with `pageInfo`. */
async function* nodes<T>(
  ctx: Ctx<typeof FIELDS>,
  query: string,
  pick: (d: unknown) => { nodes: T[]; pageInfo: { hasNextPage: boolean; endCursor?: string } },
  variables: Record<string, unknown> = {},
  max = 10_000,
): AsyncGenerator<T> {
  let after: string | undefined;
  let n = 0;
  for (let i = 0; i < 200; i++) {
    const c = pick(await linearQuery(ctx, query, { ...variables, after: after ?? null }));
    for (const x of c.nodes) {
      if (n++ >= max) return;
      yield x;
    }
    if (!c.pageInfo.hasNextPage || !c.pageInfo.endCursor) return;
    after = c.pageInfo.endCursor;
  }
}

interface LinearOrg {
  id: string;
  name: string;
  urlKey?: string;
  samlEnabled?: boolean;
}

interface LinearUser {
  id: string;
  name?: string;
  email?: string;
  active?: boolean;
  admin?: boolean;
  guest?: boolean;
  lastSeen?: string | null;
}

interface LinearIssue {
  identifier: string;
  title?: string;
  url?: string;
  createdAt?: string;
  completedAt?: string | null;
  canceledAt?: string | null;
  state?: { name?: string };
  team?: { key?: string; name?: string };
  labels?: { nodes: Array<{ name: string }> };
  attachments?: { nodes: Array<{ url?: string; sourceType?: string | null }> };
}

const USERS = `query Users($after: String) {
  users(first: 100, after: $after, includeDisabled: true) {
    nodes { id name email active admin guest lastSeen }
    pageInfo { hasNextPage endCursor }
  }
}`;

const ISSUES = `query Issues($after: String, $since: DateTimeOrDuration) {
  issues(first: 100, after: $after, filter: { createdAt: { gte: $since } }, orderBy: createdAt) {
    nodes {
      identifier title url createdAt completedAt canceledAt
      state { name } team { key name }
      labels { nodes { name } }
      attachments { nodes { url sourceType } }
    }
    pageInfo { hasNextPage endCursor }
  }
}`;

/** Linear. */
export const linear: Connector = defineConnector({
  id: "linear",
  title: "Linear",
  logo: "linear",
  serviceModels: ["SaaS"],
  markets: ["enterprise-agile-planning"],
  connectHelp: [
    "Use a workspace admin's account to read who is an admin (a member's key reads the people and issues it can see)",
    "Linear > Settings > Account > Security & access > Personal API keys > New API key",
    "Permissions: Only select permissions > Read (nothing else); Team access: All teams you have access to",
    "If you cannot make a key, a workspace admin allows member API keys (Settings > Security)",
    "Copy the key (Linear's API is GraphQL: Stolos reads it only through its own query documents, never a mutation)",
    "Linear has no second factor of its own: require SAML sign-in (Business and Enterprise plans) and your identity provider's MFA",
    "Commits and pull requests are attached to issues by Linear's GitHub, GitLab, or Bitbucket integration (use the issue ID in the branch name)",
  ],
  recipe: {
    open: {
      href: "https://linear.app/settings/account/security",
      label: "Make a read-only personal API key",
    },
  },
  fields: FIELDS,
  tokenEndpoints: () => [LINEAR_GRAPHQL],
  auth: (cred) => Promise.resolve({ Authorization: cred.token, Accept: "application/json" }),
  account: (_cred, records) =>
    records.find((r) => r.label === ORGANIZATION.name)?.display_name ?? "linear",
  resources: {
    organization: {
      label: ORGANIZATION,
      ocsf: "cloud_resources_inventory_info",
      required: true,
      async *list(ctx) {
        yield (
          await linearQuery<{ organization: LinearOrg }>(
            ctx,
            "query Org { organization { id name urlKey samlEnabled } }",
          )
        ).organization;
      },
      map: (o: LinearOrg) => ({
        native_id: o.id,
        display_name: o.urlKey || o.name,
        props: o.samlEnabled !== undefined ? { mfa_required: o.samlEnabled } : {},
      }),
      asset: () => undefined,
    },
    users: {
      label: USER_ACCOUNT,
      ocsf: "user_inventory",
      required: true,
      list: (ctx) => nodes<LinearUser>(ctx, USERS, (d) => (d as { users: never }).users),
      map: (u: LinearUser) => ({
        native_id: u.id,
        display_name: u.email || u.name || u.id,
        props: {
          ...(u.email ? { email: u.email.toLowerCase() } : {}),
          active: u.active !== false,
          ...(u.admin !== undefined ? { admin: u.admin } : {}),
          ...(u.lastSeen ? { last_login: u.lastSeen } : {}),
        },
      }),
      asset: (u: LinearUser) => ({
        kind: "user",
        facts: { admin: !!u.admin, guest: !!u.guest },
      }),
    },
    issues: {
      label: TICKET,
      ocsf: "cloud_resources_inventory_info",
      list: (ctx) =>
        nodes<LinearIssue>(
          ctx,
          ISSUES,
          (d) => (d as { issues: never }).issues,
          { since: daysBefore(ctx.now, TICKET_DAYS) },
          TICKET_MAX,
        ),
      map: (i: LinearIssue) => {
        const links = devLinks((i.attachments?.nodes ?? []).map((a) => a.url));
        const resolved = i.completedAt ?? i.canceledAt;
        return {
          native_id: i.identifier,
          display_name: i.identifier,
          props: {
            ...(i.title ? { title: i.title } : {}),
            type: ticketType(...(i.labels?.nodes ?? []).map((l) => l.name), i.team?.name),
            ...(i.state?.name ? { status: i.state.name } : {}),
            ...(i.team?.key ? { project: i.team.key } : {}),
            ...(i.createdAt ? { created: i.createdAt } : {}),
            ...(resolved ? { resolved } : {}),
            links,
            commits: links.filter((l) => !l.includes("/")).length,
            pull_requests: links.filter((l) => l.includes("/")).length,
            ...(i.url ? { src_url: i.url } : {}),
          },
        };
      },
      asset: () => undefined,
    },
  },
  posture(records) {
    const org = records.find((r) => r.label === ORGANIZATION.name);
    return {
      ...ticketPosture(records),
      ...(org?.props["mfa_required"] !== undefined
        ? { samlRequired: org.props["mfa_required"] as boolean }
        : {}),
    };
  },
  policies(o, now) {
    return [
      fresh(o, now, "linear"),
      check(o, {
        id: "linear-saml",
        title: "Sign-in goes through your identity provider (SAML), where MFA is enforced",
        scf: ["IAC-37"],
        fact: "samlRequired",
        want: (v) => v === true,
        fix: "Linear > Settings > Security > SAML authentication (Business or Enterprise plan)",
        warnOnly: true,
      }),
      ...ticketPolicies(o, "linear", {
        changes: "label each production change Change (and each incident Incident) in Linear",
        link: "connect GitHub, GitLab, or Bitbucket in Linear > Settings > Integrations, and use the issue ID in branch names",
        admins: "Linear > Settings > Members: keep two to four admins",
      }),
    ];
  },
});
