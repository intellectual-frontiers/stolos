/**
 * Spec 067 (clouds), declared with spec 091's SDK: Cloudflare, read-only:
 * accounts, zones and their DNS records, Workers, Pages projects, R2
 * buckets, and tunnels; each zone's TLS settings and DNSSEC for the posture
 * policies.
 *
 * @module
 */

import { check, type Connector, fresh, type Observation } from "./connector.ts";
import type { PolicyResult } from "../adopt/policy.ts";
import { type Ctx, defineConnector, type FieldDef, mustRead } from "./sdk.ts";
import { ACCOUNT, CLOUD_STORAGE, DNS_RECORD, DOMAIN_NAME, SOFTWARE } from "./labels.ts";

const API = "https://api.cloudflare.com/client/v4";

interface Page<T> {
  result: T[];
  result_info?: { page: number; total_pages: number };
}

interface CfAccount {
  id: string;
  name: string;
}

interface Zone {
  id: string;
  name: string;
  status: string;
  plan?: { name: string };
  /** Added here: the zone's settings (undefined: not readable). */
  ssl?: string | undefined;
  always?: string | undefined;
  minTls?: string | undefined;
  dnssec?: string | undefined;
}

interface DnsRecord {
  id: string;
  type: string;
  name: string;
  content: string;
  proxied?: boolean;
  /** Added here: its zone's name. */
  zone: string;
}

interface R2Bucket {
  name: string;
  location?: string;
  creation_date?: string;
}

type Fields = { token: FieldDef };

/** What one observation has read so far: the accounts and zones the other resources go through. */
const seen = new WeakMap<object, { accounts: CfAccount[]; zones: Zone[] }>();
const state = (ctx: Ctx<Fields>) => {
  let s = seen.get(ctx);
  if (!s) seen.set(ctx, (s = { accounts: [], zones: [] }));
  return s;
};

async function all<T>(ctx: Ctx<Fields>, path: string): Promise<T[]> {
  const out: T[] = [];
  for (let page = 1; page <= 50; page++) {
    const sep = path.includes("?") ? "&" : "?";
    const r = await ctx.json<Page<T>>(`${API}${path}${sep}per_page=50&page=${page}`);
    out.push(...(r.result ?? []));
    if (!r.result_info || page >= r.result_info.total_pages) break;
  }
  return out;
}

async function one<T>(ctx: Ctx<Fields>, path: string): Promise<T> {
  return (await ctx.json<{ result: T }>(`${API}${path}`)).result;
}

/** Each account's items of one kind, a denied account's a gap named `what`. */
async function* perAccount<T>(
  ctx: Ctx<Fields>,
  what: string,
  read: (at: string) => Promise<T[]>,
): AsyncGenerator<T & { account: string }> {
  for (const a of state(ctx).accounts) {
    for (const x of await ctx.orGap(what, [] as T[], () => read(`/accounts/${a.id}`))) {
      yield { ...x, account: a.name };
    }
  }
}

