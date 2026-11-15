/**
 * Spec 067 (clouds), declared with spec 091's SDK: Microsoft 365 (Entra ID,
 * through Microsoft Graph) and Azure (through Resource Manager), read-only,
 * with one app registration's client credentials: the tenant, its domains,
 * users and licenses, who is a Global Administrator, whether people have MFA,
 * and Azure's subscriptions and resources.
 *
 * @module
 */

import { AccessDenied, check, type Connector, fresh, getJson, type Http } from "./connector.ts";
import { type Ctx, defineConnector, type FieldDef } from "./sdk.ts";
import {
  ACCESS_CONTROL_GROUP,
  ASSESSMENT,
  DOMAIN_NAME,
  ORGANIZATION,
  POLICY,
  PRODUCT,
  RESOURCE,
  USER_ACCOUNT,
} from "./labels.ts";

const GRAPH = "https://graph.microsoft.com/v1.0";
const ARM = "https://management.azure.com";
const GLOBAL_ADMIN = "62e90394-69f5-4237-9190-012177145e10";
const SECURITY_DEFAULTS = "security defaults";
const CONDITIONAL_ACCESS = "conditional access";

const tokenUrl = (tenant: string) =>
  `https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/token`;

async function token(http: Http, c: Record<string, string>, scope: string): Promise<string> {
  const body = new URLSearchParams({
    client_id: c.clientId,
    client_secret: c.clientSecret,
    scope,
    grant_type: "client_credentials",
  }).toString();
  const r = await getJson<{ access_token: string }>(
    http,
    tokenUrl(c.tenant),
    { "Content-Type": "application/x-www-form-urlencoded" },
    "POST",
    body,
  );
  return r.access_token;
}

/** Every item of a Graph or Resource Manager list (`@odata.nextLink`, `nextLink`), up to 100 pages. */
async function pages<T>(
  ctx: Ctx<Record<string, FieldDef>>,
  url: string,
  auth?: Record<string, string>,
): Promise<T[]> {
  const out: T[] = [];
  let next: string | undefined = url;
  for (let i = 0; next && i < 100; i++) {
    const r: { value: T[]; "@odata.nextLink"?: string; nextLink?: string } = await ctx.json(
      next,
      auth,
    );
    out.push(...(r.value ?? []));
    next = r["@odata.nextLink"] ?? r.nextLink;
  }
  return out;
}

/** What one observation reads once and two resources use (the users and the posture both need it). */
const shared = new WeakMap<object, Map<string, Promise<unknown>>>();
function once<T>(ctx: object, key: string, f: () => Promise<T>): Promise<T> {
  let m = shared.get(ctx);
  if (!m) shared.set(ctx, m = new Map());
  if (!m.has(key)) m.set(key, f());
  return m.get(key) as Promise<T>;
}

type Admin = { id?: string; userPrincipalName?: string };
type MfaDetail = { userPrincipalName: string; isMfaRegistered: boolean; userType?: string };

const admins = (ctx: Ctx<Record<string, FieldDef>>) =>
  once(ctx, "admins", () =>
    ctx.orGap(
      "Global Administrators",
      undefined as Admin[] | undefined,
      () => pages<Admin>(ctx, `${GRAPH}/directoryRoles(roleTemplateId='${GLOBAL_ADMIN}')/members`),
    ));

const mfaDetails = (ctx: Ctx<Record<string, FieldDef>>) =>
  once(ctx, "mfa", () =>
    ctx.orGap(
      "MFA registration",
      undefined as MfaDetail[] | undefined,
      () => pages<MfaDetail>(ctx, `${GRAPH}/reports/authenticationMethods/userRegistrationDetails`),
    ));

interface User {
  id: string;
  displayName: string;
  userPrincipalName: string;
  accountEnabled: boolean;
  userType?: string;
  /** Added here: a Global Administrator (undefined: the role could not be read). */
  admin?: boolean;
  /** Added here: has registered MFA (undefined: not reported). */
  mfa?: boolean;
}

type Azure =
  | { sub: { subscriptionId: string; displayName: string; state: string } }
  | {
    res: { id: string; name: string; type: string; location: string };
    subscription: string;
  };

