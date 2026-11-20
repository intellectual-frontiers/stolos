/**
 * Spec 087 part B: Jira, Linear, Slack, 1Password, and Bitwarden, declared with the connector SDK,
 * against recorded API responses: read-only, accounts become the estate's accounts, tickets and
 * shared vaults become nodes of the estate graph, a denied part is a gap, a failing policy says how
 * to fix it, and the estate graph checks password manager coverage.
 *
 * @module
 */

import {
  assert,
  assertExists,
  assertEquals,
  assertStringIncludes,
  proves,
} from "@intellectual-frontiers/commons/ts/runtime/test";
import { recordedHttp } from "../src/archon/connect/sdk.ts";
import type { Result } from "@intellectual-frontiers/core";
import type { http } from "@intellectual-frontiers/commons/ts/runtime";
import { MARKET_CATEGORIES, type Observation } from "../src/archon/connect/connector.ts";
import { CONNECTORS } from "../src/archon/connect/commands.ts";
import { COMMANDS } from "../src/archon/commands/registry.ts";
import { CONNECTOR_LABELS } from "../src/archon/connect/labels.ts";
import { schemaProblems } from "../src/archon/schema/define.ts";
import { SCF } from "../src/archon/compliance/scf.ts";
import { buildGraph, estatePolicies, estateQuery } from "../src/archon/estate/graph.ts";
import { devSummary, jira } from "../src/archon/connect/jira.ts";
import { linear, LINEAR_GRAPHQL } from "../src/archon/connect/linear.ts";
import { slack } from "../src/archon/connect/slack.ts";
import { onepassword } from "../src/archon/connect/onepassword.ts";
import { bitwarden, bitwardenUrls } from "../src/archon/connect/bitwarden.ts";
import { devLinks, ticketType } from "../src/archon/connect/ticketing.ts";

const NOW = new Date("2026-11-15T12:00:00Z");
type Calls = Array<{ method: string; url: string }>;
const onlyReads = (calls: Calls, post: string[] = []): boolean =>
  calls.every((c) => c.method === "GET" || (c.method === "POST" && post.includes(c.url)));
type PolicyRow = { id: string; status: string; fix?: string; detail: string; scf: string[] };
function result(
  o: Observation,
  c: { policies: (o: Observation, n: number) => unknown },
  id: string,
): PolicyRow | undefined {
  const r = (c.policies(o, NOW.getTime()) as PolicyRow[]).find((p) => p.id === id);
  return r;
}
const DENIED = { status: 403, body: { message: "Forbidden" } };
/** `f` rejects with an Error whose message includes `includes`. */
async function assertRejects(f: () => Promise<unknown>, _type: unknown, includes: string) {
  try {
    await f();
  } catch (e) {
    assertStringIncludes((e as Error).message, includes);
    return;
  }
  throw new Error(`expected a rejection including "${includes}"`);
}
const IDS = ["jira", "linear", "slack", "onepassword", "bitwarden"];

proves(
  ["087-wave2-connectors FR-003", "087-wave2-connectors FR-004", "087-wave2-connectors FR-005"],
  "087b: the five are registered, labeled, offered by every connector command, and cite real SCF ids",
  () => {
    const markets = new Set(MARKET_CATEGORIES.map((m) => m.id));
    const scf = new Set(SCF.map((c) => c.id));
    for (const id of IDS) {
      const c = CONNECTORS.find((x) => x.id === id);
      assert(c, id);
      assertEquals(c.serviceModels, ["SaaS"]);
      assert(c.markets.length && c.markets.every((m) => markets.has(m)), `${id}: markets`);
      assert(c.connectHelp.join(" ").match(/read/i), `${id}: read-only help`);
      assert(
        c.fields.some((f) => f.secret),
        `${id}: a secret field`,
      );
      const empty = {
        at: NOW.toISOString(),
        provider: id,
        account: "",
        assets: [],
        posture: {},
        gaps: [],
      };
      for (const p of c.policies(empty, NOW.getTime())) {
        for (const x of p.scf) assert(scf.has(x), `${id} ${p.id}: ${x}`);
      }
    }
    for (const cmd of COMMANDS.filter((c) =>
      c.args?.some((a) => a.choices?.includes("rippling")),
    )) {
      const choices = cmd.args?.find((a) => a.choices?.includes("rippling"))?.choices ?? [];
      assertEquals(
        choices,
        CONNECTORS.map((c) => c.id),
        cmd.name,
      );
    }
    assertEquals(schemaProblems(CONNECTOR_LABELS), []);
    for (const l of ["ticket", "password_store"]) {
      assert(
        CONNECTOR_LABELS.some((x) => x.name === l),
        l,
      );
    }
  },
);

