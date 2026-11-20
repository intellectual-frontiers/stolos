/**
 * Spec 086: Wave 1 connectors (identity, code, HR) against recorded API responses, read-only, and
 * joined in the estate graph.
 *
 * @module
 */

import {
  assert,
  assertEquals,
  assertStringIncludes,
  proves,
} from "@intellectual-frontiers/commons/ts/runtime/test";
import type { Result } from "@intellectual-frontiers/core";
import type { http } from "@intellectual-frontiers/net";
import { github } from "../src/archon/connect/github.ts";
import { okta } from "../src/archon/connect/okta.ts";
import { google, serviceAccountJwt } from "../src/archon/connect/google.ts";
import { bamboohr, rippling } from "../src/archon/connect/hris.ts";
import { buildGraph, estatePolicies } from "../src/archon/estate/graph.ts";

const NOW = new Date("2026-11-15T12:00:00Z");
type Route = [number, unknown, string?];
/** A fake API, as a transport: path (and query) prefix to [status, body, Link]; every call is recorded. */
function fake(
  routes: Record<string, Route>,
): http.Transport & { calls: Array<{ url: string; method: string }> } {
  const calls: Array<{ url: string; method: string }> = [];
  return {
    kind: "recorded",
    calls,
    send(r): Promise<Result<http.Exchange, http.TransportError>> {
      calls.push({ url: r.url, method: r.method });
      const u = new URL(r.url);
      const key = Object.keys(routes)
        .filter((k) => `${u.host}${u.pathname}${u.search}`.startsWith(k))
        .sort((a, b) => b.length - a.length)[0];
      const [status, body, link] = (key === undefined ? undefined : routes[key]) ?? [404, {}];
      return Promise.resolve({
        kind: "ok",
        value: {
          method: r.method,
          url: r.url,
          status,
          headers: link ? { link } : {},
          body: typeof body === "string" ? body : JSON.stringify(body),
        },
      });
    },
  };
}
const reads = (
  h: { calls: Array<{ method: string; url: string }> },
  allowed: RegExp[] = [],
): boolean => h.calls.every((c) => c.method === "GET" || allowed.some((r) => r.test(c.url)));

proves(
  ["086-wave1-connectors FR-001"],
  "086: GitHub: owners, members without 2FA, branch protection or rulesets, reviews",
  async () => {
    const A = "api.github.com";
    const http = fake({
      [`${A}/orgs/ex?`]: [200, {}],
      [`${A}/orgs/ex`]: [
        200,
        {
          login: "ex",
          name: "Example",
          two_factor_requirement_enabled: false,
        },
      ],
      [`${A}/orgs/ex/members?per_page=100`]: [
        200,
        [
          { login: "alice", id: 1, type: "User" },
          {
            login: "bob",
            id: 2,
            type: "User",
          },
        ],
        `<https://${A}/orgs/ex/members?per_page=100&page=2>; rel="next"`,
      ],
      [`${A}/orgs/ex/members?per_page=100&page=2`]: [
        200,
        [{ login: "ci-bot", id: 3, type: "Bot" }],
      ],
      [`${A}/orgs/ex/members?role=admin`]: [200, [{ login: "alice" }]],
      [`${A}/orgs/ex/members?filter=2fa_disabled`]: [200, [{ login: "bob" }]],
      [`${A}/orgs/ex/repos`]: [
        200,
        [
          {
            name: "app",
            full_name: "ex/app",
            private: true,
            archived: false,
            default_branch: "main",
            security_and_analysis: { secret_scanning: { status: "enabled" } },
          },
          {
            name: "infra",
            full_name: "ex/infra",
            private: true,
            archived: false,
            default_branch: "main",
          },
          {
            name: "old",
            full_name: "ex/old",
            private: true,
            archived: true,
            default_branch: "main",
          },
          {
            name: "site",
            full_name: "ex/site",
            private: false,
            archived: false,
            default_branch: "main",
          },
        ],
      ],
      [`${A}/repos/ex/app/branches/main/protection`]: [
        200,
        {
          required_pull_request_reviews: { required_approving_review_count: 1 },
        },
      ],
      [`${A}/repos/ex/infra/rules/branches/main`]: [
        200,
        [
          {
            type: "pull_request",
            parameters: { required_approving_review_count: 0 },
          },
        ],
      ],
      [`${A}/repos/ex/site/rules/branches/main`]: [200, []],
      // Spec 088: no open Dependabot alert.
      [`${A}/orgs/ex/dependabot/alerts`]: [200, []],
    });
    const o = await github.observe({ org: "ex", token: "t" }, http, NOW);
    assertEquals(
      (o.entities?.accounts ?? []).map((a) => [a.name, a.admin, a.mfa, !!a.service]),
      [
        ["alice", true, true, false],
        ["bob", false, false, false],
        ["ci-bot", false, true, true],
      ],
    );
    assertEquals(
      (o.entities?.repositories ?? []).map((r) => [r.name, r.protected, r.reviews ?? null]),
      [
        ["ex/app", true, 1],
        ["ex/infra", true, 0],
        ["ex/site", false, null],
      ],
    );
    const by = Object.fromEntries(github.policies(o, NOW.getTime()).map((p) => [p.id, p.status]));
    assertEquals(by["gh-2fa-required"], "fail");
    assertEquals(by["gh-protected"], "pass");
    assertEquals(by["gh-reviewed"], "fail");
    assertEquals(by["gh-owners"], "warn");
    assert(reads(http), "only reads");
  },
);

