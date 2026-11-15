/**
 * Spec 080: the vendor inventory. Vendors are discovered, not typed in:
 *
 * - **SSO applications**: the apps people sign in to through the identity
 *   provider (Okta's app integrations, Entra's enterprise applications), as
 *   `application` nodes in the estate;
 * - **DNS**: CNAME and MX records whose target is a third party's (a mail
 *   provider, a help desk, a hosting platform), as `dns_record` nodes;
 * - **connected accounts**: each tenant a connector reads is itself a vendor;
 * - **billing**: a hook ({@link BillingSource}) for a future billing connector.
 *
 * A small typed table ({@link WELL_KNOWN_VENDORS}) maps catalog names and
 * service domains to the organization behind them; anything else is an
 * unknown vendor, named by its domain or app, for triage. The fleet's
 * `vendors.ts` records each vendor's criticality (FIPS 199: low, moderate,
 * high) and the data it holds (OCSF's data classification categories). A
 * vendor discovered but not in vendors.ts waits for triage.
 *
 * ```mermaid
 * flowchart LR
 *   sso["application nodes (Okta, Entra)"] --> d["discoverVendors"]
 *   dns["dns_record nodes: CNAME, MX"] --> d
 *   tenants["tenants: each connector"] --> d
 *   billing["BillingSource (future)"] --> d
 *   table["WELL_KNOWN_VENDORS + vendors.ts domains"] --> d
 *   d --> v["vendors: organization parties, party_role supplier, edges"]
 *   triage["fleets/&lt;fleet&gt;/vendors.ts: criticality, data"] --> v
 *   v --> t["not triaged: stolos vendors triage"]
 * ```
 *
 * @example A triage file
 * ```ts
 * import { defineVendors } from "./vendors.ts";
 *
 * export const vendors = defineVendors([
 *   { id: "okta", name: "Okta", criticality: "high", data: ["Personal", "Security"] },
 *   { id: "mailhost", name: "Mailhost", criticality: "moderate", data: ["Business"], domains: ["mailhost.example"] },
 * ]);
 * ```
 *
 * @module
 */

import type { Estate } from "../estate/graph.ts";
import { estateQuery } from "../estate/graph.ts";
import { exists } from "../core/fsx.ts";
import { join, toFileUrl } from "../core/path.ts";
import { P } from "../core/paths.ts";

/** FIPS 199's potential impact levels, as a vendor's criticality; "unassessed" until a person decides. */
export const CRITICALITIES = ["low", "moderate", "high", "unassessed"] as const;

/** A vendor's criticality. */
export type Criticality = typeof CRITICALITIES[number];

/** OCSF 1.9.0 data_classification categories (its category_id captions). */
export const DATA_CATEGORIES = [
  "Personal",
  "Governmental",
  "Financial",
  "Business",
  "Military and Law Enforcement",
  "Security",
  "Other",
] as const;

/** An OCSF data classification category. */
export type DataCategory = typeof DATA_CATEGORIES[number];

/** One vendor, triaged, in fleets/<fleet>/vendors.ts. */
export interface VendorDef {
  /** Its id (lower case, digits, hyphens): the well-known table's, or the one triage proposed. */
  id: string;
  /** Its name for people. */
  name: string;
  /** How critical it is (FIPS 199 potential impact), or unassessed. */
  criticality: Criticality;
  /** The kinds of data it holds (OCSF categories; empty: none of ours). */
  data: readonly DataCategory[];
  /** Service domains that are this vendor's (a CNAME or MX target ending in one, or an app's home page). */
  domains?: readonly string[];
  /** SSO applications that are this vendor's, by name (case and punctuation ignored). */
  apps?: readonly string[];
  /** Who looks after the relationship (a work email). */
  owner?: string;
  /** Anything a reviewer should know (a contract, a review date, an exit plan). */
  notes?: string;
}

const ID = /^[a-z0-9][a-z0-9-]*$/;

/** Why a triage file is malformed (none: it is fine). */
export function vendorProblems(list: readonly VendorDef[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const v of list) {
    const at = `vendor ${v.id || "(no id)"}`;
    if (!ID.test(v.id ?? "")) out.push(`${at}: its id must be lower case letters, digits, hyphens`);
    if (seen.has(v.id)) out.push(`${at}: listed twice`);
    seen.add(v.id);
    if (!v.name?.trim()) out.push(`${at}: it needs a name`);
    if (!CRITICALITIES.includes(v.criticality)) {
      out.push(`${at}: criticality must be one of ${CRITICALITIES.join(", ")}`);
    }
    for (const d of v.data ?? []) {
      if (!DATA_CATEGORIES.includes(d)) {
        out.push(`${at}: ${d} is not an OCSF data category (${DATA_CATEGORIES.join(", ")})`);
      }
    }
  }
  return out;
}

