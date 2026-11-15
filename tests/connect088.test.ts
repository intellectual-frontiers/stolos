/**
 * Spec 088: wave 3 connectors against recorded API responses: vulnerability scanners (Snyk,
 * Tenable, GitHub's Dependabot alerts), security awareness training (KnowBe4) and screening
 * (Checkr), and more clouds (Google Cloud, DigitalOcean, deeper AWS and Azure). Per connector:
 * records and posture, a 403 as a gap, a failing policy with its fix, and reads only. Open
 * vulnerabilities feed the OSCAL POA&M and export as OCSF Vulnerability Findings; training and
 * screening records feed spec 077's people controls.
 *
 * @module
 */

import {
  assert,
  assertExists,
  assertEquals,
  assertStringIncludes,
  proves,
} from "@intellectual-frontiers/ifc-ts/runtime/test";
import { Ajv } from "ajv";
import type { Result } from "@intellectual-frontiers/ifc-ts/kernel";
import { fs, type http, path } from "@intellectual-frontiers/ifc-ts/runtime";
import {
  type Connector,
  MARKET_CATEGORIES,
  type Observation,
} from "../src/archon/connect/connector.ts";
import { recordedHttp } from "../src/archon/connect/sdk.ts";
import { CONNECTORS } from "../src/archon/connect/commands.ts";
import { COMMANDS } from "../src/archon/commands/registry.ts";
import { SCF } from "../src/archon/compliance/scf.ts";
import { CONNECTOR_LABELS } from "../src/archon/connect/labels.ts";
import { schemaProblems } from "../src/archon/schema/define.ts";
import { snyk } from "../src/archon/connect/snyk.ts";
import { tenable } from "../src/archon/connect/tenable.ts";
import { github } from "../src/archon/connect/github.ts";
import { knowbe4 } from "../src/archon/connect/knowbe4.ts";
import { checkr } from "../src/archon/connect/checkr.ts";
import { gcp } from "../src/archon/connect/gcp.ts";
import { digitalocean } from "../src/archon/connect/digitalocean.ts";
import { aws, awsReadPost } from "../src/archon/connect/aws.ts";
import { microsoft } from "../src/archon/connect/microsoft.ts";
import { openVulnerabilities, severityOf } from "../src/archon/connect/vulnerability.ts";
import { oscalExports } from "../src/archon/compliance/oscal.ts";
import { complianceView, fleetEvidence } from "../src/archon/compliance/report.ts";
import type { ScfCatalog } from "../src/archon/compliance/catalog.ts";
import { estateEvents } from "../src/archon/export/ocsf.ts";
import { fixtureEstate, testControl } from "../src/archon/controls/testing.ts";
import { screeningControl, trainingControl } from "../src/archon/people/controls.ts";
import type { Person } from "../src/archon/connect/entities.ts";
import { FACTS } from "./console/serve-stolos.ts";

const NOW = new Date("2026-11-15T12:00:00Z");
type Calls = Array<{ method: string; url: string }>;
const DENIED = { status: 403, body: { message: "Forbidden" } };
const by = (c: Connector, o: Observation) =>
  Object.fromEntries(c.policies(o, NOW.getTime()).map((p) => [p.id, p]));
const reads = (calls: Calls, post: RegExp[] = []) =>
  calls.length > 0 && calls.every((c) => c.method === "GET" || post.some((r) => r.test(c.url)));

/** Answers by the longest matching prefix of host + path + query (anything else: 404). */
function routes(
  r: Record<string, { status?: number; body: unknown; link?: string }>,
  calls: Calls,
): http.Transport {
  return {
    kind: "recorded",
    send(q): Promise<Result<http.Exchange, http.TransportError>> {
      calls.push({ method: q.method, url: q.url });
      const u = new URL(q.url);
      const k = Object.keys(r)
        .filter((x) => `${u.host}${u.pathname}${u.search}`.startsWith(x))
        .sort((a, b) => b.length - a.length)[0];
      const f = (k === undefined ? undefined : r[k]) ?? { status: 404, body: {} };
      return Promise.resolve({
        kind: "ok",
        value: {
          method: q.method,
          url: q.url,
          status: f.status ?? 200,
          headers: f.link ? { link: f.link } : {},
          body: JSON.stringify(f.body),
        },
      });
    },
  };
}

/** A vendored JSON Schema of the engine's checkout, read. */
async function vendored(rel: string): Promise<Record<string, unknown>> {
  const file = path.join(path.dirname(path.fromFileUrl(import.meta.url)), "..", rel);
  const v: unknown = JSON.parse(await fs.readTextFile(file));
  assert(typeof v === "object" && v !== null && !Array.isArray(v), rel);
  return { ...v };
}

const IDS = ["snyk", "tenable", "knowbe4", "checkr", "gcp", "digitalocean"];

