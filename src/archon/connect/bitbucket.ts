/**
 * Spec 091: Bitbucket Cloud, read-only, for one workspace: its members (who
 * are owners) and its repositories (private or public, whether the main
 * branch is protected by branch restrictions, and how many approvals a pull
 * request needs to merge). Evidence for change management (SCF CHG-03) and
 * least privilege (IAC-30).
 *
 * Bitbucket's API does not show members' two-step verification or whether
 * the workspace requires it, and secret scanning has no per-repository
 * setting to read: those policies stay unknown.
 *
 * Credential: an Atlassian API token with Bitbucket scopes, read only
 * (`read:workspace:bitbucket`, `read:user:bitbucket`,
 * `read:repository:bitbucket`), sent with the account's email (HTTP Basic).
 *
 * @module
 */
// Spec: 091-connectors

import { AccessDenied, type Connector } from "./connector.ts";
import { CODE_REPOSITORY, USER_ACCOUNT } from "./labels.ts";
import { type Ctx, defineConnector } from "./sdk.ts";
import { branchMatches, codeHostPolicies, codeHostPosture } from "./codehost.ts";

/** Bitbucket Cloud's REST API. */
export const BITBUCKET_API = "https://api.bitbucket.org/2.0";

const FIELDS = {
  workspace: { secret: false, hint: "your workspace's id (bitbucket.org/<workspace>)" },
  email: { secret: false, hint: "the Atlassian account's email the token belongs to" },
  token: { secret: true, hint: "an API token with read-only Bitbucket scopes" },
};

interface BbUser {
  uuid: string;
  display_name?: string;
  nickname?: string;
  type?: string;
  has_2fa_enabled?: boolean | null;
}

interface Repo {
  full_name: string;
  is_private: boolean;
  mainbranch?: { name: string } | null;
  /** Added here: whether the main branch is protected. */
  protected?: boolean;
  /** Added here: approvals a pull request needs to merge. */
  reviews?: number;
}

/** A Bitbucket branch restriction, as its API returns it (the parts Stolos reads). */
export interface Restriction {
  /** What it restricts: push, force, delete, require_approvals_to_merge, ... */
  kind: string;
  /** glob (by `pattern`) or branching_model (by branch type). */
  branch_match_kind?: string;
  /** The branch pattern (`*` is any run of characters). */
  pattern?: string;
  /** Its number, for the kinds that have one (approvals required). */
  value?: number | null;
}

type Page<T> = { values?: T[]; next?: string };
const ws = (ctx: Ctx<typeof FIELDS>) => encodeURIComponent(ctx.cred.workspace);
/** Restrictions that stop a change from reaching the branch without a pull request. */
const PROTECTING = new Set([
  "push",
  "restrict_merges",
  "require_approvals_to_merge",
  "require_default_reviewer_approvals_to_merge",
]);
const APPROVALS = new Set([
  "require_approvals_to_merge",
  "require_default_reviewer_approvals_to_merge",
]);

/** A repository's protection, from its branch restrictions (glob patterns on its main branch). */
export function bitbucketProtection(
  branch: string,
  rs: Restriction[],
): { protected: boolean; reviews: number } {
  const on = rs.filter(
    (r) =>
      (r.branch_match_kind ?? "glob") === "glob" &&
      r.pattern !== undefined &&
      branchMatches(r.pattern, branch),
  );
  return {
    protected: on.some((r) => PROTECTING.has(r.kind)),
    reviews: Math.max(0, ...on.filter((r) => APPROVALS.has(r.kind)).map((r) => r.value ?? 0)),
  };
}

