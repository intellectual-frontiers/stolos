/**
 * Spec 086, declared with spec 091's SDK: GitHub, read-only, for one
 * organization: its members (who are owners, who have no second factor), and
 * its repositories (private or public, whether the default branch is
 * protected by branch protection or a ruleset, how many approving reviews it
 * needs, secret scanning, dependency alerts), and (spec 088) its open
 * Dependabot alerts (`GET /orgs/{org}/dependabot/alerts`, which the token's
 * read-only Dependabot alerts permission already allows) as `vulnerability`
 * records, OCSF Vulnerability Findings that feed the OSCAL POA&M. Evidence
 * for change management (SCF CHG-03), MFA (IAC-37), least privilege
 * (IAC-30), scanning (VPM-12), and remediation (VPM-06, VPM-07).
 *
 * Code scanning alerts need one more permission (Code scanning alerts: Read)
 * that the token Stolos asks for does not have; they are left for later.
 *
 * @module
 */

import { AccessDenied, check, type Connector, fresh } from "./connector.ts";
import { defineConnector } from "./sdk.ts";
import { CODE_REPOSITORY, ORGANIZATION, USER_ACCOUNT, VULNERABILITY } from "./labels.ts";
import {
  firstCve,
  severityOf,
  vulnerabilityPolicies,
  vulnerabilityPosture,
} from "./vulnerability.ts";

const API = "https://api.github.com";

interface Org {
  login: string;
  name?: string;
  two_factor_requirement_enabled?: boolean;
}

interface Member {
  login: string;
  id: number;
  type: string;
  /** Added here: an owner (undefined: the owners could not be read). */
  owner?: boolean;
  /** Added here: has a second factor (undefined: not readable with this token). */
  mfa?: boolean;
}

interface Repo {
  name: string;
  full_name: string;
  private: boolean;
  archived: boolean;
  default_branch: string;
  security_and_analysis?: {
    secret_scanning?: { status: string };
    dependabot_security_updates?: { status: string };
  };
  /** Added here: the default branch is protected (branch protection or a ruleset). */
  protected?: boolean;
  /** Added here: approving reviews the default branch needs, when it is protected. */
  reviews?: number;
}

const NO_2FA = "members without 2FA (an owner's token can read this)";

/** A Dependabot alert, as the organization's list returns it. */
interface Alert {
  number: number;
  state: string;
  html_url?: string;
  created_at?: string;
  dependency?: { package?: { name?: string; ecosystem?: string }; manifest_path?: string };
  security_advisory?: {
    ghsa_id?: string;
    cve_id?: string | null;
    summary?: string;
    severity?: string;
  };
  security_vulnerability?: {
    severity?: string;
    first_patched_version?: { identifier?: string } | null;
  };
  repository?: { full_name?: string };
}