proves(
  ["088-wave3-registry FR-005", "088-wave3-registry FR-006", "088-wave3-registry FR-007"],
  "088: the new connectors are registered, offered by every connector command, labeled, with real SCF ids",
  () => {
    const markets = new Set(MARKET_CATEGORIES.map((m) => m.id));
    const scf = new Set(SCF.map((c) => c.id));
    for (const id of IDS) {
      const c = CONNECTORS.find((x) => x.id === id);
      assert(c, id);
      assert(c.markets.length && c.markets.every((m) => markets.has(m)), `${id}: markets`);
      assert(c.connectHelp.join(" ").match(/read/i), `${id}: read-only help`);
      assert(
        c.fields.some((f) => f.secret),
        `${id}: a secret field`,
      );
    }
    for (const c of CONNECTORS) {
      const empty = {
        at: NOW.toISOString(),
        provider: c.id,
        account: "",
        assets: [],
        posture: {},
        gaps: [],
      };
      for (const p of c.policies(empty, NOW.getTime())) {
        for (const x of p.scf) assert(scf.has(x), `${c.id} ${p.id}: ${x}`);
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
    for (const l of [
      "vulnerability",
      "event_log",
      "intrusion_detection_system",
      "configuration_management_database",
      "person_record",
    ])
      assert(
        CONNECTOR_LABELS.some((x) => x.name === l),
        l,
      );
    for (const id of ["VPM-06", "VPM-07", "MON-03", "MON-05", "MON-13", "MON-16", "CFG-02"]) {
      assert(scf.has(id), id);
    }
    assertEquals(
      [severityOf("CRITICAL"), severityOf(7.5), severityOf("moderate")],
      ["critical", "high", "medium"],
    );
  },
);

// ------------------------------------------------------------------ Snyk

const SNYK = "https://api.snyk.io/rest/orgs/o1";
const V = "version=2024-10-15&limit=100";
const snykIssue = (id: string, sev: string, created: string, cve?: string) => ({
  id,
  type: "issue",
  attributes: {
    title: `issue ${id}`,
    effective_severity_level: sev,
    status: "open",
    created_at: created,
    problems: [
      ...(cve ? [{ id: cve, source: "NVD", type: "vulnerability" }] : []),
      { id: `SNYK-JS-${id}`, source: "SNYK" },
    ],
    coordinates: [
      {
        is_upgradeable: true,
        representations: [{ dependency: { package_name: "lodash", package_version: "4.17.20" } }],
      },
    ],
  },
  relationships: { scan_item: { data: { id: "p1", type: "project" } } },
});

proves(
  ["088-wave3-registry FR-002"],
  "088: Snyk: open issues as vulnerabilities, an overdue critical fails, projects denied is a gap",
  async () => {
    const calls: Calls = [];
    const o = await snyk.observe(
      { region: "", org: "o1", token: "t" },
      recordedHttp(
        {
          [`${SNYK}/projects?${V}`]: DENIED,
          [`${SNYK}/issues?${V}&status=open`]: {
            body: {
              data: [snykIssue("i1", "critical", "2026-10-01T00:00:00Z", "CVE-2021-23337")],
              links: { next: `/orgs/o1/issues?${V}&status=open&starting_after=i1` },
            },
          },
          [`${SNYK}/issues?${V}&status=open&starting_after=i1`]: {
            body: { data: [snykIssue("i2", "medium", "2026-11-10T00:00:00Z")], links: {} },
          },
        },
        calls,
      ),
      NOW,
    );
    const v = o.records?.filter((r) => r.label === "vulnerability");
    assertEquals(
      v?.map((r) => [r.display_name, r.props["severity"], r.props["asset"], r.props["package"]]),
      [
        ["CVE-2021-23337", "critical", "p1", "lodash@4.17.20"],
        ["issue i2", "medium", "p1", "lodash@4.17.20"],
      ],
    );
    assertEquals(v?.[0]?.ocsf_class_uid, 2002);
    assert(
      o.gaps.some((g) => g.startsWith("projects: ")),
      "projects denied: a gap",
    );
    assertEquals(
      [o.posture["vulnOpen"], o.posture["vulnCritical"], o.posture["vulnOverdue"]],
      [2, 1, 1],
    );
    const p = by(snyk, o);
    assertEquals(p["snyk-vuln-overdue"]?.status, "fail");
    assertStringIncludes(p["snyk-vuln-overdue"]?.fix ?? "", "CVE-2021-23337");
    assertEquals(p["snyk-vuln-critical"]?.status, "warn");
    assert(reads(calls), "only reads");
  },
);

// ------------------------------------------------------------------ Tenable

const TEN = "https://cloud.tenable.com/workbenches/assets";

proves(
  ["088-wave3-registry FR-002"],
  "088: Tenable: assets' findings, CVEs for high ones, a denied asset is a gap",
  async () => {
    const calls: Calls = [];
    const o = await tenable.observe(
      { accessKey: "a", secretKey: "s" },
      recordedHttp(
        {
          [`${TEN}/vulnerabilities?date_range=30`]: {
            body: {
              assets: [
                { id: "a1", fqdn: ["alpha.lab.example.net"] },
                { id: "a2", ipv4: ["10.0.0.2"] },
              ],
            },
          },
          [`${TEN}/a1/vulnerabilities?date_range=30`]: {
            body: {
              vulnerabilities: [
                {
                  plugin_id: 1,
                  plugin_name: "OpenSSH regreSSHion",
                  severity: 3,
                  vulnerability_state: "Active",
                },
                {
                  plugin_id: 2,
                  plugin_name: "TLS 1.0",
                  severity: 2,
                  vulnerability_state: "Active",
                },
                { plugin_id: 3, plugin_name: "Host info", severity: 0 },
              ],
            },
          },
          [`${TEN}/a1/vulnerabilities/1/info`]: {
            body: {
              info: {
                discovery: { seen_first: "2026-09-01T00:00:00Z" },
                reference_information: [{ name: "cve", values: ["CVE-2024-6387"] }],
              },
            },
          },
          [`${TEN}/a2/vulnerabilities?date_range=30`]: DENIED,
        },
        calls,
      ),
      NOW,
    );
    const v = o.records?.filter((r) => r.label === "vulnerability");
    assertEquals(
      v?.map((r) => [r.native_id, r.props["cve"] ?? null, r.props["severity"], r.props["asset"]]),
      [
        ["a1:1", "CVE-2024-6387", "high", "alpha.lab.example.net"],
        ["a1:2", null, "medium", "alpha.lab.example.net"],
      ],
    );
    assert(
      o.gaps.some((g) => g.includes("10.0.0.2")),
      "the denied asset is a gap",
    );
    assertEquals(o.posture["vulnOverdue"], 1, "a high one open since September");
    assertEquals(by(tenable, o)["tenable-vuln-overdue"]?.status, "fail");
    assertEquals(by(tenable, o)["tenable-vuln-critical"]?.status, "pass");
    assert(reads(calls));
  },
);

// ------------------------------------------------------------------ GitHub Dependabot

function githubRoutes(alerts: { status?: number; body: unknown }) {
  const A = "api.github.com";
  return {
    [`${A}/orgs/ex`]: { body: { login: "ex", two_factor_requirement_enabled: true } },
    [`${A}/orgs/ex/members?per_page=100`]: { body: [{ login: "alice", id: 1, type: "User" }] },
    [`${A}/orgs/ex/members?role=admin`]: { body: [{ login: "alice" }] },
    [`${A}/orgs/ex/members?filter=2fa_disabled`]: { body: [] },
    [`${A}/orgs/ex/repos`]: {
      body: [
        {
          name: "app",
          full_name: "ex/app",
          private: true,
          archived: false,
          default_branch: "main",
        },
      ],
    },
    [`${A}/repos/ex/app/branches/main/protection`]: {
      body: { required_pull_request_reviews: { required_approving_review_count: 1 } },
    },
    [`${A}/orgs/ex/dependabot/alerts`]: alerts,
  };
}

proves(
  ["088-wave3-registry FR-002"],
  "088: GitHub: open Dependabot alerts are vulnerabilities; denied, a gap and unknown; other outputs unchanged",
  async () => {
    const calls: Calls = [];
    const o = await github.observe(
      { org: "ex", token: "t" },
      routes(
        githubRoutes({
          body: [
            {
              number: 7,
              state: "open",
              html_url: "https://github.com/ex/app/security/dependabot/7",
              created_at: "2026-10-20T00:00:00Z",
              dependency: { package: { name: "jsonwebtoken", ecosystem: "npm" } },
              security_advisory: {
                ghsa_id: "GHSA-8cf7-32gw-wr33",
                cve_id: "CVE-2022-23529",
                summary: "jsonwebtoken RCE",
                severity: "high",
              },
              security_vulnerability: {
                severity: "high",
                first_patched_version: { identifier: "9.0.0" },
              },
              repository: { full_name: "ex/app" },
            },
          ],
        }),
        calls,
      ),
      NOW,
    );
    const v = o.records?.filter((r) => r.label === "vulnerability");
    assertEquals(
      v?.map((r) => [r.native_id, r.props["cve"], r.props["severity"], r.props["fix_available"]]),
      [["ex/app#7", "CVE-2022-23529", "high", true]],
    );
    assertEquals(o.posture["vulnOverdue"], 0, "a high one open 26 days is not yet late");
    assertEquals(by(github, o)["gh-vuln-critical"]?.status, "pass");
    assert(reads(calls));
    // Denied (the token lacks the permission): a gap, the policies unknown, the rest unchanged.
    const d = await github.observe(
      { org: "ex", token: "t" },
      routes(githubRoutes(DENIED), []),
      NOW,
    );
    assert(
      d.gaps.some((g) => g.startsWith("dependabot: ")),
      d.gaps.join("; "),
    );
    assertEquals(d.posture["vulnOpen"], undefined);
    assertEquals(by(github, d)["gh-vuln-overdue"]?.status, "unknown");
    assertEquals(by(github, d)["gh-protected"]?.status, by(github, o)["gh-protected"]?.status);
    assertEquals(d.entities, o.entities);
  },
);

// ------------------------------------------------------------------ KnowBe4 and Checkr

const PEOPLE: Person[] = ["alice", "bob", "carol"].map((n) => ({
  email: `${n}@example.org`,
  status: "active" as const,
}));
const estateWith = (o: Observation) =>
  fixtureEstate(
    {
      sources: [
        {
          connector: "bamboohr",
          observation: {
            at: "2026-11-14T00:00:00Z",
            provider: "bamboohr",
            account: "hr",
            assets: [],
            posture: {},
            gaps: [],
            entities: { people: PEOPLE },
          },
        },
        { connector: o.provider, observation: o },
      ],
    },
    NOW,
  );
const PEOPLE_FACTS = { reviewQuarter: "2026-Q3", policies: [], acks: [], activity: new Map() };

proves(
  ["088-wave3-registry FR-003"],
  "088: KnowBe4: completions are person_record training records the 077 control reads",
  async () => {
    const calls: Calls = [];
    const enr = (id: number, who: string, status: string, done?: string) => ({
      enrollment_id: id,
      module_name: "Security Awareness 2026",
      user: { id, email: `${who}@example.org` },
      status,
      completion_date: done ?? null,
    });
    const o = await knowbe4.observe(
      { region: "", token: "t" },
      recordedHttp(
        {
          "https://us.api.knowbe4.com/v1/training/enrollments?page=1&per_page=500": {
            body: [
              enr(1, "alice", "Passed", "2026-03-02T10:00:00Z"),
              enr(2, "bob", "Past Due"),
              enr(3, "carol", "Failed", "2026-02-01T10:00:00Z"),
            ],
          },
        },
        calls,
      ),
      NOW,
    );
    assertEquals(
      o.records?.map((r) => [r.label, r.props["email"], r.props["result"], r.props["date"]]),
      [
        ["person_record", "alice@example.org", "passed", "2026-03-02"],
        ["person_record", "carol@example.org", "failed", "2026-02-01"],
      ],
    );
    assertEquals(o.posture["trainingPastDue"], 1);
    const p = by(knowbe4, o)["kb4-past-due"];
    assertEquals(p?.status, "warn");
    assertStringIncludes(p?.fix ?? "", "training.knowbe4.com");
    assert(reads(calls));
    // The people control: bob and carol have no passed training.
    const [t] = testControl(trainingControl(PEOPLE_FACTS), { estate: estateWith(o), now: NOW });
    assertEquals(t?.status, "fail");
    assertStringIncludes(t?.detail ?? "", "bob@example.org");
    assertStringIncludes(t?.detail ?? "", "carol@example.org");
    // A key that may not read the report: a gap, not a failure.
    const d = await knowbe4.observe(
      { region: "eu", token: "t" },
      recordedHttp({
        "https://eu.api.knowbe4.com/v1/training/enrollments?page=1&per_page=500": DENIED,
      }),
      NOW,
    );
    assertEquals(d.gaps.length, 1);
    assertEquals(by(knowbe4, d)["kb4-past-due"]?.status, "unknown");
  },
);

proves(
  ["088-wave3-registry FR-003"],
  "088: Checkr: completed reports' outcomes only, pending counted, a denied report a gap",
  async () => {
    const calls: Calls = [];
    const C = "https://api.checkr.com/v1";
    const o = await checkr.observe(
      { token: "t" },
      recordedHttp(
        {
          [`${C}/candidates?per_page=100`]: {
            body: {
              data: [
                { id: "c1", email: "Alice@example.org", report_ids: ["r1"] },
                { id: "c2", email: "bob@example.org", report_ids: ["r2", "r3"] },
              ],
              next_href: null,
            },
          },
          [`${C}/reports/r1`]: {
            body: {
              id: "r1",
              status: "complete",
              result: "clear",
              completed_at: "2025-01-10T00:00:00Z",
              package: "basic",
            },
          },
          [`${C}/reports/r2`]: { body: { id: "r2", status: "pending", result: null } },
          [`${C}/reports/r3`]: DENIED,
        },
        calls,
      ),
      NOW,
    );
    assertEquals(
      o.records?.map((r) => [
        r.props["email"],
        r.props["kind"],
        r.props["result"],
        r.props["date"],
      ]),
      [["alice@example.org", "screening", "clear", "2025-01-10"]],
    );
    assert(o.gaps.some((g) => g.startsWith("report r3")));
    assertEquals(by(checkr, o)["checkr-pending"]?.status, "warn");
    assert(reads(calls));
    assert(
      !JSON.stringify(o).includes("consider") &&
        !JSON.stringify(o.records).includes('package":"basic'),
      "outcomes only",
    );
    const [s] = testControl(screeningControl(PEOPLE_FACTS), { estate: estateWith(o), now: NOW });
    assertEquals(s?.status, "fail");
    assertStringIncludes(s?.detail ?? "", "carol@example.org");
  },
);

// ------------------------------------------------------------------ Google Cloud

async function serviceAccountKey(email: string): Promise<string> {
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
  return JSON.stringify({ client_email: email, private_key: pem });
}

proves(
  ["088-wave3-registry FR-004"],
  "088: Google Cloud: assets, roles, public bindings, keys; sinks denied is a gap",
  async () => {
    const SA = "stolos-read@p1.iam.gserviceaccount.com";
    const key = await serviceAccountKey(SA);
    const calls: Calls = [];
    const A = "https://cloudasset.googleapis.com/v1/projects/p1";
    const I = "https://iam.googleapis.com/v1/projects/p1/serviceAccounts";
    const o = await gcp.observe(
      { project: "p1", key },
      recordedHttp(
        {
          "https://oauth2.googleapis.com/token": { body: { access_token: "x" } },
          [`${A}/assets?pageSize=1000`]: {
            body: {
              assets: [
                {
                  name: "//compute.googleapis.com/projects/p1/zones/z/instances/vm1",
                  assetType: "compute.googleapis.com/Instance",
                },
              ],
              nextPageToken: "n2",
            },
          },
          [`${A}/assets?pageSize=1000&pageToken=n2`]: {
            body: {
              assets: [
                {
                  name: "//storage.googleapis.com/public-bucket",
                  assetType: "storage.googleapis.com/Bucket",
                },
              ],
            },
          },
          [`${A}:searchAllIamPolicies?pageSize=500`]: {
            body: {
              results: [
                {
                  resource: "//cloudresourcemanager.googleapis.com/projects/p1",
                  policy: {
                    bindings: [
                      { role: "roles/owner", members: ["user:alice@example.org"] },
                      { role: "roles/viewer", members: ["group:eng@example.org"] },
                    ],
                  },
                },
                {
                  resource: "//storage.googleapis.com/public-bucket",
                  policy: {
                    bindings: [{ role: "roles/storage.objectViewer", members: ["allUsers"] }],
                  },
                },
              ],
            },
          },
          [`${I}?pageSize=100`]: {
            body: {
              accounts: [
                { email: SA, uniqueId: "1" },
                {
                  email: "ci@p1.iam.gserviceaccount.com",
                  uniqueId: "2",
                },
              ],
            },
          },
          [`${I}/${encodeURIComponent(SA)}/keys?keyTypes=USER_MANAGED`]: { body: { keys: [{}] } },
          [`${I}/ci%40p1.iam.gserviceaccount.com/keys?keyTypes=USER_MANAGED`]: {
            body: { keys: [{}, {}] },
          },
          "https://logging.googleapis.com/v2/projects/p1/sinks?pageSize=200": DENIED,
        },
        calls,
      ),
      NOW,
    );
    assertEquals(o.account, "p1");
    assertEquals(o.records?.filter((r) => r.label === "resource").length, 2);
    assertEquals(
      o.records?.filter((r) => r.label === "access_control_group").map((r) => r.native_id),
      [
        "roles/owner",
        "roles/storage.objectViewer on //storage.googleapis.com/public-bucket",
        "roles/viewer",
      ],
    );
    assert(o.gaps.some((g) => g.startsWith("sinks: ")));
    assertEquals(
      [o.posture["owners"], o.posture["publicBindings"], o.posture["serviceAccountKeys"]],
      [1, 1, 2],
    );
    const p = by(gcp, o);
    assertEquals(p["gcp-public"]?.status, "fail");
    assertStringIncludes(p["gcp-public"]?.fix ?? "", "allUsers");
    assertEquals(p["gcp-owners"]?.status, "warn");
    assertEquals(p["gcp-sa-keys"]?.status, "warn", "Stolos's own key is not counted");
    assertEquals(p["gcp-log-sink"]?.status, "unknown");
    assert(reads(calls, [/^https:\/\/oauth2\.googleapis\.com\/token$/]));
  },
);

// ------------------------------------------------------------------ DigitalOcean

proves(
  ["088-wave3-registry FR-004"],
  "088: DigitalOcean: Droplets across pages, firewalls by tag, backups; volumes denied is a gap",
  async () => {
    const calls: Calls = [];
    const D = "https://api.digitalocean.com/v2";
    const o = await digitalocean.observe(
      { token: "t" },
      recordedHttp(
        {
          [`${D}/account`]: {
            body: {
              account: {
                uuid: "u1",
                email: "alice@example.org",
                team: { uuid: "t1", name: "Lab" },
              },
            },
          },
          [`${D}/firewalls?per_page=200`]: {
            body: {
              firewalls: [
                {
                  id: "f1",
                  name: "web",
                  tags: ["web"],
                  droplet_ids: [],
                  inbound_rules: [{}, {}],
                },
              ],
              links: {},
            },
          },
          [`${D}/droplets?per_page=200`]: {
            body: {
              droplets: [
                {
                  id: 1,
                  name: "alpha",
                  status: "active",
                  size_slug: "s-1vcpu-1gb",
                  region: { slug: "fra1" },
                  features: ["backups"],
                  tags: ["web"],
                },
              ],
              links: { pages: { next: `${D}/droplets?page=2&per_page=200` } },
            },
          },
          [`${D}/droplets?page=2&per_page=200`]: {
            body: {
              droplets: [{ id: 2, name: "beta", status: "active", features: [], tags: [] }],
              links: { pages: {} },
            },
          },
          [`${D}/volumes?per_page=200`]: DENIED,
        },
        calls,
      ),
      NOW,
    );
    assertEquals(o.account, "Lab");
    assertEquals(
      o.assets.filter((a) => a.kind === "server").map((a) => a.name),
      ["alpha", "beta"],
    );
    assert(o.gaps.some((g) => g.startsWith("volumes: ")));
    assertEquals(
      [o.posture["droplets"], o.posture["dropletsWithBackups"], o.posture["dropletsWithFirewall"]],
      [2, 1, 1],
    );
    const p = by(digitalocean, o);
    assertEquals(p["do-firewall"]?.status, "fail");
    assertStringIncludes(p["do-firewall"]?.fix ?? "", "Firewalls");
    assertEquals(p["do-backups"]?.status, "warn");
    assert(reads(calls));
  },
);

// ------------------------------------------------------------------ AWS, deeper

proves(
  ["088-wave3-registry FR-004"],
  "088: AWS: CloudTrail, GuardDuty, and Config; read actions only; Config denied is a gap",
  async () => {
    const calls: Array<Calls[number] & { target?: string }> = [];
    const xml: Record<string, string> = {
      "sts.amazonaws.com/?Action=GetCallerIdentity":
        "<GetCallerIdentityResponse><Account>111122223333</Account><Arn>arn:aws:iam::111122223333:user/stolos-read</Arn></GetCallerIdentityResponse>",
      "iam.amazonaws.com/?Action=GetAccountSummary":
        "<SummaryMap><entry><key>AccountMFAEnabled</key><value>1</value></entry><entry><key>AccountAccessKeysPresent</key><value>0</value></entry></SummaryMap>",
      "iam.amazonaws.com/?Action=ListUsers": "<Users></Users>",
      "s3.amazonaws.com/": "<Buckets></Buckets>",
      "111122223333.s3-control.us-east-1.amazonaws.com/":
        "<BlockPublicAcls>true</BlockPublicAcls><IgnorePublicAcls>true</IgnorePublicAcls><BlockPublicPolicy>true</BlockPublicPolicy><RestrictPublicBuckets>true</RestrictPublicBuckets>",
      "ec2.us-east-1.amazonaws.com/?Action=DescribeRegions":
        "<regionInfo><item><regionName>us-east-1</regionName></item></regionInfo>",
      "ec2.us-east-1.amazonaws.com/?Action=DescribeInstances": "<reservationSet></reservationSet>",
    };
    const json: Record<string, { status?: number; body: unknown }> = {
      "cloudtrail.us-east-1.amazonaws.com DescribeTrails": {
        body: {
          trailList: [
            {
              Name: "main",
              TrailARN: "arn:aws:cloudtrail:us-east-1:111122223333:trail/main",
              HomeRegion: "us-east-1",
              IsMultiRegionTrail: false,
              S3BucketName: "example-logs",
            },
          ],
        },
      },
      "cloudtrail.us-east-1.amazonaws.com GetTrailStatus": { body: { IsLogging: true } },
      "config.us-east-1.amazonaws.com DescribeConfigurationRecorderStatus": {
        status: 400,
        body: { __type: "AccessDeniedException" },
      },
      "guardduty.us-east-1.amazonaws.com/detector": { body: { detectorIds: ["d1"] } },
      "guardduty.us-east-1.amazonaws.com/detector/d1": { body: { status: "DISABLED" } },
    };
    const answer = (
      q: http.OutRequest,
      status: number,
      body: string,
    ): Promise<Result<http.Exchange, http.TransportError>> =>
      Promise.resolve({
        kind: "ok",
        value: { method: q.method, url: q.url, status, headers: {}, body },
      });
    const http: http.Transport = {
      kind: "recorded",
      send(q): Promise<Result<http.Exchange, http.TransportError>> {
        const u = new URL(q.url);
        const target = Object.entries(q.headers).find(
          ([k]) => k.toLowerCase() === "x-amz-target",
        )?.[1];
        calls.push({ method: q.method, url: q.url, ...(target ? { target } : {}) });
        if (target) {
          const f = json[`${u.host} ${target.split(".").pop() ?? ""}`] ?? { status: 404, body: {} };
          return answer(q, f.status ?? 200, JSON.stringify(f.body));
        }
        const known = json[`${u.host}${u.pathname}`];
        if (known) return answer(q, 200, JSON.stringify(known.body));
        const x = Object.keys(xml)
          .filter((p) => `${u.host}${u.pathname}${u.search}`.startsWith(p))
          .sort((a, b) => b.length - a.length)[0];
        const text = x === undefined ? undefined : xml[x];
        return text === undefined ? answer(q, 404, "") : answer(q, 200, text);
      },
    };
    const o = await aws.observe({ accessKeyId: "AKIDEXAMPLE", secretAccessKey: "s" }, http, NOW);
    assertEquals(
      o.records
        ?.filter((r) => r.label === "event_log")
        .map((r) => [r.display_name, r.props["logging"], r.props["multi_region"]]),
      [["main", true, false]],
    );
    assertEquals(
      o.records
        ?.filter((r) => r.label === "intrusion_detection_system")
        .map((r) => r.props["enabled"]),
      [false],
    );
    assert(
      o.gaps.some((g) => g.startsWith("AWS Config us-east-1")),
      o.gaps.join("; "),
    );
    const p = by(aws, o);
    assertEquals(p["aws-cloudtrail"]?.status, "pass");
    assertEquals(p["aws-cloudtrail-all-regions"]?.status, "fail");
    assertStringIncludes(p["aws-cloudtrail-all-regions"]?.fix ?? "", "all regions");
    assertEquals(p["aws-guardduty"]?.status, "warn");
    assertEquals(p["aws-config"], undefined, "not read: not reported");
    // Reads only: every POST is a Describe or Get action of CloudTrail or Config.
    for (const c of calls.filter((c) => c.method !== "GET")) {
      assert(/^(Describe|Get)/.test(c.target?.split(".").pop() ?? ""), c.target);
      assert(awsReadPost(c.url, { headers: { "X-Amz-Target": c.target ?? "" } }), c.url);
    }
    assertEquals(
      awsReadPost("https://cloudtrail.us-east-1.amazonaws.com/", {
        headers: {
          "x-amz-target": "com.amazonaws.cloudtrail.v20131101.CloudTrail_20131101.StopLogging",
        },
      }),
      false,
      "a write action is refused",
    );
    assertEquals(awsReadPost("https://iam.amazonaws.com/", { headers: {} }), false);
  },
);

// ------------------------------------------------------------------ Azure, deeper

proves(
  ["088-wave3-registry FR-004"],
  "088: Azure: Defender plans and the activity log's export per subscription; a denied one is a gap",
  async () => {
    const G = "graph.microsoft.com/v1.0";
    const M = "management.azure.com/subscriptions";
    const calls: Calls = [];
    const o = await microsoft.observe(
      { tenant: "t", clientId: "c", clientSecret: "s" },
      routes(
        {
          "login.microsoftonline.com/": { body: { access_token: "x" } },
          [`${G}/organization`]: { body: { value: [{ id: "o", displayName: "Example Co" }] } },
          [`${G}/domains`]: { body: { value: [] } },
          [`${G}/users`]: { body: { value: [] } },
          [`${G}/subscribedSkus`]: { body: { value: [] } },
          [`${G}/directoryRoles`]: { body: { value: [] } },
          [`${G}/reports/authenticationMethods/userRegistrationDetails`]: { body: { value: [] } },
          [`${G}/policies/identitySecurityDefaultsEnforcementPolicy`]: {
            body: { isEnabled: true },
          },
          [`${G}/identity/conditionalAccess/policies`]: { body: { value: [] } },
          [`${G}/servicePrincipals`]: { body: { value: [] } },
          [`${M}?`]: {
            body: {
              value: [
                { subscriptionId: "s1", displayName: "Prod", state: "Enabled" },
                { subscriptionId: "s2", displayName: "Dev", state: "Enabled" },
              ],
            },
          },
          [`${M}/s1/resources`]: { body: { value: [] } },
          [`${M}/s2/resources`]: { body: { value: [] } },
          [`${M}/s1/providers/Microsoft.Security/pricings`]: {
            body: {
              value: [
                { name: "VirtualMachines", properties: { pricingTier: "Standard" } },
                { name: "StorageAccounts", properties: { pricingTier: "Free" } },
              ],
            },
          },
          [`${M}/s2/providers/Microsoft.Security/pricings`]: {
            body: { value: [{ name: "VirtualMachines", properties: { pricingTier: "Free" } }] },
          },
          [`${M}/s1/providers/Microsoft.Insights/diagnosticSettings`]: {
            body: {
              value: [
                {
                  name: "to-law",
                  properties: {
                    workspaceId:
                      "/subscriptions/s1/resourceGroups/rg/providers/Microsoft.OperationalInsights/workspaces/law1",
                    logs: [{ category: "Administrative", enabled: true }],
                  },
                },
              ],
            },
          },
          [`${M}/s2/providers/Microsoft.Insights/diagnosticSettings`]: DENIED,
        },
        calls,
      ),
      NOW,
    );
    assertEquals(
      o.records
        ?.filter((r) => r.label === "intrusion_detection_system")
        .map((r) => [r.display_name, r.props["enabled"]]),
      [
        ["Defender for VirtualMachines (Prod)", true],
        ["Defender for StorageAccounts (Prod)", false],
        ["Defender for VirtualMachines (Dev)", false],
      ],
    );
    assertEquals(
      o.records
        ?.filter((r) => r.label === "event_log")
        .map((r) => [r.display_name, r.props["destination"]]),
      [["Activity log (Prod)", "law1"]],
    );
    assert(o.gaps.some((g) => g.startsWith("activity log Dev")));
    const p = by(microsoft, o);
    assertEquals(p["az-defender"]?.status, "warn");
    assertStringIncludes(p["az-defender"]?.detail ?? "", "Dev");
    assertEquals(p["az-activity-log"]?.status, "pass", "only the readable subscription is judged");
    assert(reads(calls, [/login\.microsoftonline\.com/]));
  },
);

// ------------------------------------------------------------------ POA&M and OCSF

proves(
  ["088-wave3-registry FR-002"],
  "088: open vulnerabilities are POA&M items (valid OSCAL 1.2.3) and OCSF Vulnerability Findings (valid 1.9.0)",
  async () => {
    const o: Observation = {
      at: NOW.toISOString(),
      provider: "snyk",
      account: "o1",
      assets: [],
      posture: {},
      gaps: [],
      records: [
        {
          label: "vulnerability",
          ocsf_class_uid: 2002,
          native_id: "i1",
          display_name: "CVE-2021-23337",
          props: {
            cve: "CVE-2021-23337",
            title: "Command injection in lodash",
            severity: "high",
            status: "open",
            asset: "ex/app",
            package: "lodash@4.17.20",
            first_seen: "2026-10-01T00:00:00Z",
            fix_available: true,
          },
        },
        {
          label: "vulnerability",
          ocsf_class_uid: 2002,
          native_id: "i0",
          display_name: "old",
          props: { title: "fixed already", severity: "critical", status: "fixed", asset: "ex/app" },
        },
      ],
    };
    const vulns = openVulnerabilities([o]);
    assertEquals(
      vulns.map((v) => [v.cve, v.severity, v.asset]),
      [["CVE-2021-23337", "high", "ex/app"]],
    );
    const schema = await vendored("vendor/oscal/oscal_complete_schema-1.2.3.json");
    const validate = new Ajv({ strict: false, logger: false, allErrors: true }).compile(schema);
    const catalog = {
      format: 1,
      version: "2026.3",
      controls: Object.fromEntries(
        SCF.map((c) => [
          c.id,
          {
            domain: "",
            name: c.name,
            description: "",
            maps: {
              soc2: [],
              hipaa: [],
              pci: [],
              cmmc: [],
              nist80053: c.id === "VPM-06" ? ["SI-02"] : [],
              nist800171: [],
              fedramp: [],
            },
          },
        ]),
      ),
    } as unknown as ScfCatalog;
    const docs = await oscalExports({
      view: complianceView(fleetEvidence(FACTS), catalog),
      fleet: FACTS.fleet,
      machines: FACTS.machines,
      version: "0.0.0",
      now: NOW,
      vulnerabilities: vulns,
    });
    const poam = docs["poam.json"] as Record<string, Record<string, unknown>>;
    assert(validate(poam), JSON.stringify(validate.errors?.slice(0, 3)));
    const plan = poam["plan-of-action-and-milestones"] ?? {};
    const items = plan["poam-items"] as Array<{
      title: string;
      props: Array<{ name: string; value: string }>;
    }>;
    const item = items.find((i) => i.title.startsWith("Vulnerability: "));
    assertExists(item);
    assertEquals(item.title, "Vulnerability: CVE-2021-23337 on ex/app");
    const prop = (n: string) => item.props.find((p) => p.name === n)?.value;
    assertEquals(
      [prop("vulnerability-id"), prop("severity"), prop("asset")],
      ["CVE-2021-23337", "high", "ex/app"],
    );
    const risk = (plan["risks"] as Array<{ title: string; status: string }>).find((r) =>
      r.title.startsWith("CVE-2021-23337"),
    );
    assertExists(risk);
    assertEquals(risk.status, "open");
    // OCSF: the estate's vulnerability nodes are 2002 events, valid against OCSF 1.9.0's schema.
    const events = estateEvents(
      fixtureEstate({ sources: [{ connector: "snyk", observation: o }] }, NOW),
      { fleet: "lab", now: NOW },
    ).filter((e) => e.class_uid === 2002);
    assertEquals(events.length, 2);
    const ocsf = new Ajv({ strict: false, logger: false, allErrors: true }).compile(
      await vendored("vendor/ocsf/1.9.0/vulnerability_finding.schema.json"),
    );
    for (const e of events) assert(ocsf(e), JSON.stringify(ocsf.errors?.slice(0, 3)));
    const open = events.find((e) => "vulnerabilities" in e && e.status_id === 1);
    assertExists(open);
    assert("vulnerabilities" in open);
    assertEquals(open.vulnerabilities[0]?.cve?.uid, "CVE-2021-23337");
    assertEquals(open.severity_id, 4);
    assertEquals(open.vulnerabilities[0]?.affected_packages?.[0], {
      name: "lodash",
      version: "4.17.20",
    });
  },
);