proves(
  ["086-wave1-connectors FR-001"],
  "086: Okta: active users, administrators, second factors",
  async () => {
    const D = "example.okta.com";
    const http = fake({
      [`${D}/api/v1/users?limit=200`]: [
        200,
        [
          {
            id: "u1",
            status: "ACTIVE",
            profile: { login: "alice@example.org", email: "alice@example.org" },
          },
          {
            id: "u2",
            status: "ACTIVE",
            profile: { login: "carol@example.org", email: "carol@example.org" },
          },
          {
            id: "u3",
            status: "DEPROVISIONED",
            profile: { login: "bob@example.org", email: "bob@example.org" },
          },
        ],
      ],
      [`${D}/api/v1/iam/assignees/users`]: [200, [{ id: "u1" }]],
      [`${D}/api/v1/users/u1/factors`]: [200, [{ status: "ACTIVE" }]],
      [`${D}/api/v1/users/u2/factors`]: [200, []],
      [`${D}/api/v1/apps`]: [200, []],
    });
    const o = await okta.observe({ domain: D, token: "t" }, http, NOW);
    assertEquals(
      (o.entities?.accounts ?? []).map((a) => [a.email, a.active, a.admin, a.mfa ?? null]),
      [
        ["alice@example.org", true, true, true],
        ["carol@example.org", true, false, false],
        ["bob@example.org", false, false, null],
      ],
    );
    const by = Object.fromEntries(okta.policies(o, NOW.getTime()).map((p) => [p.id, p]));
    assertEquals(by["okta-mfa"]?.status, "fail");
    assertStringIncludes(by["okta-mfa"]?.detail ?? "", "1 of 2 active users");
    assert(reads(http));
  },
);

