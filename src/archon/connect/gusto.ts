/**
 * Spec 091: Gusto (payroll and HR), read-only, the roster only: each
 * employee's work email, name, whether they have left (and when), hire date,
 * manager, and employment status. Never compensation, SSNs, addresses,
 * birth dates, or bank details: Gusto's employee record has them, and they
 * are dropped as it is read. Evidence for account management (SCF IAC-08)
 * and provisioning (IAC-04), through the estate graph.
 *
 * Gusto's API is OAuth 2.0 for registered apps (dev.gusto.com): a company's
 * access token, scope `employees:read`, lasts two hours, and its refresh
 * token is single-use. There is no self-serve, long-lived read-only token.
 *
 * @module
 */
// Spec: 091-connectors

import { http } from "@intellectual-frontiers/net";
import type { Connector } from "./connector.ts";
import { defineConnector } from "./sdk.ts";
import {
  rosterPolicies,
  rosterPosture,
  rosterResource,
  type RosterRow,
  rosterRow,
} from "./roster.ts";

/** Gusto's production API. */
export const GUSTO_API = "https://api.gusto.com";

interface GustoEmployee {
  uuid: string;
  first_name?: string;
  preferred_first_name?: string | null;
  last_name?: string;
  work_email?: string | null;
  terminated?: boolean;
  terminations?: Array<{ effective_date?: string | null }>;
  jobs?: Array<{ hire_date?: string | null }>;
  manager_uuid?: string | null;
  current_employment_status?: string | null;
}

/** One Gusto employee, reduced to the roster's fields (`emailOf` gives a manager's work email). */
function gustoRow(
  e: GustoEmployee,
  now: Date,
  emailOf: (uuid: string) => string | undefined,
): RosterRow | undefined {
  const ends = (e.terminations ?? [])
    .map((t) => t.effective_date ?? "")
    .filter(Boolean)
    .sort();
  const end = ends.at(-1);
  const starts = (e.jobs ?? [])
    .map((j) => j.hire_date ?? "")
    .filter(Boolean)
    .sort();
  const today = now.toISOString().slice(0, 10);
  // A termination scheduled for later: still active until that day.
  const left = e.terminated === true && (!end || end.slice(0, 10) <= today);
  return rosterRow({
    id: e.uuid,
    email: e.work_email,
    name: [e.preferred_first_name || e.first_name, e.last_name].filter(Boolean).join(" "),
    status: left ? "terminated" : "active",
    start: starts[0],
    end,
    manager: e.manager_uuid ? emailOf(e.manager_uuid) : undefined,
    type: e.current_employment_status,
  });
}

/** Gusto. */
export const gusto: Connector = defineConnector({
  id: "gusto",
  title: "Gusto",
  logo: "",
  serviceModels: ["SaaS"],
  markets: ["cloud-hcm-suites"],
  connectHelp: [
    "Gusto offers no self-serve API token: its API is for apps registered at dev.gusto.com, which a company authorizes with OAuth",
    "An app your company registered (or a partner app you trust) with one read-only scope: employees:read (never compensations:read)",
    "A Gusto admin authorizes that app for your company; the app's company access token is what Stolos needs (it lasts two hours, so connect again when it expires)",
    "Your company's UUID: Gusto shows it to the app (GET /v1/token_info)",
  ],
  recipe: {
    open: { href: "https://dev.gusto.com", label: "Gusto's developer portal" },
  },
  fields: {
    company: { secret: false, hint: "your Gusto company UUID" },
    token: { secret: true, hint: "a company access token with employees:read only" },
  },
  auth: (cred) => Promise.resolve(http.bearer(cred["token"] ?? "")),
  account: (cred) => cred["company"] ?? "",
  resources: {
    employees: rosterResource(async function* (ctx) {
      const all = new Map<string, GustoEmployee>();
      // Current and former employees: Gusto lists them separately.
      for (const terminated of [false, true]) {
        for (let page = 1; page <= 1000; page++) {
          const batch = await ctx.json<GustoEmployee[]>(
            `${GUSTO_API}/v1/companies/${encodeURIComponent(
              ctx.cred["company"] ?? "",
            )}/employees?terminated=${terminated}&page=${page}&per=100`,
          );
          for (const e of batch) all.set(e.uuid, e);
          if (batch.length < 100) break;
        }
      }
      const emailOf = (uuid: string) => all.get(uuid)?.work_email ?? undefined;
      for (const e of all.values()) {
        const row = gustoRow(e, ctx.now, emailOf);
        if (row) yield row;
      }
    }),
  },
  posture: rosterPosture,
  policies: rosterPolicies("gusto", "Gusto > People"),
});