/** Cloudflare. */
export const cloudflare: Connector = defineConnector({
  id: "cloudflare",
  title: "Cloudflare",
  logo: "cloudflare",
  serviceModels: ["SaaS", "PaaS"],
  markets: ["edge-development-platforms"],
  connectHelp: [
    "dash.cloudflare.com > My Profile > API Tokens > Create Token > Create Custom Token",
    "Permissions, all Read: Account Settings, Workers Scripts, Workers R2 Storage, Cloudflare Pages, Cloudflare Tunnel; Zone, Zone Settings, DNS",
    "Account Resources: your account; Zone Resources: All zones from that account",
    "Create Token, then copy it (Cloudflare shows it once)",
  ],
  recipe: {
    open: {
      href: "https://dash.cloudflare.com/profile/api-tokens",
      label: "Open Cloudflare's API Tokens page",
    },
  },
  fields: { token: { secret: true, hint: "the API token (read-only)" } },
  auth: (cred) => Promise.resolve({ Authorization: `Bearer ${cred.token}` }),
  account: (_cred, records) =>
    records
      .filter((r) => r.label === ACCOUNT.name)
      .map((r) => r.display_name)
      .join(", ") || "(no account readable)",
  resources: {
    accounts: {
      label: ACCOUNT,
      ocsf: "cloud_resources_inventory_info",
      async *list(ctx) {
        // Without its accounts, the token reads nothing: fail loudly.
        const accounts = await mustRead(() => all<CfAccount>(ctx, "/accounts"));
        state(ctx).accounts = accounts;
        yield* accounts;
      },
      map: (a: CfAccount) => ({ native_id: a.id, display_name: a.name, props: {} }),
      asset: () => ({ kind: "account" }),
    },
    workers: {
      label: SOFTWARE,
      ocsf: "cloud_resources_inventory_info",
      list: (ctx) =>
        perAccount(ctx, "Workers", (at) =>
          all<{ id: string; modified_on?: string }>(ctx, `${at}/workers/scripts`),
        ),
      map: (w: { id: string; modified_on?: string; account: string }) => ({
        native_id: w.id,
        display_name: w.id,
        where: w.account,
        props: { kind: "worker", ...(w.modified_on ? { modified: w.modified_on } : {}) },
      }),
      asset: (w: { modified_on?: string }) => ({
        kind: "worker",
        facts: { modified: (w.modified_on ?? "").slice(0, 10) },
      }),
    },
    pages: {
      label: SOFTWARE,
      ocsf: "cloud_resources_inventory_info",
      list: (ctx) =>
        perAccount(ctx, "Pages", (at) =>
          all<{ id: string; name: string; subdomain?: string }>(ctx, `${at}/pages/projects`),
        ),
      map: (p: { id: string; name: string; account: string }) => ({
        native_id: p.id,
        display_name: p.name,
        where: p.account,
        props: { kind: "pages" },
      }),
      asset: (p: { subdomain?: string }) => ({
        kind: "pages-project",
        facts: { subdomain: p.subdomain ?? "" },
      }),
    },
    r2: {
      label: CLOUD_STORAGE,
      ocsf: "cloud_resources_inventory_info",
      list: (ctx) =>
        perAccount(
          ctx,
          "R2",
          async (at) =>
            (await one<{ buckets?: R2Bucket[] }>(ctx, `${at}/r2/buckets`)).buckets ?? [],
        ),
      map: (b: R2Bucket & { account: string }) => ({
        native_id: b.name,
        display_name: b.name,
        where: b.location ?? b.account,
        props: {
          ...(b.location ? { region: b.location } : {}),
          ...(b.creation_date ? { created: b.creation_date } : {}),
        },
      }),
      asset: (b: R2Bucket) => ({
        kind: "r2-bucket",
        facts: { created: (b.creation_date ?? "").slice(0, 10) },
      }),
    },
    tunnels: {
      label: SOFTWARE,
      ocsf: "cloud_resources_inventory_info",
      list: (ctx) =>
        perAccount(ctx, "Tunnels", (at) =>
          all<{ id: string; name: string; status?: string }>(
            ctx,
            `${at}/cfd_tunnel?is_deleted=false`,
          ),
        ),
      map: (t: { id: string; name: string; status?: string; account: string }) => ({
        native_id: t.id,
        display_name: t.name,
        where: t.account,
        props: { kind: "tunnel", ...(t.status ? { status: t.status } : {}) },
      }),
      asset: (t: { status?: string }) => ({ kind: "tunnel", facts: { status: t.status ?? "" } }),
    },
    zones: {
      label: DOMAIN_NAME,
      ocsf: "cloud_resources_inventory_info",
      async *list(ctx) {
        // A token that cannot list its zones fails loudly.
        const zones = await mustRead(() => all<Zone>(ctx, "/zones"));
        for (const z of zones) {
          const zs = `/zones/${z.id}`;
          const setting = (name: string) =>
            ctx.orGap(`${z.name} ${name}`, undefined as string | undefined, async () =>
              String((await one<{ value: unknown }>(ctx, `${zs}/settings/${name}`)).value),
            );
          const ssl = await setting("ssl");
          const always = await setting("always_use_https");
          const minTls = await setting("min_tls_version");
          const dnssec = await ctx.orGap(
            `${z.name} DNSSEC`,
            undefined as string | undefined,
            async () => (await one<{ status: string }>(ctx, `${zs}/dnssec`)).status,
          );
          const read: Zone = { ...z, ssl, always, minTls, dnssec };
          state(ctx).zones.push(read);
          yield read;
        }
      },
      map: (z: Zone) => ({
        native_id: z.id,
        display_name: z.name,
        props: {
          status: z.status,
          ...(z.dnssec !== undefined ? { dnssec: z.dnssec === "active" } : {}),
          ...(z.ssl !== undefined ? { ssl: z.ssl } : {}),
          ...(z.always !== undefined ? { always_use_https: z.always } : {}),
          ...(z.minTls !== undefined ? { min_tls_version: z.minTls } : {}),
        },
      }),
      asset: (z: Zone) => ({
        kind: "zone",
        facts: {
          status: z.status,
          plan: z.plan?.name ?? "",
          ssl: z.ssl ?? "?",
          alwaysHttps: z.always ?? "?",
          minTls: z.minTls ?? "?",
          dnssec: z.dnssec ?? "?",
        },
      }),
    },
    dns: {
      label: DNS_RECORD,
      ocsf: "cloud_resources_inventory_info",
      async *list(ctx) {
        for (const z of state(ctx).zones) {
          const records = await ctx.orGap(`${z.name} DNS`, [] as Omit<DnsRecord, "zone">[], () =>
            all<Omit<DnsRecord, "zone">>(ctx, `/zones/${z.id}/dns_records`),
          );
          for (const r of records) yield { ...r, zone: z.name };
        }
      },
      map: (r: DnsRecord) => ({
        native_id: r.id,
        display_name: r.name,
        where: r.zone,
        props: { type: r.type, content: r.content, proxied: r.proxied === true },
      }),
      asset: (r: DnsRecord) => ({
        kind: "dns-record",
        facts: { type: r.type, content: r.content, proxied: r.proxied === true },
      }),
    },
  },
  posture(records): Observation["posture"] {
    const zones = records.filter((r) => r.label === DOMAIN_NAME.name).map((r) => r.props);
    if (!zones.length) return {};
    const minTls = (v: unknown) => typeof v === "string" && v !== "" && parseFloat(v) >= 1.2;
    return {
      zones: zones.length,
      zonesStrictTls: zones.filter((p) => p["ssl"] === "strict" || p["ssl"] === "full_strict")
        .length,
      zonesAlwaysHttps: zones.filter((p) => p["always_use_https"] === "on").length,
      zonesMinTls12: zones.filter((p) => minTls(p["min_tls_version"])).length,
      zonesDnssec: zones.filter((p) => p["dnssec"] === true).length,
    };
  },
  policies(o, now): PolicyResult[] {
    const every = (v: unknown) => v === o.posture["zones"];
    const zoneFix = "dash.cloudflare.com > the zone > SSL/TLS";
    return [
      fresh(o, now, "cloudflare"),
      check(o, {
        id: "cf-tls-strict",
        title: "Every zone verifies the origin's certificate (Full strict)",
        scf: ["CRY-05", "NET-37"],
        fact: "zonesStrictTls",
        want: every,
        show: (v) => `${v} of ${o.posture["zones"]} zone(s)`,
        fix: `${zoneFix} > Overview > Full (strict)`,
      }),
      check(o, {
        id: "cf-always-https",
        title: "Every zone redirects HTTP to HTTPS",
        scf: ["CRY-05"],
        fact: "zonesAlwaysHttps",
        want: every,
        show: (v) => `${v} of ${o.posture["zones"]} zone(s)`,
        fix: `${zoneFix} > Edge Certificates > Always Use HTTPS`,
      }),
      check(o, {
        id: "cf-min-tls",
        title: "Every zone refuses TLS older than 1.2",
        scf: ["CRY-05"],
        fact: "zonesMinTls12",
        want: every,
        show: (v) => `${v} of ${o.posture["zones"]} zone(s)`,
        fix: `${zoneFix} > Edge Certificates > Minimum TLS Version: 1.2`,
      }),
      check(o, {
        id: "cf-dnssec",
        title: "Every zone signs its DNS (DNSSEC)",
        scf: ["NET-13"],
        fact: "zonesDnssec",
        want: every,
        show: (v) => `${v} of ${o.posture["zones"]} zone(s)`,
        fix: "dash.cloudflare.com > the zone > DNS > Settings > Enable DNSSEC (then add the DS record at the registrar)",
        warnOnly: true,
      }),
    ];
  },
});
