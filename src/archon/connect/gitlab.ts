/**
 * Spec 091: GitLab (GitLab.com or a self-managed GitLab), read-only, for one
 * top-level group: whether it requires two-factor authentication, its
 * members (who are owners, and who has 2FA, which GitLab shows a group
 * owner's token), and its projects (private, internal, or public, whether
 * the default branch is protected, how many approvals a merge request needs,
 * and secret push protection). Evidence for change management (SCF CHG-03),
 * MFA (IAC-37), least privilege (IAC-30), and scanning (VPM-12).
 *
 * Credential: a group access token (or a personal access token) with the
 * `read_api` scope only. GitLab shows members' 2FA only to group owners, so
 * a token with the Owner role reads more; with any lower role 2FA is a gap.
 *
 * @module
 */
// Spec: 091-connectors

import { http } from "@intellectual-frontiers/net";
import { AccessDenied, type Connector } from "./connector.ts";
import { CODE_REPOSITORY, USER_ACCOUNT } from "./labels.ts";
import { type Ctx, defineConnector } from "./sdk.ts";
import { branchMatches, codeHostPolicies, codeHostPosture } from "./codehost.ts";

const FIELDS = {
  url: { secret: false, hint: "https://gitlab.com (or your GitLab's address)" },
  group: { secret: false, hint: "your top-level group's path (gitlab.com/<group>)" },
  token: { secret: true, hint: "a group or personal access token with read_api only" },
};

interface Member {
  id: number;
  username: string;
  name?: string;
  state?: string;
  access_level: number;
  email?: string;
  two_factor_enabled?: boolean;
}

interface Project {
  id: number;
  path_with_namespace: string;
  visibility: "private" | "internal" | "public";
  default_branch?: string | null;
  archived?: boolean;
  secret_push_protection_enabled?: boolean;
  /** Added here: whether the default branch is protected (no force pushes). */
  protected?: boolean;
  /** Added here: approvals a merge request needs. */
  reviews?: number;
}

/** The REST API's root. */
const api = (url: string) => `${(url || "https://gitlab.com").replace(/\/$/, "")}/api/v4`;
const group = (ctx: Ctx<typeof FIELDS>) => encodeURIComponent(ctx.cred.group);
/** GitLab's bot users: group and project access tokens. */
const isBot = (m: Member) => /^(group|project)_\d+_bot/.test(m.username);
/** GitLab's Owner role. */
const OWNER = 50;

/** GitLab. */
export const gitlab: Connector = defineConnector<typeof FIELDS>({
  id: "gitlab",
  title: "GitLab",
  logo: "gitlab",
  serviceModels: ["SaaS"],
  markets: ["devops-platforms"],
  connectHelp: [
    "GitLab: your top-level group > Settings > Access tokens > Add new token (or your avatar > Edit profile > Access tokens)",
    "Scope: read_api only (read-only); role: Owner, because GitLab shows members' two-factor status only to owners (a lower role works, and 2FA is then listed as not readable)",
    "Set an expiry date, create it, and copy the token; your GitLab's address (https://gitlab.com, or your own) and the group's path",
    "Merge request approval rules need a paid GitLab tier (Premium or Ultimate); on Free they are read as none",
  ],
  recipe: {
    open: {
      href: "https://gitlab.com/-/user_settings/personal_access_tokens",
      label: "Make a read_api token",
    },
  },
  fields: FIELDS,
  auth: (cred) => Promise.resolve(http.bearer(cred.token)),
  account: (cred) => cred.group,
  resources: {
    members: {
      label: USER_ACCOUNT,
      ocsf: "user_inventory",
      async *list(ctx) {
        const B = api(ctx.cred.url);
        const g = await ctx.orGap(
          "group settings",
          undefined as { require_two_factor_authentication?: boolean } | undefined,
          () => ctx.json(`${B}/groups/${group(ctx)}`),
        );
        if (typeof g?.require_two_factor_authentication === "boolean") {
          ctx.fact("orgRequires2fa", g.require_two_factor_authentication);
        }
        yield* ctx.linkPages<Member>(`${B}/groups/${group(ctx)}/members/all?per_page=100`);
      },
      map: (m: Member) => ({
        native_id: String(m.id),
        display_name: m.username,
        props: {
          ...(m.email ? { email: m.email.toLowerCase() } : {}),
          active: (m.state ?? "active") === "active",
          admin: m.access_level >= OWNER,
          ...(typeof m.two_factor_enabled === "boolean" ? { mfa: m.two_factor_enabled } : {}),
          ...(isBot(m) ? { service: true } : {}),
        },
      }),
      asset: (m: Member) => ({ kind: "member", facts: { owner: m.access_level >= OWNER } }),
    },
    projects: {
      label: CODE_REPOSITORY,
      ocsf: "inventory_info",
      async *list(ctx) {
        const B = api(ctx.cred.url);
        for await (const p of ctx.linkPages<Project>(
          `${B}/groups/${group(ctx)}/projects?include_subgroups=true&archived=false&per_page=100`,
        )) {
          if (p.archived) continue;
          if (!p.default_branch) {
            // an empty project: nothing to protect yet
            yield p;
            continue;
          }
          const branch = p.default_branch;
          type Protected = { name: string; allow_force_push?: boolean };
          const rules = await ctx.orGap(
            `${p.path_with_namespace} protected branches`,
            undefined as Protected[] | undefined,
            () => ctx.json<Protected[]>(`${B}/projects/${p.id}/protected_branches?per_page=100`),
          );
          const rule = rules?.find((r) => branchMatches(r.name, branch));
          type Rule = { approvals_required?: number };
          // Approval rules are a paid tier's: elsewhere the API answers 404 (no approvals required).
          const approvals = await ctx.orGap(
            `${p.path_with_namespace} approval rules`,
            undefined as Rule[] | undefined,
            () =>
              ctx.json<Rule[]>(`${B}/projects/${p.id}/approval_rules`).catch((e) => {
                if (e instanceof AccessDenied) throw e;
                return [] as Rule[];
              }),
          );
          yield {
            ...p,
            ...(rules ? { protected: !!rule && rule.allow_force_push !== true } : {}),
            ...(approvals
              ? { reviews: Math.max(0, ...approvals.map((a) => a.approvals_required ?? 0)) }
              : {}),
          };
        }
      },
      map: (p: Project) => ({
        native_id: p.path_with_namespace,
        display_name: p.path_with_namespace,
        props: {
          private: p.visibility !== "public",
          ...(p.protected !== undefined ? { protected: p.protected } : {}),
          ...(p.reviews !== undefined ? { reviews: p.reviews } : {}),
          ...(typeof p.secret_push_protection_enabled === "boolean"
            ? { secret_scanning: p.secret_push_protection_enabled }
            : {}),
        },
      }),
      asset: (p: Project) => ({
        kind: "repository",
        facts: { visibility: p.visibility, protected: !!p.protected, reviews: p.reviews ?? 0 },
      }),
    },
  },
  posture: codeHostPosture,
  policies: codeHostPolicies("gitlab", "gitlab", {
    require2fa:
      "the group > Settings > General > Permissions and group features: All users in this group must set up two-factor authentication",
    members2fa:
      "the group > Manage > Members: ask each member without 2FA to turn it on (or require it for the group)",
    owners:
      "the group > Manage > Members: give Owner to two to four people; make the rest Maintainers",
    protect:
      "each project > Settings > Repository > Protected branches: protect the default branch, Allowed to push: No one, force push off",
    review:
      "each project > Settings > Merge requests > Merge request approvals: require 1 or more approvals",
    secrets: "each project > Secure > Security configuration: Secret push protection on",
  }),
});
