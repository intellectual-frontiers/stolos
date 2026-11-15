// Spec 067 (clouds): read-only inventory and posture, against fake provider APIs.
import { assert, assertEquals, assertStringIncludes } from "./assert.ts";
import type { Http } from "../src/archon/connect/connector.ts";
import { observationSource } from "../src/archon/connect/connector.ts";
import { cloudflare } from "../src/archon/connect/cloudflare.ts";
import { hetzner } from "../src/archon/connect/hetzner.ts";
import { microsoft } from "../src/archon/connect/microsoft.ts";
import { aws, sigv4, xmlAll } from "../src/archon/connect/aws.ts";
import { CONNECTORS, joinFleet } from "../src/archon/connect/commands.ts";

const NOW = new Date("2026-11-15T12:00:00Z");

/** A fake API: path (and query) prefix to [status, body]; every call is recorded. */
function fake(
  routes: Record<string, [number, unknown]>,
): Http & { calls: Array<{ url: string; method: string }> } {
  const calls: Array<{ url: string; method: string }> = [];
  const f = ((url: string, init?: { method?: string }) => {
    calls.push({ url, method: init?.method ?? "GET" });
    const u = new URL(url);
    const key = Object.keys(routes).filter((k) => `${u.host}${u.pathname}${u.search}`.startsWith(k))
      .sort((a, b) => b.length - a.length)[0];
    if (!key) return Promise.resolve({ status: 404, text: "{}" });
    const [status, body] = routes[key];
    return Promise.resolve({
      status,
      text: typeof body === "string" ? body : JSON.stringify(body),
    });
  }) as Http & { calls: typeof calls };
  f.calls = calls;
  return f;
}

const CF = "api.cloudflare.com/client/v4";

Deno.test("067: Cloudflare inventory, a denied part as a gap, and the TLS posture", async () => {
  const http = fake({
    [`${CF}/accounts?`]: [200, {
      result: [{ id: "a1", name: "Example Co" }],
      result_info: { page: 1, total_pages: 1 },
    }],
    [`${CF}/accounts/a1/workers/scripts`]: [403, { success: false }],
    [`${CF}/accounts/a1/pages/projects`]: [200, {
      result: [{ id: "p1", name: "site", subdomain: "site.pages.dev" }],
    }],
    [`${CF}/accounts/a1/r2/buckets`]: [200, {
      result: { buckets: [{ name: "backups", location: "ENAM" }] },
    }],
    [`${CF}/accounts/a1/cfd_tunnel`]: [200, { result: [] }],
    [`${CF}/zones?`]: [200, {
      result: [{ id: "z1", name: "example.org", status: "active", plan: { name: "Free" } }],
    }],
    [`${CF}/zones/z1/settings/ssl`]: [200, { result: { value: "strict" } }],
    [`${CF}/zones/z1/settings/always_use_https`]: [200, { result: { value: "on" } }],
    [`${CF}/zones/z1/settings/min_tls_version`]: [200, { result: { value: "1.0" } }],
    [`${CF}/zones/z1/dnssec`]: [200, { result: { status: "disabled" } }],
    [`${CF}/zones/z1/dns_records`]: [200, {
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
    }],
  });
  const o = await cloudflare.observe({ token: "t" }, http, NOW);
  assertEquals(o.account, "Example Co");
  assertEquals(o.gaps.length, 1);
  assertStringIncludes(o.gaps[0], "Workers");
  assertEquals(o.assets.filter((a) => a.kind === "dns-record").length, 2);
  assertEquals(o.assets.find((a) => a.kind === "r2-bucket")?.name, "backups");
  assert(http.calls.every((c) => c.method === "GET"), "only reads");
  const by = Object.fromEntries(cloudflare.policies(o, NOW.getTime()).map((p) => [p.id, p.status]));
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
});

Deno.test("067: a Cloudflare token that cannot list zones fails loudly", async () => {
  const http = fake({ [`${CF}/accounts?`]: [401, {}] });
  let msg = "";
  try {
    await cloudflare.observe({ token: "bad" }, http, NOW);
  } catch (e) {
    msg = (e as Error).message;
  }
  assertStringIncludes(msg, "401");
});

Deno.test("067: Hetzner servers and their posture", async () => {
  const H = "api.hetzner.cloud/v1";
  const http = fake({
    [`${H}/servers`]: [200, {
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
    }],
    [`${H}/volumes`]: [200, { volumes: [] }],
    [`${H}/firewalls`]: [200, {
      firewalls: [{ id: 9, name: "edge", rules: [{}, {}], applied_to: [{}] }],
    }],
    [`${H}/primary_ips`]: [200, { primary_ips: [] }],
    [`${H}/load_balancers`]: [200, { load_balancers: [] }],
  });
  const o = await hetzner.observe({ token: "t" }, http, NOW);
  assertEquals(o.assets.filter((a) => a.kind === "server").length, 2);
  const by = Object.fromEntries(hetzner.policies(o, NOW.getTime()).map((p) => [p.id, p.status]));
  assertEquals(by["hz-firewall"], "fail");
  assertEquals(by["hz-backups"], "warn");
});

