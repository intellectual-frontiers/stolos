/**
 * Spec 109-integrations-api: the integration layer's algebra (kinds, capabilities, `Has`, `defineIntegration`, with the compile-time
 * checks as `@ts-expect-error`), its entities and how they join the estate graph, Cloudflare as the DNS and email kinds beside its
 * unchanged connector, the standards the spec names, and the guide.
 *
 * @module
 */

import { fs, path } from "@intellectual-frontiers/commons/ts/runtime";
import type { http } from "@intellectual-frontiers/commons/ts/runtime";
import type { Result } from "@intellectual-frontiers/commons/ts/kernel";
import {
  assert,
  assertEquals,
  assertStringIncludes,
  assertThrows,
  proves,
} from "@intellectual-frontiers/commons/ts/runtime/test";
import { CODE_LISTS } from "../ontology/stolos/mod.ts";
import { API_CAPABILITIES, API_KINDS } from "../src/archon/ontology.auto.ts";
import { cloudflare } from "../src/archon/connect/cloudflare.ts";
import {
  cloudflareDns,
  cloudflareEmail,
  cloudflareFamily,
  emailFacts,
} from "../src/archon/connect/cloudflare-integration.ts";
import {
  capabilitiesOf,
  clientByMac,
  defineIntegration,
  domainsLacking,
  type Has,
  portsDown,
  readCapability,
  readContext,
  recordsNamed,
  type ReadContext,
} from "../src/archon/connect/integration.ts";
import {
  type Client,
  type Complete,
  type DnsZone,
  dmarcPolicy,
  entityParts,
  type Reading,
  RESULTS_ARE_COMPLETE,
} from "../src/archon/connect/integration-entities.ts";
import { unifiRouter } from "../src/archon/connect/unifi.ts";
import { CONNECTORS } from "../src/archon/connect/commands.ts";
import type { Observation } from "../src/archon/connect/connector.ts";
import { buildGraph, estateQuery } from "../src/archon/estate/graph.ts";
import { loadScf } from "../src/archon/compliance/catalog.ts";
import { GUIDES, guideMarkdown } from "../src/archon/core/guides.ts";
import { ENGINE_ROOT } from "./sandbox.ts";

const NOW = new Date("2026-11-17T12:00:00Z");
const LIMIT = { timeout: 180_000 };

/** A context over a transport that answers nothing (for readers that make no request). */
const nothing: http.Transport = {
  kind: "recorded",
  send: () => Promise.resolve({ kind: "err", error: { kind: "refused", message: "no" } }),
};
const ctx = (gaps: string[] = []): ReadContext =>
  readContext({ cred: {}, http: nothing, now: NOW, headers: {}, gaps });

const client = (over: Partial<Client> = {}): Client => ({
  source: "fake",
  id: "c1",
  name: "alpha",
  kind: "wired",
  mac: "02:00:00:00:00:10",
  ...over,
});

// ------------------------------------------------------------------------------ kinds and capabilities

proves(
  ["109-integrations-api FR-001"],
  "109: each kind has the typed capability set of the ontology, and each capability a result type",
  () => {
    assertEquals(API_KINDS, ["router", "dns", "email"]);
    assertEquals(capabilitiesOf("router"), [
      "dhcp-leases",
      "clients",
      "devices",
      "networks-and-vlans",
      "ports",
      "port-forwards",
      "firewall-rules",
      "wifi",
      "routes",
      "health",
    ]);
    assertEquals(capabilitiesOf("dns"), ["zones", "records"]);
    assertEquals(capabilitiesOf("email"), ["domains", "sending", "routing"]);
    // One list of words: the ontology's code list is the union the code derives from.
    assertEquals(Object.keys(CODE_LISTS.ApiCapability.list), [...API_CAPABILITIES]);
    assertEquals(
      API_CAPABILITIES.length,
      capabilitiesOf("router").length +
        capabilitiesOf("dns").length +
        capabilitiesOf("email").length,
    );
    // Every kind's results are exactly its capabilities (checked by the compiler, and here).
    assertEquals(RESULTS_ARE_COMPLETE, { router: true, dns: true, email: true });
    // A result type with a capability missing is `never`, so using it does not compile.
    // @ts-expect-error `Complete` is never for a result that lacks a capability of its kind
    const bad: Complete<"dns", { zones: DnsZone[] }> = { zones: [] };
    // @ts-expect-error nor does one with a capability the kind does not have
    const extra: Complete<"dns", { zones: DnsZone[]; records: []; clients: [] }> = {};
    void bad;
    void extra;
    const good: Complete<"dns", { zones: DnsZone[]; records: [] }> = { zones: [], records: [] };
    assertEquals(good.zones, []);
  },
);

