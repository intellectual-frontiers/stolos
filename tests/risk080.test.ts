/**
 * Spec 080: the risk register and the vendor inventory as code: typed files, controls on the SDK
 * (an overdue review fails, an expired acceptance fails, a new SSO vendor waits for triage), the
 * OSCAL POA&M carrying the register, vendor discovery from SSO apps, DNS, and tenants, and review
 * through signed pull requests.
 *
 * @module
 */
import { fs, proc } from "@intellectual-frontiers/ifc-ts/runtime";
import {
  assert,
  assertEquals,
  assertExists,
  assertStringIncludes,
  proves,
} from "@intellectual-frontiers/ifc-ts/runtime/test";
import { Ajv, type AnySchema } from "ajv";
import type { http } from "@intellectual-frontiers/ifc-ts/runtime";
import type { Observation } from "../src/archon/connect/connector.ts";
import { okta } from "../src/archon/connect/okta.ts";
import { microsoft } from "../src/archon/connect/microsoft.ts";
import { CONNECTOR_LABELS } from "../src/archon/connect/labels.ts";
import { buildGraph, type Estate, estateQuery } from "../src/archon/estate/graph.ts";
import { ESTATE_SCHEMA } from "../src/archon/estate/schema.ts";
import { schemaProblems } from "../src/archon/schema/define.ts";
import { isScfId, SCF } from "../src/archon/compliance/scf.ts";
import { complianceView, fleetEvidence } from "../src/archon/compliance/report.ts";
import { oscalExports } from "../src/archon/compliance/oscal.ts";
import type { ScfCatalog } from "../src/archon/compliance/catalog.ts";
import {
  defineRisks,
  loadRisks,
  type Risk,
  type RiskDef,
  riskLevel,
  riskProblems,
} from "../src/archon/risk/register.ts";
import {
  defineVendors,
  discoverVendors,
  loadVendors,
  needsTriage,
  registrable,
  type VendorDef,
  vendorProblems,
} from "../src/archon/risk/vendors.ts";
import { RISK_SCHEMA } from "../src/archon/risk/schema.ts";
import { RISK_PACK, runRiskPack, type ScopedAcceptance } from "../src/archon/risk/controls.ts";
import {
  appendVendors,
  approvalOf,
  openReview,
  type ReviewRunner,
  setNextReview,
} from "../src/archon/risk/review.ts";
import { COMMANDS } from "../src/archon/commands/registry.ts";
import { STOLOS_GROUPS } from "../src/archon/console/stolos-pages.ts";
import { GUIDES } from "../src/archon/core/guides.ts";
import { FACTS } from "./console/serve-stolos.ts";

const NOW = new Date("2026-11-15T12:00:00Z");
const AT = "2026-11-15T12:00:00Z";

const risk = (o: Partial<RiskDef> = {}): RiskDef => ({
  id: "laptop-theft",
  title: "A laptop is stolen",
  description: "Laptops travel.",
  likelihood: "moderate",
  impact: "high",
  owner: "alice@example.org",
  treatment: "mitigate",
  scf: ["CRY-07"],
  nextReview: "2027-01-01",
  ...o,
});
const withLevel = (r: RiskDef): Risk => ({
  ...r,
  level: riskLevel(r.likelihood, r.impact),
  status: r.status ?? "open",
});

/** An observation: Okta (people, SSO apps), Cloudflare (a zone and DNS records). */
function obs(provider: string, account: string, o: Partial<Observation> = {}): Observation {
  return { at: AT, provider, account, assets: [], posture: {}, gaps: [], ...o };
}
const app = (id: string, name: string, catalog?: string) => ({
  label: "application",
  ocsf_class_uid: 5023,
  native_id: id,
  display_name: name,
  props: { active: true, ...(catalog ? { catalog_name: catalog } : {}) },
});
const dns = (id: string, name: string, type: string, content: string) => ({
  label: "dns_record",
  ocsf_class_uid: 5023,
  native_id: id,
  display_name: name,
  props: { type, content, proxied: false },
});

