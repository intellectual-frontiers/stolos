/**
 * Spec 087: Bitwarden (Password Manager, Teams or Enterprise), read-only,
 * for one organization: its members (confirmed, invited, revoked; owner or
 * admin; whether two-step login is on), whether the organization requires
 * two-step login, and its collections (the shared vaults) with who can open
 * each, directly or through a group. Evidence for MFA (SCF IAC-37), least
 * privilege (IAC-30), and account management (IAC-08); the estate graph
 * checks that every active person has an account (coverage).
 *
 * Bitwarden's organization API key is not read-only (Bitwarden documents it
 * as full access to the organization's management API): Stolos sends it only
 * to the token endpoint and makes GET calls alone. Item names and contents
 * are end-to-end encrypted and never readable through this API.
 *
 * @module
 */
// Spec: 087-wave2-connectors

import { check, type Connector, fresh } from "./connector.ts";
import { clientCredentials, type Ctx, defineConnector } from "./sdk.ts";
import { PASSWORD_STORE, USER_ACCOUNT } from "./labels.ts";

const FIELDS = {
  server: {
    secret: false,
    hint: "us, eu, or your self-hosted server's URL (https://vault.example.org)",
  },
  client_id: { secret: false, hint: "the organization API key's client_id (organization.<id>)" },
  client_secret: { secret: true, hint: "the organization API key's client_secret" },
};

/** The API and token endpoint for a server (us, eu, or a self-hosted URL). */
export function bitwardenUrls(server: string): { api: string; token: string } {
  const s = server.trim().toLowerCase();
  if (s === "" || s === "us") {
    return {
      api: "https://api.bitwarden.com",
      token: "https://identity.bitwarden.com/connect/token",
    };
  }
  if (s === "eu") {
    return {
      api: "https://api.bitwarden.eu",
      token: "https://identity.bitwarden.eu/connect/token",
    };
  }
  const b = server.trim().replace(/\/$/, "");
  return { api: `${b}/api`, token: `${b}/identity/connect/token` };
}

/** Member status: Invited 0, Accepted 1, Confirmed 2, Revoked -1 (numbers, or their names). */
const STATUS: Record<string, string> = {
  "0": "invited",
  "1": "accepted",
  "2": "confirmed",
  "-1": "revoked",
};
/** Member type: Owner 0, Admin 1, User 2, Manager 3, Custom 4. */
const TYPE: Record<string, string> = {
  "0": "owner",
  "1": "admin",
  "2": "user",
  "3": "manager",
  "4": "custom",
};
const word = (v: unknown, names: Record<string, string>): string => {
  const k = typeof v === "string" || typeof v === "number" ? String(v) : "";
  return names[k] ?? k.toLowerCase();
};

interface Member {
  id: string;
  email: string;
  name?: string | null;
  twoFactorEnabled?: boolean;
  status: number | string;
  type: number | string;
  collections?: Array<{ id: string }> | null;
}

interface Collection {
  id: string;
  externalId?: string | null;
  groups?: Array<{ id: string }> | null;
  /** Added here: who can open it (emails), and through how many groups. */
  access?: { members: string[]; groups: number };
}

interface List<T> {
  data?: T[];
  continuationToken?: string | null;
}

/** Every item of a Bitwarden list, following `continuationToken`. */
function pages<T>(ctx: Ctx<typeof FIELDS>, url: string): AsyncGenerator<T> {
  return ctx.cursorPages<List<T>, T>(
    url,
    (b) => b.data,
    (b) =>
      b.continuationToken
        ? `${url}${url.includes("?") ? "&" : "?"}continuationToken=${encodeURIComponent(
            b.continuationToken,
          )}`
        : undefined,
  );
}

const PRIVILEGED = new Set(["owner", "admin"]);

