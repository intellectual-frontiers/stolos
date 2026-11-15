/**
 * Spec 091: Gusto, Deel, Justworks, JumpCloud, GitLab, and Bitbucket, declared with the connector
 * SDK, against recorded API responses: read-only, records become the estate's entities, a denied
 * resource is a gap, and a failing policy says how to fix it.
 *
 * @module
 */

import {
  assert,
  assertEquals,
  assertStringIncludes,
  proves,
} from "@intellectual-frontiers/ifc-ts/runtime/test";
import { recordedHttp } from "../src/archon/connect/sdk.ts";
import { MARKET_CATEGORIES, type Observation } from "../src/archon/connect/connector.ts";
import { CONNECTORS } from "../src/archon/connect/commands.ts";
import { COMMANDS } from "../src/archon/commands/registry.ts";
import { PERSON_SOURCES } from "../src/archon/estate/graph.ts";
import { gusto } from "../src/archon/connect/gusto.ts";
import { deel } from "../src/archon/connect/deel.ts";
import { justworks, JUSTWORKS_TOKEN } from "../src/archon/connect/justworks.ts";
import { jumpcloud } from "../src/archon/connect/jumpcloud.ts";
import { gitlab } from "../src/archon/connect/gitlab.ts";
import { bitbucket, bitbucketProtection } from "../src/archon/connect/bitbucket.ts";
import { branchMatches } from "../src/archon/connect/codehost.ts";

const NOW = new Date("2026-11-15T12:00:00Z");
const LATER = NOW.getTime() + 30 * 86_400_000;
type Calls = Array<{ method: string; url: string }>;
const onlyReads = (calls: Calls, token: string[] = []) =>
  calls.every((c) => c.method === "GET" || (c.method === "POST" && token.includes(c.url)));
function result(
  o: Observation,
  c: { policies: (o: Observation, n: number) => unknown },
  id: string,
  now = NOW.getTime(),
): { id: string; status: string; fix?: string; detail: string } | undefined {
  const r = (
    c.policies(o, now) as Array<{ id: string; status: string; fix?: string; detail: string }>
  ).find((p) => p.id === id);
  return r;
}
const DENIED = { status: 403, body: { message: "403 Forbidden" } };