function estate(apps = [app("a1", "Salesforce.com", "salesforce")]): Estate {
  return buildGraph(
    {
      fleet: "lab",
      machines: [],
      links: {},
      sources: [
        {
          connector: "okta",
          observation: obs("okta", "example.okta.com", {
            entities: {
              accounts: [
                {
                  system: "okta",
                  id: "u1",
                  name: "alice@example.org",
                  email: "alice@example.org",
                  active: true,
                },
                {
                  system: "okta",
                  id: "u2",
                  name: "bob@example.org",
                  email: "bob@example.org",
                  active: false,
                },
              ],
            },
            records: apps,
          }),
        },
        {
          connector: "cloudflare",
          observation: obs("cloudflare", "Lab", {
            records: [
              {
                label: "domain_name",
                ocsf_class_uid: 5023,
                native_id: "z1",
                display_name: "lab.example.net",
                props: {},
              },
              dns("r1", "lab.example.net", "MX", "10 aspmx.l.google.com"),
              dns("r2", "status.lab.example.net", "CNAME", "lab.statushost.example"),
              dns("r3", "www.lab.example.net", "CNAME", "lab.example.net"),
              dns("r4", "mail.lab.example.net", "CNAME", "in.mailhost.example."),
              dns("r5", "lab.example.net", "A", "192.0.2.10"),
            ],
          }),
        },
      ],
    },
    { now: NOW, fleetTitle: "Lab" },
  );
}

const TRIAGE: VendorDef[] = [
  { id: "okta", name: "Okta", criticality: "high", data: ["Personal", "Security"] },
  { id: "cloudflare", name: "Cloudflare", criticality: "high", data: ["Business"] },
  { id: "google", name: "Google", criticality: "high", data: ["Personal", "Business"] },
  {
    id: "mailhost",
    name: "Mailhost",
    criticality: "moderate",
    data: ["Business"],
    domains: ["mailhost.example"],
  },
  {
    id: "statushost-example",
    name: "statushost.example",
    criticality: "low",
    data: [],
  },
];

const result = async (o: {
  risks?: RiskDef[];
  triage?: VendorDef[];
  acceptances?: ScopedAcceptance[];
  apps?: ReturnType<typeof app>[];
}) => {
  const e = estate(o.apps);
  const vendors = discoverVendors(e, { triage: o.triage ?? TRIAGE });
  const run = await runRiskPack({
    estate: e,
    ...(o.risks ? { risks: o.risks.map(withLevel) } : {}),
    vendors,
    acceptances: o.acceptances ?? [],
    now: NOW,
  });
  return {
    e,
    vendors,
    by: Object.fromEntries(run.results.map((r) => [r.control, r])),
  };
};

proves(
  ["080-risks-vendors FR-001"],
  "080: the register is typed; SP 800-30 levels; problems are named",
  async () => {
    // The example lab's files load, typed.
    const lab = await loadRisks("examples/fleets/lab/risks.ts");
    assertEquals(
      got(lab).map((r) => [r.id, r.level]),
      [
        ["laptop-theft", "moderate"],
        ["dns-provider-outage", "low"],
      ],
    );
    assertEquals((await loadVendors("examples/fleets/lab/vendors.ts")).length, 2);
    assertEquals(await loadRisks("examples/fleets/lab/no-such.ts"), undefined);
    // SP 800-30 Rev 1 Table I-2.
    assertEquals(riskLevel("very-high", "very-high"), "very-high");
    assertEquals(riskLevel("moderate", "high"), "moderate");
    assertEquals(riskLevel("low", "very-high"), "moderate");
    assertEquals(riskLevel("very-low", "high"), "low");
    assertEquals(riskLevel("high", "very-low"), "very-low");
    // Wrong values fail type checking (and at definition).
    // @ts-expect-error: not an SCF control Stolos knows
    assert(riskProblems([risk({ scf: ["XYZ-99"] })]).some((p) => p.includes("XYZ-99")));
    // @ts-expect-error: not on SP 800-30's scale
    assert(riskProblems([risk({ likelihood: "likely" })]).some((p) => p.includes("likelihood")));
    // @ts-expect-error: not a standard risk response
    assert(riskProblems([risk({ treatment: "ignore" })]).some((p) => p.includes("treatment")));
    assert(riskProblems([risk({ owner: "alice" })]).some((p) => p.includes("owner")));
    assert(
      riskProblems([risk({ nextReview: "2027-02-30" })]).some((p) => p.includes("nextReview")),
    );
    assert(riskProblems([risk(), risk()]).some((p) => p.includes("two risks")));
    let threw = false;
    try {
      defineRisks([risk({ id: "Bad Id" })]);
    } catch {
      threw = true;
    }
    assert(threw, "defineRisks checks at definition");
    assert(
      // @ts-expect-error: not an OCSF data category
      vendorProblems([{ id: "x", name: "X", criticality: "low", data: ["Secrets"] }]).some((p) =>
        p.includes("Secrets"),
      ),
    );
    assertEquals(
      defineVendors([{ id: "x", name: "X", criticality: "low", data: ["Business"] }]).length,
      1,
    );
  },
);

