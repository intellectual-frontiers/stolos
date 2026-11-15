/**
 * Spec 067 (clouds): Microsoft 365 (Entra ID, through Microsoft Graph) and
 * Azure (through Resource Manager), read-only, with one app registration's
 * client credentials: the tenant, its domains, users and licenses, who is a
 * Global Administrator, whether people have MFA, and Azure's subscriptions
 * and resources.
 *
 * @module
 */

import {
  type Asset,
  check,
  type Connector,
  fresh,
  getJson,
  type Http,
  orGap,
} from "./connector.ts";

const GRAPH = "https://graph.microsoft.com/v1.0";
const ARM = "https://management.azure.com";
const GLOBAL_ADMIN = "62e90394-69f5-4237-9190-012177145e10";

async function token(http: Http, c: Record<string, string>, scope: string): Promise<string> {
  const body = new URLSearchParams({
    client_id: c.clientId,
    client_secret: c.clientSecret,
    scope,
    grant_type: "client_credentials",
  }).toString();
  const r = await getJson<{ access_token: string }>(
    http,
    `https://login.microsoftonline.com/${encodeURIComponent(c.tenant)}/oauth2/v2.0/token`,
    { "Content-Type": "application/x-www-form-urlencoded" },
    "POST",
    body,
  );
  return r.access_token;
}

async function pages<T>(http: Http, url: string, auth: Record<string, string>): Promise<T[]> {
  const out: T[] = [];
  let next: string | undefined = url;
  for (let i = 0; next && i < 100; i++) {
    const r: { value: T[]; "@odata.nextLink"?: string; nextLink?: string } = await getJson(
      http,
      next,
      auth,
    );
    out.push(...(r.value ?? []));
    next = r["@odata.nextLink"] ?? r.nextLink;
  }
  return out;
}