/** Define the triage file: checked now, returned unchanged. */
export function defineVendors<const V extends readonly VendorDef[]>(list: V): V {
  const p = vendorProblems(list);
  if (p.length) throw new Error(p.join("; "));
  return list;
}

/** Where the fleet's triage file is. */
export function vendorsFile(dir: string = P.fleetDir): string {
  return join(dir, "vendors.ts");
}

/** The fleet's triage file (fleets/<fleet>/vendors.ts, exporting `vendors`), or [] when there is none. */
export async function loadVendors(file: string = vendorsFile()): Promise<VendorDef[]> {
  if (!(await exists(file))) return [];
  const mod = await import(toFileUrl(file).href + `?t=${Date.now()}`);
  const list = (mod.vendors ?? mod.default) as VendorDef[] | undefined;
  if (!Array.isArray(list)) {
    throw new Error("vendors.ts exports no vendors (export const vendors = defineVendors([...]))");
  }
  const p = vendorProblems(list);
  if (p.length) throw new Error(p.join("; "));
  return list;
}

/** A well-known vendor: the organization, and how to recognize it. */
export interface KnownVendor {
  /** Its id. */
  id: string;
  /** Its name. */
  name: string;
  /** Its service domains (a CNAME or MX target ending in one is this vendor's). */
  domains: readonly string[];
  /** Its SSO catalog names and app names (normalized: lower case letters and digits). */
  apps?: readonly string[];
  /** The Stolos connectors whose tenants are this vendor's. */
  connectors?: readonly string[];
}

/**
 * Well-known vendors: data, not an endorsement. A starter table; a fleet
 * adds its own through vendors.ts (`domains`, `apps`).
 */