proves(
  ["080-risks-vendors FR-004"],
  "080: an overdue review fails; an on-time one passes; an empty register warns",
  async () => {
    const overdue = await result({ risks: [risk({ nextReview: "2026-11-01" })] });
    assertEquals(overdue.by["review-due"]?.status, "fail");
    assertStringIncludes(got(overdue.by["review-due"]?.detail), "laptop-theft (due 2026-11-01");
    assertEquals(overdue.by["review-due"]?.id, "risk-register/review-due");
    assertEquals(overdue.by["review-due"]?.scf, ["RSK-14", "RSK-13.2"]);
    assertEquals((await result({ risks: [risk()] })).by["review-due"]?.status, "pass");
    assertEquals((await result({ risks: [] })).by["review-due"]?.status, "warn");
    // A closed risk is not reviewed.
    assertEquals(
      (await result({ risks: [risk({ nextReview: "2026-01-01", status: "closed" })] })).by[
        "review-due"
      ]?.status,
      "warn",
    );
    // The register is in the estate: SQL can ask it.
    const { e } = overdue;
    assertEquals(estateQuery(e, "SELECT risk_uid, level FROM risk"), [
      { risk_uid: "laptop-theft", level: "moderate" },
    ]);
  },
);

proves(["080-risks-vendors FR-004"], "080: an owner not active on the roster warns", async () => {
  const r = await result({
    risks: [
      risk(),
      risk({ id: "b", owner: "bob@example.org" }),
      risk({ id: "c", owner: "carol@example.org" }),
    ],
  });
  assertEquals(r.by["owner-on-roster"]?.status, "warn");
  assertStringIncludes(got(r.by["owner-on-roster"]?.detail), "b (bob@example.org)");
  assertStringIncludes(got(r.by["owner-on-roster"]?.detail), "c (carol@example.org)");
  assertEquals((await result({ risks: [risk()] })).by["owner-on-roster"]?.status, "pass");
});

proves(
  ["080-risks-vendors FR-002", "080-risks-vendors FR-004"],
  "080: an accepted risk past its date fails; one not in the register warns",
  async () => {
    const acc = (policy: string, until: string, scope = "fleet"): ScopedAcceptance => ({
      policy,
      reason: "a reason",
      by: "alice",
      until,
      scope,
    });
    const expired = await result({
      risks: [risk({ accepted: ["baseline/few-admins"] })],
      acceptances: [acc("baseline/few-admins", "2026-10-31")],
    });
    assertEquals(expired.by["accepted-current"]?.status, "fail");
    assertStringIncludes(got(expired.by["accepted-current"]?.detail), "ended 2026-10-31");
    const fine = await result({
      risks: [risk({ accepted: ["baseline/few-admins", "alice-mbp:firewall"] })],
      acceptances: [
        acc("baseline/few-admins", "2027-01-31"),
        acc("firewall", "2027-01-31", "alice-mbp"),
      ],
    });
    assertEquals(fine.by["accepted-current"]?.status, "pass");
    const loose = await result({
      risks: [risk({ accepted: ["nowhere/none"] })],
      acceptances: [acc("baseline/few-admins", "2027-01-31")],
    });
    assertEquals(loose.by["accepted-current"]?.status, "warn");
    assertStringIncludes(got(loose.by["accepted-current"]?.detail), "not in the register");
    assertStringIncludes(got(loose.by["accepted-current"]?.detail), "laptop-theft -> nowhere/none");
    // No acceptances and no links: the control does not apply.
    assertEquals((await result({ risks: [risk()] })).by["accepted-current"], undefined);
  },
);

