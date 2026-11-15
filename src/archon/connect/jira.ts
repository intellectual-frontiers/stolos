/**
 * Spec 087: Jira (Cloud), read-only: the site's people (active, who is in
 * an administrators group), and the last 90 days of tickets: each one's
 * key, type (change, incident, or other, from its issue type and project),
 * status, created and resolved times, and the development work it links
 * (commit and pull request counts from Jira's development panel, and commit
 * or pull request URLs among its remote links). Evidence for change control
 * (SCF CHG-03) and least privilege (IAC-30).
 *
 * It uses an Atlassian API token with scopes (read:jira-work,
 * read:jira-user), which Atlassian serves only through its API gateway
 * (`api.atlassian.com/ex/jira/<cloud id>`); the cloud id is read from the
 * site's public `/_edge/tenant_info`.
 *
 * @module
 */

import { type Connector, fresh } from "./connector.ts";
import { type Ctx, defineConnector } from "./sdk.ts";
import { TICKET, USER_ACCOUNT } from "./labels.ts";
import {
  daysBefore,
  devLinks,
  TICKET_DAYS,
  TICKET_MAX,
  ticketPolicies,
  ticketPosture,
  ticketType,
} from "./ticketing.ts";

/** The site's host, from what was typed (example.atlassian.net). */
export const jiraSite = (site: string): string =>
  site.replace(/^https?:\/\//, "").replace(/\/.*$/, "").toLowerCase();

const FIELDS = {
  site: { secret: false, hint: "your Jira site (example.atlassian.net)" },
  email: { secret: false, hint: "the email of the account that made the token" },
  token: { secret: true, hint: "an API token with scopes: read:jira-work, read:jira-user" },
};

const bases = new WeakMap<object, Promise<string>>();

/** The API gateway base for the site (`https://api.atlassian.com/ex/jira/<cloud id>`), read once per observation. */
function apiBase(ctx: Ctx<typeof FIELDS>): Promise<string> {
  let b = bases.get(ctx);
  if (!b) {
    b = ctx.json<{ cloudId: string }>(`https://${jiraSite(ctx.cred.site)}/_edge/tenant_info`, {
      Accept: "application/json",
    }).then((t) => `https://api.atlassian.com/ex/jira/${t.cloudId}`);
    bases.set(ctx, b);
  }
  return b;
}

interface JiraUser {
  accountId: string;
  accountType?: string;
  emailAddress?: string;
  displayName?: string;
  active?: boolean;
  /** Added here: in an administrators group (undefined: the groups could not be read). */
  admin?: boolean;
}

interface JiraIssue {
  id: string;
  key: string;
  fields: {
    summary?: string;
    issuetype?: { name?: string };
    project?: { key?: string; name?: string; projectTypeKey?: string };
    status?: { name?: string };
    created?: string;
    resolutiondate?: string | null;
    [field: string]: unknown;
  };
  /** Added here: the development panel's counts and the remote links that are development work. */
  dev?: { commits?: number; pull_requests?: number; links: string[] };
}

/** Administrators groups, by Jira Cloud's default names. */
const ADMIN_GROUP =
  /^(site-admins|org-admins|administrators|jira-administrators|jira-admins(-.+)?)$/i;

/** The development panel's counts, from the field's value (a JSON summary, or the older text form). */
export function devSummary(v: unknown): { commits?: number; pull_requests?: number } {
  if (v === undefined || v === null || v === "" || v === "{}") return {};
  const s = typeof v === "string" ? v : JSON.stringify(v);
  const count = (kind: string) => {
    const json = s.match(new RegExp(`"${kind}":\\{"overall":\\{"count":(\\d+)`))?.[1];
    const text = s.match(new RegExp(`${kind}=\\{[^}]*?(?:stateCount|count)=(\\d+)`))?.[1];
    const n = json ?? text;
    return n === undefined ? undefined : Number(n);
  };
  const pr = count("pullrequest");
  const commits = count("repository");
  return {
    ...(commits !== undefined ? { commits } : {}),
    ...(pr !== undefined ? { pull_requests: pr } : {}),
  };
}

const iso = (t?: string | null) =>
  t ? new Date(t).toISOString().replace(/\.\d+Z$/, "Z") : undefined;

/** Jira (Cloud). */
export const jira: Connector = defineConnector({
  id: "jira",
  title: "Jira",
  logo: "jira",
  serviceModels: ["SaaS"],
  markets: ["it-service-management", "enterprise-agile-planning"],
  connectHelp: [
    "Use an account that can browse the projects to check (a dedicated one is best; it needs no administration rights)",
    "Signed in as it: id.atlassian.com/manage-profile/security/api-tokens > Create API token with scopes",
    "App: Jira; scopes, read only: read:jira-work and read:jira-user (nothing that writes)",
    "Copy the token, your site (example.atlassian.net), and the account's email",
    "Who is an administrator is read from Jira's default administrators groups (site-admins, jira-admins-...); the account needs Browse users and groups to read them",
    "Atlassian does not show second factors or last sign-ins to a Jira token (that is Atlassian Guard, in admin.atlassian.com): the estate graph checks MFA in your identity provider",
    "Commit and pull request counts need a development tool connected to Jira (GitHub for Jira, GitLab, Bitbucket)",
  ],
  recipe: {
    open: {
      href: "https://id.atlassian.com/manage-profile/security/api-tokens",
      label: "Make an API token with read-only scopes",
    },
  },
  fields: FIELDS,
  auth: (cred) =>
    Promise.resolve({
      Authorization: `Basic ${btoa(`${cred.email}:${cred.token}`)}`,
      Accept: "application/json",
    }),
  account: (cred) => jiraSite(cred.site),
  resources: {
    users: {
      label: USER_ACCOUNT,
      ocsf: "user_inventory",
      required: true,
      async *list(ctx) {
        const b = await apiBase(ctx);
        const users: JiraUser[] = [];
        for (let at = 0; at < 10_000; at += 100) {
          const page = await ctx.json<JiraUser[]>(
            `${b}/rest/api/3/users/search?startAt=${at}&maxResults=100`,
          );
          users.push(...page.filter((u) => (u.accountType ?? "atlassian") === "atlassian"));
          if (page.length < 100) break;
        }
        const admins = await ctx.orGap(
          "administrators groups",
          undefined as Set<string> | undefined,
          async () => {
            const picker = await ctx.json<{ groups?: Array<{ name: string; groupId?: string }> }>(
              `${b}/rest/api/3/groups/picker?query=admin&maxResults=50`,
            );
            const ids = new Set<string>();
            for (const g of (picker.groups ?? []).filter((g) => ADMIN_GROUP.test(g.name))) {
              const q = g.groupId
                ? `groupId=${encodeURIComponent(g.groupId)}`
                : `groupname=${encodeURIComponent(g.name)}`;
              for (let at = 0; at < 5000; at += 50) {
                const m = await ctx.json<
                  { values?: Array<{ accountId: string }>; isLast?: boolean }
                >(
                  `${b}/rest/api/3/group/member?${q}&startAt=${at}&maxResults=50`,
                );
                for (const v of m.values ?? []) ids.add(v.accountId);
                if (m.isLast !== false) break;
              }
            }
            return ids;
          },
        );
        for (const u of users) {
          yield { ...u, ...(admins ? { admin: admins.has(u.accountId) } : {}) };
        }
      },
      map: (u: JiraUser) => ({
        native_id: u.accountId,
        display_name: u.displayName || u.emailAddress || u.accountId,
        props: {
          ...(u.emailAddress ? { email: u.emailAddress.toLowerCase() } : {}),
          active: u.active !== false,
          ...(u.admin !== undefined ? { admin: u.admin } : {}),
        },
      }),
      asset: (u: JiraUser) => ({ kind: "user", facts: { admin: !!u.admin } }),
    },
    tickets: {
      label: TICKET,
      ocsf: "cloud_resources_inventory_info",
      async *list(ctx) {
        const b = await apiBase(ctx);
        const dev = await ctx.orGap(
          "development field",
          undefined as string | undefined,
          async () =>
            (await ctx.json<Array<{ id: string; schema?: { custom?: string } }>>(
              `${b}/rest/api/3/field`,
            )).find((f) => /devsummary/i.test(f.schema?.custom ?? ""))?.id,
        );
        const fields = [
          "summary",
          "issuetype",
          "project",
          "status",
          "created",
          "resolutiondate",
          ...(dev ? [dev] : []),
        ].join(",");
        const jql = encodeURIComponent(
          `created >= "${daysBefore(ctx.now, TICKET_DAYS).slice(0, 10)}" ORDER BY created DESC`,
        );
        const first = `${b}/rest/api/3/search/jql?jql=${jql}&fields=${fields}&maxResults=100`;
        let n = 0;
        let remote = 0;
        for await (
          const i of ctx.cursorPages<
            { issues?: JiraIssue[]; nextPageToken?: string; isLast?: boolean },
            JiraIssue
          >(
            first,
            (p) => p.issues,
            (p) =>
              p.nextPageToken && !p.isLast
                ? `${first}&nextPageToken=${encodeURIComponent(p.nextPageToken)}`
                : undefined,
          )
        ) {
          if (n++ >= TICKET_MAX) break;
          const counts = dev ? devSummary(i.fields[dev]) : {};
          const type = ticketType(i.fields.issuetype?.name, i.fields.project?.name);
          let links: string[] = [];
          // A resolved change the panel does not show: look for commit or pull request URLs it links.
          if (
            type === "change" && i.fields.resolutiondate && !counts.commits &&
            !counts.pull_requests && remote++ < 200
          ) {
            links = await ctx.orGap("remote links", [] as string[], async () =>
              devLinks(
                (await ctx.json<Array<{ object?: { url?: string } }>>(
                  `${b}/rest/api/3/issue/${encodeURIComponent(i.key)}/remotelink`,
                )).map((l) => l.object?.url),
              ));
          }
          yield { ...i, dev: { ...counts, links } };
        }
      },
      map: (i: JiraIssue) => ({
        native_id: i.key,
        display_name: i.key,
        props: {
          ...(i.fields.summary ? { title: i.fields.summary } : {}),
          type: ticketType(i.fields.issuetype?.name, i.fields.project?.name),
          ...(i.fields.status?.name ? { status: i.fields.status.name } : {}),
          ...(i.fields.project?.key ? { project: i.fields.project.key } : {}),
          ...(iso(i.fields.created) ? { created: iso(i.fields.created) } : {}),
          ...(iso(i.fields.resolutiondate) ? { resolved: iso(i.fields.resolutiondate) } : {}),
          links: i.dev?.links ?? [],
          ...(i.dev?.commits !== undefined ? { commits: i.dev.commits } : {}),
          ...(i.dev?.pull_requests !== undefined ? { pull_requests: i.dev.pull_requests } : {}),
        },
      }),
      asset: () => undefined,
    },
  },
  posture: (records) => ticketPosture(records),
  policies(o, now) {
    return [
      fresh(o, now, "jira"),
      ...ticketPolicies(o, "jira", {
        changes:
          "record each production change as a ticket (Jira Service Management's Change type, or an issue type named Change)",
        link:
          "connect your code host to Jira (GitHub for Jira, GitLab, or Bitbucket) and put the ticket key in branch names, commits, and pull request titles",
        admins:
          "Jira > Settings > User management > Groups: keep two to four in the administrators groups",
      }),
    ];
  },
});
