/**
 * Spec 088: Google Cloud, read-only, for one project: its resources (Cloud
 * Asset Inventory, `assets.list`), who holds which role on the project (Cloud
 * Asset Inventory's `searchAllIamPolicies`, a GET), its service accounts and
 * their user-managed keys (IAM), and where its logs are routed (Cloud
 * Logging's sinks). Evidence for least privilege (SCF IAC-30), public access
 * (DCH-02), long-lived keys (IAC-10), and audit logging (MON-03).
 *
 * Credential: a service account's JSON key, with the read-only roles Cloud
 * Asset Viewer (`roles/cloudasset.viewer`), Security Reviewer
 * (`roles/iam.securityReviewer`), and Logs Viewer (`roles/logging.viewer`) on
 * the project; it signs in with the scope `cloud-platform.read-only` (the JWT
 * is signed here, RS256, as for Google Workspace). Docs:
 * https://cloud.google.com/asset-inventory/docs/reference/rest,
 * https://cloud.google.com/iam/docs/reference/rest, and
 * https://cloud.google.com/logging/docs/reference/v2/rest.
 *
 * @module
 */
// Spec: 088-wave3-registry

import { http } from "@intellectual-frontiers/commons/ts/runtime";
import { check, type Connector, fresh } from "./connector.ts";
import { type Ctx, defineConnector, type ObservedRecord, sendJson } from "./sdk.ts";
import { serviceAccountJwt } from "./google.ts";
import { ACCESS_CONTROL_GROUP, CLOUD_USER_ACCOUNT, EVENT_LOG, RESOURCE } from "./labels.ts";

const TOKEN = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/cloud-platform.read-only";
const ASSET = "https://cloudasset.googleapis.com/v1";
const IAM = "https://iam.googleapis.com/v1";
const LOGGING = "https://logging.googleapis.com/v2";

/** Members who are anyone at all: a binding to them makes the project's resources public. */
const PUBLIC = ["allUsers", "allAuthenticatedUsers"];

interface Asset {
  name: string;
  assetType: string;
  updateTime?: string;
}

interface Binding {
  role: string;
  members?: string[];
}

interface ServiceAccount {
  email: string;
  uniqueId: string;
  disabled?: boolean;
  /** Added here: its user-managed keys (undefined: not readable). */
  keys?: number;
}

interface Sink {
  name: string;
  destination: string;
  disabled?: boolean;
}

/** Google's own sinks, there in every project. */
const GOOGLE_SINKS = ["_Required", "_Default"];

/** Every item of a Google list that pages with nextPageToken. */
function pages<T>(ctx: Ctx<typeof FIELDS>, url: string, key: string): AsyncGenerator<T> {
  const join = url.includes("?") ? "&" : "?";
  return ctx.cursorPages<Record<string, unknown> & { nextPageToken?: string }, T>(
    url,
    (b) => b[key] as T[] | undefined,
    (b) =>
      b.nextPageToken ? `${url}${join}pageToken=${encodeURIComponent(b.nextPageToken)}` : undefined,
  );
}

const FIELDS = {
  project: { secret: false, hint: "the project's ID (not its name or number)" },
  key: { secret: true, file: true, hint: "the service account's JSON key file (its path)" },
};