proves(
  ["080-risks-vendors FR-005"],
  "080: vendors are discovered from SSO apps, DNS records, and connected accounts",
  async () => {
    const e = estate([
      app("a1", "Salesforce.com", "salesforce"),
      app("a2", "Zoom", "zoomus"),
      app("a3", "Acme Expenses", "examplecorp_acmeexpenses_1"),
    ]);
    const v = discoverVendors(e, { triage: TRIAGE });
    const by = Object.fromEntries(v.map((x) => [x.id, x]));
    // Tenants: each connector is a vendor.
    assertEquals(
      by["okta"]?.seen.map((s) => s.kind),
      ["tenant"],
    );
    assertEquals(
      by["cloudflare"]?.seen.map((s) => s.kind),
      ["tenant"],
    );
    // SSO apps: known by catalog name; unknown ones named by their app.
    assertEquals(by["salesforce"]?.seen[0]?.kind, "sso");
    assert(by["salesforce"]?.known);
    assertEquals(by["zoom"]?.name, "Zoom");
    assertEquals(by["acme-expenses"]?.known, false);
    // DNS: MX to a known provider; CNAME to a domain vendors.ts claims; CNAME to an unknown domain.
    assertEquals(by["google"]?.seen[0]?.detail, "MX lab.example.net -> aspmx.l.google.com");
    assertEquals(by["mailhost"]?.seen[0]?.kind, "dns");
    assertEquals(by["statushost-example"]?.seen[0]?.uid, "cloudflare:Lab:r2");
    // A record inside the fleet's own zones, and an A record, reveal no vendor.
    assert(
      !v.some((x) => x.seen.some((s) => s.uid === "cloudflare:Lab:r3" || s.uid.endsWith(":r5"))),
    );
    assertEquals(registrable("in.mailhost.example."), "mailhost.example");
    assertEquals(registrable("mx.example.co.uk"), "example.co.uk");
    // Billing: the hook.
    const billed = discoverVendors(e, {
      triage: TRIAGE,
      billed: [{ name: "Acme Payroll", account: "ledger-1", source: "books" }],
    });
    assertEquals(
      billed.find((x) => x.id === "acme-payroll")?.seen[0]?.uid,
      "billing:books:ledger-1",
    );
    // In the estate: organization parties, party_role supplier, supplies edges.
    await runRiskPack({ estate: e, vendors: v, now: NOW });
    const rows = estateQuery(
      e,
      `SELECT o.name, r.role_type, count(x.dst_uid) AS n FROM organization o
     JOIN party_role r ON r.party_uid = o.party_uid
     JOIN edge x ON x.src_uid = o.party_uid AND x.verb = 'supplies'
     WHERE o.party_uid = 'organization:vendor:salesforce' GROUP BY o.name, r.role_type`,
    );
    assertEquals(rows, [{ name: "Salesforce", role_type: "supplier", n: 1 }]);
    assertEquals(
      estateQuery(
        e,
        "SELECT criticality FROM data_classification WHERE party_uid = 'organization:vendor:okta'",
      ),
      [{ criticality: "high" }],
    );
  },
);

