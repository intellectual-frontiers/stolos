/**
 * Spec 088: Tenable Vulnerability Management (cloud.tenable.com), read-only,
 * through its workbench API: every asset with vulnerabilities in the last 30
 * days (`GET /workbenches/assets/vulnerabilities`), each asset's
 * vulnerabilities by plugin (`GET /workbenches/assets/{id}/vulnerabilities`),
 * and, for the critical and high ones, the plugin's CVEs and when it was first
 * seen on that asset (`GET /workbenches/assets/{id}/vulnerabilities/{plugin}/info`).
 * Each is a `vulnerability` record (OCSF Vulnerability Finding, 2002); open
 * ones go in the OSCAL POA&M. Evidence for SCF VPM-06 and VPM-07.
 *
 * Credential: the API keys of a user made for Stolos with the Basic role
 * (view only), given Can View on the assets' access groups. Docs:
 * https://developer.tenable.com/reference/workbenches-assets-vulnerabilities
 * and https://developer.tenable.com/docs/authorization.
 *
 * Limits: medium and low findings carry no CVE (one more call each would);
 * at most 2,000 detail calls per observation; info-level findings are left
 * out.
 *
 * @module
 */

import { type Connector, fresh } from "./connector.ts";
import { defineConnector } from "./sdk.ts";
import { VULNERABILITY } from "./labels.ts";
import {
  firstCve,
  type Severity,
  vulnerabilityPolicies,
  vulnerabilityPosture,
} from "./vulnerability.ts";

const API = "https://cloud.tenable.com";
const MAX_DETAILS = 2000;
const SEVERITY: Severity[] = ["info", "low", "medium", "high", "critical"];

interface TAsset {
  id: string;
  fqdn?: string[];
  ipv4?: string[];
  netbios_name?: string[];
  agent_name?: string[];
}

interface TVuln {
  plugin_id: number;
  plugin_name: string;
  severity: number;
  vulnerability_state?: string;
  accepted_count?: number;
}

interface TInfo {
  info?: {
    discovery?: { seen_first?: string };
    reference_information?: Array<{ name: string; values?: string[] }>;
  };
}

/** One finding: a plugin on an asset. */
interface Finding {
  asset: TAsset;
  vuln: TVuln;
  cve?: string;
  firstSeen?: string;
}

const assetName = (a: TAsset) =>
  a.fqdn?.[0] ?? a.netbios_name?.[0] ?? a.agent_name?.[0] ?? a.ipv4?.[0] ?? a.id;

/** Tenable Vulnerability Management. */
export const tenable: Connector = defineConnector({
  id: "tenable",
  title: "Tenable Vulnerability Management",
  logo: "tenable",
  serviceModels: ["SaaS"],
  markets: ["vulnerability-assessment"],
  connectHelp: [
    "cloud.tenable.com > Settings > Access Control > Users > Create User: stolos-read, role Basic (read only)",
    "Access Control > Groups or access groups: give the user Can View on the assets to report",
    "Sign in as that user (or as an administrator: the user > API Keys) > Generate: copy the Access Key and the Secret Key",
  ],
  recipe: {
    open: {
      href: "https://cloud.tenable.com/tio/app.html#/settings/my-account/api-keys",
      label: "Tenable: My Account > API Keys",
    },
  },
  fields: {
    accessKey: { secret: false, hint: "the Access Key" },
    secretKey: { secret: true, hint: "the Secret Key (a Basic, read-only user's)" },
  },
  auth: (cred) =>
    Promise.resolve({
      "X-ApiKeys": `accessKey=${cred.accessKey};secretKey=${cred.secretKey};`,
      Accept: "application/json",
    }),
  account: () => "cloud.tenable.com",
  resources: {
    vulnerabilities: {
      label: VULNERABILITY,
      ocsf: "vulnerability_finding",
      required: true,
      async *list(ctx): AsyncGenerator<Finding> {
        const { assets } = await ctx.json<{ assets?: TAsset[] }>(
          `${API}/workbenches/assets/vulnerabilities?date_range=30`,
        );
        let details = 0;
        for (const a of assets ?? []) {
          const { vulnerabilities } = await ctx.orGap(
            `asset ${assetName(a)}`,
            { vulnerabilities: [] as TVuln[] },
            () =>
              ctx
                .json<{ vulnerabilities?: TVuln[] }>(
                  `${API}/workbenches/assets/${a.id}/vulnerabilities?date_range=30`,
                )
                .then((r) => ({ vulnerabilities: r.vulnerabilities ?? [] })),
          );
          for (const v of vulnerabilities.filter((x) => x.severity >= 1)) {
            let f: Finding = { asset: a, vuln: v };
            if (v.severity >= 3 && details++ < MAX_DETAILS) {
              const unread: TInfo = {};
              const info = await ctx.orGap(`plugin ${v.plugin_id} on ${assetName(a)}`, unread, () =>
                ctx.json<TInfo>(
                  `${API}/workbenches/assets/${a.id}/vulnerabilities/${v.plugin_id}/info`,
                ),
              );
              const cves = info.info?.reference_information?.find((r) => r.name === "cve")?.values;
              const cve = firstCve(cves ?? []);
              const first = info.info?.discovery?.seen_first;
              f = { ...f, ...(cve ? { cve } : {}), ...(first ? { firstSeen: first } : {}) };
            }
            yield f;
          }
        }
      },
      map: (f: Finding) => ({
        native_id: `${f.asset.id}:${f.vuln.plugin_id}`,
        display_name: f.cve ?? f.vuln.plugin_name,
        props: {
          ...(f.cve ? { cve: f.cve } : {}),
          title: f.vuln.plugin_name,
          severity: SEVERITY[Math.min(4, Math.max(0, f.vuln.severity))],
          status:
            f.vuln.vulnerability_state === "Fixed"
              ? "fixed"
              : (f.vuln.accepted_count ?? 0) > 0
                ? "dismissed"
                : "open",
          asset: assetName(f.asset),
          ...(f.firstSeen ? { first_seen: f.firstSeen } : {}),
        },
      }),
      asset: () => undefined,
    },
  },
  posture: (records, _cred, seen) => vulnerabilityPosture(records, seen.now),
  policies(o, now) {
    return [
      fresh(o, now, "tenable"),
      ...vulnerabilityPolicies(o, "tenable", "cloud.tenable.com > Explore > Findings"),
    ];
  },
});