proves(
  ["087-wave2-connectors FR-003"],
  "087b: tickets are classed, and commits and pull requests found among links",
  () => {
    assertEquals(ticketType("Change"), "change");
    assertEquals(ticketType("Task", "Change Management"), "change");
    assertEquals(ticketType("[System] Incident"), "incident");
    assertEquals(ticketType("Bug", "Website"), "other");
    assertEquals(
      devLinks([
        "https://github.com/example/app/commit/ABCDEF1234567",
        "https://gitlab.example.org/g/p/-/merge_requests/3",
        "https://example.org/wiki",
        "https://github.com/example/app/pull/7",
        "https://github.com/example/app/pull/7",
        undefined,
      ]),
      [
        "abcdef1234567",
        "https://gitlab.example.org/g/p/-/merge_requests/3",
        "https://github.com/example/app/pull/7",
      ],
    );
    assertEquals(
      devSummary(
        '{pullrequest={dataType=pullrequest, state=MERGED, stateCount=2}, json={"cachedValue":{"errors":[],"summary":{"pullrequest":{"overall":{"count":2}},"repository":{"overall":{"count":5}}}}}}',
      ),
      { commits: 5, pull_requests: 2 },
    );
    assertEquals(devSummary("{}"), {});
    assertEquals(devSummary(null), {});
  },
);

const J = "https://api.atlassian.com/ex/jira/c1";
const JQL = `${J}/rest/api/3/search/jql?jql=${encodeURIComponent(
  'created >= "2026-08-17" ORDER BY created DESC',
)}&fields=summary,issuetype,project,status,created,resolutiondate,customfield_10000&maxResults=100`;
const DEV =
  '{pullrequest={dataType=pullrequest, state=MERGED, stateCount=1}, json={"cachedValue":{"errors":[],"summary":{"pullrequest":{"overall":{"count":1}},"repository":{"overall":{"count":3}}}}}}';
const issue = (key: string, type: string, resolved: string | null, dev = "{}") => ({
  id: key,
  key,
  fields: {
    summary: `${key} summary`,
    issuetype: { name: type },
    project: { key: "OPS", name: "Operations" },
    status: { name: resolved ? "Done" : "In Progress" },
    created: "2026-10-01T10:00:00.000+0000",
    resolutiondate: resolved,
    customfield_10000: dev,
  },
});
const jiraFixtures = {
  "https://example.atlassian.net/_edge/tenant_info": { body: { cloudId: "c1" } },
  [`${J}/rest/api/3/users/search?startAt=0&maxResults=100`]: {
    body: [
      {
        accountId: "a1",
        accountType: "atlassian",
        emailAddress: "Alice@example.org",
        displayName: "Alice",
        active: true,
      },
      { accountId: "a2", accountType: "atlassian", displayName: "Bob", active: true },
      { accountId: "a3", accountType: "atlassian", displayName: "Carol", active: false },
      { accountId: "bot", accountType: "app", displayName: "Automation", active: true },
    ],
  },
  [`${J}/rest/api/3/groups/picker?query=admin&maxResults=50`]: {
    body: {
      groups: [
        { name: "jira-admins-example", groupId: "g1" },
        {
          name: "admin-helpers",
          groupId: "g2",
        },
      ],
    },
  },
  [`${J}/rest/api/3/group/member?groupId=g1&startAt=0&maxResults=50`]: {
    body: { values: [{ accountId: "a1" }], isLast: true },
  },
  [`${J}/rest/api/3/field`]: {
    body: [
      { id: "summary", schema: {} },
      {
        id: "customfield_10000",
        schema: {
          custom: "com.atlassian.jira.plugins.jira-development-integration-plugin:devsummarycf",
        },
      },
    ],
  },
  [JQL]: {
    body: {
      issues: [
        issue("OPS-1", "Change", "2026-10-02T10:00:00.000+0000", DEV),
        issue("OPS-2", "Change", "2026-10-03T10:00:00.000+0000"),
        issue("OPS-3", "Incident", null),
      ],
      nextPageToken: "t2",
      isLast: false,
    },
  },
  [`${JQL}&nextPageToken=t2`]: {
    body: { issues: [issue("OPS-4", "Change", "2026-10-04T10:00:00.000+0000")], isLast: true },
  },
  [`${J}/rest/api/3/issue/OPS-2/remotelink`]: {
    body: [
      { object: { url: "https://github.com/example/app/pull/7" } },
      {
        object: { url: "https://example.org/doc" },
      },
    ],
  },
  [`${J}/rest/api/3/issue/OPS-4/remotelink`]: { body: [] },
};

