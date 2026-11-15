/**
 * Spec 067 (clouds): read-only inventory and posture, against fake provider APIs.
 *
 * @module
 */

import {
  assert,
  assertEquals,
  assertStringIncludes,
  proves,
  test,
} from "@intellectual-frontiers/ifc-ts/runtime/test";
import type { http } from "@intellectual-frontiers/ifc-ts/runtime";
import type { Result } from "@intellectual-frontiers/ifc-ts/kernel";
import { observationSource } from "../src/archon/connect/connector.ts";
import { cloudflare } from "../src/archon/connect/cloudflare.ts";
import { hetzner } from "../src/archon/connect/hetzner.ts";
import { microsoft } from "../src/archon/connect/microsoft.ts";
import { aws, signed, xmlAll } from "../src/archon/connect/aws.ts";
import { CONNECTORS, joinFleet } from "../src/archon/connect/commands.ts";

const NOW = new Date("2026-11-15T12:00:00Z");

/** A fake API, as a transport: path (and query) prefix to [status, body]; every call is recorded. */
function fake(
  routes: Record<string, [number, unknown]>,
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
      const [status, body] = (key === undefined ? undefined : routes[key]) ?? [404, {}];
      return Promise.resolve({
        kind: "ok",
        value: {
          method: r.method,
          url: r.url,
          status,
          headers: {},
          body: typeof body === "string" ? body : JSON.stringify(body),
        },
      });
    },
  };
}

const CF = "api.cloudflare.com/client/v4";

proves(
  ["067-adopt FR-008", "067-adopt FR-009", "084-connectors FR-001"],
  "067: Cloudflare inventory, a denied part as a gap, and the TLS posture",
  async () => {
    const http = fake({
      [`${CF}/accounts?`]: [
        200,
        {
          result: [{ id: "a1", name: "Example Co" }],
          result_info: { page: 1, total_pages: 1 },
        },
      ],
      [`${CF}/accounts/a1/workers/scripts`]: [403, { success: false }],
      [`${CF}/accounts/a1/pages/projects`]: [
        200,
        {
          result: [{ id: "p1", name: "site", subdomain: "site.pages.dev" }],
        },
      ],
      [`${CF}/accounts/a1/r2/buckets`]: [
        200,
        {
          result: { buckets: [{ name: "backups", location: "ENAM" }] },
        },
      ],
      [`${CF}/accounts/a1/cfd_tunnel`]: [200, { result: [] }],
      [`${CF}/zones?`]: [
        200,
        {
          result: [{ id: "z1", name: "example.org", status: "active", plan: { name: "Free" } }],
        },
      ],
      [`${CF}/zones/z1/settings/ssl`]: [200, { result: { value: "strict" } }],
      [`${CF}/zones/z1/settings/always_use_https`]: [200, { result: { value: "on" } }],
      [`${CF}/zones/z1/settings/min_tls_version`]: [200, { result: { value: "1.0" } }],
      [`${CF}/zones/z1/dnssec`]: [200, { result: { status: "disabled" } }],
      [`${CF}/zones/z1/dns_records`]: [
        200,
        {
          result: [
            {
              id: "r1",
              type: "A",
              name: "server1.example.org",
              content: "203.0.113.10",
              proxied: false,
            },
            {
              id: "r2",
              type: "CNAME",
              name: "www.example.org",
              content: "site.pages.dev",
              proxied: true,
            },
          ],
        },
      ],
    });
    const o = await cloudflare.observe({ token: "t" }, http, NOW);
    assertEquals(o.account, "Example Co");
    assertEquals(o.gaps.length, 1);
    assertStringIncludes(o.gaps[0] ?? "", "Workers");
    assertEquals(o.assets.filter((a) => a.kind === "dns-record").length, 2);
    assertEquals(o.assets.find((a) => a.kind === "r2-bucket")?.name, "backups");
    assert(
      http.calls.every((c) => c.method === "GET"),
      "only reads",
    );
    const by = Object.fromEntries(
      cloudflare.policies(o, NOW.getTime()).map((p) => [p.id, p.status]),
    );
    assertEquals(by, {
      observed: "pass",
      "cf-tls-strict": "pass",
      "cf-always-https": "pass",
      "cf-min-tls": "fail",
      "cf-dnssec": "warn",
    });
    const joined = joinFleet(o, ["server1"], "example.org");
    assertEquals(
      joined.assets.find((a) => a.name === "server1.example.org")?.fleetMachine,
      "server1",
    );
    assertEquals(joined.assets.find((a) => a.name === "www.example.org")?.fleetMachine, undefined);
    assertStringIncludes(observationSource(o), "GENERATED");
  },
);