proves(
  ["080-risks-vendors FR-004", "080-risks-vendors FR-006"],
  "080: a new SSO vendor appears for triage, and the control warns until vendors.ts has it",
  async () => {
    const before = await result({ triage: TRIAGE });
    assertEquals(before.by["vendors-triaged"]?.status, "warn");
    assertStringIncludes(got(before.by["vendors-triaged"]?.detail), "Salesforce");
    assertEquals(before.by["vendors-triaged"]?.scf, ["TPM-08", "TPM-09"]);
    assertEquals(
      before.vendors.filter(needsTriage).map((v) => v.id),
      ["salesforce"],
    );
    // Triage proposes it as unassessed: still waiting.
    const proposed = await result({
      triage: [
        ...TRIAGE,
        {
          id: "salesforce",
          name: "Salesforce",
          criticality: "unassessed",
          data: [],
        },
      ],
    });
    assertEquals(proposed.by["vendors-triaged"]?.status, "warn");
    const after = await result({
      triage: [
        ...TRIAGE,
        {
          id: "salesforce",
          name: "Salesforce",
          criticality: "high",
          data: ["Personal", "Financial"],
        },
      ],
    });
    assertEquals(after.by["vendors-triaged"]?.status, "pass");
    assertEquals(after.vendors.filter(needsTriage), []);
  },
);

proves(
  ["080-risks-vendors FR-005"],
  "080: Okta and Entra list SSO applications; their other outputs are unchanged",
  async () => {
    const fake = (routes: Record<string, unknown>): http.Transport => ({
      kind: "recorded",
      send: (r) => {
        const u = new URL(r.url);
        const key = Object.keys(routes)
          .filter((k) => `${u.host}${u.pathname}${u.search}`.startsWith(k))
          .sort((a, b) => b.length - a.length)[0];
        const answer =
          key === undefined
            ? { status: 404, body: "{}" }
            : { status: 200, body: JSON.stringify(routes[key]) };
        return Promise.resolve({
          kind: "ok" as const,
          value: { method: r.method, url: r.url, headers: {}, ...answer },
        });
      },
    });
    const D = "example.okta.com";
    const o = await okta.observe(
      { domain: D, token: "t" },
      fake({
        [`${D}/api/v1/users?limit=200`]: [
          {
            id: "u1",
            status: "ACTIVE",
            profile: { login: "alice@example.org", email: "alice@example.org" },
          },
        ],
        [`${D}/api/v1/iam/assignees/users`]: [],
        [`${D}/api/v1/users/u1/factors`]: [{ status: "ACTIVE" }],
        [`${D}/api/v1/apps`]: [
          {
            id: "a1",
            name: "salesforce",
            label: "Salesforce.com",
            status: "ACTIVE",
            signOnMode: "SAML_2_0",
          },
          { id: "a2", name: "okta_enduser", label: "Okta Dashboard", status: "ACTIVE" },
          { id: "a3", name: "saasure", label: "Okta Admin Console", status: "ACTIVE" },
        ],
      }),
      NOW,
    );
    assertEquals(
      got(o.records).map((r) => [r.label, r.display_name, r.props["catalog_name"]]),
      [["application", "Salesforce.com", "salesforce"]],
    );
    assertEquals(o.posture["activeUsers"], 1, "apps are not users");
    assertEquals(got(got(o.entities).accounts).length, 1);

    const G = "graph.microsoft.com/v1.0";
    const m = await microsoft.observe(
      { tenant: "t", clientId: "c", clientSecret: "s" },
      fake({
        "login.microsoftonline.com/": { access_token: "x" },
        [`${G}/organization`]: { value: [{ id: "own-tenant", displayName: "Example Co" }] },
        [`${G}/domains`]: { value: [] },
        [`${G}/users`]: { value: [] },
        [`${G}/subscribedSkus`]: { value: [] },
        [`${G}/directoryRoles`]: { value: [] },
        [`${G}/reports/authenticationMethods/userRegistrationDetails`]: { value: [] },
        [`${G}/policies/identitySecurityDefaultsEnforcementPolicy`]: { isEnabled: true },
        [`${G}/identity/conditionalAccess/policies`]: { value: [] },
        [`${G}/servicePrincipals`]: {
          value: [
            {
              id: "sp1",
              displayName: "Slack",
              appOwnerOrganizationId: "vendor-tenant",
              servicePrincipalType: "Application",
              preferredSingleSignOnMode: "saml",
            },
            {
              id: "sp2",
              displayName: "Microsoft Graph",
              appOwnerOrganizationId: "f8cdef31-a31e-4b4a-93e4-5f571e91255a",
              servicePrincipalType: "Application",
            },
            {
              id: "sp3",
              displayName: "stolos-read",
              appOwnerOrganizationId: "own-tenant",
              servicePrincipalType: "Application",
            },
            {
              id: "sp4",
              displayName: "a managed identity",
              servicePrincipalType: "ManagedIdentity",
            },
          ],
        },
        "management.azure.com/subscriptions?": { value: [] },
      }),
      NOW,
    );
    assertEquals(
      got(m.records)
        .filter((r) => r.label === "application")
        .map((r) => [r.display_name, r.props["sign_on_mode"]]),
      [["Slack", "saml"]],
    );
  },
);