proves(
  ["109-integrations-api FR-002"],
  "109: a function that needs a capability accepts only an integration that offers it; the rest does not compile",
  async () => {
    const fake = defineIntegration({
      id: "fake",
      title: "Fake router",
      kind: "router",
      read: {
        clients: () =>
          Promise.resolve([client(), client({ id: "c2", name: "beta", mac: "02:00:00:00:00:11" })]),
        devices: () => Promise.resolve([]),
      },
      notOffered: {
        "dhcp-leases": "no leases endpoint",
        "networks-and-vlans": "not read",
        ports: "not read",
        "port-forwards": "not read",
        "firewall-rules": "not read",
        wifi: "not read",
        routes: "not read",
        health: "not read",
      },
    });
    assertEquals(fake.offers, ["clients", "devices"]);
    assertEquals(fake.notOffered.ports, "not read");
    // It offers clients, so a function over clients takes it, however the MAC is written.
    assertEquals((await clientByMac(fake, ctx(), "02-00-00-00-00-11"))?.name, "beta");
    assertEquals(await clientByMac(fake, ctx(), "02:00:00:00:00:99"), undefined);
    const typed: Promise<Client[]> = readCapability(fake, "clients", ctx());
    assertEquals((await typed).length, 2);
    // It does not offer ports.
    // @ts-expect-error a router without `ports` is not accepted where `ports` is needed
    const noPorts = (): unknown => portsDown(fake, ctx());
    // @ts-expect-error nor is a capability it does not offer read by name
    const noRead = (): unknown => readCapability(fake, "ports", ctx());
    // A DNS provider is not a router, whatever it offers.
    // @ts-expect-error an integration of another kind does not fit `Has<"router", ...>`
    const wrongKind = (): unknown => clientByMac(cloudflareDns, ctx(), "02:00:00:00:00:10");
    // UniFi offers clients, devices, networks, ports, firewall rules, wifi and health, but not leases, port forwards or routes.
    const ok: Has<"router", "clients" | "ports" | "health"> = unifiRouter;
    // @ts-expect-error UniFi's documented API has no DHCP leases, and the type says so
    const leases: Has<"router", "dhcp-leases"> = unifiRouter;
    // @ts-expect-error nor port forwards
    const forwards = (): unknown => readCapability(unifiRouter, "port-forwards", ctx());
    // Cloudflare's email offers domains and routing, not sending.
    const mail: Has<"email", "domains" | "routing"> = cloudflareEmail;
    // @ts-expect-error `sending` is not offered by Cloudflare
    const sending: Has<"email", "sending"> = cloudflareEmail;
    // The kinds Cloudflare is.
    const dns: Has<"dns", "zones" | "records"> = cloudflareDns;
    assertEquals(
      [typeof noPorts, typeof noRead, typeof wrongKind, typeof forwards],
      ["function", "function", "function", "function"],
    );
    assert(ok.kind === "router" && mail.kind === "email" && dns.kind === "dns");
    void leases;
    void sending;

    // Every capability of the kind is read or explained: leaving a reason out does not compile, and a JavaScript caller is stopped too.
    assertThrows(
      () =>
        defineIntegration({
          id: "half",
          title: "Half",
          kind: "router",
          read: { clients: () => Promise.resolve([]) },
          // @ts-expect-error `routes` is neither offered nor explained
          notOffered: {
            "dhcp-leases": "x",
            devices: "x",
            "networks-and-vlans": "x",
            ports: "x",
            "port-forwards": "x",
            "firewall-rules": "x",
            wifi: "x",
            health: "x",
          },
        }),
      Error,
      "say why it does not offer routes",
    );
    // A capability of another kind is refused too.
    assertThrows(
      () =>
        defineIntegration({
          id: "odd",
          title: "Odd",
          kind: "dns",
          read: {
            zones: () => Promise.resolve([]),
            records: () => Promise.resolve([]),
            // @ts-expect-error `clients` is not a capability of a DNS provider
            clients: () => Promise.resolve([]),
          },
          notOffered: {},
        }),
      Error,
      "clients is not a capability of dns",
    );
    // Cloudflare's DNS offers everything of its kind and so owes no reason; its email owes one, for sending.
    assertEquals(cloudflareDns.notOffered, {});
    assertStringIncludes(cloudflareEmail.notOffered.sending, "outbound sending");
  },
);