test("067: a Cloudflare token that cannot list zones fails loudly", async () => {
  const http = fake({ [`${CF}/accounts?`]: [401, {}] });
  let msg = "";
  try {
    await cloudflare.observe({ token: "bad" }, http, NOW);
  } catch (e) {
    msg = e instanceof Error ? e.message : String(e);
  }
  assertStringIncludes(msg, "401");
});

proves(
  ["067-adopt FR-008", "067-adopt FR-009"],
  "067: Hetzner servers and their posture",
  async () => {
    const H = "api.hetzner.cloud/v1";
    const http = fake({
      [`${H}/servers`]: [
        200,
        {
          servers: [
            {
              id: 1,
              name: "server1",
              status: "running",
              backup_window: "22-02",
              protection: { delete: true },
              public_net: { ipv4: { ip: "198.51.100.1" }, firewalls: [{ id: 9 }] },
            },
            {
              id: 2,
              name: "scratch",
              status: "off",
              backup_window: null,
              protection: { delete: false },
              public_net: { firewalls: [] },
            },
          ],
          meta: { pagination: { next_page: null } },
        },
      ],
      [`${H}/volumes`]: [200, { volumes: [] }],
      [`${H}/firewalls`]: [
        200,
        {
          firewalls: [{ id: 9, name: "edge", rules: [{}, {}], applied_to: [{}] }],
        },
      ],
      [`${H}/primary_ips`]: [200, { primary_ips: [] }],
      [`${H}/load_balancers`]: [200, { load_balancers: [] }],
    });
    const o = await hetzner.observe({ token: "t" }, http, NOW);
    assertEquals(o.assets.filter((a) => a.kind === "server").length, 2);
    const by = Object.fromEntries(hetzner.policies(o, NOW.getTime()).map((p) => [p.id, p.status]));
    assertEquals(by["hz-firewall"], "fail");
    assertEquals(by["hz-backups"], "warn");
  },
);

proves(
  ["067-adopt FR-008", "067-adopt FR-009", "067-adopt FR-011", "084-connectors FR-003"],
  "067: Microsoft 365: users, Global Administrators, MFA; Azure optional",
  async () => {
    const G = "graph.microsoft.com/v1.0";
    const http = fake({
      "login.microsoftonline.com/": [200, { access_token: "x" }],
      [`${G}/organization`]: [200, { value: [{ id: "o", displayName: "Example Co" }] }],
      [`${G}/domains`]: [
        200,
        { value: [{ id: "example.org", isVerified: true, isDefault: true }] },
      ],
      [`${G}/users`]: [
        200,
        {
          value: [
            {
              id: "1",
              displayName: "Alice",
              userPrincipalName: "alice@example.org",
              accountEnabled: true,
            },
            {
              id: "2",
              displayName: "Bob",
              userPrincipalName: "bob@example.org",
              accountEnabled: true,
            },
          ],
        },
      ],
      [`${G}/subscribedSkus`]: [
        200,
        {
          value: [
            {
              skuId: "s",
              skuPartNumber: "O365_BUSINESS_PREMIUM",
              consumedUnits: 2,
              prepaidUnits: { enabled: 5 },
            },
          ],
        },
      ],
      [`${G}/directoryRoles`]: [200, { value: [{ userPrincipalName: "alice@example.org" }] }],
      [`${G}/reports/authenticationMethods/userRegistrationDetails`]: [
        200,
        {
          value: [
            { userPrincipalName: "alice@example.org", isMfaRegistered: true },
            { userPrincipalName: "bob@example.org", isMfaRegistered: false },
          ],
        },
      ],
      [`${G}/policies/identitySecurityDefaultsEnforcementPolicy`]: [200, { isEnabled: true }],
      [`${G}/identity/conditionalAccess/policies`]: [403, {}],
      [`${G}/servicePrincipals`]: [200, { value: [] }],
      "management.azure.com/subscriptions?": [200, { value: [] }],
    });
    const o = await microsoft.observe({ tenant: "t", clientId: "c", clientSecret: "s" }, http, NOW);
    assertEquals(o.account, "Example Co");
    assertEquals(o.posture["membersWithoutMfa"], 1);
    assertEquals(o.posture["mfaEnforced"], true);
    // Spec 085: its people's accounts, for the estate graph.
    const acc = o.entities?.accounts ?? [];
    assertEquals(
      acc.map((a) => [a.email, a.admin, a.mfa]),
      [
        ["alice@example.org", true, true],
        ["bob@example.org", false, false],
      ],
    );
    const by = Object.fromEntries(microsoft.policies(o, NOW.getTime()).map((p) => [p.id, p]));
    assertEquals(by["ms-mfa-registered"]?.status, "fail");
    assertStringIncludes(by["ms-mfa-registered"]?.fix ?? "", "bob@example.org");
    assertEquals(by["ms-global-admins"]?.status, "warn");
    assertEquals(by["ms-mfa-enforced"]?.status, "pass");
    assert(o.gaps.some((g) => g.includes("Conditional Access")));
    // Only the token requests are POSTs; everything else reads.
    assert(
      http.calls
        .filter((c) => c.method !== "GET")
        .every((c) => c.url.includes("login.microsoftonline.com")),
    );
  },
);