proves(
  ["091-connectors FR-003", "086-wave1-connectors FR-003"],
  "091: the six are registered, labeled, and offered by every connector command",
  () => {
    const ids = ["jumpcloud", "gitlab", "bitbucket", "gusto", "deel", "justworks"];
    const markets = new Set(MARKET_CATEGORIES.map((m) => m.id));
    for (const id of ids) {
      const c = CONNECTORS.find((x) => x.id === id);
      assert(c, id);
      assertEquals(c.serviceModels, ["SaaS"]);
      assert(c.markets.length && c.markets.every((m) => markets.has(m)), `${id}: markets`);
      assert(c.connectHelp.join(" ").match(/read/i), `${id}: read-only help`);
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
    for (const hr of ["gusto", "deel", "justworks"]) assert(PERSON_SOURCES.includes(hr), hr);
  },
);

proves(
  ["091-connectors FR-003"],
  "091: Gusto: the roster only, current and former employees, scheduled leavers still active",
  async () => {
    const E = "https://api.gusto.com/v1/companies/c1/employees";
    const calls: Calls = [];
    const http = recordedHttp(
      {
        [`${E}?terminated=false&page=1&per=100`]: {
          body: [
            {
              uuid: "u1",
              first_name: "Alice",
              last_name: "Example",
              work_email: "Alice@Example.org",
              email: "alice.home@example.net",
              ssn: "000-00-0000",
              date_of_birth: "1990-01-01",
              terminated: false,
              jobs: [{ hire_date: "2024-02-01", rate: "100000.00" }],
              manager_uuid: "u2",
              current_employment_status: "full_time",
            },
            {
              uuid: "u2",
              first_name: "Bob",
              last_name: "Example",
              work_email: "bob@example.org",
              terminated: false,
              jobs: [{ hire_date: "2023-05-01" }],
            },
            { uuid: "u5", first_name: "Eve", terminated: false }, // no work email: not on the roster
          ],
        },
        [`${E}?terminated=true&page=1&per=100`]: {
          body: [
            {
              uuid: "u3",
              first_name: "Carol",
              last_name: "Example",
              work_email: "carol@example.org",
              terminated: true,
              terminations: [{ effective_date: "2026-10-01" }],
              jobs: [{ hire_date: "2022-01-10" }],
            },
            {
              uuid: "u4",
              first_name: "Dan",
              last_name: "Example",
              work_email: "dan@example.org",
              terminated: true,
              terminations: [{ effective_date: "2026-12-31" }],
            },
          ],
        },
      },
      calls,
    );
    const o = await gusto.observe({ company: "c1", token: "t" }, http, NOW);
    assert(onlyReads(calls));
    const people = o.entities?.people ?? [];
    assertEquals(
      people.map((p) => [p.email, p.status]),
      [
        ["alice@example.org", "active"],
        ["bob@example.org", "active"],
        ["carol@example.org", "terminated"],
        ["dan@example.org", "active"],
      ],
    );
    assertEquals(people[0], {
      email: "alice@example.org",
      status: "active",
      name: "Alice Example",
      start: "2024-02-01",
      manager: "bob@example.org",
      type: "full_time",
    });
    assertEquals(people[2]?.end, "2026-10-01");
    const text = JSON.stringify(o);
    for (const never of ["000-00-0000", "1990-01-01", "100000", "alice.home"]) {
      assert(!text.includes(never), `never keeps ${never}`);
    }
    assertEquals(o.assets, []);
    assertEquals(o.posture, { leftLast90Days: 1, people: 4, active: 3, leaversWithoutEndDate: 0 });
    assertEquals(result(o, gusto, "observed")?.status, "pass");
    const stale = result(o, gusto, "observed", LATER);
    assertEquals(stale?.status, "fail");
    assertStringIncludes(stale?.fix ?? "", "estate observe gusto");

    const denied = await gusto.observe(
      { company: "c1", token: "t" },
      recordedHttp({ [`${E}?terminated=false&page=1&per=100`]: DENIED }),
      NOW,
    );
    assertStringIncludes(denied.gaps.join(";"), "employees:");
    assertEquals(denied.entities, undefined);
  },
);

proves(
  ["091-connectors FR-003"],
  "091: Deel: people with work email, hiring status, last day, and manager",
  async () => {
    const P = "https://api.letsdeel.com/rest/v2/people";
    const calls: Calls = [];
    const http = recordedHttp(
      {
        [`${P}?limit=100&offset=0`]: {
          body: {
            data: [
              {
                id: "d1",
                full_name: "Alice Example",
                emails: [
                  { type: "personal", value: "alice@example.net" },
                  {
                    type: "work",
                    value: "alice@example.org",
                  },
                ],
                hiring_status: "active",
                person_status: "ACTIVE",
                hiring_type: "eor",
                start_date: "2025-03-01",
                birth_date: "1990-01-01",
                addresses: [{ streetAddress: "1 Example Street" }],
                direct_manager: { work_email: "bob@example.org" },
              },
              {
                id: "d2",
                full_name: "Bob Example",
                employments: [
                  { work_email: "bob@example.org", termination_last_day: "2026-09-30" },
                ],
                hiring_status: "inactive",
                person_status: "INACTIVE",
                hiring_type: "contractor",
              },
              {
                id: "d3",
                full_name: "Carol Example",
                emails: [{ type: "work", value: "carol@example.org" }],
                hiring_status: "inactive",
              },
            ],
            page: { offset: 0, total_rows: 3, items_per_page: 100 },
          },
        },
      },
      calls,
    );
    const o = await deel.observe({ token: "t" }, http, NOW);
    assert(onlyReads(calls));
    assertEquals(o.entities?.people, [
      {
        email: "alice@example.org",
        status: "active",
        name: "Alice Example",
        start: "2025-03-01",
        manager: "bob@example.org",
        type: "eor",
      },
      {
        email: "bob@example.org",
        status: "terminated",
        name: "Bob Example",
        end: "2026-09-30",
        type: "contractor",
      },
      { email: "carol@example.org", status: "terminated", name: "Carol Example" },
    ]);
    assert(!JSON.stringify(o).includes("Example Street"), "no addresses");
    assertEquals(o.posture["leftLast90Days"], 1);
    const leavers = result(o, deel, "deel-leaver-dates");
    assertEquals(leavers?.status, "warn");
    assertEquals(leavers?.detail, "1 leavers without one");
    assertStringIncludes(leavers?.fix ?? "", "termination date");

    const denied = await deel.observe(
      { token: "t" },
      recordedHttp({ [`${P}?limit=100&offset=0`]: DENIED }),
      NOW,
    );
    assertStringIncludes(denied.gaps[0] ?? "", "people:");
    assertEquals(result(denied, deel, "observed", LATER)?.status, "fail");
  },
);

proves(
  ["091-connectors FR-003"],
  "091: Justworks: a refresh token for an access token, members across cursor pages",
  async () => {
    const M = "https://public-api.justworks.com/v1/members";
    const calls: Calls = [];
    const http = recordedHttp(
      {
        [JUSTWORKS_TOKEN]: {
          body: { access_token: "at", token_type: "Bearer", expires_in: 86400 },
        },
        [`${M}?limit=100`]: {
          body: {
            items: [
              {
                id: "member_1",
                active: true,
                name: { full_preferred_name: "Alice Example" },
                emails: [
                  { type: "home", email: "alice@example.net" },
                  {
                    type: "work",
                    email: "alice@example.org",
                  },
                ],
                employment_start_date: "2024-06-01",
                current_employment: { status: "active", type: "full_time" },
                manager: { id: "member_2" },
                current_pay: { amount: 1 },
              },
            ],
            next_cursor: "member_2",
          },
        },
        [`${M}?limit=100&cursor=member_2`]: {
          body: {
            items: [
              {
                id: "member_2",
                active: true,
                name: { given_name: "Bob", family_name: "Example" },
                emails: [{ type: "work", email: "bob@example.org" }],
                current_employment: { status: "on_leave" },
              },
              {
                id: "member_3",
                active: false,
                name: { full_preferred_name: "Carol Example" },
                emails: [{ type: "work", email: "carol@example.org" }],
                employment_termination_date: "2026-11-01",
              },
            ],
            next_cursor: null,
          },
        },
      },
      calls,
    );
    const o = await justworks.observe(
      { client_id: "id", client_secret: "s", refresh_token: "r" },
      http,
      NOW,
    );
    assert(onlyReads(calls, [JUSTWORKS_TOKEN]), "GETs, and the token endpoint only");
    assertEquals(calls[0]?.method, "POST");
    assertEquals(
      (o.entities?.people ?? []).map((p) => [p.email, p.status, p.manager ?? "", p.end ?? ""]),
      [
        ["alice@example.org", "active", "bob@example.org", ""],
        ["bob@example.org", "leave", "", ""],
        ["carol@example.org", "terminated", "", "2026-11-01"],
      ],
    );
    assert(!JSON.stringify(o).includes("amount"), "no pay");
    assertEquals(o.posture["leftLast90Days"], 1);
    assertEquals(result(o, justworks, "justworks-leaver-dates")?.status, "pass");

    const denied = await justworks.observe(
      { client_id: "id", client_secret: "s", refresh_token: "r" },
      recordedHttp({
        [JUSTWORKS_TOKEN]: { body: { access_token: "at" } },
        [`${M}?limit=100`]: DENIED,
      }),
      NOW,
    );
    assertStringIncludes(denied.gaps[0] ?? "", "members:");
  },
);

proves(
  ["091-connectors FR-003"],
  "091: JumpCloud: users and their second factors, administrators, devices and encryption",
  async () => {
    const J = "https://console.jumpcloud.com/api";
    const users = {
      totalCount: 3,
      results: [
        {
          _id: "j1",
          username: "alice",
          email: "Alice@example.org",
          activated: true,
          mfaEnrollment: { overallStatus: "ENROLLED" },
        },
        {
          _id: "j2",
          username: "bob",
          email: "bob@example.org",
          activated: true,
          mfaEnrollment: { overallStatus: "NOT_ENROLLED" },
        },
        { _id: "j3", username: "carol", email: "carol@example.org", suspended: true },
      ],
    };
    const systems = {
      totalCount: 2,
      results: [
        {
          _id: "s1",
          displayName: "alice-mac",
          os: "Mac OS X",
          version: "15.1",
          serialNumber: "C02EXAMPLE1",
          fde: { active: true, keyPresent: true },
          lastContact: "2026-11-14T09:00:00Z",
        },
        { _id: "s2", hostname: "bob-pc", os: "Windows", fde: { active: false } },
      ],
    };
    const calls: Calls = [];
    const http = recordedHttp(
      {
        [`${J}/systemusers?limit=100&skip=0`]: { body: users },
        [`${J}/users?limit=100&skip=0`]: {
          body: {
            totalCount: 1,
            results: [{ _id: "a1", email: "alice@example.org", totpEnrolled: false }],
          },
        },
        [`${J}/systems?limit=100&skip=0`]: { body: systems },
      },
      calls,
    );
    const o = await jumpcloud.observe({ host: "console.jumpcloud.com", key: "k" }, http, NOW);
    assert(onlyReads(calls));
    assertEquals(
      (o.entities?.accounts ?? []).map((a) => [a.id, a.email, a.active, a.admin, a.mfa]),
      [
        ["j1", "alice@example.org", true, false, true],
        ["j2", "bob@example.org", true, false, false],
        ["j3", "carol@example.org", false, false, false],
        ["admin:a1", "alice@example.org", true, true, false],
      ],
    );
    assertEquals(o.entities?.devices?.[0], {
      source: "jumpcloud",
      id: "s1",
      name: "alice-mac",
      managed: false,
      os: "Mac OS X 15.1",
      serial: "C02EXAMPLE1",
      encrypted: true,
      seen: "2026-11-14T09:00:00Z",
    });
    assertEquals(o.posture, {
      activeUsers: 2,
      activeWithoutMfa: 1,
      admins: 1,
      adminsWithoutMfa: 1,
      devices: 2,
      devicesUnencrypted: 1,
    });
    const mfa = result(o, jumpcloud, "jumpcloud-mfa");
    assertEquals(mfa?.status, "fail");
    assertEquals(mfa?.detail, "1 of 2 active users without one");
    assertStringIncludes(mfa?.fix ?? "", "require MFA");
    assertEquals(result(o, jumpcloud, "jumpcloud-admin-mfa")?.status, "fail");
    assertEquals(result(o, jumpcloud, "jumpcloud-admins")?.status, "warn");
    const fde = result(o, jumpcloud, "jumpcloud-disk-encryption");
    assertEquals(fde?.status, "fail");
    assertStringIncludes(fde?.fix ?? "", "BitLocker");

    const partial = await jumpcloud.observe(
      { host: "", key: "k" },
      recordedHttp({
        [`${J}/systemusers?limit=100&skip=0`]: { body: users },
        [`${J}/users?limit=100&skip=0`]: DENIED,
        [`${J}/systems?limit=100&skip=0`]: { body: systems },
      }),
      NOW,
    );
    assertStringIncludes(partial.gaps.join(";"), "administrators:");
    assertEquals(partial.posture["admins"], undefined);
    assertEquals(result(partial, jumpcloud, "jumpcloud-admins")?.status, "unknown");
    assertEquals(partial.entities?.accounts?.length, 3);
  },
);

proves(
  ["091-connectors FR-003"],
  "091: GitLab: the group's 2FA rule, owners and 2FA, protected branches and approvals",
  async () => {
    const B = "https://gitlab.com/api/v4";
    const calls: Calls = [];
    const http = recordedHttp(
      {
        [`${B}/groups/ex`]: {
          body: { id: 9, full_path: "ex", require_two_factor_authentication: false },
        },
        [`${B}/groups/ex/members/all?per_page=100`]: {
          body: [
            {
              id: 1,
              username: "alice",
              state: "active",
              access_level: 50,
              two_factor_enabled: true,
            },
            {
              id: 2,
              username: "bob",
              state: "active",
              access_level: 30,
              two_factor_enabled: false,
            },
          ],
          link: `<${B}/groups/ex/members/all?per_page=100&page=2>; rel="next"`,
        },
        [`${B}/groups/ex/members/all?per_page=100&page=2`]: {
          body: [{ id: 3, username: "group_9_bot_abc", state: "active", access_level: 10 }],
        },
        [`${B}/groups/ex/projects?include_subgroups=true&archived=false&per_page=100`]: {
          body: [
            {
              id: 11,
              path_with_namespace: "ex/app",
              visibility: "private",
              default_branch: "main",
              secret_push_protection_enabled: true,
            },
            {
              id: 12,
              path_with_namespace: "ex/site",
              visibility: "public",
              default_branch: "main",
            },
            {
              id: 13,
              path_with_namespace: "ex/infra",
              visibility: "internal",
              default_branch: "main",
            },
          ],
        },
        [`${B}/projects/11/protected_branches?per_page=100`]: {
          body: [{ name: "main", allow_force_push: false }],
        },
        [`${B}/projects/11/approval_rules`]: { body: [{ approvals_required: 2 }] },
        [`${B}/projects/12/protected_branches?per_page=100`]: { body: [] },
        [`${B}/projects/12/approval_rules`]: { status: 404, body: { message: "404 Not Found" } },
        [`${B}/projects/13/protected_branches?per_page=100`]: DENIED,
        [`${B}/projects/13/approval_rules`]: { status: 404, body: { message: "404 Not Found" } },
      },
      calls,
    );
    const o = await gitlab.observe(
      { url: "https://gitlab.com/", group: "ex", token: "t" },
      http,
      NOW,
    );
    assert(onlyReads(calls));
    assertEquals(
      (o.entities?.accounts ?? []).map((a) => [a.name, a.admin, a.mfa ?? null, !!a.service]),
      [
        ["alice", true, true, false],
        ["bob", false, false, false],
        ["group_9_bot_abc", false, null, true],
      ],
    );
    assertEquals(o.entities?.repositories, [
      {
        system: "gitlab",
        name: "ex/app",
        private: true,
        protected: true,
        reviews: 2,
        secretScanning: true,
      },
      { system: "gitlab", name: "ex/site", private: false, protected: false, reviews: 0 },
      { system: "gitlab", name: "ex/infra", private: true, reviews: 0 },
    ]);
    assertStringIncludes(o.gaps.join(";"), "ex/infra protected branches");
    assertEquals(o.posture["orgRequires2fa"], false);
    assertEquals(o.posture["owners"], 1);
    assertEquals(o.posture["membersWithout2fa"], 1);
    const twoFa = result(o, gitlab, "gitlab-2fa-required");
    assertEquals(twoFa?.status, "fail");
    assertStringIncludes(twoFa?.fix ?? "", "two-factor authentication");
    const prot = result(o, gitlab, "gitlab-protected");
    assertEquals([prot?.status, prot?.detail], ["fail", "1 of 2 private repositories"]);
    assertEquals(result(o, gitlab, "gitlab-reviewed")?.status, "fail");
    assertEquals(result(o, gitlab, "gitlab-owners")?.status, "warn");
    assertEquals(result(o, gitlab, "observed")?.status, "pass");
  },
);

proves(
  ["091-connectors FR-003"],
  "091: Bitbucket: members, owners behind a gap, branch restrictions and approvals",
  async () => {
    const A = "https://api.bitbucket.org/2.0";
    const calls: Calls = [];
    const http = recordedHttp(
      {
        [`${A}/workspaces/ex/permissions?q=permission%3D%22owner%22&pagelen=100`]: DENIED,
        [`${A}/workspaces/ex/members?pagelen=100`]: {
          body: {
            values: [{ user: { uuid: "{a}", nickname: "alice", type: "user" } }],
            next: `${A}/workspaces/ex/members?pagelen=100&page=2`,
          },
        },
        [`${A}/workspaces/ex/members?pagelen=100&page=2`]: {
          body: { values: [{ user: { uuid: "{b}", nickname: "bob", type: "user" } }] },
        },
        [`${A}/repositories/ex?pagelen=100`]: {
          body: {
            values: [
              { full_name: "ex/app", is_private: true, mainbranch: { name: "main" } },
              { full_name: "ex/web", is_private: true, mainbranch: { name: "main" } },
            ],
          },
        },
        [`${A}/repositories/ex/app/branch-restrictions?pagelen=100`]: {
          body: {
            values: [
              { kind: "push", branch_match_kind: "glob", pattern: "main" },
              {
                kind: "require_approvals_to_merge",
                branch_match_kind: "glob",
                pattern: "ma*",
                value: 1,
              },
            ],
          },
        },
        [`${A}/repositories/ex/web/branch-restrictions?pagelen=100`]: {
          body: { values: [{ kind: "force", branch_match_kind: "glob", pattern: "main" }] },
        },
      },
      calls,
    );
    const o = await bitbucket.observe(
      { workspace: "ex", email: "alice@example.org", token: "t" },
      http,
      NOW,
    );
    assert(onlyReads(calls));
    assertStringIncludes(o.gaps.join(";"), "owners:");
    assertEquals(
      (o.entities?.accounts ?? []).map((a) => [a.name, a.admin]),
      [
        ["alice", undefined],
        ["bob", undefined],
      ],
    );
    assertEquals(o.entities?.repositories, [
      { system: "bitbucket", name: "ex/app", private: true, protected: true, reviews: 1 },
      { system: "bitbucket", name: "ex/web", private: true, protected: false, reviews: 0 },
    ]);
    assertEquals(o.posture["owners"], undefined);
    assertEquals(result(o, bitbucket, "bitbucket-owners")?.status, "unknown");
    const prot = result(o, bitbucket, "bitbucket-protected");
    assertEquals([prot?.status, prot?.detail], ["fail", "1 of 2 private repositories"]);
    assertStringIncludes(prot?.fix ?? "", "Branch restrictions");
    assertEquals(result(o, bitbucket, "bitbucket-reviewed")?.status, "fail");
    // The API does not show two-step verification: unknown, never a guess.
    assertEquals(result(o, bitbucket, "bitbucket-2fa")?.status, "unknown");

    // An owner's token reads the owners.
    const owner = await bitbucket.observe(
      { workspace: "ex", email: "alice@example.org", token: "t" },
      recordedHttp({
        [`${A}/workspaces/ex/permissions?q=permission%3D%22owner%22&pagelen=100`]: {
          body: { values: [{ permission: "owner", user: { uuid: "{a}" } }] },
        },
        [`${A}/workspaces/ex/members?pagelen=100`]: {
          body: {
            values: [
              { user: { uuid: "{a}", nickname: "alice" } },
              {
                user: { uuid: "{b}", nickname: "bob" },
              },
            ],
          },
        },
        [`${A}/repositories/ex?pagelen=100`]: { body: { values: [] } },
      }),
      NOW,
    );
    assertEquals(owner.gaps, []);
    assertEquals(owner.posture["owners"], 1);
    assertEquals(result(owner, bitbucket, "bitbucket-owners")?.status, "warn");
  },
);

proves(["091-connectors FR-003"], "091: branch patterns and Bitbucket's restrictions", () => {
  assert(branchMatches("main", "main"));
  assert(branchMatches("ma*", "main"));
  assert(branchMatches("*", "main"));
  assert(!branchMatches("release/*", "main"));
  assert(!branchMatches("mai.", "main"), "a dot is a dot");
  assertEquals(bitbucketProtection("main", []), { protected: false, reviews: 0 });
  assertEquals(
    bitbucketProtection("main", [
      { kind: "require_default_reviewer_approvals_to_merge", pattern: "main", value: 2 },
      { kind: "push", branch_match_kind: "branching_model", pattern: "" },
    ]),
    { protected: true, reviews: 2 },
  );
});

proves(
  ["091-connectors FR-004"],
  "091: the vendors' limits are stated in each connector's connect steps",
  () => {
    const steps = (id: string): string => {
      const c = CONNECTORS.find((x) => x.id === id);
      assert(c, id);
      return c.connectHelp.join("\n");
    };
    assertStringIncludes(steps("gusto"), "Gusto offers no self-serve API token");
    assertStringIncludes(steps("gusto"), "OAuth");
    assertStringIncludes(steps("justworks"), "Justworks offers no self-serve API token");
    assertStringIncludes(steps("justworks"), "partner apps");
    assertStringIncludes(
      steps("bitbucket"),
      "Bitbucket's API does not show members' two-factor status",
    );
    assertStringIncludes(steps("gitlab"), "two-factor status only to owners");
    assertStringIncludes(steps("gitlab"), "approval rules need a paid GitLab tier");
  },
);

proves(
  ["091-connectors FR-001"],
  "091: every connector is declared with defineConnector; records carry D3FEND, OCSF or UDM labels; four become entities",
  async () => {
    const { CONNECTOR_LABELS } = await import("../src/archon/connect/labels.ts");
    const { toEntities } = await import("../src/archon/connect/sdk.ts");
    const labels = new Set(CONNECTOR_LABELS.map((l) => l.name));
    for (const l of CONNECTOR_LABELS) {
      assert(
        l.terms.length > 0 && l.terms.every((t) => ["d3fend", "ocsf", "udm"].includes(t.from)),
        l.name,
      );
    }
    const ported = [
      "cloudflare",
      "hetzner",
      "aws",
      "microsoft",
      "google",
      "github",
      "okta",
      "bamboohr",
      "rippling",
    ];
    for (const c of CONNECTORS) {
      assert("def" in c, `${c.id} is declared with defineConnector`);
      const def: unknown = Reflect.get(c, "def");
      const resources = Reflect.get(def as object, "resources") as Record<
        string,
        { label: { name: string } }
      >;
      for (const [name, r] of Object.entries(resources)) {
        assert(labels.has(r.label.name), `${c.id}.${name}: ${r.label.name} is a connector label`);
      }
    }
    for (const id of ported)
      assert(
        CONNECTORS.some((c) => c.id === id),
        id,
      );
    const rec = (label: string) => ({
      label,
      ocsf_class_uid: 0,
      native_id: label,
      display_name: label,
      props: {},
    });
    const { entities, rest } = toEntities("x", [
      rec("user_account"),
      rec("code_repository"),
      rec("person"),
      rec("hardware_device"),
      rec("server"),
    ]);
    assertEquals(
      [
        entities.accounts?.length,
        entities.repositories?.length,
        entities.people?.length,
        entities.devices?.length,
      ],
      [1, 1, 1, 1],
    );
    assertEquals(
      rest.map((r) => r.label),
      ["server"],
    );
  },
);

proves(
  ["091-connectors FR-002"],
  "091: the SDK: orGap, required and mustRead, account from the records, posture with gaps and now, ctx.fact, asset()",
  async () => {
    const {
      defineConnector,
      mustRead,
      recordedHttp: rec,
    } = await import("../src/archon/connect/sdk.ts");
    const { ORGANIZATION, USER_ACCOUNT } = await import("../src/archon/connect/labels.ts");
    const B = "https://api.example.invalid";
    type User = { id: string; login: string; admin: boolean; mfa?: boolean };
    const make = (requireSecrets: boolean) =>
      defineConnector({
        id: "example",
        title: "Example",
        logo: "",
        serviceModels: ["SaaS"],
        markets: ["access-management"],
        connectHelp: ["a read-only token"],
        recipe: {},
        fields: { token: { secret: true, hint: "the token" } },
        auth: () => Promise.resolve({ authorization: "Bearer t" }),
        // The account's name comes from what was read.
        account: (_cred, records) =>
          records.find((r) => r.label === "organization")?.display_name ?? "?",
        resources: {
          org: {
            label: ORGANIZATION,
            ocsf: "user_inventory",
            async *list(ctx) {
              const o = await mustRead(() => ctx.json<{ name: string; mfa: boolean }>(`${B}/org`));
              ctx.fact("org_mfa_required", o.mfa);
              yield o;
            },
            map: (o: { name: string; mfa: boolean }) => ({
              native_id: o.name,
              display_name: o.name,
              props: { mfa_required: o.mfa },
            }),
          },
          users: {
            label: USER_ACCOUNT,
            ocsf: "user_inventory",
            async *list(ctx) {
              for (const u of await ctx.json<User[]>(`${B}/users`)) {
                // A part read and the rest kept: a denied factor read is a gap, the user stays.
                const mfa = await ctx.orGap("factors", undefined as boolean | undefined, () =>
                  ctx.json<{ active: boolean }>(`${B}/users/${u.id}/factors`).then((f) => f.active),
                );
                yield { ...u, ...(mfa === undefined ? {} : { mfa }) };
              }
            },
            map: (u: User) => ({
              native_id: u.id,
              display_name: u.login,
              props: {
                active: true,
                admin: u.admin,
                ...(u.mfa === undefined ? {} : { mfa: u.mfa }),
              },
            }),
            asset: (u: User) =>
              u.admin ? { kind: "administrator", facts: { login: u.login } } : undefined,
          },
          secrets: {
            label: ORGANIZATION,
            ocsf: "user_inventory",
            required: requireSecrets,
            async *list(ctx) {
              yield await ctx.json<{ name: string }>(`${B}/secrets`);
            },
            map: (o: { name: string }) => ({ native_id: o.name, display_name: o.name, props: {} }),
          },
        },
        posture: (records, _cred, seen) => ({
          admins: records.filter((r) => r.props["admin"] === true).length,
          gaps: seen.gaps.length,
          at: seen.now.toISOString(),
        }),
        policies: () => [],
      });
    const DENIED = { status: 403, body: {} };
    const answers = {
      [`${B}/org`]: { body: { name: "Example Co", mfa: true } },
      [`${B}/users`]: {
        body: [
          { id: "1", login: "alice", admin: true },
          { id: "2", login: "bob", admin: false },
        ],
      },
      [`${B}/users/1/factors`]: { body: { active: true } },
      [`${B}/users/2/factors`]: DENIED,
      [`${B}/secrets`]: DENIED,
    };
    const NOW = new Date("2026-11-15T12:00:00Z");
    const o = await make(false).observe({ token: "t" }, rec(answers), NOW);
    assertEquals(o.account, "Example Co", "account(cred, records)");
    assertEquals(o.posture["org_mfa_required"], true, "ctx.fact");
    assertEquals(o.posture["admins"], 1);
    assertEquals(o.posture["gaps"], 2, "posture is told the gaps");
    assertEquals(o.posture["at"], "2026-11-15T12:00:00.000Z", "and when");
    assert(
      o.gaps.some((g) => g.startsWith("factors: ")),
      o.gaps.join("; "),
    );
    assert(
      o.gaps.some((g) => g.startsWith("secrets: ")),
      "a denied resource is a gap",
    );
    assertEquals(
      o.entities?.accounts?.map((a) => [a.name, a.mfa ?? null]),
      [
        ["alice", true],
        ["bob", null],
      ],
      "bob kept, his factors a gap",
    );
    assertEquals(
      o.assets.filter((a) => a.kind === "administrator").map((a) => [a.name, a.facts?.["login"]]),
      [["alice", "alice"]],
      "asset() names estate assets' kind and facts, and leaves out what it returns nothing for",
    );
    // required: a denied read fails the observation instead.
    const failed = await make(true)
      .observe({ token: "t" }, rec(answers), NOW)
      .then(
        () => "",
        (e: unknown) => (e instanceof Error ? e.message : String(e)),
      );
    assertStringIncludes(failed, "403");
    // mustRead: a denial inside a resource fails it too.
    const noOrg = await make(false)
      .observe({ token: "t" }, rec({ ...answers, [`${B}/org`]: DENIED }), NOW)
      .then(
        () => "",
        (e: unknown) => (e instanceof Error ? e.message : String(e)),
      );
    assertStringIncludes(noOrg, "403");
  },
);
