/**
 * Spec 086: GitHub, read-only, for one organization: its members (who are
 * owners, who have no second factor), and its repositories (private or
 * public, whether the default branch is protected by branch protection or a
 * ruleset, how many approving reviews it needs, secret scanning, dependency
 * alerts). Evidence for change management (SCF CHG-02), MFA (IAC-06), least
 * privilege (IAC-21), and scanning (VPM-06).
 *
 * @module
 */

import {
  AccessDenied,
  check,
  type Connector,
  fresh,
  getJson,
  type Http,
  linkPages,
  orGap,
} from "./connector.ts";
import type { Account, Repository } from "./entities.ts";

const API = "https://api.github.com";

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
}

/** GitHub (an organization). */
export const github: Connector = {
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
  fields: [
    { name: "org", secret: false, hint: "your organization's login (github.com/<org>)" },
    { name: "token", secret: true, hint: "the fine-grained token (read only)" },
  ],
  async observe(cred, http: Http, now) {
    const h = {
      Authorization: `Bearer ${cred.token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    };
    const gaps: string[] = [];
    const org = await getJson<
      { login: string; name?: string; two_factor_requirement_enabled?: boolean }
    >(http, `${API}/orgs/${cred.org}`, h);
    const members = await linkPages<{ login: string; id: number; type: string }>(
      http,
      `${API}/orgs/${cred.org}/members?per_page=100`,
      h,
    );
    const owners = await orGap(
      gaps,
      "owners",
      undefined as Array<{ login: string }> | undefined,
      () => linkPages(http, `${API}/orgs/${cred.org}/members?role=admin&per_page=100`, h),
    );
    const no2fa = await orGap(
      gaps,
      "members without 2FA (an owner's token can read this)",
      undefined as Array<{ login: string }> | undefined,
      () => linkPages(http, `${API}/orgs/${cred.org}/members?filter=2fa_disabled&per_page=100`, h),
    );
    const ownerSet = new Set((owners ?? []).map((m) => m.login));
    const no2faSet = new Set((no2fa ?? []).map((m) => m.login));
    const accounts: Account[] = members.map((m) => ({
      system: "github",
      id: String(m.id),
      name: m.login,
      active: true,
      ...(owners ? { admin: ownerSet.has(m.login) } : {}),
      ...(no2fa ? { mfa: !no2faSet.has(m.login) } : {}),
      ...(m.type === "Bot" ? { service: true } : {}),
    }));
    const repos =
      (await linkPages<Repo>(http, `${API}/orgs/${cred.org}/repos?per_page=100&type=all`, h))
        .filter((r) => !r.archived);
    const repositories: Repository[] = [];
    for (const r of repos) {
      const branch = encodeURIComponent(r.default_branch);
      let reviews: number | undefined;
      let isProtected = false;
      try {
        const p = await getJson<
          { required_pull_request_reviews?: { required_approving_review_count?: number } }
        >(
          http,
          `${API}/repos/${r.full_name}/branches/${branch}/protection`,
          h,
        );
        isProtected = true;
        reviews = p.required_pull_request_reviews?.required_approving_review_count ?? 0;
      } catch (e) {
        if (e instanceof AccessDenied) gaps.push(`${r.full_name} branch protection: ${e.message}`);
        // 404: no branch protection; a ruleset may still protect the branch.
      }
      if (!isProtected) {
        type Rule = { type: string; parameters?: { required_approving_review_count?: number } };
        const rules: Rule[] = await orGap(
          gaps,
          `${r.full_name} rulesets`,
          [] as Rule[],
          () =>
            getJson<Rule[]>(http, `${API}/repos/${r.full_name}/rules/branches/${branch}`, h).catch(
              (e) => {
                if (e instanceof AccessDenied) throw e;
                return [] as Rule[];
              },
            ),
        );
        const pr = rules.find((x) => x.type === "pull_request");
        if (pr) {
          isProtected = true;
          reviews = pr.parameters?.required_approving_review_count ?? 0;
        }
      }
      const sa = r.security_and_analysis;
      repositories.push({
        system: "github",
        name: r.full_name,
        private: r.private,
        protected: isProtected,
        ...(reviews !== undefined ? { reviews } : {}),
        ...(sa?.secret_scanning ? { secretScanning: sa.secret_scanning.status === "enabled" } : {}),
        ...(sa?.dependabot_security_updates
          ? { dependencyAlerts: sa.dependabot_security_updates.status === "enabled" }
          : {}),
      });
    }
    const priv = repositories.filter((r) => r.private);
    return {
      at: now.toISOString().replace(/\.\d+Z$/, "Z"),
      provider: "github",
      account: org.name || org.login,
      assets: [
        ...members.map((m) => ({
          kind: "member",
          id: String(m.id),
          name: m.login,
          facts: { owner: ownerSet.has(m.login) },
        })),
        ...repositories.map((r) => ({
          kind: "repository",
          id: r.name,
          name: r.name,
          facts: { private: r.private, protected: !!r.protected, reviews: r.reviews ?? 0 },
        })),
      ],
      posture: {
        ...(org.two_factor_requirement_enabled !== undefined
          ? { orgRequires2fa: org.two_factor_requirement_enabled }
          : {}),
        ...(owners ? { owners: owners.length } : {}),
        ...(no2fa ? { membersWithout2fa: no2fa.length } : {}),
        privateRepos: priv.length,
        privateReposProtected: priv.filter((r) => r.protected).length,
        privateReposReviewed: priv.filter((r) => (r.reviews ?? 0) >= 1).length,
        ...(priv.some((r) => r.secretScanning !== undefined)
          ? { privateReposSecretScanning: priv.filter((r) => r.secretScanning).length }
          : {}),
      },
      gaps,
      entities: { accounts, repositories },
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
        scf: ["IAC-06"],
        fact: "orgRequires2fa",
        want: (v) => v === true,
        fix: "github.com/organizations/<org>/settings/security > Require two-factor authentication",
      }),
      check(o, {
        id: "gh-owners",
        title: "Two to four owners",
        scf: ["IAC-21"],
        fact: "owners",
        want: (v) => typeof v === "number" && v >= 2 && v <= 4,
        fix: "github.com/orgs/<org>/people > Role: Owner; make the rest Members",
        warnOnly: true,
      }),
      check(o, {
        id: "gh-protected",
        title: "Every private repository protects its default branch",
        scf: ["CHG-02"],
        fact: "privateReposProtected",
        want: all,
        show: of,
        fix:
          "each repository > Settings > Rules (or Branches): require a pull request and passing checks",
      }),
      check(o, {
        id: "gh-reviewed",
        title: "Every private repository requires an approving review",
        scf: ["CHG-02"],
        fact: "privateReposReviewed",
        want: all,
        show: of,
        fix: "the default branch's rule: Require approvals, 1 or more",
      }),
      check(o, {
        id: "gh-secret-scanning",
        title: "Every private repository scans for secrets",
        scf: ["VPM-06"],
        fact: "privateReposSecretScanning",
        want: all,
        show: of,
        fix: "the organization > Settings > Code security: Secret scanning on for all repositories",
        warnOnly: true,
      }),
    ];
  },
};