/** Bitbucket Cloud. */
export const bitbucket: Connector = defineConnector<typeof FIELDS>({
  id: "bitbucket",
  title: "Bitbucket",
  logo: "bitbucket",
  serviceModels: ["SaaS"],
  markets: ["devops-platforms"],
  connectHelp: [
    "Atlassian account (a workspace member; an owner's account also reads who the owners are) > Security > Create and manage API tokens > Create API token with scopes",
    "App: Bitbucket; scopes, all read only: read:workspace:bitbucket, read:user:bitbucket, read:repository:bitbucket",
    "Set an expiry, create it, and copy the token; with it, the account's email and the workspace's id",
    "Bitbucket's API does not show members' two-factor status: the estate graph checks MFA in your identity provider",
  ],
  recipe: {
    open: {
      href: "https://id.atlassian.com/manage-profile/security/api-tokens",
      label: "Make a read-only API token",
    },
  },
  fields: FIELDS,
  auth: (cred) =>
    Promise.resolve({
      Authorization: `Basic ${btoa(`${cred.email}:${cred.token}`)}`,
      Accept: "application/json",
    }),
  account: (cred) => cred.workspace,
  resources: {
    members: {
      label: USER_ACCOUNT,
      ocsf: "user_inventory",
      async *list(ctx) {
        // Only an owner may read the workspace's permissions: otherwise, a gap.
        const owners = await ctx.orGap("owners", undefined as Set<string> | undefined, async () => {
          const out = new Set<string>();
          try {
            for await (const p of ctx.cursorPages<Page<{ user: BbUser }>, { user: BbUser }>(
              `${BITBUCKET_API}/workspaces/${ws(ctx)}/permissions?q=${encodeURIComponent(
                'permission="owner"',
              )}&pagelen=100`,
              (b) => b.values,
              (b) => b.next,
            ))
              out.add(p.user.uuid);
          } catch (e) {
            if (e instanceof AccessDenied) throw e;
            throw new AccessDenied(`not readable (${(e as Error).message})`);
          }
          return out;
        });
        for await (const m of ctx.cursorPages<Page<{ user: BbUser }>, { user: BbUser }>(
          `${BITBUCKET_API}/workspaces/${ws(ctx)}/members?pagelen=100`,
          (b) => b.values,
          (b) => b.next,
        ))
          yield { ...m.user, ...(owners ? { owner: owners.has(m.user.uuid) } : {}) };
      },
      map: (u: BbUser & { owner?: boolean }) => ({
        native_id: u.uuid,
        display_name: u.nickname ?? u.display_name ?? u.uuid,
        props: {
          active: true,
          ...(u.owner !== undefined ? { admin: u.owner } : {}),
          ...(typeof u.has_2fa_enabled === "boolean" ? { mfa: u.has_2fa_enabled } : {}),
          ...(u.type && u.type !== "user" ? { service: true } : {}),
        },
      }),
      asset: (u: BbUser & { owner?: boolean }) => ({
        kind: "member",
        facts: { owner: !!u.owner },
      }),
    },
    repositories: {
      label: CODE_REPOSITORY,
      ocsf: "inventory_info",
      async *list(ctx) {
        for await (const r of ctx.cursorPages<Page<Repo>, Repo>(
          `${BITBUCKET_API}/repositories/${ws(ctx)}?pagelen=100`,
          (b) => b.values,
          (b) => b.next,
        )) {
          const branch = r.mainbranch?.name;
          if (!branch) {
            // an empty repository: nothing to protect yet
            yield r;
            continue;
          }
          const rs = await ctx.orGap(
            `${r.full_name} branch restrictions`,
            undefined as Restriction[] | undefined,
            async () => {
              const out: Restriction[] = [];
              for await (const x of ctx.cursorPages<Page<Restriction>, Restriction>(
                `${BITBUCKET_API}/repositories/${r.full_name}/branch-restrictions?pagelen=100`,
                (b) => b.values,
                (b) => b.next,
              ))
                out.push(x);
              return out;
            },
          );
          yield { ...r, ...(rs ? bitbucketProtection(branch, rs) : {}) };
        }
      },
      map: (r: Repo) => ({
        native_id: r.full_name,
        display_name: r.full_name,
        props: {
          private: r.is_private,
          ...(r.protected !== undefined ? { protected: r.protected } : {}),
          ...(r.reviews !== undefined ? { reviews: r.reviews } : {}),
        },
      }),
      asset: (r: Repo) => ({
        kind: "repository",
        facts: { private: r.is_private, protected: !!r.protected, reviews: r.reviews ?? 0 },
      }),
    },
  },
  posture: codeHostPosture,
  policies: codeHostPolicies("bitbucket", "bitbucket", {
    require2fa:
      "Bitbucket's API does not show it: workspace settings > Security > Two-step verification > Require (Premium), or enforce it at your identity provider",
    members2fa:
      "Bitbucket's API does not show it: ask every member to turn on two-step verification in their Atlassian account",
    owners:
      "workspace settings > User groups (or Users): give owner rights to two to four people only",
    protect:
      "each repository > Repository settings > Branch restrictions: on the main branch, allow no direct pushes (merge via pull request only)",
    review:
      "the main branch's restriction: Minimum number of approvals, 1 or more (Premium: enforce merge checks)",
    secrets:
      "Bitbucket scans pushes for secrets on its own; there is no per-repository setting for Stolos to read",
  }),
});