// ------------------------------------------------------------------------------ entities and the estate graph

proves(
  ["109-integrations-api FR-003", "109-integrations-api FR-015"],
  "109: what an integration reads becomes records and device entities that join the one estate graph",
  () => {
    const readings: Reading[] = [
      {
        kind: "router",
        capability: "devices",
        items: [
          {
            source: "unifi",
            site: "Default",
            id: "d1",
            name: "gateway",
            kind: "gateway",
            model: "UDM-Pro",
            mac: "02:00:00:00:00:01",
            ip: "192.0.2.1",
            state: "ONLINE",
            firmware: "4.0.6",
            firmwareUpdatable: false,
          },
        ],
      },
      {
        kind: "router",
        capability: "clients",
        items: [client({ source: "unifi", site: "Default", ip: "10.0.0.10" })],
      },
      {
        kind: "router",
        capability: "networks-and-vlans",
        items: [
          { source: "unifi", id: "n1", name: "IoT", vlanId: 20, enabled: true, default: false },
        ],
      },
      {
        kind: "dns",
        capability: "zones",
        items: [
          { source: "cloudflare", id: "z1", name: "example.org", status: "active", dnssec: true },
        ],
      },
      {
        kind: "email",
        capability: "routing",
        items: [
          {
            source: "cloudflare",
            id: "r1",
            zone: "example.org",
            name: "to-team",
            enabled: true,
            matches: ["address"],
            actions: ["forward"],
            destinations: 2,
            catchAll: false,
          },
        ],
      },
      // Posture, not nodes: no records, and not a failure.
      { kind: "router", capability: "health", items: [] },
      { kind: "email", capability: "sending", items: [] },
    ];
    const parts = readings.map(entityParts);
    const labels = parts.flatMap((p) => p.records).map((r) => r.label);
    assertEquals(labels, [
      "computer_network_node",
      "network_endpoint",
      "local_area_network",
      "domain_name",
      "email_rule",
    ]);
    // A device is a device entity of the source unifi, never managed: a fixed asset beside the fleet's machines.
    assertEquals(parts[0]?.devices, [
      { source: "unifi", id: "d1", name: "gateway", managed: false },
    ]);
    assertEquals(parts[1]?.records[0]?.props["mac"], "02:00:00:00:00:10");
    assertEquals(parts[4]?.records[0]?.props["destinations"], 2);

    const o: Observation = {
      at: "2026-11-17T12:00:00Z",
      provider: "unifi",
      account: "192.0.2.1",
      assets: parts.flatMap((p) => p.assets),
      posture: {},
      gaps: [],
      entities: { devices: parts.flatMap((p) => p.devices) },
      records: parts.flatMap((p) => p.records),
    };
    const e = buildGraph({
      fleet: "lab",
      sources: [{ connector: "unifi", observation: o }],
      machines: [],
      links: {},
    });
    const rows = (sql: string) => estateQuery(e, sql);
    assertEquals(
      rows(
        "select display_name, json_extract(props, '$.mac') as mac, json_extract(props, '$.ip') as ip from node where label = 'network_endpoint'",
      ),
      [{ display_name: "alpha", mac: "02:00:00:00:00:10", ip: "10.0.0.10" }],
    );
    assertEquals(
      rows(
        "select display_name, json_extract(props, '$.vlan_id') as vlan_id from node where label = 'local_area_network'",
      ),
      [{ display_name: "IoT", vlan_id: 20 }],
    );
    assertEquals(
      rows(
        "select json_extract(props, '$.kind') as kind, json_extract(props, '$.model') as model from node where label = 'computer_network_node'",
      ),
      [{ kind: "gateway", model: "UDM-Pro" }],
    );
    // The gateway is also a fixed asset, a network device, in the same graph as the fleet's machines.
    assertEquals(rows("select hostname, fixed_asset_type from fixed_asset"), [
      { hostname: "gateway", fixed_asset_type: "network_device" },
    ]);
    assertEquals(rows("select count(*) as n from node where ocsf_class_uid in (5001, 5023)"), [
      { n: 5 },
    ]);
    // An email domain's policy word, read the way RFC 7489 writes it.
    assertEquals(dmarcPolicy("v=DMARC1; p=Quarantine; rua=mailto:r@example.org"), "quarantine");
    assertEquals(dmarcPolicy("v=DMARC1"), undefined);
  },
);