proves(
  ["080-risks-vendors FR-009"],
  "080: the POA&M carries the register's open risks, valid OSCAL 1.2.3",
  async () => {
    const schema = JSON.parse(
      await fs.readTextFile(
        new URL("../vendor/oscal/oscal_complete_schema-1.2.3.json", import.meta.url),
      ),
    ) as AnySchema;
    const validate = new Ajv({ strict: false, logger: false, allErrors: true }).compile(schema);
    const catalog: ScfCatalog = {
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
              nist80053: c.id === "CRY-07" ? ["SC-28"] : [],
              nist800171: [],
              fedramp: [],
            },
          },
        ]),
      ),
    };
    const docs = await oscalExports({
      view: complianceView(fleetEvidence(FACTS), catalog),
      fleet: FACTS.fleet,
      machines: FACTS.machines,
      version: "0.0.0",
      now: NOW,
      register: [
        withLevel(risk()),
        withLevel(risk({ id: "outage", title: "An outage", treatment: "accept" })),
        withLevel(risk({ id: "gone", title: "A closed risk", status: "closed" })),
      ],
    });
    for (const [name, doc] of Object.entries(docs)) {
      assert(validate(doc), `${name}: ${JSON.stringify(validate.errors?.slice(0, 3), null, 1)}`);
    }
    type Doc = Record<string, Record<string, unknown>>;
    const p = (docs["poam.json"] as Doc)["plan-of-action-and-milestones"];
    const risks = p?.["risks"] as Array<{
      title: string;
      status: string;
      characterizations: Array<{ facets: Array<{ name: string; value: string }> }>;
    }>;
    const laptop = got(risks.find((r) => r.title === "A laptop is stolen"));
    assertEquals(laptop.status, "remediating");
    assertEquals(
      laptop.characterizations[0]?.facets.map((f) => [f.name, f.value]),
      [
        ["likelihood", "moderate"],
        ["impact", "high"],
        ["risk", "moderate"],
      ],
    );
    assertEquals(got(risks.find((r) => r.title === "An outage")).status, "deviation-approved");
    assert(!risks.some((r) => r.title === "A closed risk"), "closed risks are left out");
    const items = p?.["poam-items"] as Array<{ title: string }>;
    assert(items.some((i) => i.title === "Risk register: A laptop is stolen"));
  },
);

proves(
  ["080-risks-vendors FR-003", "080-risks-vendors FR-008", "080-risks-vendors FR-010"],
  "080: names cite standards; SCF ids are confirmed; commands, groups, and the guide",
  () => {
    assertEquals(schemaProblems(RISK_SCHEMA), []);
    assertEquals(schemaProblems([...ESTATE_SCHEMA, ...RISK_SCHEMA]), []);
    assertEquals(schemaProblems(CONNECTOR_LABELS), []);
    for (const id of ["RSK-11", "RSK-13.2", "RSK-14", "RSK-16.1", "TPM-08", "TPM-09"]) {
      assert(isScfId(id), id);
    }
    for (const c of RISK_PACK.controls) assert(c.scf.every(isScfId), c.id);
    const names = COMMANDS.map((c) => c.name);
    for (const n of [
      "risks list",
      "risks check",
      "risks review",
      "vendors list",
      "vendors triage",
    ]) {
      assert(names.includes(n), n);
    }
    const by = (n: string) => got(COMMANDS.find((c) => c.name === n));
    assert(
      by("risks review").noMcp && by("vendors triage").noMcp,
      "the writing ones are terminal only",
    );
    assertEquals(by("risks list").aliases, ["risks"]);
    for (const n of ["risks list", "risks check", "vendors list"]) {
      assert(
        STOLOS_GROUPS.some((g) => g.names.includes(n)),
        `${n} has a console group`,
      );
    }
    assert(GUIDES.some((g) => g.name === "risks" && g.module === "src/archon/risk/mod.ts"));
  },
);

