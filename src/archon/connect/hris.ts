/**
 * Spec 086, declared with spec 091's SDK: HR systems (Cloud HCM suites),
 * read-only: the roster only, the source of truth for who should have
 * access. Name, work email, status, start and end dates, manager, type:
 * never compensation, personal contact details, or anything else. Each
 * person is a `person` record, which becomes one of the estate's people; the
 * estate graph joins them with every account (leavers, orphans, devices per
 * person).
 *
 * @module
 */

import { type Connector, fresh, getJson } from "./connector.ts";
import { emailKey, type Person } from "./entities.ts";
import { type ConnectorDef, defineConnector, type FieldDef, type ObservedRecord } from "./sdk.ts";
import { PERSON } from "./labels.ts";

const day = (s?: string | null) => (s && /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : undefined);

/** A person from the roster, mapped to the `person` label. */
const personRecord = (p: Person) => ({
  native_id: p.email,
  display_name: p.name ?? p.email,
  props: {
    email: p.email,
    status: p.status,
    ...(p.name ? { name: p.name } : {}),
    ...(p.start ? { start_date: p.start } : {}),
    ...(p.end ? { end_date: p.end } : {}),
    ...(p.manager ? { manager: p.manager } : {}),
    ...(p.type ? { role_type: p.type } : {}),
  },
});

/** The roster's counts: how many people, how many active, how many left in the last 90 days. */
function rosterPosture(records: ObservedRecord[], _cred: unknown, { now }: { now: Date }) {
  const people = records.filter((r) => r.label === PERSON.name).map((r) => r.props);
  return {
    people: people.length,
    active: people.filter((p) => p.status === "active").length,
    leftLast90Days:
      people.filter((p) =>
        p.end_date && Date.parse(p.end_date as string) > now.getTime() - 90 * 86_400_000 &&
        p.status === "terminated"
      ).length,
  };
}

/** HR policies: the roster itself is the evidence; the estate graph checks against it. */
function rosterPolicies(id: string) {
  return (o: Parameters<Connector["policies"]>[0], now: number) => [fresh(o, now, id)];
}

/** What every roster connector shares: SaaS, Cloud HCM suites, the roster's posture and policy. */
const roster = <F extends Record<string, FieldDef>>(
  d: Omit<ConnectorDef<F>, "serviceModels" | "markets" | "posture" | "policies">,
) =>
  defineConnector<F>({
    ...d,
    serviceModels: ["SaaS"],
    markets: ["cloud-hcm-suites"],
    posture: rosterPosture,
    policies: rosterPolicies(d.id),
  });

const BAMBOO_FIELDS = [
  "displayName",
  "workEmail",
  "status",
  "hireDate",
  "terminationDate",
  "employmentHistoryStatus",
  "supervisorEmail",
];

const bambooReport = (subdomain: string) =>
  `https://api.bamboohr.com/api/gateway.php/${
    encodeURIComponent(subdomain)
  }/v1/reports/custom?format=JSON&onlyCurrent=false`;

/** BambooHR. */
export const bamboohr: Connector = roster({
  id: "bamboohr",
  title: "BambooHR",
  logo: "",
  connectHelp: [
    "BambooHR: a user whose access level can read employees' names, work emails, status, and hire and termination dates only",
    "Signed in as that user: your name (top right) > API Keys > Add New Key",
    "Your company's subdomain: <subdomain>.bamboohr.com",
  ],
  recipe: {},
  fields: {
    subdomain: { secret: false, hint: "your BambooHR subdomain (<subdomain>.bamboohr.com)" },
    key: { secret: true, hint: "the API key (of a limited, read-only user)" },
  },
  // BambooHR's custom report is read with a POST that names the fields (a query, never a change).
  tokenEndpoints: (cred) => [bambooReport(cred.subdomain)],
  auth: (cred) =>
    Promise.resolve({
      Authorization: `Basic ${btoa(`${cred.key}:x`)}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    }),
  account: (cred) => cred.subdomain,
  resources: {
    roster: {
      label: PERSON,
      ocsf: "user_inventory",
      required: true,
      async *list(ctx) {
        const r = await getJson<{ employees: Array<Record<string, string | null>> }>(
          ctx.http,
          bambooReport(ctx.cred.subdomain),
          ctx.headers,
          "POST",
          JSON.stringify({ fields: BAMBOO_FIELDS }),
        );
        for (const e of r.employees ?? []) {
          const email = emailKey(e.workEmail ?? undefined);
          if (!email) continue;
          const status = (e.status ?? "").toLowerCase() === "active"
            ? "active"
            : e.terminationDate
            ? "terminated"
            : "unknown";
          const p: Person = {
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
          };
          yield p;
        }
      },
      map: personRecord,
      // The roster is not listed as assets in Git beyond counts: people live in the estate graph.
      asset: () => undefined,
    },
  },
});

/** Rippling. */
export const rippling: Connector = roster({
  id: "rippling",
  title: "Rippling",
  logo: "",
  connectHelp: [
    "Rippling: Settings > Company settings > API Tokens > Create API token",
    "Scopes, read only: employees' name, work email, role state (employment status), start and end dates, manager",
  ],
  recipe: {},
  fields: { token: { secret: true, hint: "the API token (read only)" } },
  auth: (cred) =>
    Promise.resolve({ Authorization: `Bearer ${cred.token}`, Accept: "application/json" }),
  account: () => "Rippling",
  resources: {
    roster: {
      label: PERSON,
      ocsf: "user_inventory",
      required: true,
      async *list(ctx) {
        const out: Array<Record<string, unknown>> = [];
        for (let offset = 0; offset < 100_000; offset += 100) {
          const page = await ctx.json<Array<Record<string, unknown>>>(
            `https://api.rippling.com/platform/api/employees/include_terminated?limit=100&offset=${offset}`,
          );
          out.push(...page);
          if (page.length < 100) break;
        }
        const byId = new Map(out.map((e) => [String(e.id), emailKey(String(e.workEmail ?? ""))]));
        for (const e of out) {
          const email = emailKey(String(e.workEmail ?? ""));
          if (!email) continue;
          const state = String(e.roleState ?? "").toUpperCase();
          const p: Person = {
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
          };
          yield p;
        }
      },
      map: personRecord,
      asset: () => undefined,
    },
  },
});