proves(["067-adopt FR-010"], "067: AWS SigV4 matches AWS's published example", async () => {
  // docs.aws.amazon.com: "Signature Version 4 signing process" example (IAM ListUsers).
  const r = await signed(
    {
      method: "GET",
      host: "iam.amazonaws.com",
      path: "/",
      query: { Action: "ListUsers", Version: "2010-05-08" },
      headers: { "content-type": "application/x-www-form-urlencoded; charset=utf-8" },
      body: "",
      region: "us-east-1",
      service: "iam",
    },
    { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY" },
    new Date("2015-08-30T12:36:00Z"),
  );
  assertEquals(r.url, "https://iam.amazonaws.com/?Action=ListUsers&Version=2010-05-08");
  const h = r.headers;
  assertStringIncludes(
    h["authorization"] ?? "",
    "Signature=5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7",
  );
  assertStringIncludes(
    h["authorization"] ?? "",
    "Credential=AKIDEXAMPLE/20150830/us-east-1/iam/aws4_request",
  );
});

proves(
  ["067-adopt FR-008", "067-adopt FR-009", "067-adopt FR-010"],
  "067: AWS root MFA, S3 public access, EC2 across regions",
  async () => {
    const http = fake({
      "sts.amazonaws.com/?Action=GetCallerIdentity": [
        200,
        "<GetCallerIdentityResponse><Account>111122223333</Account><Arn>arn:aws:iam::111122223333:user/stolos-read</Arn></GetCallerIdentityResponse>",
      ],
      "iam.amazonaws.com/?Action=GetAccountSummary": [
        200,
        "<SummaryMap><entry><key>AccountMFAEnabled</key><value>0</value></entry><entry><key>AccountAccessKeysPresent</key><value>0</value></entry></SummaryMap>",
      ],
      "iam.amazonaws.com/?Action=ListUsers": [
        200,
        "<Users><member><UserName>stolos-read</UserName><UserId>AID1</UserId><CreateDate>2026-01-01T00:00:00Z</CreateDate></member></Users>",
      ],
      "s3.amazonaws.com/": [
        200,
        "<Buckets><Bucket><Name>example-backups</Name><CreationDate>2025-03-01T00:00:00Z</CreationDate></Bucket></Buckets>",
      ],
      "111122223333.s3-control.us-east-1.amazonaws.com/": [
        404,
        "<Error><Code>NoSuchPublicAccessBlockConfiguration</Code></Error>",
      ],
      "ec2.us-east-1.amazonaws.com/?Action=DescribeRegions": [
        200,
        "<regionInfo><item><regionName>us-east-1</regionName></item><item><regionName>eu-central-1</regionName></item></regionInfo>",
      ],
      "ec2.us-east-1.amazonaws.com/?Action=DescribeInstances": [
        200,
        "<reservationSet><item><instancesSet><item><instanceId>i-1</instanceId><instanceType>t3.micro</instanceType><instanceState><name>running</name></instanceState><metadataOptions><httpTokens>optional</httpTokens></metadataOptions><tagSet><item><key>Name</key><value>server1</value></item></tagSet></item></instancesSet></item></reservationSet>",
      ],
      "ec2.eu-central-1.amazonaws.com/?Action=DescribeInstances": [
        403,
        "<Response><Errors><Error><Code>UnauthorizedOperation</Code></Error></Errors></Response>",
      ],
    });
    const o = await aws.observe({ accessKeyId: "AKIDEXAMPLE", secretAccessKey: "s" }, http, NOW);
    assertEquals(o.account, "111122223333");
    assertEquals(o.assets.find((a) => a.kind === "ec2-instance")?.name, "server1");
    assert(o.gaps.some((g) => g.includes("eu-central-1")));
    const by = Object.fromEntries(aws.policies(o, NOW.getTime()).map((p) => [p.id, p.status]));
    assertEquals(by, {
      observed: "pass",
      "aws-root-mfa": "fail",
      "aws-root-keys": "pass",
      "aws-s3-public": "fail",
      "aws-imdsv2": "warn",
    });
    // Spec 088: GET, plus CloudTrail's and Config's read actions (their APIs are JSON over POST).
    assert(
      http.calls.every(
        (c) =>
          c.method === "GET" ||
          /^https:\/\/(cloudtrail|config)\.[a-z0-9-]+\.amazonaws\.com\/$/.test(c.url),
      ),
      "only reads",
    );
    assertEquals(xmlAll("<a>1</a><a>2</a>", "a"), ["1", "2"]);
  },
);

proves(
  ["067-adopt FR-007", "084-connectors FR-001"],
  "067: every provider says how to make a read-only credential, and names SCF controls",
  () => {
    assertEquals(
      CONNECTORS.map((c) => c.id),
      [
        "cloudflare",
        "microsoft",
        "google",
        "okta",
        "jumpcloud",
        "intune",
        "defender",
        "jamf",
        "kandji",
        "crowdstrike",
        "sentinelone",
        "github",
        "gitlab",
        "bitbucket",
        "bamboohr",
        "rippling",
        "gusto",
        "deel",
        "justworks",
        "jira",
        "linear",
        "slack",
        "onepassword",
        "bitwarden",
        "snyk",
        "tenable",
        "knowbe4",
        "checkr",
        "aws",
        "gcp",
        "digitalocean",
        "hetzner",
      ],
    );
    for (const c of CONNECTORS) {
      assert(c.connectHelp.join(" ").match(/read/i), `${c.id}: read-only help`);
      assert(
        c.fields.some((f) => f.secret),
        `${c.id}: a secret field`,
      );
    }
  },
);

proves(
  ["084-connectors FR-002"],
  "084: stolos connect, disconnect, estate observe | check | assets; the console's page is Connected accounts",
  async () => {
    const { fs, path } = await import("@intellectual-frontiers/ifc-ts/runtime");
    const { sandbox, linkEngine } = await import("./sandbox.ts");
    const { COMMANDS } = await import("../src/archon/commands/registry.ts");
    for (const n of ["connect", "disconnect", "estate observe", "estate check", "estate assets"]) {
      assert(
        COMMANDS.some((c) => c.name === n),
        n,
      );
    }
    const { STOLOS_NAV } = await import("../src/archon/console/stolos-pages.ts");
    assert(STOLOS_NAV.some((n) => n.label === "Connected accounts" && n.href === "/clouds"));
    const sb = await sandbox("stolos-estate-");
    try {
      const repo = path.join(sb.home, "fleet");
      await fs.mkdir(path.join(repo, "fleets"), { recursive: true });
      await fs.copy("examples/fleets/lab", path.join(repo, "fleets", "lab"));
      await linkEngine(repo);
      const env = { ARCHON_REPO: repo, ARCHON_FLEET: "lab" };
      const stolos = (args: string[], stdin = "") => sb.run("src/stolos/main.ts", args, stdin, env);
      // The last observation, in Git, as estate observe writes it.
      const o = await cloudflare.observe({ token: "t" }, cfFake(), NOW);
      await fs.mkdir(path.join(repo, "fleets", "lab", "estate"), { recursive: true });
      await fs.writeTextFile(
        path.join(repo, "fleets", "lab", "estate", "cloudflare.ts"),
        observationSource(o),
      );
      let r = await stolos(["estate", "assets", "--json"]);
      assertEquals(r.code, 0, r.out);
      const rows = JSON.parse(
        r.out.slice(r.out.indexOf("["), r.out.lastIndexOf("]") + 1),
      ) as Array<{
        provider: string;
        kind: string;
      }>;
      assert(
        rows.some((a) => a.provider === "cloudflare" && a.kind === "zone"),
        r.out,
      );
      r = await stolos(["estate", "check", "--json"]);
      const checked = JSON.parse(r.out.slice(r.out.indexOf("{"), r.out.lastIndexOf("}") + 1)) as {
        accounts: Array<{ provider: string; results: Array<{ id: string; status: string }> }>;
      };
      const cf = checked.accounts.find((a) => a.provider === "cloudflare");
      assertEquals(cf?.results.find((p) => p.id === "cf-min-tls")?.status, "fail");
      assertEquals(r.code, 1, "a failing policy fails the check");
      // Nothing connected on this PC: observe reads nothing and says how to connect.
      r = await stolos(["estate", "observe", "cloudflare"]);
      assertStringIncludes(r.out, "not connected (bun run stolos connect cloudflare)");
      // connect asks for the read-only credential (here: none given, so nothing is kept).
      r = await stolos(["connect", "cloudflare"], "\n");
      assertStringIncludes(r.out, "make a read-only credential");
      const cred = path.join(
        sb.home,
        "config",
        "stolos",
        "secrets",
        "lab",
        "connectors",
        "cloudflare",
      );
      assert(!(await fs.exists(path.join(cred, "credential.json"))));
      // disconnect: the credential leaves the vault; the observation stays in Git.
      await fs.mkdir(cred, { recursive: true });
      await fs.writeTextFile(path.join(cred, "credential.json"), '{"token":"t"}\n');
      r = await stolos(["disconnect", "cloudflare"]);
      assertEquals(r.code, 0, r.out);
      assertStringIncludes(r.out, "the credential is gone from this PC's vault");
      assert(!(await fs.exists(path.join(cred, "credential.json"))));
      assert(await fs.exists(path.join(repo, "fleets", "lab", "estate", "cloudflare.ts")));
    } finally {
      await fs.remove(sb.home, { recursive: true });
    }
  },
);

/** Cloudflare's recorded answers (the first test's), for a whole observation. */
function cfFake(): ReturnType<typeof fake> {
  return fake({
    [`${CF}/accounts?`]: [
      200,
      {
        result: [{ id: "a1", name: "Example Co" }],
        result_info: { page: 1, total_pages: 1 },
      },
    ],
    [`${CF}/accounts/a1/workers/scripts`]: [403, { success: false }],
    [`${CF}/accounts/a1/pages/projects`]: [
      200,
      {
        result: [{ id: "p1", name: "site", subdomain: "site.pages.dev" }],
      },
    ],
    [`${CF}/accounts/a1/r2/buckets`]: [
      200,
      {
        result: { buckets: [{ name: "backups", location: "ENAM" }] },
      },
    ],
    [`${CF}/accounts/a1/cfd_tunnel`]: [200, { result: [] }],
    [`${CF}/zones?`]: [
      200,
      {
        result: [{ id: "z1", name: "example.org", status: "active", plan: { name: "Free" } }],
      },
    ],
    [`${CF}/zones/z1/settings/ssl`]: [200, { result: { value: "strict" } }],
    [`${CF}/zones/z1/settings/always_use_https`]: [200, { result: { value: "on" } }],
    [`${CF}/zones/z1/settings/min_tls_version`]: [200, { result: { value: "1.0" } }],
    [`${CF}/zones/z1/dnssec`]: [200, { result: { status: "disabled" } }],
    [`${CF}/zones/z1/dns_records`]: [
      200,
      {
        result: [
          {
            id: "r1",
            type: "A",
            name: "server1.example.org",
            content: "203.0.113.10",
            proxied: false,
          },
          {
            id: "r2",
            type: "CNAME",
            name: "www.example.org",
            content: "site.pages.dev",
            proxied: true,
          },
        ],
      },
    ],
  });
}