proves(
  ["080-risks-vendors FR-007"],
  "080: review edits the right risk; triage appends loadable entries",
  async () => {
    const src = await fs.readTextFile("examples/fleets/lab/risks.ts");
    const out = setNextReview(src, "dns-provider-outage", "2028-05-01");
    assertStringIncludes(out, '"2028-05-01"');
    assertEquals(out.split("2027-11-01").length, 2, "the other risk's date is unchanged");
    let threw = "";
    try {
      setNextReview(src, "nope", "2028-01-01");
    } catch (e) {
      threw = (e as Error).message;
    }
    assertStringIncludes(threw, 'no risk with id "nope"');
    // vendors.ts gains entries that still load (criticality unassessed until a person sets it).
    const v = discoverVendors(estate(), { triage: TRIAGE }).filter((x) => !x.triage);
    const dir = await fs.makeTempDir({ dir: ".", prefix: ".risk080-" });
    try {
      for (const [name, base] of [
        ["a.ts", await fs.readTextFile("examples/fleets/lab/vendors.ts")],
        ["b.ts", undefined],
      ] as const) {
        const f = `${dir}/${name}`;
        await fs.writeTextFile(f, appendVendors(base, v));
        const loaded = await loadVendors(f);
        const s = got(loaded.find((x) => x.id === "salesforce"));
        assertEquals([s.criticality, s.data.length], ["unassessed", 0]);
      }
    } finally {
      await fs.remove(dir, { recursive: true });
    }
  },
);

proves(
  ["080-risks-vendors FR-007"],
  "080: a review is a branch, one signed commit, a push, and a pull request",
  async () => {
    const repo = await fs.makeTempDir();
    try {
      await fs.mkdir(`${repo}/fleets/lab`, { recursive: true });
      await fs.writeTextFile(`${repo}/fleets/lab/risks.ts`, 'id: "a", nextReview: "2026-01-01"');
      const calls: string[] = [];
      const r: ReviewRunner = {
        run(argv) {
          calls.push(argv.join(" "));
          const out =
            argv[1] === "rev-parse"
              ? "main"
              : argv[1] === "symbolic-ref"
                ? "origin/main"
                : argv[0] === "gh"
                  ? "https://github.com/example/fleet/pull/7"
                  : "";
          return Promise.resolve({ ok: true, stdout: out, stderr: "" });
        },
        interactive(argv) {
          calls.push(argv.join(" "));
          return Promise.resolve(true);
        },
      };
      const res = await openReview(
        repo,
        {
          branch: "risks/review-a-2026-11-15",
          message: "lab: review risk a",
          body: "b",
          edit: async (read) => ({
            "fleets/lab/risks.ts": setNextReview(
              got(await read("fleets/lab/risks.ts")),
              "a",
              "2027-02-13",
            ),
          }),
        },
        r,
      );
      assert(res.ok, res.steps.join("; "));
      assertEquals(res.url, "https://github.com/example/fleet/pull/7");
      assertStringIncludes(await fs.readTextFile(`${repo}/fleets/lab/risks.ts`), "2027-02-13");
      const order = [
        "git switch -q -c risks/review-a-2026-11-15 origin/main",
        "git commit -q -S -m lab: review risk a",
        "git push -q -u origin HEAD:risks/review-a-2026-11-15",
        "gh pr create --base main --head risks/review-a-2026-11-15",
        "git switch -q main",
      ].map((x) => calls.findIndex((c) => c.startsWith(x)));
      assert(
        order.every((i, k) => i >= 0 && (k === 0 || i > (order[k - 1] ?? -1))),
        calls.join("\n"),
      );
      assert(!calls.some((c) => /merge/.test(c)), "nothing is merged for the reviewer");
    } finally {
      await fs.remove(repo, { recursive: true });
    }
  },
);