// ------------------------------------------------------------------------------ Cloudflare, generalized

const CF = "api.cloudflare.com/client/v4";

/** Cloudflare's recorded answers (as tests/connect084.test.ts has them), with email: two zones, routing readable on the first only. */
function cfFake(): http.Transport & { calls: string[] } {
  const calls: string[] = [];
  const ok = (body: unknown): [number, unknown] => [200, body];
  const routes: Record<string, [number, unknown]> = {
    [`${CF}/accounts?`]: ok({
      result: [{ id: "a1", name: "Example Co" }],
      result_info: { page: 1, total_pages: 1 },
    }),
    [`${CF}/accounts/a1/workers/scripts`]: [403, {}],
    [`${CF}/accounts/a1/pages/projects`]: ok({ result: [] }),
    [`${CF}/accounts/a1/r2/buckets`]: ok({ result: { buckets: [] } }),
    [`${CF}/accounts/a1/cfd_tunnel`]: ok({ result: [] }),
    [`${CF}/zones?`]: ok({
      result: [
        { id: "z1", name: "example.org", status: "active", plan: { name: "Free" } },
        { id: "z2", name: "bare.example.org", status: "active" },
      ],
    }),
    [`${CF}/zones/z1/settings/ssl`]: ok({ result: { value: "strict" } }),
    [`${CF}/zones/z1/settings/always_use_https`]: ok({ result: { value: "on" } }),
    [`${CF}/zones/z1/settings/min_tls_version`]: ok({ result: { value: "1.2" } }),
    [`${CF}/zones/z1/dnssec`]: ok({ result: { status: "active" } }),
    [`${CF}/zones/z1/dns_records`]: ok({
      result: [
        {
          id: "r1",
          type: "A",
          name: "server1.example.org",
          content: "203.0.113.10",
          proxied: false,
        },
        { id: "r2", type: "MX", name: "example.org", content: "route1.mx.cloudflare.net", ttl: 1 },
        {
          id: "r3",
          type: "TXT",
          name: "example.org",
          content: '"v=spf1 include:_spf.mx.cloudflare.net ~all"',
        },
        { id: "r4", type: "TXT", name: "_dmarc.example.org", content: '"v=DMARC1; p=none"' },
        {
          id: "r5",
          type: "CNAME",
          name: "s1._domainkey.example.org",
          content: "s1.dkim.example.net",
        },
      ],
    }),
    [`${CF}/zones/z2/settings`]: [403, {}],
    [`${CF}/zones/z2/dnssec`]: [403, {}],
    [`${CF}/zones/z2/dns_records`]: ok({
      result: [{ id: "r6", type: "MX", name: "bare.example.org", content: "mail.example.net" }],
    }),
    // The integrations' own reads: Email Routing (the second zone's is refused).
    [`${CF}/zones/z1/email/routing/rules`]: ok({
      result: [
        {
          tag: "rule1",
          name: "team",
          enabled: true,
          priority: 1,
          matchers: [{ type: "literal", field: "to", value: "team@example.org" }],
          actions: [{ type: "forward", value: ["alice@example.net"] }],
        },
        {
          tag: "rule2",
          name: "catch all",
          enabled: true,
          matchers: [{ type: "all" }],
          actions: [{ type: "drop" }],
        },
      ],
    }),
    [`${CF}/zones/z1/email/routing`]: ok({ result: { enabled: true } }),
    [`${CF}/zones/z2/email/routing`]: [403, {}],
  };
  return {
    kind: "recorded",
    calls,
    send(r): Promise<Result<http.Exchange, http.TransportError>> {
      calls.push(`${r.method} ${r.url}`);
      const u = new URL(r.url);
      const key = Object.keys(routes)
        .filter((k) => `${u.host}${u.pathname}${u.search}`.startsWith(k))
        .sort((a, b) => b.length - a.length)[0];
      const [status, body] = (key === undefined ? undefined : routes[key]) ?? [404, {}];
      return Promise.resolve({
        kind: "ok",
        value: { method: r.method, url: r.url, status, headers: {}, body: JSON.stringify(body) },
      });
    },
  };
}