export const WELL_KNOWN_VENDORS: readonly KnownVendor[] = [
  {
    id: "microsoft",
    name: "Microsoft",
    domains: [
      "outlook.com",
      "office365.com",
      "azurewebsites.net",
      "azureedge.net",
      "onmicrosoft.com",
      "trafficmanager.net",
      "cloudapp.net",
    ],
    apps: ["office365", "microsoftoffice365", "microsoft365"],
    connectors: ["microsoft", "microsoft-endpoint"],
  },
  {
    id: "google",
    name: "Google",
    domains: [
      "google.com",
      "googlemail.com",
      "ghs.googlehosted.com",
      "googlehosted.com",
      "appspot.com",
      "web.app",
    ],
    apps: ["google", "googleworkspace", "gsuite"],
    connectors: ["google"],
  },
  {
    id: "amazon-web-services",
    name: "Amazon Web Services",
    domains: [
      "amazonaws.com",
      "cloudfront.net",
      "awsapps.com",
      "amazonses.com",
      "elasticbeanstalk.com",
    ],
    apps: ["amazonaws", "awsiamidentitycenter", "awsconsole"],
    connectors: ["aws"],
  },
  {
    id: "cloudflare",
    name: "Cloudflare",
    domains: ["cloudflare.net", "cloudflare.com", "pages.dev", "workers.dev"],
    apps: ["cloudflare"],
    connectors: ["cloudflare"],
  },
  {
    id: "hetzner",
    name: "Hetzner",
    domains: ["your-server.de", "hetzner.com"],
    connectors: ["hetzner"],
  },
  { id: "okta", name: "Okta", domains: ["okta.com", "oktapreview.com"], connectors: ["okta"] },
  { id: "jumpcloud", name: "JumpCloud", domains: ["jumpcloud.com"], connectors: ["jumpcloud"] },
  {
    id: "github",
    name: "GitHub",
    domains: ["github.io", "github.com"],
    apps: ["github", "githubenterprisecloud", "githubenterprise"],
    connectors: ["github"],
  },
  {
    id: "gitlab",
    name: "GitLab",
    domains: ["gitlab.io", "gitlab.com"],
    apps: ["gitlab"],
    connectors: ["gitlab"],
  },
  {
    id: "atlassian",
    name: "Atlassian",
    domains: ["atlassian.net", "statuspage.io", "bitbucket.io"],
    apps: ["atlassian", "jira", "confluence", "atlassiancloud", "bitbucket"],
    connectors: ["jira", "bitbucket"],
  },
  { id: "slack", name: "Slack", domains: ["slack.com"], apps: ["slack"], connectors: ["slack"] },
  {
    id: "salesforce",
    name: "Salesforce",
    domains: ["salesforce.com", "force.com", "exacttarget.com"],
    apps: ["salesforce", "salesforcecom"],
  },
  { id: "zoom", name: "Zoom", domains: ["zoom.us"], apps: ["zoom", "zoomus"] },
  { id: "zendesk", name: "Zendesk", domains: ["zendesk.com", "zdassets.com"], apps: ["zendesk"] },
  {
    id: "hubspot",
    name: "HubSpot",
    domains: ["hubspot.net", "hubspot.com", "hs-sites.com"],
    apps: ["hubspot"],
  },
  {
    id: "twilio",
    name: "Twilio (SendGrid)",
    domains: ["sendgrid.net", "twilio.com"],
    apps: ["twilio", "sendgrid"],
  },
  { id: "mailgun", name: "Mailgun", domains: ["mailgun.org"] },
  { id: "proofpoint", name: "Proofpoint", domains: ["pphosted.com", "ppe-hosted.com"] },
  { id: "mimecast", name: "Mimecast", domains: ["mimecast.com"] },
  { id: "zoho", name: "Zoho", domains: ["zoho.com", "zoho.eu"], apps: ["zoho"] },
  { id: "fastly", name: "Fastly", domains: ["fastly.net"] },
  { id: "netlify", name: "Netlify", domains: ["netlify.app", "netlify.com"] },
  { id: "vercel", name: "Vercel", domains: ["vercel-dns.com", "vercel.app"] },
  { id: "heroku", name: "Heroku", domains: ["herokudns.com", "herokuapp.com"] },
  { id: "shopify", name: "Shopify", domains: ["myshopify.com", "shopify.com"], apps: ["shopify"] },
  { id: "squarespace", name: "Squarespace", domains: ["squarespace.com"] },
  { id: "webflow", name: "Webflow", domains: ["webflow.io", "proxy-ssl.webflow.com"] },
  {
    id: "dropbox",
    name: "Dropbox",
    domains: ["dropbox.com"],
    apps: ["dropbox", "dropboxbusiness"],
  },
  { id: "box", name: "Box", domains: ["box.com"], apps: ["box", "boxnet"] },
  {
    id: "docusign",
    name: "Docusign",
    domains: ["docusign.net", "docusign.com"],
    apps: ["docusign"],
  },
  {
    id: "1password",
    name: "1Password",
    domains: ["1password.com"],
    apps: ["1password", "onepassword"],
    connectors: ["onepassword"],
  },
  {
    id: "bitwarden",
    name: "Bitwarden",
    domains: ["bitwarden.com"],
    apps: ["bitwarden"],
    connectors: ["bitwarden"],
  },
  {
    id: "crowdstrike",
    name: "CrowdStrike",
    domains: ["crowdstrike.com"],
    connectors: ["crowdstrike"],
  },
  {
    id: "sentinelone",
    name: "SentinelOne",
    domains: ["sentinelone.net"],
    connectors: ["sentinelone"],
  },
  {
    id: "jamf",
    name: "Jamf",
    domains: ["jamfcloud.com"],
    apps: ["jamf", "jamfpro"],
    connectors: ["jamf"],
  },
  { id: "kandji", name: "Kandji", domains: ["kandji.io"], connectors: ["kandji"] },
  {
    id: "linear",
    name: "Linear",
    domains: ["linear.app"],
    apps: ["linear"],
    connectors: ["linear"],
  },
  {
    id: "bamboohr",
    name: "BambooHR",
    domains: ["bamboohr.com"],
    apps: ["bamboohr"],
    connectors: ["bamboohr"],
  },
  {
    id: "rippling",
    name: "Rippling",
    domains: ["rippling.com"],
    apps: ["rippling"],
    connectors: ["rippling"],
  },
  { id: "gusto", name: "Gusto", domains: ["gusto.com"], apps: ["gusto"], connectors: ["gusto"] },
  { id: "deel", name: "Deel", domains: ["deel.com"], apps: ["deel"], connectors: ["deel"] },
  {
    id: "justworks",
    name: "Justworks",
    domains: ["justworks.com"],
    apps: ["justworks"],
    connectors: ["justworks"],
  },
];

/** How a vendor was found. */
export type VendorEvidence = "sso" | "dns" | "tenant" | "billing";