const hasSsh = proc.which("ssh-keygen") !== undefined;

proves(
  ["080-risks-vendors FR-007"],
  "080: approval is a fleet signer's signed merge commit (git verify-commit against signers.ts)",
  async () => {
    const dir = await fs.makeTempDir();
    const sh = async (...a: string[]): Promise<string> => {
      const r = await proc.run(a, { cwd: dir, stdin: "null" });
      if (r.code !== 0) throw new Error(`${a.join(" ")}: ${r.stderr}`);
      return r.stdout.trim();
    };
    try {
      await sh("ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-C", "", "-f", `${dir}/alice`);
      const pub = (await fs.readTextFile(`${dir}/alice.pub`))
        .trim()
        .split(" ")
        .slice(0, 2)
        .join(" ");
      const allowed = `alice namespaces="git" ${pub}\n`;
      const signed = [
        "-c",
        "gpg.format=ssh",
        "-c",
        "gpg.ssh.program=ssh-keygen",
        "-c",
        `user.signingkey=${dir}/alice`,
      ];
      await sh("git", "init", "-q", "-b", "main");
      await sh("git", "config", "user.email", "test@example.invalid");
      await sh("git", "config", "user.name", "test");
      await fs.mkdir(`${dir}/fleets/lab`, { recursive: true });
      await fs.writeTextFile(`${dir}/fleets/lab/risks.ts`, "1");
      await sh("git", "add", "-A");
      await sh("git", ...signed, "commit", "-q", "-S", "-m", "first");
      // A review branch, unsigned, merged with a signed merge commit.
      await sh("git", "switch", "-q", "-c", "review");
      await fs.writeTextFile(`${dir}/fleets/lab/risks.ts`, "2");
      await sh("git", "commit", "-q", "--no-gpg-sign", "-am", "review");
      await sh("git", "switch", "-q", "main");
      await sh("git", ...signed, "merge", "-q", "--no-ff", "-S", "-m", "merge review", "review");
      const a = await approvalOf(dir, "fleets/lab/risks.ts", allowed);
      assertEquals(a.signer, "alice");
      assertEquals(a.commit, await sh("git", "rev-parse", "HEAD"));
      // An unsigned merge (GitHub's website): approved by the next signed commit.
      await sh("git", "switch", "-q", "-c", "review2");
      await fs.writeTextFile(`${dir}/fleets/lab/risks.ts`, "3");
      await sh("git", "commit", "-q", "--no-gpg-sign", "-am", "review 2");
      await sh("git", "switch", "-q", "main");
      await sh("git", "merge", "-q", "--no-ff", "--no-gpg-sign", "-m", "merge 2", "review2");
      const merge = await sh("git", "rev-parse", "HEAD");
      const pending = await approvalOf(dir, "fleets/lab/risks.ts", allowed);
      assertEquals([pending.commit, pending.signer, !!pending.reason], [merge, undefined, true]);
      await fs.writeTextFile(`${dir}/other.txt`, "x");
      await sh("git", "add", "-A");
      await sh("git", ...signed, "commit", "-q", "-S", "-m", "approve");
      const later = await approvalOf(dir, "fleets/lab/risks.ts", allowed);
      assertEquals(later.approvedBy?.signer, "alice");
    } finally {
      await fs.remove(dir, { recursive: true });
    }
  },
  { skip: !hasSsh && "ssh-keygen is not installed" },
);

/** The value the test expects to be there. */
function got<T>(value: T | undefined | null, what = "a value"): T {
  assertExists(value, `${what} is missing`);
  return value;
}
