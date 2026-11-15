/**
 * Spec 067 (clouds): Cloudflare, read-only: accounts, zones and their DNS
 * records, Workers, Pages projects, R2 buckets, and tunnels; each zone's
 * TLS settings and DNSSEC for the posture policies.
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
  type Observation,
  orGap,
} from "./connector.ts";
import type { PolicyResult } from "../adopt/policy.ts";

const API = "https://api.cloudflare.com/client/v4";

interface Page<T> {
  result: T[];
  result_info?: { page: number; total_pages: number };
}

async function all<T>(http: Http, path: string, auth: Record<string, string>): Promise<T[]> {
  const out: T[] = [];
  for (let page = 1; page <= 50; page++) {
    const sep = path.includes("?") ? "&" : "?";
    const r = await getJson<Page<T>>(http, `${API}${path}${sep}per_page=50&page=${page}`, auth);
    out.push(...(r.result ?? []));
    if (!r.result_info || page >= r.result_info.total_pages) break;
  }
  return out;
}

async function one<T>(http: Http, path: string, auth: Record<string, string>): Promise<T> {
  return (await getJson<{ result: T }>(http, `${API}${path}`, auth)).result;
}

/** Cloudflare. */
export const cloudflare: Connector = {
  id: "cloudflare",
  serviceModels: ["SaaS", "PaaS"],
  markets: ["edge-development-platforms"],
  title: "Cloudflare",
  logo: "cloudflare",
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
  fields: [{ name: "token", secret: true, hint: "the API token (read-only)" }],
  async observe(cred, http, now) {
    const auth = { Authorization: `Bearer ${cred.token}` };
    const gaps: string[] = [];
    const assets: Asset[] = [];
    const posture: Observation["posture"] = {};
    const accounts = await all<{ id: string; name: string }>(http, "/accounts", auth);
    for (const a of accounts) {
      assets.push({ kind: "account", id: a.id, name: a.name });
      const at = `/accounts/${a.id}`;
      for (
        const w of await orGap(
          gaps,
          "Workers",
          [],
          () => all<{ id: string; modified_on?: string }>(http, `${at}/workers/scripts`, auth),
        )
      ) {
        assets.push({
          kind: "worker",
          id: w.id,
          name: w.id,
          where: a.name,
          facts: { modified: (w.modified_on ?? "").slice(0, 10) },
        });
      }
      for (
        const p of await orGap(
          gaps,
          "Pages",
          [],
          () =>
            all<{ id: string; name: string; subdomain?: string }>(
              http,
              `${at}/pages/projects`,
              auth,
            ),
        )
      ) {
        assets.push({
          kind: "pages-project",
          id: p.id,
          name: p.name,
          where: a.name,
          facts: { subdomain: p.subdomain ?? "" },
        });
      }
      const r2 = await orGap(
        gaps,
        "R2",
        { buckets: [] as Array<{ name: string; location?: string; creation_date?: string }> },
        () =>
          one<{ buckets: Array<{ name: string; location?: string; creation_date?: string }> }>(
            http,
            `${at}/r2/buckets`,
            auth,
          ),
      );
      for (const b of r2.buckets ?? []) {
        assets.push({
          kind: "r2-bucket",
          id: b.name,
          name: b.name,
          where: b.location ?? a.name,
          facts: { created: (b.creation_date ?? "").slice(0, 10) },
        });
      }
      for (
        const t of await orGap(
          gaps,
          "Tunnels",
          [],
          () =>
            all<{ id: string; name: string; status?: string }>(
              http,
              `${at}/cfd_tunnel?is_deleted=false`,
              auth,
            ),
        )
      ) {
        assets.push({
          kind: "tunnel",
          id: t.id,
          name: t.name,
          where: a.name,
          facts: { status: t.status ?? "" },
        });
      }
    }
    const zones = await all<{ id: string; name: string; status: string; plan?: { name: string } }>(
      http,
      "/zones",
      auth,
    );
    let strict = 0, https = 0, tls12 = 0, dnssec = 0;
    for (const z of zones) {
      const zs = `/zones/${z.id}`;
      const setting = (name: string) =>
        orGap(
          gaps,
          `${z.name} ${name}`,
          undefined as string | undefined,
          async () =>
            String((await one<{ value: unknown }>(http, `${zs}/settings/${name}`, auth)).value),
        );
      const ssl = await setting("ssl");
      const always = await setting("always_use_https");
      const minTls = await setting("min_tls_version");
      const sec = await orGap(
        gaps,
        `${z.name} DNSSEC`,
        undefined as string | undefined,
        async () => (await one<{ status: string }>(http, `${zs}/dnssec`, auth)).status,
      );
      if (ssl === "strict" || ssl === "full_strict") strict++;
      if (always === "on") https++;
      if (minTls && parseFloat(minTls) >= 1.2) tls12++;
      if (sec === "active") dnssec++;
      assets.push({
        kind: "zone",
        id: z.id,
        name: z.name,
        facts: {
          status: z.status,
          plan: z.plan?.name ?? "",
          ssl: ssl ?? "?",
          alwaysHttps: always ?? "?",
          minTls: minTls ?? "?",
          dnssec: sec ?? "?",
        },
      });
      for (
        const r of await orGap(
          gaps,
          `${z.name} DNS`,
          [],
          () =>
            all<{ id: string; type: string; name: string; content: string; proxied?: boolean }>(
              http,
              `${zs}/dns_records`,
              auth,
            ),
        )
      ) {
        assets.push({
          kind: "dns-record",
          id: r.id,
          name: r.name,
          where: z.name,
          facts: { type: r.type, content: r.content, proxied: r.proxied === true },
        });
      }
    }
    if (zones.length) {
      posture.zones = zones.length;
      posture.zonesStrictTls = strict;
      posture.zonesAlwaysHttps = https;
      posture.zonesMinTls12 = tls12;
      posture.zonesDnssec = dnssec;
    }
    return {
      at: now.toISOString().replace(/\.\d+Z$/, "Z"),
      provider: "cloudflare",
      account: accounts.map((a) => a.name).join(", ") || "(no account readable)",
      assets,
      posture,
      gaps,
    };
  },
  policies(o, now): PolicyResult[] {
    const every = (v: unknown) => v === o.posture.zones;
    const zoneFix = "dash.cloudflare.com > the zone > SSL/TLS";
    return [
      fresh(o, now, "cloudflare"),
      check(o, {
        id: "cf-tls-strict",
        title: "Every zone verifies the origin's certificate (Full strict)",
        scf: ["CRY-03", "NET-12"],
        fact: "zonesStrictTls",
        want: every,
        show: (v) => `${v} of ${o.posture.zones} zone(s)`,
        fix: `${zoneFix} > Overview > Full (strict)`,
      }),
      check(o, {
        id: "cf-always-https",
        title: "Every zone redirects HTTP to HTTPS",
        scf: ["CRY-03"],
        fact: "zonesAlwaysHttps",
        want: every,
        show: (v) => `${v} of ${o.posture.zones} zone(s)`,
        fix: `${zoneFix} > Edge Certificates > Always Use HTTPS`,
      }),
      check(o, {
        id: "cf-min-tls",
        title: "Every zone refuses TLS older than 1.2",
        scf: ["CRY-03"],
        fact: "zonesMinTls12",
        want: every,
        show: (v) => `${v} of ${o.posture.zones} zone(s)`,
        fix: `${zoneFix} > Edge Certificates > Minimum TLS Version: 1.2`,
      }),
      check(o, {
        id: "cf-dnssec",
        title: "Every zone signs its DNS (DNSSEC)",
        scf: ["NET-10"],
        fact: "zonesDnssec",
        want: every,
        show: (v) => `${v} of ${o.posture.zones} zone(s)`,
        fix:
          "dash.cloudflare.com > the zone > DNS > Settings > Enable DNSSEC (then add the DS record at the registrar)",
        warnOnly: true,
      }),
    ];
  },
};