/** One thing that revealed a vendor. */
export interface VendorSighting {
  /** How. */
  kind: VendorEvidence;
  /** The estate uid that revealed it (a node, a tenant), or the billing source's. */
  uid: string;
  /** The connector or source. */
  source: string;
  /** What it was, in words (an app's name, a record and its target, a tenant). */
  detail: string;
}

/** A vendor, discovered (and, when in vendors.ts, triaged). */
export interface Vendor {
  /** Its id. */
  id: string;
  /** Its name. */
  name: string;
  /** In the well-known table or vendors.ts (false: an unknown vendor, named by its domain or app). */
  known: boolean;
  /** Its triage, from vendors.ts. */
  triage?: VendorDef;
  /** What revealed it. */
  seen: VendorSighting[];
}

/** One vendor a billing source reports (a future billing connector). */
export interface BilledVendor {
  /** The payee's name. */
  name: string;
  /** Its domain, when the source knows it. */
  domain?: string;
  /** The billing account or ledger it is in. */
  account: string;
}

/**
 * A billing source (spec 080's hook): a future connector that reads who the
 * company pays (an expense or accounts payable system). None ships yet.
 */
export interface BillingSource {
  /** Its id (a connector id). */
  id: string;
  /** Its name for people. */
  title: string;
  /** The vendors it reports. */
  vendors(now: Date): Promise<BilledVendor[]>;
}

/** The billing sources Stolos knows (none yet). */
export const BILLING_SOURCES: readonly BillingSource[] = [];

/** A name or app, normalized: lower case letters and digits. */
export const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** A hostname, lower case, without a trailing dot. */
const host = (s: string) => s.trim().toLowerCase().replace(/\.$/, "");

/** Whether `h` is `d` or under it. */
const under = (h: string, d: string) => h === d || h.endsWith(`.${d}`);

/**
 * A hostname's registrable domain, approximately: its last two labels, or
 * three under a two-letter country code's second level (example.co.uk).
 */
export function registrable(h: string): string {
  const parts = host(h).split(".").filter(Boolean);
  if (parts.length <= 2) return parts.join(".");
  const [sld, tld] = parts.slice(-2);
  const n = tld.length === 2 && sld.length <= 3 ? 3 : 2;
  return parts.slice(-n).join(".");
}

/** An id from a domain or a name: lower case letters, digits, hyphens. */
export const slug = (s: string): string =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "vendor";

/** What discovery reads besides the estate. */
export interface DiscoverOptions {
  /** The fleet's triage file. */
  triage?: readonly VendorDef[];
  /** What billing sources report. */
  billed?: ReadonlyArray<BilledVendor & { source: string }>;
  /** The vendor table (default: WELL_KNOWN_VENDORS). */
  known?: readonly KnownVendor[];
}

/**
 * Discover the vendors the estate reveals: its SSO applications, its DNS
 * records pointing at third parties, its connected accounts, and what
 * billing reports. A record pointing inside the fleet's own zones is not a
 * vendor. Vendors in vendors.ts that nothing revealed are listed too (seen
 * through triage).
 */