proves(
  ["087-wave2-connectors FR-003"],
  "087b: Jira: people and admin groups, tickets with their development links, an unlinked change fails",
  async () => {
    const calls: Calls = [];
    const cred = { site: "https://Example.atlassian.net/", email: "alice@example.org", token: "t" };
    const o = await jira.observe(cred, recordedHttp(jiraFixtures, calls), NOW);
    assert(onlyReads(calls));
    assertEquals(o.account, "example.atlassian.net");
    assertEquals(o.gaps, []);
    assertEquals(
      o.entities?.accounts?.map((a) => [a.id, a.email, a.active, a.admin]),
      [
        ["a1", "alice@example.org", true, true],
        ["a2", undefined, true, false],
        ["a3", undefined, false, false],
      ],
    );
    const tickets = (o.records ?? []).filter((r) => r.label === "ticket");
    assertEquals(
      tickets.map((t) => [t.native_id, t.props["type"], t.props["resolved"] ?? null]),
      [
        ["OPS-1", "change", "2026-10-02T10:00:00Z"],
        ["OPS-2", "change", "2026-10-03T10:00:00Z"],
        ["OPS-3", "incident", null],
        ["OPS-4", "change", "2026-10-04T10:00:00Z"],
      ],
    );
    assertEquals(tickets[0]?.props["commits"], 3);
    assertEquals(tickets[0]?.props["pull_requests"], 1);
    assertEquals(tickets[1]?.props["links"], ["https://github.com/example/app/pull/7"]);
    assertEquals(tickets[0]?.ocsf_class_uid, 5023);
    assertEquals(o.posture["changeTickets"], 3);
    assertEquals(o.posture["resolvedChangesUnlinked"], 1);
    assertEquals(o.posture["openIncidents"], 1);
    assertEquals(o.posture["admins"], 1);
    const linked = result(o, jira, "jira-changes-linked");
    assertEquals(linked?.status, "fail");
    assertEquals(linked?.scf, ["CHG-03"]);
    assertStringIncludes(linked?.detail ?? "", "1 of 3");
    assertStringIncludes(linked?.fix ?? "", "GitHub for Jira");
    assertEquals(result(o, jira, "jira-changes")?.status, "pass");
    assertEquals(result(o, jira, "jira-admins")?.status, "warn");
    assertEquals(result(o, jira, "observed")?.status, "pass");

    const denied = await jira.observe(
      cred,
      recordedHttp({
        ...jiraFixtures,
        [`${J}/rest/api/3/groups/picker?query=admin&maxResults=50`]: DENIED,
        [`${J}/rest/api/3/field`]: DENIED,
        [JQL.replace(",customfield_10000", "")]: DENIED,
      }),
      NOW,
    );
    assertStringIncludes(denied.gaps.join(";"), "administrators groups:");
    assertStringIncludes(denied.gaps.join(";"), "tickets:");
    assertEquals(denied.posture["admins"], undefined);
    assertEquals(result(denied, jira, "jira-admins")?.status, "unknown");
    assertEquals(denied.entities?.accounts?.length, 3);
  },
);

