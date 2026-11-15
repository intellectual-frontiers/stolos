/**
 * Spec 091: Deel (global HR, EOR, and contractors), read-only, the roster
 * only: each person's work email, name, hiring status, start date, last day,
 * direct manager, and hiring type (employee, EOR, contractor, ...). Never
 * pay, birth dates, addresses, or nationalities: Deel's person record has
 * them, and they are dropped as it is read. Evidence for account management
 * (SCF IAC-08) and provisioning (IAC-04), through the estate graph.
 *
 * Credential: an organization API token a Deel admin makes, scope
 * `people:read` only.
 *
 * @module
 */

import type { Connector } from "./connector.ts";
import { bearer, defineConnector } from "./sdk.ts";
import {
  rosterPolicies,
  rosterPosture,
  rosterResource,
  type RosterRow,
  rosterRow,
} from "./roster.ts";

/** Deel's REST API. */
export const DEEL_API = "https://api.letsdeel.com/rest/v2";

interface DeelPerson {
  id: string;
  full_name?: string;
  emails?: Array<{ type?: string; value?: string }> | null;
  hiring_status?: string;
  person_status?: "ACTIVE" | "NOT_STARTED" | "INACTIVE" | null;
  hiring_type?: string | null;
  start_date?: string | null;
  direct_employee_termination_last_day?: string | null;
  direct_manager?: { work_email?: string | null } | null;
  employments?: Array<{ work_email?: string | null; termination_last_day?: string | null }> | null;
}

/** Deel's hiring statuses, as the roster's. */
function status(p: DeelPerson): RosterRow["status"] {
  const h = (p.hiring_status ?? "").toLowerCase();
  if (p.person_status === "INACTIVE" || h === "inactive") return "terminated";
  if (p.person_status === "ACTIVE" || h === "active" || h === "offboarding") return "active";
  return "unknown"; // drafts, invites, and onboarding: not started yet
}

/** One Deel person, reduced to the roster's fields. */
function deelRow(p: DeelPerson): RosterRow | undefined {
  const work = p.emails?.find((e) => e.type === "work")?.value ??
    p.employments?.find((e) => e.work_email)?.work_email;
  const end = p.direct_employee_termination_last_day ??
    p.employments?.find((e) => e.termination_last_day)?.termination_last_day;
  return rosterRow({
    id: p.id,
    email: work,
    name: p.full_name,
    status: status(p),
    start: p.start_date,
    end,
    manager: p.direct_manager?.work_email,
    type: p.hiring_type,
  });
}

/** Deel. */
export const deel: Connector = defineConnector({
  id: "deel",
  title: "Deel",
  logo: "",
  serviceModels: ["SaaS"],
  markets: ["cloud-hcm-suites"],
  connectHelp: [
    "Deel, signed in as an Org Admin (or IT Developer Admin): Apps & Integrations (or More) > Developer Center > Access tokens > Generate new token",
    "Token type: Organization (a personal token stops working when its owner leaves)",
    "Scopes, read only: people:read, and nothing else",
    "Copy the token now: Deel shows it once",
  ],
  recipe: {
    open: { href: "https://app.deel.com/developer-center", label: "Deel's Developer Center" },
  },
  fields: {
    token: { secret: true, hint: "the organization API token (people:read only)" },
  },
  auth: (cred) => Promise.resolve(bearer(cred.token)),
  account: () => "Deel",
  resources: {
    people: rosterResource(async function* (ctx) {
      type Page = { data?: DeelPerson[]; page?: { offset?: number; total_rows?: number } };
      for await (
        const p of ctx.cursorPages<Page, DeelPerson>(
          `${DEEL_API}/people?limit=100&offset=0`,
          (b) => b.data,
          (b, url) => {
            const offset = Number(new URL(url).searchParams.get("offset") ?? 0) + 100;
            const total = b.page?.total_rows ?? 0;
            return (b.data?.length ?? 0) === 100 && offset < total
              ? `${DEEL_API}/people?limit=100&offset=${offset}`
              : undefined;
          },
        )
      ) {
        const row = deelRow(p);
        if (row) yield row;
      }
    }),
  },
  posture: rosterPosture,
  policies: rosterPolicies("deel", "Deel > People"),
});