export function discoverVendors(e: Estate, o: DiscoverOptions = {}): Vendor[] {
  const known = o.known ?? WELL_KNOWN_VENDORS;
  const triage = o.triage ?? [];
  const out = new Map<string, Vendor>();
  // vendors.ts first: a fleet's own domains and apps win over the table.
  const byDomain: Array<{ d: string; id: string; name: string }> = [
    ...triage.flatMap((v) =>
      (v.domains ?? []).map((d) => ({ d: host(d), id: v.id, name: v.name }))
    ),
    ...known.flatMap((v) => v.domains.map((d) => ({ d: host(d), id: v.id, name: v.name }))),
  ];
  const byApp = new Map<string, { id: string; name: string }>();
  for (const v of [...known].reverse()) {
    for (const a of [norm(v.name), ...(v.apps ?? [])]) byApp.set(norm(a), v);
  }
  for (const v of [...triage].reverse()) {
    for (const a of [norm(v.name), ...(v.apps ?? [])]) byApp.set(norm(a), v);
  }
  const byConnector = new Map<string, { id: string; name: string }>();
  for (const v of known) for (const c of v.connectors ?? []) byConnector.set(c, v);
  const isKnown = (id: string) => known.some((v) => v.id === id) || triage.some((v) => v.id === id);
  const add = (id: string, name: string, s: VendorSighting) => {
    const v = out.get(id) ?? { id, name, known: isKnown(id), seen: [] };
    if (!v.seen.some((x) => x.uid === s.uid && x.kind === s.kind)) v.seen.push(s);
    out.set(id, v);
  };
  const ofDomain = (h: string) => {
    const x = h && byDomain.find((b) => under(h, b.d));
    if (x) return { id: x.id, name: x.name };
    const r = registrable(h);
    return { id: slug(r), name: r };
  };
  const q = (sql: string) => {
    try {
      return estateQuery(e, sql);
    } catch {
      return [];
    }
  };

  // Connected accounts: each tenant's connector is a vendor.
  for (
    const t of q(
      "SELECT tenant_uid, connector, name FROM tenant WHERE connector <> 'fleet' ORDER BY tenant_uid",
    )
  ) {
    const c = String(t.connector);
    const v = byConnector.get(c) ?? { id: slug(c), name: c };
    add(v.id, v.name, {
      kind: "tenant",
      uid: String(t.tenant_uid),
      source: c,
      detail: `the ${c} account ${t.name}`,
    });
  }

  // SSO applications.
  for (
    const a of q(`SELECT n.node_uid AS uid, n.display_name AS name, t.connector,
      json_extract(n.props, '$.catalog_name') AS catalog, json_extract(n.props, '$.url') AS url,
      json_extract(n.props, '$.publisher') AS publisher
      FROM node n JOIN tenant t ON t.tenant_uid = n.tenant_uid
      WHERE n.label = 'application' ORDER BY n.node_uid`)
  ) {
    const name = String(a.name ?? "");
    const keys = [a.catalog, name, a.publisher].filter(Boolean).map((x) => norm(String(x)));
    let v = keys.map((k) => byApp.get(k)).find(Boolean);
    // A catalog name like salesforce_2 or zoomus_sso: its first word.
    v ??= keys.map((k) => [...byApp.entries()].find(([n]) => n.length >= 4 && k.startsWith(n))?.[1])
      .find(Boolean);
    if (!v && a.url) {
      try {
        const d = ofDomain(new URL(String(a.url)).hostname);
        if (isKnown(d.id)) v = d;
      } catch {
        // not a URL
      }
    }
    v ??= { id: slug(name), name };
    add(v.id, v.name, {
      kind: "sso",
      uid: String(a.uid),
      source: String(a.connector),
      detail: `the SSO application ${name}`,
    });
  }

  // DNS: CNAME and MX targets outside the fleet's own zones.
  const zones = q("SELECT DISTINCT lower(display_name) AS z FROM node WHERE label = 'domain_name'")
    .map((r) => host(String(r.z)));
  for (
    const r of q(`SELECT n.node_uid AS uid, n.display_name AS name, t.connector,
      json_extract(n.props, '$.type') AS type, json_extract(n.props, '$.content') AS content
      FROM node n JOIN tenant t ON t.tenant_uid = n.tenant_uid
      WHERE n.label = 'dns_record' AND json_extract(n.props, '$.type') IN ('CNAME', 'MX')
      ORDER BY n.node_uid`)
  ) {
    // An MX record's content may carry its priority first ("10 mx.example.net").
    const target = host(String(r.content ?? "").split(/\s+/).pop() ?? "");
    if (!target || !target.includes(".") || zones.some((z) => under(target, z))) continue;
    const v = ofDomain(target);
    add(v.id, v.name, {
      kind: "dns",
      uid: String(r.uid),
      source: String(r.connector),
      detail: `${r.type} ${r.name} -> ${target}`,
    });
  }

  // Billing (a future connector).
  for (const b of o.billed ?? []) {
    const v = b.domain
      ? ofDomain(b.domain)
      : (byApp.get(norm(b.name)) ?? { id: slug(b.name), name: b.name });
    add(v.id, v.name, {
      kind: "billing",
      uid: `billing:${b.source}:${b.account}`,
      source: b.source,
      detail: `paid from ${b.account}`,
    });
  }

  // vendors.ts: each triaged vendor, whether or not something revealed it.
  for (const t of triage) {
    const v = out.get(t.id) ?? { id: t.id, name: t.name, known: true, seen: [] };
    out.set(t.id, { ...v, name: t.name, known: true, triage: t });
  }
  return [...out.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/** Whether a vendor still waits for triage: not in vendors.ts, or its criticality unassessed. */
export const needsTriage = (v: Vendor): boolean =>
  !v.triage || v.triage.criticality === "unassessed";