/** Linear's GraphQL, recorded by operation name and cursor. */
function linearHttp(
  answers: Record<string, unknown>,
  calls: Calls,
  bodies: string[] = [],
): http.Transport {
  const refuse = (message: string): Promise<Result<http.Exchange, http.TransportError>> =>
    Promise.resolve({ kind: "err", error: { kind: "refused", message } });
  return {
    kind: "recorded",
    send(q): Promise<Result<http.Exchange, http.TransportError>> {
      calls.push({ method: q.method, url: q.url });
      bodies.push(q.body ?? "");
      if (q.url !== LINEAR_GRAPHQL) return refuse(`no recorded response for ${q.url}`);
      const b = JSON.parse(q.body ?? "{}") as { query: string; variables: { after?: string } };
      const op = b.query.match(/^\s*query\s+(\w+)/)?.[1] ?? "";
      const a = answers[`${op}${b.variables?.after ? `:${b.variables.after}` : ""}`];
      if (a === undefined) return refuse(`no recorded answer for ${op}`);
      const r = a as { status?: number; body?: unknown };
      return Promise.resolve({
        kind: "ok",
        value: {
          method: q.method,
          url: q.url,
          status: r.status ?? 200,
          headers: {},
          body: JSON.stringify(r.status ? r.body : a),
        },
      });
    },
  };
}

const page = <T>(nodes: T[], end?: string) => ({
  nodes,
  pageInfo: { hasNextPage: !!end, endCursor: end ?? null },
});
const linearAnswers = {
  Org: {
    data: { organization: { id: "o1", name: "Example", urlKey: "example", samlEnabled: false } },
  },
  Users: {
    data: {
      users: page(
        [
          {
            id: "u1",
            name: "Alice",
            email: "alice@example.org",
            active: true,
            admin: true,
            guest: false,
            lastSeen: "2026-11-14T09:00:00Z",
          },
          {
            id: "u2",
            name: "Bob",
            email: "bob@example.org",
            active: true,
            admin: false,
            guest: true,
          },
        ],
        "c1",
      ),
    },
  },
  "Users:c1": {
    data: {
      users: page([
        {
          id: "u3",
          name: "Carol",
          email: "carol@example.org",
          active: false,
          admin: true,
        },
      ]),
    },
  },
  Issues: {
    data: {
      issues: page([
        {
          identifier: "ENG-1",
          title: "Rotate the certificates",
          url: "https://linear.app/example/issue/ENG-1",
          createdAt: "2026-10-01T00:00:00Z",
          completedAt: "2026-10-02T00:00:00Z",
          state: { name: "Done" },
          team: { key: "ENG", name: "Engineering" },
          labels: { nodes: [{ name: "Change" }] },
          attachments: {
            nodes: [
              { url: "https://github.com/example/app/pull/12", sourceType: "github" },
              { url: "https://github.com/example/app/commit/0123abcd", sourceType: "github" },
            ],
          },
        },
        {
          identifier: "ENG-2",
          title: "Upgrade the database",
          createdAt: "2026-10-03T00:00:00Z",
          completedAt: "2026-10-05T00:00:00Z",
          state: { name: "Done" },
          team: { key: "ENG", name: "Engineering" },
          labels: { nodes: [{ name: "change" }] },
          attachments: { nodes: [] },
        },
        {
          identifier: "ENG-3",
          title: "Site down",
          createdAt: "2026-10-06T00:00:00Z",
          state: { name: "In Progress" },
          team: { key: "ENG", name: "Engineering" },
          labels: { nodes: [{ name: "Incident" }] },
          attachments: { nodes: [] },
        },
      ]),
    },
  },
};