/** Microsoft 365 and Azure. */
export const microsoft: Connector = defineConnector({
  id: "microsoft",
  serviceModels: ["SaaS", "PaaS", "IaaS"],
  markets: ["access-management", "strategic-cloud-platform-services"],
  title: "Microsoft 365 and Azure",
  logo: "",
  connectHelp: [
    "entra.microsoft.com > App registrations > New registration: stolos-read (single tenant)",
    "API permissions > Microsoft Graph > Application: Organization.Read.All, Domain.Read.All, User.Read.All, Directory.Read.All, Policy.Read.All, AuditLog.Read.All, Reports.Read.All > Grant admin consent",
    "Certificates & secrets > New client secret (copy its Value)",
    "Azure (optional): portal.azure.com > Subscriptions > each one > Access control (IAM) > Add role assignment > Reader > the app",
    "Overview: copy the Directory (tenant) ID and Application (client) ID",
  ],
  recipe: {
    open: {
      href: "https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade",
      label: "Open Entra app registrations",
    },
    shell: {
      where: "Azure Cloud Shell (Bash), for Azure only: a read-only identity on one subscription",
      href: "https://shell.azure.com",
      command:
        'az ad sp create-for-rbac --name stolos-read --role Reader --scopes "/subscriptions/$(az account show --query id -o tsv)"',
    },
  },
  fields: {
    tenant: { secret: false, hint: "Directory (tenant) ID" },
    clientId: { secret: false, hint: "Application (client) ID" },
    clientSecret: { secret: true, hint: "the client secret's Value" },
  },
  tokenEndpoints: (cred) => [tokenUrl(cred.tenant)],
  auth: async (cred, http) => ({
    Authorization: `Bearer ${await token(http, cred, "https://graph.microsoft.com/.default")}`,
  }),
  account: (cred, records) =>
    records.find((r) => r.label === ORGANIZATION.name)?.display_name ?? cred.tenant,
  // Each resource is named as the old connector named its gaps.
  resources: {
    Organization: {
      label: ORGANIZATION,
      ocsf: "cloud_resources_inventory_info",
      list: async function* (ctx) {
        yield* (await pages<{ id: string; displayName: string }>(ctx, `${GRAPH}/organization`))
          .slice(0, 1);
      },
      map: (o: { id: string; displayName: string }) => ({
        native_id: o.id,
        display_name: o.displayName,
        props: {},
      }),
      asset: () => undefined,
    },
    Domains: {
      label: DOMAIN_NAME,
      ocsf: "cloud_resources_inventory_info",
      list: async function* (ctx) {
        yield* await pages<{ id: string; isVerified: boolean; isDefault: boolean }>(
          ctx,
          `${GRAPH}/domains`,
        );
      },
      map: (d: { id: string; isVerified: boolean }) => ({
        native_id: d.id,
        display_name: d.id,
        props: { status: d.isVerified ? "verified" : "unverified" },
      }),
      asset: (d: { isVerified: boolean; isDefault: boolean }) => ({
        kind: "domain",
        facts: { verified: d.isVerified, default: d.isDefault },
      }),
    },
    Users: {
      label: USER_ACCOUNT,
      ocsf: "user_inventory",
      list: async function* (ctx) {
        const users = await pages<User>(
          ctx,
          `${GRAPH}/users?$select=id,displayName,userPrincipalName,accountEnabled,userType&$top=999`,
        );
        const a = await admins(ctx);
        const m = await mfaDetails(ctx);
        const adminSet = new Set((a ?? []).map((x) => (x.userPrincipalName ?? "").toLowerCase()));
        const mfaOf = new Map(
          (m ?? []).map((x) => [x.userPrincipalName.toLowerCase(), x.isMfaRegistered]),
        );
        for (const u of users) {
          const k = u.userPrincipalName.toLowerCase();
          yield {
            ...u,
            ...(a ? { admin: adminSet.has(k) } : {}),
            ...(mfaOf.has(k) ? { mfa: mfaOf.get(k)! } : {}),
          };
        }
      },
      map: (u: User) => ({
        native_id: u.id,
        display_name: u.userPrincipalName,
        props: {
          email: u.userPrincipalName.toLowerCase(),
          active: u.accountEnabled,
          ...(u.admin !== undefined ? { admin: u.admin } : {}),
          ...(u.mfa !== undefined ? { mfa: u.mfa } : {}),
          // A guest: not one of the tenant's members.
          ...((u.userType ?? "Member") !== "Member" ? { service: false } : {}),
        },
      }),
      asset: (u: User) => ({
        kind: "user",
        facts: {
          displayName: u.displayName,
          enabled: u.accountEnabled,
          type: u.userType ?? "Member",
        },
      }),
    },
    Licenses: {
      label: PRODUCT,
      ocsf: "software_info",
      list: async function* (ctx) {
        yield* await pages<Sku>(ctx, `${GRAPH}/subscribedSkus`);
      },
      map: (s: Sku) => ({
        native_id: s.skuId,
        display_name: s.skuPartNumber,
        props: { used: s.consumedUnits, bought: s.prepaidUnits?.enabled ?? 0 },
      }),
      asset: (s: Sku) => ({
        kind: "license",
        facts: { used: s.consumedUnits, bought: s.prepaidUnits?.enabled ?? 0 },
      }),
    },
    "Global Administrators": {
      label: ACCESS_CONTROL_GROUP,
      ocsf: "cloud_resources_inventory_info",
      list: async function* (ctx) {
        const a = await admins(ctx);
        if (a) yield a;
      },
      map: (a: Admin[]) => ({
        native_id: GLOBAL_ADMIN,
        display_name: "Global Administrator",
        props: {
          members: a.length,
          member_names: a.map((x) => x.userPrincipalName ?? "?").join(", "),
        },
      }),
      asset: () => undefined,
    },
    "MFA registration": {
      label: ASSESSMENT,
      ocsf: "evidence_info",
      list: async function* (ctx) {
        const m = await mfaDetails(ctx);
        if (m) yield m;
      },
      map: (m: MfaDetail[]) => ({
        native_id: "userRegistrationDetails",
        display_name: "MFA registration",
        props: {
          registered: m.filter((x) => x.isMfaRegistered).length,
          unregistered: m.filter((x) => !x.isMfaRegistered).map((x) => x.userPrincipalName),
        },
      }),
      asset: () => undefined,
    },
    "Security defaults": {
      label: POLICY,
      ocsf: "cloud_resources_inventory_info",
      list: async function* (ctx) {
        yield await ctx.json<{ id?: string; isEnabled: boolean }>(
          `${GRAPH}/policies/identitySecurityDefaultsEnforcementPolicy`,
        );
      },
      map: (p: { id?: string; isEnabled: boolean }) => ({
        native_id: p.id ?? "identitySecurityDefaultsEnforcementPolicy",
        display_name: "Security defaults",
        props: { type: SECURITY_DEFAULTS, enabled: p.isEnabled === true },
      }),
      asset: () => undefined,
    },
    "Conditional Access": {
      label: POLICY,
      ocsf: "cloud_resources_inventory_info",
      list: async function* (ctx) {
        yield* await pages<CaPolicy>(ctx, `${GRAPH}/identity/conditionalAccess/policies`);
      },
      map: (p: CaPolicy) => ({
        native_id: p.id ?? "",
        display_name: p.displayName ?? p.id ?? "",
        props: { type: CONDITIONAL_ACCESS, enabled: p.state === "enabled" },
      }),
      asset: () => undefined,
    },
    // Azure: only when the app was given Reader on a subscription. Anything that goes wrong is a gap.
    Azure: {
      label: RESOURCE,
      ocsf: "cloud_resources_inventory_info",
      list: async function* (ctx): AsyncGenerator<Azure> {
        try {
          const a = {
            Authorization: `Bearer ${await token(ctx.http, ctx.cred, `${ARM}/.default`)}`,
          };
          const subs = await pages<{ subscriptionId: string; displayName: string; state: string }>(
            ctx,
            `${ARM}/subscriptions?api-version=2022-12-01`,
            a,
          );
          for (const s of subs) {
            yield { sub: s };
            for (
              const r of await ctx.orGap(
                `Azure ${s.displayName}`,
                [] as Array<{ id: string; name: string; type: string; location: string }>,
                () =>
                  pages(
                    ctx,
                    `${ARM}/subscriptions/${s.subscriptionId}/resources?api-version=2021-04-01`,
                    a,
                  ),
              )
            ) yield { res: r, subscription: s.displayName };
          }
        } catch (e) {
          throw e instanceof AccessDenied ? e : new AccessDenied((e as Error).message);
        }
      },
      map: (x: Azure) =>
        "sub" in x
          ? {
            native_id: x.sub.subscriptionId,
            display_name: x.sub.displayName,
            props: { type: "subscription", state: x.sub.state },
          }
          : {
            native_id: x.res.id,
            display_name: x.res.name,
            where: x.res.location,
            props: { type: x.res.type, region: x.res.location, subscription: x.subscription },
          },
      asset: (x: Azure): { kind: string; facts: Record<string, string> } =>
        "sub" in x
          ? { kind: "azure-subscription", facts: { state: x.sub.state } }
          : { kind: "azure-resource", facts: { type: x.res.type, subscription: x.subscription } },
    },
  },
  posture(records, _cred, { gaps }) {
    const posture: Record<string, string | number | boolean> = {};
    const of = (l: { name: string }) => records.filter((r) => r.label === l.name);
    const read = (what: string) => !gaps.some((g) => g.startsWith(`${what}: `));
    const role = of(ACCESS_CONTROL_GROUP).find((r) => r.native_id === GLOBAL_ADMIN);
    if (role) {
      posture.globalAdmins = role.props.members as number;
      posture.globalAdminNames = role.props.member_names as string;
    }
    const mfa = of(ASSESSMENT)[0];
    if (mfa) {
      const users = of(USER_ACCOUNT);
      const enabled = new Set(
        users.filter((u) => u.props.active && u.props.service === undefined).map((u) =>
          u.display_name
        ),
      );
      const without = (mfa.props.unregistered as string[]).filter((n) =>
        !users.length || enabled.has(n)
      );
      posture.membersWithoutMfa = without.length;
      posture.membersWithoutMfaNames = without.slice(0, 20).join(", ");
    }
    if (read("Security defaults") || read("Conditional Access")) {
      posture.mfaEnforced = of(POLICY).some((p) => p.props.enabled);
    }
    if (read("Azure")) {
      posture.azureSubscriptions = of(RESOURCE).filter((r) => r.props.type === "subscription")
        .length;
    }
    return posture;
  },
  policies(o, now) {
    return [
      fresh(o, now, "microsoft"),
      check(o, {
        id: "ms-mfa-enforced",
        title: "MFA is enforced (security defaults or Conditional Access)",
        scf: ["IAC-37"],
        fact: "mfaEnforced",
        want: (v) => v === true,
        fix:
          "entra.microsoft.com > Overview > Properties > Manage security defaults: Enabled (or a Conditional Access policy requiring MFA)",
      }),
      check(o, {
        id: "ms-mfa-registered",
        title: "Every member has registered MFA",
        scf: ["IAC-37"],
        fact: "membersWithoutMfa",
        show: (v) =>
          `${v} member(s) without MFA${v ? `: ${o.posture.membersWithoutMfaNames ?? ""}` : ""}`,
        want: (v) => v === 0,
        fix: `ask each person in membersWithoutMfaNames to sign in at aka.ms/mysecurityinfo: ${
          o.posture.membersWithoutMfaNames ?? ""
        }`.trim(),
      }),
      check(o, {
        id: "ms-global-admins",
        title: "Two to four Global Administrators",
        scf: ["IAC-30"],
        fact: "globalAdmins",
        show: (v) => `${v}: ${o.posture.globalAdminNames ?? "?"}`,
        want: (v) => typeof v === "number" && v >= 2 && v <= 4,
        fix: `entra.microsoft.com > Roles and administrators > Global Administrator (now: ${
          o.posture.globalAdminNames ?? "?"
        })`,
        warnOnly: true,
      }),
    ];
  },
});

interface Sku {
  skuId: string;
  skuPartNumber: string;
  consumedUnits: number;
  prepaidUnits?: { enabled: number };
}

interface CaPolicy {
  id?: string;
  displayName?: string;
  state: string;
}