/** Bitwarden (an organization). */
export const bitwarden: Connector = defineConnector({
  id: "bitwarden",
  title: "Bitwarden",
  logo: "bitwarden",
  serviceModels: ["SaaS"],
  markets: ["secrets-management"],
  connectHelp: [
    "Needs a Teams or Enterprise organization (the organization API is not on other plans)",
    "Bitwarden web app, signed in as an owner > Admin Console > Settings > Organization info > API key > View API key",
    "Copy client_id and client_secret, and say where the organization is: us (bitwarden.com), eu (bitwarden.eu), or your server's URL",
    "Bitwarden's organization key is not read-only: Stolos only reads with it (GET), and it can be rotated on the same page",
    "Item names and contents are end-to-end encrypted: Stolos sees members, two-step login, and who can open each collection, never a secret",
  ],
  recipe: {
    open: {
      href: "https://vault.bitwarden.com/#/organizations",
      label: "Open the Admin Console (Settings > Organization info > API key)",
    },
  },
  fields: FIELDS,
  tokenEndpoints: (cred) => [bitwardenUrls(cred.server).token],
  auth: (cred, http) =>
    clientCredentials(
      http,
      bitwardenUrls(cred.server).token,
      cred.client_id,
      cred.client_secret,
      "api.organization",
    ),
  account: (cred) => cred.client_id.replace(/^organization\./, ""),
  resources: {
    members: {
      label: USER_ACCOUNT,
      ocsf: "user_inventory",
      required: true,
      async *list(ctx) {
        const api = bitwardenUrls(ctx.cred.server).api;
        type Policy = { type: unknown; enabled?: boolean };
        const policies = await ctx.orGap(
          "policies",
          undefined as Policy[] | undefined,
          async () => {
            const out: Policy[] = [];
            for await (const p of pages<Policy>(ctx, `${api}/public/policies`)) out.push(p);
            return out;
          },
        );
        if (policies) {
          const twoStep = policies.find(
            (p) => String(p.type) === "0" || p.type === "TwoFactorAuthentication",
          );
          ctx.fact("orgRequires2fa", !!twoStep?.enabled);
        }
        yield* pages<Member>(ctx, `${api}/public/members`);
      },
      map: (m: Member) => {
        const status = word(m.status, STATUS);
        const role = word(m.type, TYPE);
        return {
          native_id: m.id,
          display_name: m.email,
          props: {
            email: m.email.toLowerCase(),
            active: status === "confirmed" || status === "accepted",
            admin: PRIVILEGED.has(role),
            ...(m.twoFactorEnabled !== undefined ? { mfa: m.twoFactorEnabled } : {}),
          },
        };
      },
      asset: (m: Member) => ({
        kind: "member",
        facts: { status: word(m.status, STATUS), role: word(m.type, TYPE) },
      }),
    },
    collections: {
      label: PASSWORD_STORE,
      ocsf: "cloud_resources_inventory_info",
      async *list(ctx) {
        const api = bitwardenUrls(ctx.cred.server).api;
        const collections: Collection[] = [];
        for await (const c of pages<Collection>(ctx, `${api}/public/collections`)) {
          collections.push(c);
        }
        const direct = new Map<string, Set<string>>();
        const email = new Map<string, string>();
        for await (const m of pages<Member>(ctx, `${api}/public/members`)) {
          email.set(m.id, m.email.toLowerCase());
          if (word(m.status, STATUS) === "revoked") continue;
          for (const c of m.collections ?? []) {
            direct.set(c.id, (direct.get(c.id) ?? new Set()).add(m.email.toLowerCase()));
          }
        }
        const groupMembers = new Map<string, string[]>();
        for (const c of collections) {
          const who = new Set(direct.get(c.id) ?? []);
          for (const g of c.groups ?? []) {
            if (!groupMembers.has(g.id)) {
              groupMembers.set(
                g.id,
                await ctx.orGap(`group ${g.id} members`, [] as string[], async () =>
                  (await ctx.json<string[]>(`${api}/public/groups/${g.id}/member-ids`))
                    .map((id) => email.get(id))
                    .filter((e): e is string => !!e),
                ),
              );
            }
            for (const e of groupMembers.get(g.id) ?? []) who.add(e);
          }
          yield { ...c, access: { members: [...who].sort(), groups: (c.groups ?? []).length } };
        }
      },
      map: (c: Collection) => ({
        native_id: c.id,
        display_name: c.externalId || c.id,
        props: {
          members: c.access?.members.length ?? 0,
          member_names: (c.access?.members ?? []).join(", "),
          granting_groups: c.access?.groups ?? 0,
        },
      }),
      asset: (c: Collection) => ({
        kind: "collection",
        facts: { members: c.access?.members.length ?? 0, groups: c.access?.groups ?? 0 },
      }),
    },
  },
  posture(records) {
    const active = records.filter((r) => r.label === USER_ACCOUNT.name && r.props["active"]);
    const stores = records.filter((r) => r.label === PASSWORD_STORE.name);
    const known = active.some((r) => typeof r.props["mfa"] === "boolean");
    return {
      activeMembers: active.length,
      admins: active.filter((r) => r.props["admin"]).length,
      ...(known
        ? { membersWithout2fa: active.filter((r) => r.props["mfa"] === false).length }
        : {}),
      ...(known
        ? {
            adminsWithout2fa: active.filter((r) => r.props["admin"] && r.props["mfa"] === false)
              .length,
          }
        : {}),
      sharedCollections: stores.length,
      ...(stores.length
        ? { widestCollection: Math.max(...stores.map((r) => Number(r.props["members"] ?? 0))) }
        : {}),
    };
  },
  policies(o, now) {
    return [
      fresh(o, now, "bitwarden"),
      check(o, {
        id: "bitwarden-2fa-required",
        title: "The organization requires two-step login",
        scf: ["IAC-37"],
        fact: "orgRequires2fa",
        want: (v) => v === true,
        fix: "Admin Console > Policies > Require two-step login: on",
      }),
      check(o, {
        id: "bitwarden-2fa",
        title: "Every member has two-step login on",
        scf: ["IAC-37"],
        fact: "membersWithout2fa",
        want: (v) => v === 0,
        show: (v) => `${v} of ${o.posture["activeMembers"]} members without it`,
        fix: "each member: Settings > Security > Two-step login (or turn on the Require two-step login policy)",
      }),
      check(o, {
        id: "bitwarden-admins",
        title: "Two to four owners and admins",
        scf: ["IAC-30"],
        fact: "admins",
        want: (v) => typeof v === "number" && v >= 2 && v <= 4,
        fix: "Admin Console > Members: make those who need no admin rights Users",
        warnOnly: true,
      }),
    ];
  },
});