/** GitHub (an organization). */
export const github: Connector = defineConnector({
  id: "github",
  title: "GitHub",
  logo: "github",
  serviceModels: ["SaaS"],
  markets: ["devops-platforms"],
  connectHelp: [
    "github.com > Settings > Developer settings > Fine-grained tokens > Generate new token",
    "Resource owner: your organization; Repository access: All repositories",
    "Permissions, all Read-only: Administration, Metadata, Secret scanning alerts, Dependabot alerts; Organization: Members, Administration",
    "If your organization requires approval for tokens, an owner approves it",
  ],
  recipe: {
    open: {
      href: "https://github.com/settings/personal-access-tokens/new",
      label: "Make a fine-grained, read-only token",
    },
  },
  fields: {
    org: { secret: false, hint: "your organization's login (github.com/<org>)" },
    token: { secret: true, hint: "the fine-grained token (read only)" },
  },
  auth: (cred) =>
    Promise.resolve({
      Authorization: `Bearer ${cred.token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    }),
  account: (cred, records) =>
    records.find((r) => r.label === ORGANIZATION.name)?.display_name ?? cred.org,
  resources: {
    organization: {
      label: ORGANIZATION,
      ocsf: "cloud_resources_inventory_info",
      required: true,
      async *list(ctx) {
        yield await ctx.json<Org>(`${API}/orgs/${ctx.cred.org}`);
      },
      map: (o: Org) => ({
        native_id: o.login,
        display_name: o.name || o.login,
        props: o.two_factor_requirement_enabled !== undefined
          ? { mfa_required: o.two_factor_requirement_enabled }
          : {},
      }),
      asset: () => undefined,
    },
    members: {
      label: USER_ACCOUNT,
      ocsf: "user_inventory",
      required: true,
      async *list(ctx) {
        const members: Member[] = [];
        for await (
          const m of ctx.linkPages<Member>(`${API}/orgs/${ctx.cred.org}/members?per_page=100`)
        ) members.push(m);
        const logins = (url: string) => async () => {
          const s = new Set<string>();
          for await (const m of ctx.linkPages<{ login: string }>(url)) s.add(m.login);
          return s;
        };
        const owners = await ctx.orGap(
          "owners",
          undefined as Set<string> | undefined,
          logins(`${API}/orgs/${ctx.cred.org}/members?role=admin&per_page=100`),
        );
        const no2fa = await ctx.orGap(
          NO_2FA,
          undefined as Set<string> | undefined,
          logins(`${API}/orgs/${ctx.cred.org}/members?filter=2fa_disabled&per_page=100`),
        );
        for (const m of members) {
          yield {
            ...m,
            ...(owners ? { owner: owners.has(m.login) } : {}),
            ...(no2fa ? { mfa: !no2fa.has(m.login) } : {}),
          };
        }
      },
      map: (m: Member) => ({
        native_id: String(m.id),
        display_name: m.login,
        props: {
          active: true,
          ...(m.owner !== undefined ? { admin: m.owner } : {}),
          ...(m.mfa !== undefined ? { mfa: m.mfa } : {}),
          ...(m.type === "Bot" ? { service: true } : {}),
        },
      }),
      asset: (m: Member) => ({ kind: "member", facts: { owner: !!m.owner } }),
    },
    repositories: {
      label: CODE_REPOSITORY,
      ocsf: "cloud_resources_inventory_info",
      required: true,
      async *list(ctx) {
        const repos: Repo[] = [];
        for await (
          const r of ctx.linkPages<Repo>(`${API}/orgs/${ctx.cred.org}/repos?per_page=100&type=all`)
        ) if (!r.archived) repos.push(r);
        for (const r of repos) {
          const branch = encodeURIComponent(r.default_branch);
          // 404: no branch protection; a ruleset may still protect the branch.
          const notFound = <T>(e: unknown): T | undefined => {
            if (e instanceof AccessDenied) throw e;
            return undefined;
          };
          type Protection = {
            required_pull_request_reviews?: { required_approving_review_count?: number };
          };
          const p = await ctx.orGap(
            `${r.full_name} branch protection`,
            undefined as Protection | undefined,
            () =>
              ctx.json<Protection>(`${API}/repos/${r.full_name}/branches/${branch}/protection`)
                .catch(notFound<Protection>),
          );
          let isProtected = p !== undefined;
          let reviews = p?.required_pull_request_reviews?.required_approving_review_count ??
            (p ? 0 : undefined);
          if (!isProtected) {
            type Rule = {
              type: string;
              parameters?: { required_approving_review_count?: number };
            };
            const rules = await ctx.orGap(
              `${r.full_name} rulesets`,
              [] as Rule[],
              async () =>
                (await ctx.json<Rule[]>(`${API}/repos/${r.full_name}/rules/branches/${branch}`)
                  .catch(notFound<Rule[]>)) ?? [],
            );
            const pr = rules.find((x) => x.type === "pull_request");
            if (pr) {
              isProtected = true;
              reviews = pr.parameters?.required_approving_review_count ?? 0;
            }
          }
          yield { ...r, protected: isProtected, ...(reviews !== undefined ? { reviews } : {}) };
        }
      },
      map: (r: Repo) => {
        const sa = r.security_and_analysis;
        return {
          native_id: r.full_name,
          display_name: r.full_name,
          props: {
            private: r.private,
            protected: !!r.protected,
            ...(r.reviews !== undefined ? { reviews: r.reviews } : {}),
            ...(sa?.secret_scanning
              ? { secret_scanning: sa.secret_scanning.status === "enabled" }
              : {}),
            ...(sa?.dependabot_security_updates
              ? { dependency_alerts: sa.dependabot_security_updates.status === "enabled" }
              : {}),
          },
        };
      },
      asset: (r: Repo) => ({
        kind: "repository",
        facts: { private: r.private, protected: !!r.protected, reviews: r.reviews ?? 0 },
      }),
    },
    dependabot: {
      label: VULNERABILITY,
      ocsf: "vulnerability_finding",
      async *list(ctx): AsyncGenerator<Alert> {
        try {
          yield* ctx.linkPages<Alert>(
            `${API}/orgs/${ctx.cred.org}/dependabot/alerts?state=open&per_page=100`,
          );
        } catch (e) {
          // 404: Dependabot alerts are off for the organization, or hidden from this token.
          if (e instanceof AccessDenied || !/HTTP 404/.test((e as Error).message)) throw e;
          throw new AccessDenied(`${(e as Error).message} (off, or not readable with this token)`);
        }
      },
      map: (a: Alert) => {
        const repo = a.repository?.full_name ?? "";
        const adv = a.security_advisory;
        const cve = firstCve([adv?.cve_id ?? undefined]);
        const pkg = a.dependency?.package?.name;
        return {
          native_id: `${repo}#${a.number}`,
          display_name: cve ?? adv?.ghsa_id ?? `${repo}#${a.number}`,
          props: {
            ...(cve ? { cve } : {}),
            ...(adv?.summary ? { title: adv.summary } : {}),
            severity: severityOf(a.security_vulnerability?.severity ?? adv?.severity),
            status: a.state === "open" ? "open" : a.state === "fixed" ? "fixed" : "dismissed",
            asset: repo,
            ...(pkg ? { package: pkg } : {}),
            ...(a.created_at ? { first_seen: a.created_at } : {}),
            fix_available: !!a.security_vulnerability?.first_patched_version?.identifier,
            ...(a.html_url ? { src_url: a.html_url } : {}),
          },
        };
      },
      asset: () => undefined,
    },
  },
  posture(records, _cred, { gaps, now }) {
    const org = records.find((r) => r.label === ORGANIZATION.name);
    const members = records.filter((r) => r.label === USER_ACCOUNT.name);
    const read = (what: string) => !gaps.some((g) => g.startsWith(`${what}: `));
    const priv = records.filter((r) => r.label === CODE_REPOSITORY.name && r.props.private);
    return {
      ...(org?.props.mfa_required !== undefined
        ? { orgRequires2fa: org.props.mfa_required as boolean }
        : {}),
      ...(read("owners") ? { owners: members.filter((m) => m.props.admin).length } : {}),
      ...(read(NO_2FA)
        ? { membersWithout2fa: members.filter((m) => m.props.mfa === false).length }
        : {}),
      privateRepos: priv.length,
      privateReposProtected: priv.filter((r) => r.props.protected).length,
      privateReposReviewed: priv.filter((r) => ((r.props.reviews as number | undefined) ?? 0) >= 1)
        .length,
      ...(priv.some((r) => r.props.secret_scanning !== undefined)
        ? { privateReposSecretScanning: priv.filter((r) => r.props.secret_scanning).length }
        : {}),
      // Spec 088: only when the alerts could be read (else unknown, not none).
      ...vulnerabilityPosture(records, now, read("dependabot")),
    };
  },
  policies(o, now) {
    const all = (v: unknown) => v === o.posture.privateRepos;
    const of = (v: string | number | boolean) =>
      `${v} of ${o.posture.privateRepos} private repositories`;
    return [
      fresh(o, now, "github"),
      check(o, {
        id: "gh-2fa-required",
        title: "The organization requires two-factor authentication",
        scf: ["IAC-37"],
        fact: "orgRequires2fa",
        want: (v) => v === true,
        fix: "github.com/organizations/<org>/settings/security > Require two-factor authentication",
      }),
      check(o, {
        id: "gh-owners",
        title: "Two to four owners",
        scf: ["IAC-30"],
        fact: "owners",
        want: (v) => typeof v === "number" && v >= 2 && v <= 4,
        fix: "github.com/orgs/<org>/people > Role: Owner; make the rest Members",
        warnOnly: true,
      }),
      check(o, {
        id: "gh-protected",
        title: "Every private repository protects its default branch",
        scf: ["CHG-03"],
        fact: "privateReposProtected",
        want: all,
        show: of,
        fix:
          "each repository > Settings > Rules (or Branches): require a pull request and passing checks",
      }),
      check(o, {
        id: "gh-reviewed",
        title: "Every private repository requires an approving review",
        scf: ["CHG-03"],
        fact: "privateReposReviewed",
        want: all,
        show: of,
        fix: "the default branch's rule: Require approvals, 1 or more",
      }),
      check(o, {
        id: "gh-secret-scanning",
        title: "Every private repository scans for secrets",
        scf: ["VPM-12"],
        fact: "privateReposSecretScanning",
        want: all,
        show: of,
        fix: "the organization > Settings > Code security: Secret scanning on for all repositories",
        warnOnly: true,
      }),
      ...vulnerabilityPolicies(
        o,
        "gh",
        "each repository > Security > Dependabot alerts (merge Dependabot's pull request, or upgrade)",
      ),
    ];
  },
});