Deno.test("067: Microsoft 365: users, Global Administrators, MFA; Azure optional", async () => {
  const G = "graph.microsoft.com/v1.0";
  const http = fake({
    "login.microsoftonline.com/": [200, { access_token: "x" }],
    [`${G}/organization`]: [200, { value: [{ id: "o", displayName: "Example Co" }] }],
    [`${G}/domains`]: [200, { value: [{ id: "example.org", isVerified: true, isDefault: true }] }],
    [`${G}/users`]: [200, {
      value: [
        {
          id: "1",
          displayName: "Alice",
          userPrincipalName: "alice@example.org",
          accountEnabled: true,
        },
        { id: "2", displayName: "Bob", userPrincipalName: "bob@example.org", accountEnabled: true },
      ],
    }],
    [`${G}/subscribedSkus`]: [200, {
      value: [{
        skuId: "s",
        skuPartNumber: "O365_BUSINESS_PREMIUM",
        consumedUnits: 2,
        prepaidUnits: { enabled: 5 },
      }],
    }],
    [`${G}/directoryRoles`]: [200, { value: [{ userPrincipalName: "alice@example.org" }] }],
    [`${G}/reports/authenticationMethods/userRegistrationDetails`]: [200, {
      value: [
        { userPrincipalName: "alice@example.org", isMfaRegistered: true },
        { userPrincipalName: "bob@example.org", isMfaRegistered: false },
      ],
    }],
    [`${G}/policies/identitySecurityDefaultsEnforcementPolicy`]: [200, { isEnabled: true }],
    [`${G}/identity/conditionalAccess/policies`]: [403, {}],
    "management.azure.com/subscriptions?": [200, { value: [] }],
  });
  const o = await microsoft.observe({ tenant: "t", clientId: "c", clientSecret: "s" }, http, NOW);
  assertEquals(o.account, "Example Co");
  assertEquals(o.posture.membersWithoutMfa, 1);
  assertEquals(o.posture.mfaEnforced, true);
  // Spec 085: its people's accounts, for the estate graph.
  const acc = o.entities?.accounts ?? [];
  assertEquals(acc.map((a) => [a.email, a.admin, a.mfa]), [["alice@example.org", true, true], [
    "bob@example.org",
    false,
    false,
  ]]);
  const by = Object.fromEntries(microsoft.policies(o, NOW.getTime()).map((p) => [p.id, p]));
  assertEquals(by["ms-mfa-registered"].status, "fail");
  assertStringIncludes(by["ms-mfa-registered"].fix!, "bob@example.org");
  assertEquals(by["ms-global-admins"].status, "warn");
  assertEquals(by["ms-mfa-enforced"].status, "pass");
  assert(o.gaps.some((g) => g.includes("Conditional Access")));
  // Only the token requests are POSTs; everything else reads.
  assert(
    http.calls.filter((c) => c.method !== "GET").every((c) =>
      c.url.includes("login.microsoftonline.com")
    ),
  );
});

Deno.test("067: AWS SigV4 matches AWS's published example", async () => {
  // docs.aws.amazon.com: "Signature Version 4 signing process" example (IAM ListUsers).
  const h = await sigv4(
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
  assertStringIncludes(
    h.Authorization,
    "Signature=5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7",
  );
  assertStringIncludes(
    h.Authorization,
    "Credential=AKIDEXAMPLE/20150830/us-east-1/iam/aws4_request",
  );
});

Deno.test("067: AWS root MFA, S3 public access, EC2 across regions", async () => {
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
  assert(http.calls.every((c) => c.method === "GET"), "only reads");
  assertEquals(xmlAll("<a>1</a><a>2</a>", "a"), ["1", "2"]);
});

Deno.test("067: every provider says how to make a read-only credential, and names SCF controls", () => {
  assertEquals(CONNECTORS.map((c) => c.id), [
    "cloudflare",
    "microsoft",
    "google",
    "okta",
    "jumpcloud",
    "github",
    "gitlab",
    "bitbucket",
    "bamboohr",
    "rippling",
    "gusto",
    "deel",
    "justworks",
    "aws",
    "hetzner",
  ]);
  for (const c of CONNECTORS) {
    assert(c.connectHelp.join(" ").match(/read/i), `${c.id}: read-only help`);
    assert(c.fields.some((f) => f.secret), `${c.id}: a secret field`);
  }
});
