/**
 * Spec 086: HR systems (Cloud HCM suites), read-only: the roster only, the
 * source of truth for who should have access. Name, work email, status,
 * start and end dates, manager, type: never compensation, personal contact
 * details, or anything else. The estate graph joins it with every account
 * (leavers, orphans, devices per person).
 *
 * @module
 */

import { type Connector, fresh, getJson, type Http } from "./connector.ts";
import type { Person } from "./entities.ts";
import { emailKey } from "./entities.ts";

const day = (s?: string | null) => (s && /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : undefined);

function rosterObservation(
  provider: string,
  account: string,
  people: Person[],
  now: Date,
  gaps: string[] = [],
) {
  const active = people.filter((p) => p.status === "active").length;
  return {
    at: now.toISOString().replace(/\.\d+Z$/, "Z"),
    provider,
    account,
    // The roster is not listed as assets in Git beyond counts: people live in the estate graph.
    assets: [],
    posture: {
      people: people.length,
      active,
      leftLast90Days:
        people.filter((p) =>
          p.end && Date.parse(p.end) > now.getTime() - 90 * 86_400_000 && p.status === "terminated"
        ).length,
    },
    gaps,
    entities: { people },
  };
}

/** HR policies: the roster itself is the evidence; the estate graph checks against it. */
function rosterPolicies(id: string) {
  return (o: Parameters<Connector["policies"]>[0], now: number) => [fresh(o, now, id)];
}

/** BambooHR. */
export const bamboohr: Connector = {
  id: "bamboohr",
  title: "BambooHR",
  logo: "",
  serviceModels: ["SaaS"],
  markets: ["cloud-hcm-suites"],
  connectHelp: [
    "BambooHR: a user whose access level can read employees' names, work emails, status, and hire and termination dates only",
    "Signed in as that user: your name (top right) > API Keys > Add New Key",
    "Your company's subdomain: <subdomain>.bamboohr.com",
  ],
  recipe: {},
  fields: [
    {
      name: "subdomain",
      secret: false,
      hint: "your BambooHR subdomain (<subdomain>.bamboohr.com)",
    },
    { name: "key", secret: true, hint: "the API key (of a limited, read-only user)" },
  ],
  async observe(cred, http: Http, now) {
    const h = {
      Authorization: `Basic ${btoa(`${cred.key}:x`)}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    };
    const r = await getJson<{ employees: Array<Record<string, string | null>> }>(
      http,
      `https://api.bamboohr.com/api/gateway.php/${
        encodeURIComponent(cred.subdomain)
      }/v1/reports/custom?format=JSON&onlyCurrent=false`,
      h,
      "POST",
      JSON.stringify({
        fields: [
          "displayName",
          "workEmail",
          "status",
          "hireDate",
          "terminationDate",
          "employmentHistoryStatus",
          "supervisorEmail",
        ],
      }),
    );
    const people: Person[] = [];
    for (const e of r.employees ?? []) {
      const email = emailKey(e.workEmail ?? undefined);
      if (!email) continue;
      const status = (e.status ?? "").toLowerCase() === "active"
        ? "active"
        : e.terminationDate
        ? "terminated"
        : "unknown";
      people.push({
        email,
        ...(e.displayName ? { name: e.displayName } : {}),
        status,
        ...(day(e.hireDate) ? { start: day(e.hireDate) } : {}),
        ...(day(e.terminationDate) && e.terminationDate !== "0000-00-00"
          ? { end: day(e.terminationDate) }
          : {}),
        ...(emailKey(e.supervisorEmail ?? undefined)
          ? { manager: emailKey(e.supervisorEmail ?? undefined) }
          : {}),
        ...(e.employmentHistoryStatus ? { type: e.employmentHistoryStatus } : {}),
      });
    }
    return rosterObservation("bamboohr", cred.subdomain, people, now);
  },
  policies: rosterPolicies("bamboohr"),
};

/** Rippling. */
export const rippling: Connector = {
  id: "rippling",
  title: "Rippling",
  logo: "",
  serviceModels: ["SaaS"],
  markets: ["cloud-hcm-suites"],
  connectHelp: [
    "Rippling: Settings > Company settings > API Tokens > Create API token",
    "Scopes, read only: employees' name, work email, role state (employment status), start and end dates, manager",
  ],
  recipe: {},
  fields: [{ name: "token", secret: true, hint: "the API token (read only)" }],
  async observe(cred, http: Http, now) {
    const h = { Authorization: `Bearer ${cred.token}`, Accept: "application/json" };
    const out: Array<Record<string, unknown>> = [];
    for (let offset = 0; offset < 100_000; offset += 100) {
      const page = await getJson<Array<Record<string, unknown>>>(
        http,
        `https://api.rippling.com/platform/api/employees/include_terminated?limit=100&offset=${offset}`,
        h,
      );
      out.push(...page);
      if (page.length < 100) break;
    }
    const byId = new Map(out.map((e) => [String(e.id), emailKey(String(e.workEmail ?? ""))]));
    const people: Person[] = [];
    for (const e of out) {
      const email = emailKey(String(e.workEmail ?? ""));
      if (!email) continue;
      const state = String(e.roleState ?? "").toUpperCase();
      people.push({
        email,
        ...(e.name ? { name: String(e.name) } : {}),
        status: state === "ACTIVE"
          ? "active"
          : state === "TERMINATED"
          ? "terminated"
          : state === "ACCEPTED" || state === "HIRED"
          ? "active"
          : "unknown",
        ...(day(e.startDate as string) ? { start: day(e.startDate as string) } : {}),
        ...(day(e.endDate as string) ? { end: day(e.endDate as string) } : {}),
        ...(e.manager && byId.get(String(e.manager))
          ? { manager: byId.get(String(e.manager)) }
          : {}),
        ...(e.employmentType ? { type: String(e.employmentType) } : {}),
      });
    }
    return rosterObservation("rippling", "Rippling", people, now);
  },
  policies: rosterPolicies("rippling"),
};