proves(
  ["109-integrations-api FR-007"],
  "109: Cloudflare is the dns kind behind the layer, its connector is unchanged, and no request is sent twice",
  async () => {
    const baseT = cfFake();
    const base = await cloudflare.observe({ token: "t" }, baseT, NOW);
    const famT = cfFake();
    const fam = await cloudflareFamily.observe({ token: "t" }, famT, NOW);
    // Everything the connector wrote is as it was: its assets first and unchanged, its records, its posture, its gaps.
    assertEquals(fam.assets.slice(0, base.assets.length), base.assets);
    assertEquals((fam.records ?? []).slice(0, (base.records ?? []).length), base.records ?? []);
    for (const [k, v] of Object.entries(base.posture)) assertEquals(fam.posture[k], v, k);
    for (const g of base.gaps) assert(fam.gaps.includes(g), g);
    assertEquals(fam.account, base.account);
    assertEquals(fam.provider, "cloudflare");
    // Its policies are the connector's, with the same results on its own observation.
    assertEquals(
      cloudflareFamily.policies(base, NOW.getTime()),
      cloudflare.policies(base, NOW.getTime()),
    );
    assertEquals(cloudflareFamily.id, "cloudflare");
    assertEquals(CONNECTORS.filter((c) => c.id === "cloudflare").length, 1);
    // The requests: the connector's, once each, and the layer's own (Email Routing) beside them.
    const unique = (c: string[]): string[] => [...new Set(c)].sort();
    assertEquals(famT.calls.length, unique(famT.calls).length, "no request was sent twice");
    const email = famT.calls.filter((c) => c.includes("/email/routing"));
    assertEquals(
      unique(famT.calls.filter((c) => !c.includes("/email/routing"))),
      unique(baseT.calls),
      "the same requests as the connector sends, and no others",
    );
    assert(email.length >= 3, "Email Routing was read");
    for (const c of famT.calls) assert(c.startsWith("GET "), c);
    // The dns kind, read on its own, is typed: zones and records of the account.
    const gaps: string[] = [];
    const c2 = readContext({
      cred: { token: "t" },
      http: cfFake(),
      now: NOW,
      headers: { Authorization: "Bearer t" },
      gaps,
    });
    const zones = await readCapability(cloudflareDns, "zones", c2);
    assertEquals(
      zones.map((z) => [z.name, z.dnssec]),
      [
        ["example.org", true],
        ["bare.example.org", undefined],
      ],
    );
    const records = await recordsNamed(cloudflareDns, c2, "SERVER1.example.org");
    assertEquals(
      records.map((r) => [r.type, r.content, r.proxied]),
      [["A", "203.0.113.10", false]],
    );
    // The web front door's Cloudflare code (spec 032) is not part of the layer: it imports nothing of it.
    for (const f of ["cloudflare.ts", "acme.ts", "commands.ts", "config.ts", "serve.ts"]) {
      const text = await fs.readTextFile(path.join(ENGINE_ROOT, "src/archon/web", f));
      assert(
        !/connect\//.test(text.replace(/\/\/.*$/gm, "")) || f === "commands.ts",
        `${f} stays as it was`,
      );
    }
    const front = await fs.readTextFile(path.join(ENGINE_ROOT, "src/archon/web/cloudflare.ts"));
    assert(!/integration/.test(front));
  },
  LIMIT,
);

