/**
 * Spec 091: Justworks (PEO, payroll, and HR), read-only, the roster only:
 * each member's work email, name, whether they are active, start and
 * termination dates, manager, and employment type. Never pay, birth dates,
 * sex, phones, or addresses: the scopes Stolos asks for exclude them, and
 * anything else in the record is dropped as it is read. Evidence for account
 * management (SCF IAC-08) and provisioning (IAC-04), through the estate
 * graph.
 *
 * Justworks' API is a partner API: OAuth 2.0 (authorization code, then
 * refresh tokens) for apps Justworks approves (partner-api@justworks.com).
 * There is no self-serve token. Stolos keeps the app's client id and secret
 * and a refresh token (valid 30 days), and asks for a fresh access token on
 * each observation.
 *
 * @module
 */

import { http } from "@intellectual-frontiers/commons/ts/runtime";
import { AccessDenied, type Connector } from "./connector.ts";
import { accessToken, defineConnector, exchange } from "./sdk.ts";
import {
  rosterPolicies,
  rosterPosture,
  rosterResource,
  type RosterRow,
  rosterRow,
} from "./roster.ts";

/** Justworks' public API. */
export const JUSTWORKS_API = "https://public-api.justworks.com";
/** Its OAuth token endpoint. */
export const JUSTWORKS_TOKEN = `${JUSTWORKS_API}/oauth/token`;

interface JustworksMember {
  id: string;
  active?: boolean;
  name?: { full_preferred_name?: string; given_name?: string; family_name?: string };
  emails?: Array<{ type?: string; email?: string }>;
  employment_start_date?: string | null;
  employment_termination_date?: string | null;
  current_employment?: { status?: string; type?: string } | null;
  manager?: { id?: string } | null;
  type?: string;
}

/** One Justworks member, reduced to the roster's fields (`emailOf` gives a manager's work email). */
function justworksRow(
  m: JustworksMember,
  emailOf: (id: string) => string | undefined,
): RosterRow | undefined {
  const st = (m.current_employment?.status ?? "").toLowerCase();
  const status: RosterRow["status"] = /leave/.test(st)
    ? "leave"
    : m.active === true
      ? "active"
      : m.active === false || m.employment_termination_date
        ? "terminated"
        : "unknown";
  return rosterRow({
    id: m.id,
    email: workEmail(m),
    name:
      m.name?.full_preferred_name ??
      [m.name?.given_name, m.name?.family_name].filter(Boolean).join(" "),
    status,
    start: m.employment_start_date,
    end: m.employment_termination_date,
    manager: m.manager?.id ? emailOf(m.manager.id) : undefined,
    type: m.current_employment?.type ?? m.type,
  });
}

const workEmail = (m: JustworksMember) => m.emails?.find((e) => e.type === "work")?.email;

/** A fresh access token from a refresh token (RFC 6749 section 6), as a bearer header. */
export async function justworksToken(
  t: http.Transport,
  cred: { client_id: string; client_secret: string; refresh_token: string },
): Promise<Record<string, string>> {
  const r = await exchange(t, {
    method: "POST",
    url: JUSTWORKS_TOKEN,
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: cred.client_id,
      client_secret: cred.client_secret,
      refresh_token: cred.refresh_token,
    }).toString(),
  });
  if (r.status === 400 || r.status === 401 || r.status === 403) {
    throw new AccessDenied(
      `/oauth/token: ${r.status} (the refresh token may have expired: authorize the app again)`,
    );
  }
  if (r.status >= 400) throw new Error(`/oauth/token: HTTP ${r.status}`);
  return { ...http.bearer(accessToken(r.body, JUSTWORKS_TOKEN)) };
}

const FIELDS = {
  client_id: { secret: false, hint: "the app's OAuth client id" },
  client_secret: { secret: true, hint: "the app's OAuth client secret" },
  refresh_token: { secret: true, hint: "a refresh token for your company (read-only scopes)" },
};

/** Justworks. */
export const justworks: Connector = defineConnector<typeof FIELDS>({
  id: "justworks",
  title: "Justworks",
  logo: "",
  serviceModels: ["SaaS"],
  markets: ["cloud-hcm-suites"],
  connectHelp: [
    "Justworks offers no self-serve API token: its API is for partner apps it approves (write to partner-api@justworks.com)",
    "The app asks for read-only scopes only: member.basic:read, member.detail:read (work email), member.employment:read; never member.pay:read, member.dob:read, or member.sex:read",
    "A Justworks admin authorizes the app for your company; keep the app's client id and secret and the refresh token it receives (valid 30 days)",
  ],
  recipe: {},
  fields: FIELDS,
  tokenEndpoints: () => [JUSTWORKS_TOKEN],
  auth: (cred, t) => justworksToken(t, cred),
  account: () => "Justworks",
  resources: {
    members: rosterResource(async function* (ctx) {
      type Page = { items?: JustworksMember[]; next_cursor?: string | null };
      const all: JustworksMember[] = [];
      for await (const m of ctx.cursorPages<Page, JustworksMember>(
        `${JUSTWORKS_API}/v1/members?limit=100`,
        (b) => b.items,
        (b) =>
          b.next_cursor
            ? `${JUSTWORKS_API}/v1/members?limit=100&cursor=${encodeURIComponent(b.next_cursor)}`
            : undefined,
      ))
        all.push(m);
      const byId = new Map(all.map((m) => [m.id, workEmail(m)]));
      for (const m of all) {
        const row = justworksRow(m, (id) => byId.get(id));
        if (row) yield row;
      }
    }),
  },
  posture: rosterPosture,
  policies: rosterPolicies("justworks", "Justworks > Team"),
});