/** Microsoft 365 and Azure. */
export const microsoft: Connector = {
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
  fields: [
    { name: "tenant", secret: false, hint: "Directory (tenant) ID" },
    { name: "clientId", secret: false, hint: "Application (client) ID" },
    { name: "clientSecret", secret: true, hint: "the client secret's Value" },
  ],
  async observe(cred, http, now) {
    const gaps: string[] = [];
    const assets: Asset[] = [];
    const posture: Record<string, string | number | boolean> = {};
    const g = {
      Authorization: `Bearer ${await token(http, cred, "https://graph.microsoft.com/.default")}`,
    };
    const org = await orGap(
      gaps,
      "Organization",
      [] as Array<{ id: string; displayName: string }>,
      () => pages(http, `${GRAPH}/organization`, g),
    );
    for (
      const d of await orGap(
        gaps,
        "Domains",
        [] as Array<{ id: string; isVerified: boolean; isDefault: boolean }>,
        () => pages(http, `${GRAPH}/domains`, g),
      )
    ) {
      assets.push({
        kind: "domain",
        id: d.id,
        name: d.id,
        facts: { verified: d.isVerified, default: d.isDefault },
      });
    }
    const users = await orGap(
      gaps,
      "Users",
      [] as Array<
        {
          id: string;
          displayName: string;
          userPrincipalName: string;
          accountEnabled: boolean;
          userType?: string;
        }
      >,
      () =>
        pages(
          http,
          `${GRAPH}/users?$select=id,displayName,userPrincipalName,accountEnabled,userType&$top=999`,
          g,
        ),
    );
    for (const u of users) {
      assets.push({
        kind: "user",
        id: u.id,
        name: u.userPrincipalName,
        facts: {
          displayName: u.displayName,
          enabled: u.accountEnabled,
          type: u.userType ?? "Member",
        },
      });
    }
    for (
      const s of await orGap(
        gaps,
        "Licenses",
        [] as Array<
          {
            skuId: string;
            skuPartNumber: string;
            consumedUnits: number;
            prepaidUnits?: { enabled: number };
          }
        >,
        () => pages(http, `${GRAPH}/subscribedSkus`, g),
      )
    ) {
      assets.push({
        kind: "license",
        id: s.skuId,
        name: s.skuPartNumber,
        facts: { used: s.consumedUnits, bought: s.prepaidUnits?.enabled ?? 0 },
      });
    }
    const admins = await orGap(
      gaps,
      "Global Administrators",
      undefined as Array<{ userPrincipalName?: string }> | undefined,
      () => pages(http, `${GRAPH}/directoryRoles(roleTemplateId='${GLOBAL_ADMIN}')/members`, g),
    );
    if (admins) {
      posture.globalAdmins = admins.length;
      posture.globalAdminNames = admins.map((a) => a.userPrincipalName ?? "?").join(", ");
    }
    const mfa = await orGap(
      gaps,
      "MFA registration",
      undefined as
        | Array<{ userPrincipalName: string; isMfaRegistered: boolean; userType?: string }>
        | undefined,
      () => pages(http, `${GRAPH}/reports/authenticationMethods/userRegistrationDetails`, g),
    );
    if (mfa) {
      const enabled = new Set(
        users.filter((u) => u.accountEnabled && (u.userType ?? "Member") === "Member").map((u) =>
          u.userPrincipalName
        ),
      );
      const people = mfa.filter((m) => !users.length || enabled.has(m.userPrincipalName));
      posture.membersWithoutMfa = people.filter((m) => !m.isMfaRegistered).length;
      posture.membersWithoutMfaNames = people.filter((m) => !m.isMfaRegistered).map((m) =>
        m.userPrincipalName
      ).slice(0, 20).join(", ");
    }
    const defaults = await orGap(
      gaps,
      "Security defaults",
      undefined as { isEnabled: boolean } | undefined,
      () => getJson(http, `${GRAPH}/policies/identitySecurityDefaultsEnforcementPolicy`, g),
    );
    const ca = await orGap(
      gaps,
      "Conditional Access",
      undefined as Array<{ state: string }> | undefined,
      () => pages(http, `${GRAPH}/identity/conditionalAccess/policies`, g),
    );
    if (defaults || ca) {
      posture.mfaEnforced = defaults?.isEnabled === true ||
        (ca ?? []).some((p) => p.state === "enabled");
    }
    // Azure: only when the app was given Reader on a subscription.
    try {
      const a = { Authorization: `Bearer ${await token(http, cred, `${ARM}/.default`)}` };
      const subs = await pages<{ subscriptionId: string; displayName: string; state: string }>(
        http,
        `${ARM}/subscriptions?api-version=2022-12-01`,
        a,
      );
      for (const s of subs) {
        assets.push({
          kind: "azure-subscription",
          id: s.subscriptionId,
          name: s.displayName,
          facts: { state: s.state },
        });
        for (
          const r of await orGap(
            gaps,
            `Azure ${s.displayName}`,
            [] as Array<{ id: string; name: string; type: string; location: string }>,
            () =>
              pages(
                http,
                `${ARM}/subscriptions/${s.subscriptionId}/resources?api-version=2021-04-01`,
                a,
              ),
          )
        ) {
          assets.push({
            kind: "azure-resource",
            id: r.id,
            name: r.name,
            where: r.location,
            facts: { type: r.type, subscription: s.displayName },
          });
        }
      }
      posture.azureSubscriptions = subs.length;
    } catch (e) {
      gaps.push(`Azure: ${(e as Error).message}`);
    }
    // Spec 085: its people's accounts, for the estate graph.
    const adminSet = new Set((admins ?? []).map((a) => (a.userPrincipalName ?? "").toLowerCase()));
    const mfaOf = new Map(
      (mfa ?? []).map((m) => [m.userPrincipalName.toLowerCase(), m.isMfaRegistered]),
    );
    const accounts = users.map((u) => {
      const k = u.userPrincipalName.toLowerCase();
      return {
        system: "microsoft",
        id: u.id,
        name: u.userPrincipalName,
        email: k,
        active: u.accountEnabled,
        ...(admins ? { admin: adminSet.has(k) } : {}),
        ...(mfaOf.has(k) ? { mfa: mfaOf.get(k)! } : {}),
        ...((u.userType ?? "Member") !== "Member" ? { service: false } : {}),
      };
    });
    return {
      at: now.toISOString().replace(/\.\d+Z$/, "Z"),
      provider: "microsoft",
      account: org[0]?.displayName ?? cred.tenant,
      assets,
      posture,
      gaps,
      entities: { accounts },
    };
  },
  policies(o, now) {
    return [
      fresh(o, now, "microsoft"),
      check(o, {
        id: "ms-mfa-enforced",
        title: "MFA is enforced (security defaults or Conditional Access)",
        scf: ["IAC-06"],
        fact: "mfaEnforced",
        want: (v) => v === true,
        fix:
          "entra.microsoft.com > Overview > Properties > Manage security defaults: Enabled (or a Conditional Access policy requiring MFA)",
      }),
      check(o, {
        id: "ms-mfa-registered",
        title: "Every member has registered MFA",
        scf: ["IAC-06"],
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
        scf: ["IAC-21"],
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
};