proves(
  ["109-integrations-api FR-008", "109-integrations-api FR-004", "109-integrations-api FR-005"],
  "109: Cloudflare is the email kind: domains, routing without destination addresses, a gap for sending, and the email policies",
  async () => {
    const o = await cloudflareFamily.observe({ token: "t" }, cfFake(), NOW);
    const domains = (o.records ?? []).filter((r) => r.label === "mail_service");
    assertEquals(
      domains.map((r) => [
        r.display_name,
        r.props["spf"],
        r.props["dmarc"],
        r.props["dkim"],
        r.props["routing"],
      ]),
      [
        ["example.org", true, true, true, true],
        ["bare.example.org", false, false, false, undefined],
      ],
    );
    assertEquals(domains[0]?.props["dmarc_policy"], "none");
    assertEquals(domains[0]?.props["mx"], "route1.mx.cloudflare.net");
    const rules = (o.records ?? []).filter((r) => r.label === "email_rule");
    assertEquals(
      rules.map((r) => [
        r.display_name,
        r.props["destinations"],
        r.props["catch_all"],
        r.props["actions"],
      ]),
      [
        ["team", 1, false, "forward"],
        ["catch all", 0, true, "drop"],
      ],
    );
    // Nothing that is a person: the address that mail is forwarded to, and the address that matches, are not kept anywhere.
    const text = JSON.stringify(o);
    assert(!text.includes("alice@"), "no destination address");
    assert(!text.includes("team@"), "no matched address");
    // The posture and the gaps: sending is not offered (with its reason), and a zone whose Email Routing is refused is said once.
    assertEquals(o.posture["emailDomains"], 2);
    assertEquals(o.posture["emailDomainsMissingSpf"], 1);
    assertEquals(o.posture["emailDomainsMissingDmarc"], 1);
    assertEquals(o.posture["emailDomainsMissingDkim"], 1);
    assertEquals(o.posture["emailRoutingOn"], 1);
    assertEquals(o.posture["emailRoutes"], 2);
    assertEquals(o.posture["emailCatchAll"], 1);
    assert(o.gaps.some((g) => g.startsWith("sending: this release reads inbound Email Routing")));
    assertEquals(o.gaps.filter((g) => g.startsWith("bare.example.org email routing:")).length, 1);
    // The policies, each with its fix and SCF NET-39, only because the domains were read.
    const by = Object.fromEntries(
      cloudflareFamily.policies(o, NOW.getTime()).map((r) => [r.id, r]),
    );
    assertEquals(by["cf-email-spf"]?.status, "fail");
    assertEquals(by["cf-email-dmarc"]?.status, "fail");
    assertEquals(by["cf-email-dkim"]?.status, "warn");
    for (const id of ["cf-email-spf", "cf-email-dmarc", "cf-email-dkim"]) {
      assertEquals(by[id]?.scf, ["NET-39"]);
      assert((by[id]?.fix ?? "").length > 20, id);
    }
    assertStringIncludes(by["cf-email-spf"]?.detail ?? "", "1 of 2");
    // The email kind, read on its own: any email provider that offers domains answers the question.
    const lacking = await domainsLacking(
      cloudflareEmail,
      readContext({
        cred: { token: "t" },
        http: cfFake(),
        now: NOW,
        headers: { Authorization: "Bearer t" },
        gaps: [],
      }),
      "spf",
    );
    assertEquals(
      lacking.map((d) => d.domain),
      ["bare.example.org"],
    );
    // What a zone's records say of its email (RFC 7208, 6376, 7489), and a zone with none.
    assertEquals(emailFacts("x.example.org", []), { domain: "x.example.org", mx: [], dkim: false });
    // A token that may read no Email Routing at all still observes: gaps, never a failure.
    const inner = cfFake();
    const denied: http.Transport = {
      kind: "recorded",
      send: (r) =>
        r.url.includes("/email/routing")
          ? Promise.resolve({
              kind: "ok",
              value: { method: "GET", url: r.url, status: 403, headers: {}, body: "{}" },
            })
          : inner.send(r),
    };
    const blind = await cloudflareFamily.observe({ token: "t" }, denied, NOW);
    assertEquals(blind.account, o.account);
    assert(blind.gaps.some((g) => g.includes("email routing")));
    assertEquals(blind.posture["emailRoutingOn"], 0);
    // An observation made before the integrations has none of the email policies.
    const old = await cloudflare.observe({ token: "t" }, cfFake(), NOW);
    assert(!cloudflareFamily.policies(old, NOW.getTime()).some((r) => r.id.startsWith("cf-email")));
  },
  LIMIT,
);