/** Google Cloud (one project). */
export const gcp: Connector = defineConnector({
  id: "gcp",
  title: "Google Cloud",
  logo: "googlecloud",
  serviceModels: ["IaaS", "PaaS"],
  markets: ["strategic-cloud-platform-services"],
  connectHelp: [
    "console.cloud.google.com > the project > APIs & Services: enable the Cloud Asset API",
    "IAM & Admin > Service accounts > Create: stolos-read; grant only the read-only roles Cloud Asset Viewer, Security Reviewer, and Logs Viewer",
    "The service account > Keys > Add key > JSON: a key file downloads",
  ],
  recipe: {
    shell: {
      where: "Cloud Shell (the >_ icon in the console), in the project, as an owner",
      href: "https://shell.cloud.google.com",
      command:
        'P=$(gcloud config get-value project) && gcloud iam service-accounts create stolos-read && for r in cloudasset.viewer iam.securityReviewer logging.viewer; do gcloud projects add-iam-policy-binding "$P" --member "serviceAccount:stolos-read@$P.iam.gserviceaccount.com" --role "roles/$r" --condition None; done && gcloud iam service-accounts keys create stolos-read.json --iam-account "stolos-read@$P.iam.gserviceaccount.com"',
    },
  },
  fields: FIELDS,
  tokenEndpoints: () => [TOKEN],
  async auth(cred, t, now) {
    const key = JSON.parse(cred.key) as { client_email: string; private_key: string };
    const assertion = await serviceAccountJwt(key, key.client_email, SCOPE, now);
    const tok = await sendJson<{ access_token: string }>(
      t,
      TOKEN,
      { "Content-Type": "application/x-www-form-urlencoded" },
      "POST",
      new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion,
      }).toString(),
    );
    return http.bearer(tok.access_token);
  },
  account: (cred) => cred.project,
  resources: {
    assets: {
      label: RESOURCE,
      ocsf: "cloud_resources_inventory_info",
      list: (ctx) =>
        pages<Asset>(ctx, `${ASSET}/projects/${ctx.cred.project}/assets?pageSize=1000`, "assets"),
      map: (a: Asset) => ({
        native_id: a.name,
        display_name: a.name.split("/").pop() ?? a.name,
        props: { type: a.assetType },
      }),
      asset: (a: Asset) => ({ kind: "gcp-resource", facts: { type: a.assetType } }),
    },
    roles: {
      label: ACCESS_CONTROL_GROUP,
      ocsf: "cloud_resources_inventory_info",
      async *list(ctx): AsyncGenerator<Binding> {
        const self = `//cloudresourcemanager.googleapis.com/projects/${ctx.cred.project}`;
        const by = new Map<string, Set<string>>();
        for await (const r of pages<{ resource: string; policy?: { bindings?: Binding[] } }>(
          ctx,
          `${ASSET}/projects/${ctx.cred.project}:searchAllIamPolicies?pageSize=500`,
          "results",
        )) {
          for (const b of r.policy?.bindings ?? []) {
            // The project's own roles, and any binding anywhere to anyone at all.
            const pub = (b.members ?? []).filter((m) => PUBLIC.includes(m));
            if (r.resource !== self && !pub.length) continue;
            const role = r.resource === self ? b.role : `${b.role} on ${r.resource}`;
            const s = by.get(role) ?? new Set<string>();
            for (const m of r.resource === self ? (b.members ?? []) : pub) s.add(m);
            by.set(role, s);
          }
        }
        for (const [role, members] of [...by].sort(([a], [b]) => a.localeCompare(b))) {
          yield { role, members: [...members].sort() };
        }
      },
      map: (b: Binding) => ({
        native_id: b.role,
        display_name: b.role,
        props: { members: b.members?.length ?? 0, member_names: (b.members ?? []).join(", ") },
      }),
      asset: () => undefined,
    },
    serviceAccounts: {
      label: CLOUD_USER_ACCOUNT,
      ocsf: "cloud_resources_inventory_info",
      async *list(ctx): AsyncGenerator<ServiceAccount> {
        for await (const sa of pages<ServiceAccount>(
          ctx,
          `${IAM}/projects/${ctx.cred.project}/serviceAccounts?pageSize=100`,
          "accounts",
        )) {
          const keys = await ctx.orGap(
            `${sa.email} keys`,
            undefined as number | undefined,
            async () =>
              (
                (
                  await ctx.json<{ keys?: unknown[] }>(
                    `${IAM}/projects/${ctx.cred.project}/serviceAccounts/${encodeURIComponent(
                      sa.email,
                    )}/keys?keyTypes=USER_MANAGED`,
                  )
                ).keys ?? []
              ).length,
          );
          yield { ...sa, ...(keys !== undefined ? { keys } : {}) };
        }
      },
      map: (sa: ServiceAccount) => ({
        native_id: sa.uniqueId,
        display_name: sa.email,
        props: sa.keys !== undefined ? { access_keys: sa.keys } : {},
      }),
      asset: (sa: ServiceAccount) => ({
        kind: "service-account",
        facts: { disabled: !!sa.disabled, ...(sa.keys !== undefined ? { keys: sa.keys } : {}) },
      }),
    },
    sinks: {
      label: EVENT_LOG,
      ocsf: "cloud_resources_inventory_info",
      list: (ctx) =>
        pages<Sink>(ctx, `${LOGGING}/projects/${ctx.cred.project}/sinks?pageSize=200`, "sinks"),
      map: (s: Sink) => ({
        native_id: s.name,
        display_name: s.name,
        props: { kind: "log-sink", logging: !s.disabled, destination: s.destination },
      }),
      asset: () => undefined,
    },
  },
  posture(records, cred, { gaps }) {
    const read = (what: string) => !gaps.some((g) => g.startsWith(`${what}: `));
    const out: Record<string, string | number | boolean> = {};
    const roles = records.filter((r) => r.label === ACCESS_CONTROL_GROUP.name);
    if (read("roles")) {
      const owners = roles.find((r) => r.native_id === "roles/owner");
      out["owners"] = (owners?.props["members"] as number | undefined) ?? 0;
      const names = (r: ObservedRecord | undefined): string => {
        const v = r?.props["member_names"];
        return typeof v === "string" ? v : "";
      };
      out["ownerNames"] = names(owners);
      const pub = roles.filter((r) => PUBLIC.some((p) => names(r).includes(p)));
      out["publicBindings"] = pub.length;
      out["publicBindingNames"] = pub
        .map((r) => r.native_id)
        .slice(0, 10)
        .join(", ");
    }
    // Keys are counted only for the service accounts whose keys could be read.
    // Stolos's own service account has the one key it signs in with: not counted.
    let self = "";
    try {
      self = (JSON.parse(cred.key) as { client_email?: string }).client_email ?? "";
    } catch {
      /* not a key file: every account counts */
    }
    const sas = records.filter(
      (r) => r.label === CLOUD_USER_ACCOUNT.name && r.display_name !== self,
    );
    if (read("serviceAccounts") && sas.every((r) => r.props["access_keys"] !== undefined)) {
      out["serviceAccountKeys"] = sas.reduce((n, r) => n + (r.props["access_keys"] as number), 0);
    }
    if (read("sinks")) {
      out["logSinks"] = records.filter(
        (r) =>
          r.label === EVENT_LOG.name && r.props["logging"] && !GOOGLE_SINKS.includes(r.native_id),
      ).length;
    }
    return out;
  },
  policies(o, now) {
    return [
      fresh(o, now, "gcp"),
      check(o, {
        id: "gcp-public",
        title: "No role is granted to everyone (allUsers, allAuthenticatedUsers)",
        scf: ["DCH-02"],
        fact: "publicBindings",
        want: (v) => v === 0,
        show: (v) => `${v}${v ? `: ${o.posture["publicBindingNames"] ?? ""}` : ""}`,
        fix: "console.cloud.google.com > IAM & Admin > IAM (or the resource's permissions): remove allUsers and allAuthenticatedUsers",
      }),
      check(o, {
        id: "gcp-owners",
        title: "Two to four owners of the project",
        scf: ["IAC-30"],
        fact: "owners",
        want: (v) => typeof v === "number" && v >= 2 && v <= 4,
        show: (v) => `${v}: ${o.posture["ownerNames"] ?? ""}`,
        fix: "IAM & Admin > IAM: give the rest narrower roles than Owner",
        warnOnly: true,
      }),
      check(o, {
        id: "gcp-sa-keys",
        title: "No service account has a user-managed key",
        scf: ["IAC-10"],
        fact: "serviceAccountKeys",
        want: (v) => v === 0,
        show: (v) => `${v} key(s)`,
        fix: "IAM & Admin > Service accounts > each one > Keys: delete them, and use workload identity federation instead (Stolos's own key is not counted)",
        warnOnly: true,
      }),
      check(o, {
        id: "gcp-log-sink",
        title: "The project's logs are also routed somewhere of the fleet's own",
        scf: ["MON-03", "MON-13"],
        fact: "logSinks",
        want: (v) => typeof v === "number" && v > 0,
        show: (v) => `${v} sink(s) besides Google's _Required and _Default`,
        fix: "Logging > Log Router > Create sink: to a bucket with a locked retention policy (or a SIEM)",
        warnOnly: true,
      }),
    ];
  },
});