proves(
  ["087-wave2-connectors FR-003"],
  "087b: Linear: queries only, people and admins, issues with attached pull requests, SAML off warns",
  async () => {
    const calls: Calls = [];
    const bodies: string[] = [];
    const o = await linear.observe(
      { token: "lin_api_x" },
      linearHttp(linearAnswers, calls, bodies),
      NOW,
    );
    assert(onlyReads(calls, [LINEAR_GRAPHQL]));
    assert(bodies.every((b) => !/mutation/i.test(b)));
    assertStringIncludes(bodies.find((b) => b.includes("Issues")) ?? "", "2026-08-17T12:00:00Z");
    assertEquals(o.account, "example");
    assertEquals(o.gaps, []);
    assertEquals(
      o.entities?.accounts?.map((a) => [a.email, a.active, a.admin, a.lastLogin]),
      [
        ["alice@example.org", true, true, "2026-11-14T09:00:00Z"],
        ["bob@example.org", true, false, undefined],
        ["carol@example.org", false, true, undefined],
      ],
    );
    const t = (o.records ?? []).filter((r) => r.label === "ticket");
    assertEquals(
      t.map((x) => [x.native_id, x.props["type"]]),
      [
        ["ENG-1", "change"],
        ["ENG-2", "change"],
        ["ENG-3", "incident"],
      ],
    );
    assertEquals(t[0]?.props["links"], ["https://github.com/example/app/pull/12", "0123abcd"]);
    assertEquals([t[0]?.props["commits"], t[0]?.props["pull_requests"]], [1, 1]);
    assertEquals(o.posture["samlRequired"], false);
    assertEquals(o.posture["admins"], 1);
    assertEquals(result(o, linear, "linear-saml")?.status, "warn");
    const linked = result(o, linear, "linear-changes-linked");
    assertEquals(linked?.status, "fail");
    assertStringIncludes(linked?.fix ?? "", "Integrations");

    const denied = await linear.observe(
      { token: "lin_api_x" },
      linearHttp(
        {
          ...linearAnswers,
          Issues: {
            status: 400,
            body: { errors: [{ message: "no", extensions: { code: "FORBIDDEN" } }] },
          },
        },
        [],
      ),
      NOW,
    );
    assertStringIncludes(denied.gaps.join(";"), "issues:");
    assertEquals(denied.entities?.accounts?.length, 3);
    // A mutation never leaves.
    const c2: Calls = [];
    const { linearQuery } = await import("../src/archon/connect/linear.ts");
    await assertRejects(
      () =>
        linearQuery(
          { http: linearHttp({}, c2), headers: {} },
          'mutation { issueDelete(id: "x") { success } }',
        ),
      Error,
      "read-only",
    );
    assertEquals(c2, []);
  },
);

const S = "https://slack.com/api";
const CH = `${S}/conversations.list?types=public_channel%2Cprivate_channel&exclude_archived=true&limit=200`;
const slackUsers = (has2fa: boolean) => [
  { id: "USLACKBOT", name: "slackbot", is_bot: false },
  {
    id: "U1",
    name: "alice",
    is_owner: true,
    is_admin: true,
    profile: { email: "alice@example.org" },
    ...(has2fa ? { has_2fa: true } : {}),
  },
  {
    id: "U2",
    name: "bob",
    profile: { email: "bob@example.org" },
    ...(has2fa ? { has_2fa: false } : {}),
  },
  {
    id: "U3",
    name: "guest",
    is_restricted: true,
    profile: { email: "eve@example.net" },
    ...(has2fa ? { has_2fa: true } : {}),
  },
  { id: "U4", name: "carol", deleted: true, profile: { email: "carol@example.org" } },
  { id: "B1", name: "deploybot", is_bot: true },
];
const slackFixtures = {
  [`${S}/team.info`]: {
    body: { ok: true, team: { id: "T1", name: "Example", domain: "example" } },
  },
  [CH]: {
    body: {
      ok: true,
      channels: [{ id: "C1", is_ext_shared: true }, { id: "C2" }],
      response_metadata: { next_cursor: "n2" },
    },
  },
  [`${CH}&cursor=n2`]: {
    body: {
      ok: true,
      channels: [{ id: "C3", is_pending_ext_shared: true }],
      response_metadata: { next_cursor: "" },
    },
  },
  [`${S}/users.list?limit=200`]: {
    body: {
      ok: true,
      members: slackUsers(true).slice(0, 3),
      response_metadata: { next_cursor: "u2" },
    },
  },
  [`${S}/users.list?limit=200&cursor=u2`]: {
    body: { ok: true, members: slackUsers(true).slice(3) },
  },
};