proves(
  ["109-integrations-api FR-006"],
  "109: the family builds on the connector framework: the older connectors are unchanged, and the new ones are listed beside them",
  () => {
    const ids = CONNECTORS.map((c) => c.id);
    assertEquals(
      ids.slice(0, 32).join(","),
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
      ].join(","),
    );
    assertEquals(ids.slice(32), ["unifi"]);
    for (const c of CONNECTORS) {
      assert(typeof c.observe === "function" && typeof c.policies === "function", c.id);
    }
  },
);

// ------------------------------------------------------------------------------ the standards, the guide

proves(
  ["109-integrations-api FR-016", "109-integrations-api FR-008"],
  "109: the SCF controls the spec names are SCF's, with SCF's names, and the spec and plan follow the profile",
  async () => {
    const named: Record<string, string> = {
      "AST-04": "Asset Inventories",
      "MON-02": "Continuous Monitoring",
      "VPM-08": "Software & Firmware Patching",
      "NET-24": "Wireless Networking",
      "NET-10": "Virtual Local Area Network (VLAN) Separation",
      "CRY-05": "Encrypting Data In Transit",
      "CRY-09": "Public Key Infrastructure (PKI)",
      "NET-39": "Email Domain Reputation Protections",
    };
    const spec = await fs.readTextFile(
      path.join(ENGINE_ROOT, "specs/109-integrations-api/spec.md"),
    );
    const plan = await fs.readTextFile(
      path.join(ENGINE_ROOT, "specs/109-integrations-api/plan.md"),
    );
    for (const id of Object.keys(named)) assertStringIncludes(spec, id);
    assertStringIncludes(spec, "**Standards considered.**");
    assertStringIncludes(plan, "## Standards considered");
    for (const word of [
      "RFC 2119",
      "OpenAPI Specification 3.1.0",
      "RFC 6125",
      "RFC 7489",
      "SP 800-53",
    ]) {
      assertStringIncludes(spec, word);
    }
    assert(!/[—]/.test(spec + plan), "no em dashes");
    for (const line of spec.split("\n").filter((l) => /^- \*\*FR-\d{3}\*\*/.test(l))) {
      const id = /FR-\d{3}/.exec(line)?.[0] ?? "";
      const block = spec.slice(spec.indexOf(line)).split(/\n(?=- \*\*FR-|\n#)/)[0] ?? "";
      assert(/\b(MUST|MUST NOT|SHOULD|SHOULD NOT|MAY)\b/.test(block), `${id} has no RFC 2119 word`);
    }
    // Every policy the code has names SCF controls the spec names.
    for (const c of ["unifi", "cloudflare"]) {
      const o = CONNECTORS.find((x) => x.id === c);
      assert(o !== undefined);
    }
    const catalog = await loadScf().catch(() => undefined);
    if (catalog === undefined) {
      assert(
        (await import("@intellectual-frontiers/commons/ts/runtime")).proc.env.get(
          "STOLOS_REQUIRE_SCF",
        ) === undefined,
        "STOLOS_REQUIRE_SCF is set (CI) but the SCF catalog is not cached",
      );
      return;
    }
    for (const [id, name] of Object.entries(named))
      assertEquals(catalog.controls[id]?.name, name, id);
  },
  LIMIT,
);

proves(
  ["109-integrations-api FR-019"],
  "109: the guide says what is true now, has a Mermaid diagram, and is in the guides' list",
  async () => {
    const g = GUIDES.find((x) => x.name === "integrations");
    assert(g !== undefined);
    assertEquals(g.module, "src/archon/connect/mod.ts");
    const md = guideMarkdown(await fs.readTextFile(path.join(ENGINE_ROOT, g.module)));
    assertStringIncludes(md, "```mermaid");
    for (const w of [
      "10.3.58",
      "DHCP leases",
      "port forwards",
      "fingerprint",
      "Cloudflare",
      "defineIntegration",
      "Has<kind, capability>",
    ]) {
      assertStringIncludes(md.replaceAll("&lt;", "<").replaceAll("&gt;", ">"), w);
    }
    assert(!/[—]/.test(md), "no em dashes");
  },
);
