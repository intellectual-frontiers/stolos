/**
 * Spec 091: what the code-host connectors declared with the SDK share: a
 * branch-name pattern matcher, the repositories' posture (private ones
 * protected, reviewed, scanned for secrets), and the policies on it. Evidence
 * for change management (SCF CHG-03), MFA (IAC-37), least privilege
 * (IAC-30), and scanning (VPM-12).
 *
 * @module
 */

import { check, fresh, type Observation } from "./connector.ts";
import type { ObservedRecord } from "./sdk.ts";
import type { PolicyResult } from "../adopt/policy.ts";

/** Whether a branch name matches a pattern where `*` is any run of characters (GitLab, Bitbucket). */
export function branchMatches(pattern: string, branch: string): boolean {
  const re = pattern
    .split("*")
    .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${re}$`).test(branch);
}

/** Members' and repositories' posture from the records. */
export function codeHostPosture(records: ObservedRecord[]): Observation["posture"] {
  const members = records.filter((r) => r.label === "user_account" && !r.props["service"]);
  const mfaKnown = members.some((r) => typeof r.props["mfa"] === "boolean");
  const adminKnown = members.some((r) => typeof r.props["admin"] === "boolean");
  const priv = records.filter((r) => r.label === "code_repository" && r.props["private"]);
  return {
    members: members.length,
    ...(adminKnown ? { owners: members.filter((r) => r.props["admin"]).length } : {}),
    ...(mfaKnown
      ? { membersWithout2fa: members.filter((r) => r.props["mfa"] === false).length }
      : {}),
    privateRepos: priv.length,
    privateReposProtected: priv.filter((r) => r.props["protected"]).length,
    privateReposReviewed: priv.filter((r) => Number(r.props["reviews"] ?? 0) >= 1).length,
    ...(priv.some((r) => typeof r.props["secret_scanning"] === "boolean")
      ? { privateReposSecretScanning: priv.filter((r) => r.props["secret_scanning"]).length }
      : {}),
  };
}

/** How to fix each code-host policy, in the vendor's words. */
export interface CodeHostFixes {
  /** Require 2FA for everyone. */
  require2fa: string;
  /** Members without 2FA. */
  members2fa: string;
  /** Fewer owners. */
  owners: string;
  /** Protect the default branch. */
  protect: string;
  /** Require an approval. */
  review: string;
  /** Scan for secrets. */
  secrets: string;
}

/** A code host's policies (ids prefixed with `prefix`). */
export function codeHostPolicies(
  id: string,
  prefix: string,
  fix: CodeHostFixes,
): (o: Observation, now: number) => PolicyResult[] {
  return (o, now) => {
    const all = (v: unknown) => v === o.posture["privateRepos"];
    const of = (v: string | number | boolean) =>
      `${v} of ${o.posture["privateRepos"]} private repositories`;
    return [
      fresh(o, now, id),
      check(o, {
        id: `${prefix}-2fa-required`,
        title: "Two-factor authentication is required for everyone",
        scf: ["IAC-37"],
        fact: "orgRequires2fa",
        want: (v) => v === true,
        fix: fix.require2fa,
      }),
      check(o, {
        id: `${prefix}-2fa`,
        title: "Every member has two-factor authentication",
        scf: ["IAC-37"],
        fact: "membersWithout2fa",
        want: (v) => v === 0,
        show: (v) => `${v} of ${o.posture["members"]} members without it`,
        fix: fix.members2fa,
      }),
      check(o, {
        id: `${prefix}-owners`,
        title: "Two to four owners",
        scf: ["IAC-30"],
        fact: "owners",
        want: (v) => typeof v === "number" && v >= 2 && v <= 4,
        fix: fix.owners,
        warnOnly: true,
      }),
      check(o, {
        id: `${prefix}-protected`,
        title: "Every private repository protects its default branch",
        scf: ["CHG-03"],
        fact: "privateReposProtected",
        want: all,
        show: of,
        fix: fix.protect,
      }),
      check(o, {
        id: `${prefix}-reviewed`,
        title: "Every private repository requires an approving review",
        scf: ["CHG-03"],
        fact: "privateReposReviewed",
        want: all,
        show: of,
        fix: fix.review,
      }),
      check(o, {
        id: `${prefix}-secret-scanning`,
        title: "Every private repository scans for secrets",
        scf: ["VPM-12"],
        fact: "privateReposSecretScanning",
        want: all,
        show: of,
        fix: fix.secrets,
        warnOnly: true,
      }),
    ];
  };
}