proves(
  ["087-wave2-connectors FR-004"],
  "087b: Slack: people, owners and admins, guests, two-factor, shared channels, by GET",
  async () => {
    const calls: Calls = [];
    const o = await slack.observe({ token: "xoxp-1" }, recordedHttp(slackFixtures, calls), NOW);
    assert(calls.every((c) => c.method === "GET"));
    assertEquals(o.account, "example.slack.com");
    assertEquals(o.gaps, []);
    assertEquals(
      o.entities?.accounts?.map((a) => [a.id, a.active, a.admin, a.mfa, a.service]),
      [
        ["U1", true, true, true, undefined],
        ["U2", true, false, false, undefined],
        ["U3", true, false, true, undefined],
        ["U4", false, false, undefined, undefined],
        ["B1", true, false, undefined, true],
      ],
    );
    assertEquals(o.posture, {
      externalChannels: 1,
      pendingExternalChannels: 1,
      guests: 1,
      members: 3,
      admins: 1,
      membersWithout2fa: 1,
    });
    const twofa = result(o, slack, "slack-2fa");
    assertEquals(twofa?.status, "fail");
    assertStringIncludes(twofa?.fix ?? "", "Two-factor authentication");
    assertEquals(result(o, slack, "slack-external")?.status, "warn");
    assertEquals(result(o, slack, "slack-admins")?.status, "warn");

    // A member's token: no two-factor status; no groups:read: shared channels are a gap.
    const member = await slack.observe(
      { token: "xoxp-2" },
      recordedHttp({
        ...slackFixtures,
        [CH]: { body: { ok: false, error: "missing_scope", needed: "groups:read" } },
        [`${S}/users.list?limit=200`]: { body: { ok: true, members: slackUsers(false) } },
      }),
      NOW,
    );
    assertStringIncludes(
      member.gaps.join(";"),
      "shared channels: conversations.list: missing_scope",
    );
    assertStringIncludes(member.gaps.join(";"), "two-factor status");
    assertEquals(member.posture["membersWithout2fa"], undefined);
    assertEquals(result(member, slack, "slack-2fa")?.status, "unknown");
    await assertRejects(
      () =>
        slack.observe(
          { token: "x" },
          recordedHttp({ [`${S}/team.info`]: { body: { ok: false, error: "invalid_auth" } } }),
          NOW,
        ),
      Error,
      "invalid_auth",
    );
  },
);

const OP = "https://api.1password.com";
const OP_USERS = `${OP}/v1/accounts/ACCT/users?max_page_size=1000`;

proves(
  ["087-wave2-connectors FR-005"],
  "087b: 1Password: a users.view token, people active, suspended, and pending",
  async () => {
    const calls: Calls = [];
    const cred = { region: "1password.com", account: "ACCT", client_id: "id", client_secret: "s" };
    const o = await onepassword.observe(
      cred,
      recordedHttp(
        {
          [`${OP}/v1/oauth/token`]: { body: { access_token: "a", expires_in: 900 } },
          [OP_USERS]: {
            body: {
              results: [
                { id: "1", email: "Alice@example.org", display_name: "Alice", state: "ACTIVE" },
                { id: "2", email: "bob@example.org", state: "SUSPENDED" },
              ],
              next_page_token: "p2",
            },
          },
          [`${OP_USERS}&page_token=p2`]: {
            body: { results: [{ id: "3", email: "carol@example.org" }] },
          },
        },
        calls,
      ),
      NOW,
    );
    assert(onlyReads(calls, [`${OP}/v1/oauth/token`]));
    assertEquals(calls[0]?.method, "POST");
    assertEquals(
      o.entities?.accounts?.map((a) => [a.email, a.active]),
      [
        ["alice@example.org", true],
        ["bob@example.org", false],
        ["carol@example.org", false],
      ],
    );
    assertEquals(o.posture, { pendingMembers: 1, activeMembers: 1, members: 3 });
    const pending = result(o, onepassword, "onepassword-pending");
    assertEquals(pending?.status, "warn");
    assertStringIncludes(pending?.fix ?? "", "pending invitation");
    assertEquals(result(o, onepassword, "onepassword-members")?.status, "pass");

    const denied = await onepassword.observe(
      cred,
      recordedHttp({
        [`${OP}/v1/oauth/token`]: { body: { access_token: "a" } },
        [OP_USERS]: DENIED,
      }),
      NOW,
    );
    assertStringIncludes(denied.gaps.join(";"), "users:");
    assertEquals(result(denied, onepassword, "onepassword-members")?.status, "unknown");
    assertEquals(
      (await import("../src/archon/connect/onepassword.ts")).onePasswordApi(
        "https://EU.1password.eu",
      ),
      "https://api.1password.eu",
    );
  },
);