proves(
  ["086-wave1-connectors FR-001"],
  "086: Google Workspace: a signed JWT for a read-only scope, then users",
  async () => {
    const kp = await crypto.subtle.generateKey(
      {
        name: "RSASSA-PKCS1-v1_5",
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: "SHA-256",
      },
      true,
      ["sign", "verify"],
    );
    const der = new Uint8Array(await crypto.subtle.exportKey("pkcs8", kp.privateKey));
    const pem = `-----BEGIN PRIVATE KEY-----\n${btoa(
      String.fromCharCode(...der),
    )}\n-----END PRIVATE KEY-----\n`;
    const jwt = await serviceAccountJwt(
      { client_email: "sa@x.iam.gserviceaccount.com", private_key: pem },
      "admin@example.org",
      "s",
      NOW,
    );
    const [h, c, sig] = jwt.split(".");
    const unb = (s: string) =>
      Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (x) => x.charCodeAt(0));
    assert(
      await crypto.subtle.verify(
        "RSASSA-PKCS1-v1_5",
        kp.publicKey,
        unb(sig ?? ""),
        new TextEncoder().encode(`${h}.${c}`),
      ),
      "the signature verifies",
    );
    const claims = JSON.parse(new TextDecoder().decode(unb(c ?? ""))) as { sub?: string };
    assertEquals(claims.sub, "admin@example.org");
    const http = fake({
      "oauth2.googleapis.com/token": [200, { access_token: "x" }],
      "admin.googleapis.com/admin/directory/v1/users": [
        200,
        {
          users: [
            {
              id: "1",
              primaryEmail: "alice@example.org",
              isAdmin: true,
              isEnrolledIn2Sv: true,
              isEnforcedIn2Sv: true,
            },
            { id: "2", primaryEmail: "bob@example.org", isEnrolledIn2Sv: false },
            { id: "3", primaryEmail: "old@example.org", suspended: true },
          ],
        },
      ],
    });
    const o = await google.observe(
      {
        admin: "admin@example.org",
        key: JSON.stringify({ client_email: "sa@x", private_key: pem }),
      },
      http,
      NOW,
    );
    assertEquals(
      (o.entities?.accounts ?? []).map((a) => [a.email, a.active, a.admin, a.mfa]),
      [
        ["alice@example.org", true, true, true],
        ["bob@example.org", true, false, false],
        ["old@example.org", false, false, false],
      ],
    );
    assertEquals(o.posture["activeWithout2sv"], 1);
    assert(reads(http, [/oauth2\.googleapis\.com\/token/]), "only the token request is a POST");
  },
);

proves(
  ["086-wave1-connectors FR-001", "085-estate-graph FR-003"],
  "086: HR systems: the roster only; joined with accounts, leavers fail",
  async () => {
    const bamboo = fake({
      "api.bamboohr.com/api/gateway.php/ex/v1/reports/custom": [
        200,
        {
          employees: [
            {
              displayName: "Alice",
              workEmail: "alice@example.org",
              status: "Active",
              hireDate: "2024-01-02",
              terminationDate: "0000-00-00",
              payRate: "100000",
            },
            {
              displayName: "Bob",
              workEmail: "bob@example.org",
              status: "Inactive",
              hireDate: "2023-01-02",
              terminationDate: "2026-10-31",
            },
          ],
        },
      ],
    });
    const b = await bamboohr.observe({ subdomain: "ex", key: "k" }, bamboo, NOW);
    assertEquals(
      (b.entities?.people ?? []).map((p) => [p.email, p.status, p.end ?? null]),
      [
        ["alice@example.org", "active", null],
        ["bob@example.org", "terminated", "2026-10-31"],
      ],
    );
    assert(!JSON.stringify(b).includes("100000"), "never pay or personal fields");
    assertEquals(b.assets, [], "people are not listed as assets");
    const rip = fake({
      "api.rippling.com/platform/api/employees/include_terminated": [
        200,
        [
          {
            id: "e1",
            name: "Carol",
            workEmail: "carol@example.org",
            roleState: "ACTIVE",
            startDate: "2025-03-01",
            manager: "e2",
          },
          {
            id: "e2",
            name: "Dan",
            workEmail: "dan@example.org",
            roleState: "TERMINATED",
            endDate: "2026-09-30",
          },
        ],
      ],
    });
    const r = await rippling.observe({ token: "t" }, rip, NOW);
    assertEquals(
      (r.entities?.people ?? []).map((p) => [p.email, p.status, p.manager ?? null]),
      [
        ["carol@example.org", "active", "dan@example.org"],
        ["dan@example.org", "terminated", null],
      ],
    );
    const at = "2026-11-15T00:00:00Z";
    const e = buildGraph({
      fleet: "lab",
      machines: [],
      links: {},
      sources: [
        { connector: "bamboohr", observation: { ...b, at } },
        {
          connector: "okta",
          observation: {
            at,
            provider: "okta",
            account: "example.okta.com",
            assets: [],
            posture: {},
            gaps: [],
            entities: {
              accounts: [
                {
                  system: "okta",
                  id: "1",
                  name: "bob",
                  email: "bob@example.org",
                  active: true,
                },
              ],
            },
          },
        },
      ],
    });
    assertEquals(estatePolicies(e).find((p) => p.id === "leavers")?.status, "fail");
  },
);
