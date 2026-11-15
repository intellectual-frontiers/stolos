/**
 * Spec 088: a connector template, the starting point for a connector of your
 * own that a fleet adds from its repository with `stolos connector add`. Copy
 * this folder into a repository of its own, rename the id, point it at your
 * vendor's API, record a few of its answers as fixtures, and publish it at a
 * tag. The contract (`stolos docs connectors`):
 *
 * - the default export is a `defineConnector` result: read only (GET, plus
 *   declared token endpoints), labels that are D3FEND, OCSF, or UDM terms
 *   (import the engine's from `labels.ts` where one fits), and policies that
 *   cite SCF ids the engine knows;
 * - `engine` is the range of engine versions it supports;
 * - `fixtures` are its recorded-fixture tests: Stolos runs them itself, in a
 *   process with no network, before it adds the connector.
 *
 * This one reads an imaginary scanner's open findings
 * (`GET https://api.example.com/v1/findings`) as OCSF vulnerabilities.
 *
 * @module
 */

import { type Connector, fresh } from "@intellectual-frontiers/stolos/archon/connect/connector";
import { bearer, defineConnector } from "@intellectual-frontiers/stolos/archon/connect/sdk";
import { VULNERABILITY } from "@intellectual-frontiers/stolos/archon/connect/labels";
import {
  firstCve,
  severityOf,
  vulnerabilityPolicies,
  vulnerabilityPosture,
} from "@intellectual-frontiers/stolos/archon/connect/vulnerability";
import type { ConnectorFixture } from "@intellectual-frontiers/stolos/archon/connect/registry-contract";

/** The engine versions this connector supports. */
export const engine = ">=0.112.0 <1.0.0";

const API = "https://api.example.com/v1";

/** One finding, as the imaginary scanner returns it. */
interface Finding {
  id: string;
  cve?: string;
  title: string;
  severity: string;
  host: string;
  first_seen: string;
}

/** The connector. */
const connector: Connector = defineConnector({
  id: "example-scanner",
  title: "Example Scanner",
  logo: "",
  serviceModels: ["SaaS"],
  markets: ["vulnerability-assessment"],
  connectHelp: [
    "scanner.example.com > Settings > API tokens > New token: stolos-read",
    "Scope: read only",
  ],
  recipe: {},
  fields: { token: { secret: true, hint: "the scanner's API token (read only)" } },
  auth: (cred) => Promise.resolve(bearer(cred.token)),
  account: () => "scanner.example.com",
  resources: {
    findings: {
      label: VULNERABILITY,
      ocsf: "vulnerability_finding",
      list: (ctx) =>
        ctx.cursorPages<{ items?: Finding[]; next?: string }, Finding>(
          `${API}/findings?status=open`,
          (b) => b.items,
          (b) => b.next,
        ),
      map: (f: Finding) => {
        const cve = firstCve([f.cve]);
        return {
          native_id: f.id,
          display_name: cve ?? f.title,
          props: {
            ...(cve ? { cve } : {}),
            title: f.title,
            severity: severityOf(f.severity),
            status: "open",
            asset: f.host,
            first_seen: f.first_seen,
          },
        };
      },
      asset: () => undefined,
    },
  },
  posture: (records, _cred, seen) =>
    vulnerabilityPosture(records, seen.now, !seen.gaps.some((g) => g.startsWith("findings: "))),
  policies: (o, now) => [
    fresh(o, now, "example-scanner"),
    ...vulnerabilityPolicies(o, "example", "scanner.example.com > Findings"),
  ],
});

export default connector;

const FINDINGS = `${API}/findings?status=open`;

/** Recorded answers, and what the observation must say about them. */
export const fixtures: ConnectorFixture[] = [
  {
    name: "two open findings, one critical and overdue",
    cred: { token: "t" },
    now: "2026-11-15T12:00:00Z",
    responses: {
      [FINDINGS]: {
        body: {
          items: [
            {
              id: "f1",
              cve: "CVE-2024-3094",
              title: "xz backdoor",
              severity: "Critical",
              host: "alpha.lab.example.net",
              first_seen: "2026-10-01T00:00:00Z",
            },
          ],
          next: `${API}/findings?status=open&page=2`,
        },
      },
      [`${API}/findings?status=open&page=2`]: {
        body: {
          items: [
            {
              id: "f2",
              title: "TLS 1.0 enabled",
              severity: "Medium",
              host: "beta.lab.example.net",
              first_seen: "2026-11-10T00:00:00Z",
            },
          ],
        },
      },
    },
    expect: {
      account: "scanner.example.com",
      records: { vulnerability: 2 },
      gaps: 0,
      posture: { vulnOpen: 2, vulnCritical: 1, vulnOverdue: 1 },
      policies: { "example-vuln-overdue": "fail", "example-vuln-critical": "warn" },
    },
  },
  {
    name: "a token that may not read findings is a gap, not a failure",
    cred: { token: "t" },
    now: "2026-11-15T12:00:00Z",
    responses: { [FINDINGS]: { status: 403, body: { error: "forbidden" } } },
    expect: { gaps: 1, policies: { "example-vuln-overdue": "unknown" } },
  },
];