const BW = "https://api.bitwarden.com";
const BW_TOKEN = "https://identity.bitwarden.com/connect/token";
const bwFixtures = {
  [BW_TOKEN]: { body: { access_token: "a", expires_in: 3600 } },
  [`${BW}/public/policies`]: {
    body: {
      object: "list",
      data: [
        { type: 0, enabled: false },
        { type: 1, enabled: true },
      ],
    },
  },
  [`${BW}/public/members`]: {
    body: {
      object: "list",
      data: [
        {
          id: "m1",
          email: "alice@example.org",
          twoFactorEnabled: true,
          status: 2,
          type: 0,
          collections: [{ id: "c1" }],
        },
        {
          id: "m2",
          email: "bob@example.org",
          twoFactorEnabled: false,
          status: 2,
          type: 2,
          collections: [],
        },
        { id: "m3", email: "carol@example.org", twoFactorEnabled: false, status: 0, type: 2 },
        {
          id: "m4",
          email: "dan@example.org",
          twoFactorEnabled: true,
          status: -1,
          type: 1,
          collections: [{ id: "c1" }],
        },
      ],
      continuationToken: null,
    },
  },
  [`${BW}/public/collections`]: {
    body: {
      object: "list",
      data: [
        { id: "c1", externalId: "engineering", groups: [{ id: "g1" }] },
        {
          id: "c2",
          groups: [],
        },
      ],
    },
  },
  [`${BW}/public/groups/g1/member-ids`]: { body: ["m2"] },
};

proves(
  ["087-wave2-connectors FR-005"],
  "087b: Bitwarden: members and two-step login, the org policy, collections and who opens them",
  async () => {
    const calls: Calls = [];
    const cred = { server: "us", client_id: "organization.o1", client_secret: "s" };
    const o = await bitwarden.observe(cred, recordedHttp(bwFixtures, calls), NOW);
    assert(onlyReads(calls, [BW_TOKEN]));
    assertEquals(o.account, "o1");
    assertEquals(o.gaps, []);
    assertEquals(
      o.entities?.accounts?.map((a) => [a.email, a.active, a.admin, a.mfa]),
      [
        ["alice@example.org", true, true, true],
        ["bob@example.org", true, false, false],
        ["carol@example.org", false, false, false],
        ["dan@example.org", false, true, true],
      ],
    );
    const stores = (o.records ?? []).filter((r) => r.label === "password_store");
    assertEquals(
      stores.map((s) => [
        s.display_name,
        s.props["members"],
        s.props["member_names"],
        s.props["granting_groups"],
      ]),
      [
        ["engineering", 2, "alice@example.org, bob@example.org", 1],
        ["c2", 0, "", 0],
      ],
    );
    assertEquals(o.posture["orgRequires2fa"], false);
    assertEquals(o.posture["membersWithout2fa"], 1);
    assertEquals(o.posture["sharedCollections"], 2);
    const req = result(o, bitwarden, "bitwarden-2fa-required");
    assertEquals(req?.status, "fail");
    assertStringIncludes(req?.fix ?? "", "Require two-step login");
    assertEquals(result(o, bitwarden, "bitwarden-2fa")?.status, "fail");
    assertEquals(result(o, bitwarden, "bitwarden-admins")?.status, "warn");

    const denied = await bitwarden.observe(
      cred,
      recordedHttp({
        ...bwFixtures,
        [`${BW}/public/policies`]: DENIED,
        [`${BW}/public/collections`]: DENIED,
      }),
      NOW,
    );
    assertStringIncludes(denied.gaps.join(";"), "policies:");
    assertStringIncludes(denied.gaps.join(";"), "collections:");
    assertEquals(result(denied, bitwarden, "bitwarden-2fa-required")?.status, "unknown");
    assertEquals(bitwardenUrls("eu").token, "https://identity.bitwarden.eu/connect/token");
    assertEquals(bitwardenUrls("https://vault.example.org/").api, "https://vault.example.org/api");
  },
);

