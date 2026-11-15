/**
 * Spec 088: Snyk, read-only, through its REST API (`/rest`, version
 * `2024-10-15`): one organization's open issues (vulnerabilities in open
 * source dependencies, containers, and code) with their CVE, severity, the
 * project they are in, and when each was found. Each issue is a
 * `vulnerability` record (OCSF Vulnerability Finding, 2002); open ones go in
 * the OSCAL POA&M. Evidence for vulnerability remediation and its timeliness
 * (SCF VPM-06, VPM-07).
 *
 * Credential: a service account's API token on the organization, with a role
 * that only views (on Enterprise plans, a custom organization role with the
 * View Organization, View Project, and View Issues permissions; otherwise the
 * predefined Org Collaborator, which can also start tests: Stolos only reads).
 * Docs: https://docs.snyk.io/snyk-api/reference/issues and
 * https://docs.snyk.io/snyk-api/authentication-for-api.
 *
 * @module
 */

import { type Connector, fresh } from "./connector.ts";
import { defineConnector } from "./sdk.ts";
import { VULNERABILITY } from "./labels.ts";
import {
  firstCve,
  severityOf,
  vulnerabilityPolicies,
  vulnerabilityPosture,
} from "./vulnerability.ts";

/** The REST API version Stolos reads (Snyk dates its versions). */
export const SNYK_VERSION = "2024-10-15";

const FIELDS = {
  region: {
    secret: false,
    hint: "your Snyk API address: api.snyk.io (US, the default), api.eu.snyk.io, or api.au.snyk.io",
  },
  org: { secret: false, hint: "the organization's ID (Settings > General > Organization ID)" },
  token: { secret: true, hint: "the service account's API token (a view-only role)" },
};

const base = (region: string) =>
  `https://${(region || "api.snyk.io").replace(/^https?:\/\//, "").replace(/\/+$/, "")}/rest`;

interface Issue {
  id: string;
  attributes: {
    title?: string;
    type?: string;
    effective_severity_level?: string;
    status?: string;
    ignored?: boolean;
    created_at?: string;
    problems?: Array<{ id: string; source?: string; type?: string; url?: string }>;
    coordinates?: Array<{
      is_upgradeable?: boolean;
      is_patchable?: boolean;
      is_fixable_snyk?: boolean;
      representations?: Array<{ dependency?: { package_name?: string; package_version?: string } }>;
    }>;
  };
  relationships?: { scan_item?: { data?: { id?: string; type?: string } } };
  /** Added here: the project's name. */
  project?: string;
}

interface Page<T> {
  data?: T[];
  links?: { next?: string };
}

/** The next page's absolute URL (Snyk gives a path, with or without /rest). */
const nextOf = (api: string) => (b: Page<unknown>) => {
  const n = b.links?.next;
  if (!n) return undefined;
  if (/^https?:/.test(n)) return n;
  return n.startsWith("/rest/") ? `${new URL(api).origin}${n}` : `${api}${n}`;
};

/** Snyk. */
export const snyk: Connector = defineConnector({
  id: "snyk",
  title: "Snyk",
  logo: "snyk",
  serviceModels: ["SaaS"],
  markets: ["vulnerability-assessment"],
  connectHelp: [
    "app.snyk.io > your organization > Settings > Service accounts > Create a service account: stolos-read",
    "Role: a custom role that only views (View Organization, View Project, View Issues) on Enterprise plans; otherwise Org Collaborator (Stolos only reads with it)",
    "Copy the API token (shown once) and the Organization ID (Settings > General)",
  ],
  recipe: {
    open: {
      href: "https://app.snyk.io/account",
      label: "Snyk: organization settings (Service accounts)",
    },
  },
  fields: FIELDS,
  auth: (cred) =>
    Promise.resolve({
      Authorization: `token ${cred.token}`,
      Accept: "application/vnd.api+json",
    }),
  account: (cred) => cred.org,
  resources: {
    issues: {
      label: VULNERABILITY,
      ocsf: "vulnerability_finding",
      required: true,
      async *list(ctx) {
        const api = base(ctx.cred.region);
        const v = `version=${SNYK_VERSION}&limit=100`;
        // Project names, for people: without them, the project's id stands for it.
        const names = await ctx.orGap("projects", new Map<string, string>(), async () => {
          const m = new Map<string, string>();
          for await (const p of ctx.cursorPages<
            Page<{ id: string; attributes?: { name?: string } }>,
            {
              id: string;
              attributes?: { name?: string };
            }
          >(`${api}/orgs/${ctx.cred.org}/projects?${v}`, (b) => b.data, nextOf(api)))
            m.set(p.id, p.attributes?.name ?? p.id);
          return m;
        });
        for await (const i of ctx.cursorPages<Page<Issue>, Issue>(
          `${api}/orgs/${ctx.cred.org}/issues?${v}&status=open`,
          (b) => b.data,
          nextOf(api),
        )) {
          const pid = i.relationships?.scan_item?.data?.id;
          yield { ...i, ...(pid ? { project: names.get(pid) ?? pid } : {}) };
        }
      },
      map: (i: Issue) => {
        const a = i.attributes;
        const cve = firstCve((a.problems ?? []).map((p) => p.id));
        const dep = a.coordinates
          ?.flatMap((c) => c.representations ?? [])
          .find((r) => r.dependency?.package_name)?.dependency;
        const fixable = a.coordinates?.some(
          (c) => c.is_upgradeable || c.is_patchable || c.is_fixable_snyk,
        );
        return {
          native_id: i.id,
          display_name: cve ?? a.title ?? i.id,
          props: {
            ...(cve ? { cve } : {}),
            ...(a.title ? { title: a.title } : {}),
            severity: severityOf(a.effective_severity_level),
            status: a.ignored ? "dismissed" : a.status === "resolved" ? "fixed" : "open",
            ...(i.project ? { asset: i.project } : {}),
            ...(dep?.package_name
              ? {
                  package: `${dep.package_name}${
                    dep.package_version ? `@${dep.package_version}` : ""
                  }`,
                }
              : {}),
            ...(a.created_at ? { first_seen: a.created_at } : {}),
            ...(fixable !== undefined ? { fix_available: fixable } : {}),
          },
        };
      },
      asset: () => undefined,
    },
  },
  posture: (records, _cred, seen) => vulnerabilityPosture(records, seen.now),
  policies(o, now) {
    return [
      fresh(o, now, "snyk"),
      ...vulnerabilityPolicies(o, "snyk", "app.snyk.io > the organization > Projects"),
    ];
  },
});