proves(
  ["087-wave2-connectors FR-005", "087-wave2-connectors FR-003"],
  "087b: the estate graph: password manager coverage, tickets and shared vaults as nodes",
  async () => {
    const bw = await bitwarden.observe(
      { server: "us", client_id: "organization.o1", client_secret: "s" },
      recordedHttp(bwFixtures),
      NOW,
    );
    const tickets = await jira.observe(
      { site: "example.atlassian.net", email: "alice@example.org", token: "t" },
      recordedHttp(jiraFixtures),
      NOW,
    );
    const hr: Observation = {
      at: NOW.toISOString(),
      provider: "bamboohr",
      account: "example",
      assets: [],
      posture: {},
      gaps: [],
      entities: {
        people: [
          { email: "alice@example.org", status: "active" },
          { email: "bob@example.org", status: "active" },
          { email: "erin@example.org", status: "active" },
          { email: "dan@example.org", status: "terminated" },
        ],
      },
    };
    const e = buildGraph(
      {
        fleet: "lab",
        sources: [
          { connector: "bamboohr", observation: hr },
          { connector: "bitwarden", observation: bw },
          { connector: "jira", observation: tickets },
        ],
        machines: [],
        links: {},
      },
      { now: NOW },
    );
    const p = estatePolicies(e, NOW).find((x) => x.id === "password-manager");
    assertExists(p);
    assertEquals(p.status, "warn");
    assertEquals(p.scf, ["IAC-14"]);
    assertStringIncludes(p.detail, "1 without one: erin@example.org");
    assertEquals(
      estateQuery(e, "SELECT native_id FROM node WHERE label = 'ticket' ORDER BY native_id").map(
        (r) => r["native_id"],
      ),
      ["OPS-1", "OPS-2", "OPS-3", "OPS-4"],
    );
    assertEquals(
      estateQuery(e, "SELECT count(*) AS n FROM node WHERE label = 'password_store'")[0]?.["n"],
      2,
    );
    // Without a password manager, no coverage policy.
    const none = buildGraph(
      {
        fleet: "lab",
        sources: [{ connector: "bamboohr", observation: hr }],
        machines: [],
        links: {},
      },
      { now: NOW },
    );
    assert(!estatePolicies(none, NOW).some((x) => x.id === "password-manager"));
  },
);

proves(
  ["087-wave2-connectors FR-006"],
  "087b: the vendors' limits are stated in each connector's connect steps",
  () => {
    const steps = (id: string): string => {
      const c = CONNECTORS.find((x) => x.id === id);
      assert(c, id);
      return c.connectHelp.join("\n");
    };
    const op = steps("onepassword");
    assert(
      /Users API is in preview/.test(op) && /does not show roles, two-factor status/.test(op),
      op,
    );
    assert(
      /two-factor status only to an admin's or owner's token/.test(steps("slack")),
      steps("slack"),
    );
    assert(/commit and pull request counts, not their SHAs/.test(steps("jira")), steps("jira"));
    assert(/GraphQL: Stolos reads it only through its own query documents/.test(steps("linear")));
  },
);
