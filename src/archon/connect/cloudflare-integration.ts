/**
 * Spec 109-integrations-api FR-007, FR-008: Cloudflare as an implementation of two kinds of the integration layer, beside its connector
 * (`cloudflare.ts`, spec 067, which keeps working unchanged).
 *
 * - **dns**: `zones` and `records`, the same reads the connector makes (the layer shares them, so no request is sent twice).
 * - **email**: `domains` (the domains' email DNS records Cloudflare manages: MX, SPF, DKIM, DMARC, and whether Email Routing is on)
 *   and `routing` (the Email Routing rules, without the addresses they forward to). `sending` is not offered: this release reads
 *   inbound routing and the DNS only.
 *
 * The web front door (spec 032, `src/archon/web/cloudflare.ts`) uses Cloudflare to write the server's own certificate challenges and
 * records; that code is left as it is (`tasks.md`, L001).
 *
 * @module
 */
// Spec: 109-integrations-api FR-007, FR-008

import { check } from "./connector.ts";
import { cloudflare } from "./cloudflare.ts";
import { type ReadContext, defineIntegration } from "./integration.ts";
import type {
  DnsRecord,
  DnsZone,
  EmailDomain,
  EmailRoute,
  Reading,
} from "./integration-entities.ts";
import { withIntegrations } from "./integration-connector.ts";
import type { Connector } from "./connector.ts";

const API = "https://api.cloudflare.com/client/v4";

interface Page<T> {
  result: T[];
  result_info?: { page: number; total_pages: number };
}

interface CfZone {
  id: string;
  name: string;
  status: string;
  plan?: { name: string };
}

interface CfRecord {
  id: string;
  type: string;
  name: string;
  content: string;
  proxied?: boolean;
  ttl?: number;
}

interface CfRule {
  tag: string;
  name?: string;
  enabled?: boolean;
  priority?: number;
  matchers?: Array<{ type: string }>;
  actions?: Array<{ type: string; value?: string[] }>;
}

/** Every item of a list, paged as the connector pages it (the same URLs, so the transport answers a second read from the first). */
async function all<T>(ctx: ReadContext, path: string): Promise<T[]> {
  const out: T[] = [];
  for (let page = 1; page <= 50; page++) {
    const sep = path.includes("?") ? "&" : "?";
    const r = await ctx.json<Page<T>>(`${API}${path}${sep}per_page=50&page=${page}`);
    out.push(...(r.result ?? []));
    if (!r.result_info || page >= r.result_info.total_pages) break;
  }
  return out;
}

/** The zones of the account, read once for the whole observation. */
const zonesOf = (ctx: ReadContext): Promise<CfZone[]> =>
  ctx.memo("cloudflare:zones", () => all<CfZone>(ctx, "/zones"));

/** A zone's DNS records, read once for the whole observation (a denied zone is a gap and has none). */
const recordsOf = (ctx: ReadContext, z: CfZone): Promise<CfRecord[]> =>
  ctx.memo(`cloudflare:records:${z.id}`, () =>
    ctx.orGap(`${z.name} DNS`, [] as CfRecord[], () =>
      all<CfRecord>(ctx, `/zones/${z.id}/dns_records`),
    ),
  );

/** Cloudflare's DNS: the `dns` kind. */
export const cloudflareDns = defineIntegration({
  id: "cloudflare",
  title: "Cloudflare DNS",
  kind: "dns",
  read: {
    async zones(ctx): Promise<DnsZone[]> {
      const out: DnsZone[] = [];
      for (const z of await zonesOf(ctx)) {
        const dnssec = await ctx.orGap(
          `${z.name} DNSSEC`,
          undefined as boolean | undefined,
          async () => {
            const r = await ctx.json<{ result: { status: string } }>(`${API}/zones/${z.id}/dnssec`);
            return r.result.status === "active";
          },
        );
        out.push({
          source: "cloudflare",
          id: z.id,
          name: z.name,
          status: z.status,
          ...(z.plan?.name ? { plan: z.plan.name } : {}),
          ...(dnssec !== undefined ? { dnssec } : {}),
        });
      }
      return out;
    },
    async records(ctx): Promise<DnsRecord[]> {
      const out: DnsRecord[] = [];
      for (const z of await zonesOf(ctx)) {
        for (const r of await recordsOf(ctx, z)) {
          out.push({
            source: "cloudflare",
            id: r.id,
            zone: z.name,
            name: r.name,
            type: r.type,
            content: r.content,
            ...(r.proxied !== undefined ? { proxied: r.proxied } : {}),
            ...(r.ttl !== undefined ? { ttl: r.ttl } : {}),
          });
        }
      }
      return out;
    },
  },
  notOffered: {},
});

/** A TXT record's text without the quotes Cloudflare may wrap it in. */
const txt = (content: string): string => content.replace(/^"|"$/g, "").replace(/"\s*"/g, "");

/** What a zone's records say of its email (RFC 7208 SPF, RFC 6376 DKIM, RFC 7489 DMARC). */
export function emailFacts(
  zone: string,
  records: readonly CfRecord[],
): Omit<EmailDomain, "source" | "routing"> {
  const name = zone.toLowerCase();
  const apex = records.filter((r) => r.name.toLowerCase() === name);
  const spf = apex.find((r) => r.type === "TXT" && /^v=spf1\b/i.test(txt(r.content)));
  const dmarc = records.find(
    (r) =>
      r.type === "TXT" &&
      r.name.toLowerCase() === `_dmarc.${name}` &&
      /^v=DMARC1\b/i.test(txt(r.content)),
  );
  return {
    domain: zone,
    mx: apex.filter((r) => r.type === "MX").map((r) => r.content.toLowerCase()),
    ...(spf ? { spf: txt(spf.content) } : {}),
    dkim: records.some((r) => /\._domainkey\./i.test(r.name) && ["TXT", "CNAME"].includes(r.type)),
    ...(dmarc ? { dmarc: txt(dmarc.content) } : {}),
  };
}

/** Cloudflare's email: the `email` kind (Email Routing and the domains' email DNS). */
export const cloudflareEmail = defineIntegration({
  id: "cloudflare",
  title: "Cloudflare Email Routing",
  kind: "email",
  read: {
    async domains(ctx): Promise<EmailDomain[]> {
      const out: EmailDomain[] = [];
      let routingReadable = true;
      for (const z of await zonesOf(ctx)) {
        const facts = emailFacts(z.name, await recordsOf(ctx, z));
        let routing: boolean | undefined;
        if (routingReadable) {
          routing = await ctx.orGap(
            `${z.name} email routing`,
            undefined as boolean | undefined,
            async () => {
              const r = await ctx.json<{ result: { enabled?: boolean } }>(
                `${API}/zones/${z.id}/email/routing`,
              );
              return r.result.enabled === true;
            },
          );
          // A token that may not read Email Routing may not read it on any zone: say so once.
          if (routing === undefined) routingReadable = false;
        }
        // A domain is an email domain when it has MX records or routes mail through Cloudflare.
        if (facts.mx.length === 0 && routing !== true) continue;
        out.push({ source: "cloudflare", ...facts, ...(routing !== undefined ? { routing } : {}) });
      }
      return out;
    },
    async routing(ctx): Promise<EmailRoute[]> {
      const out: EmailRoute[] = [];
      for (const z of await zonesOf(ctx)) {
        const rules = await ctx.orGap(`${z.name} email routing rules`, [] as CfRule[], () =>
          all<CfRule>(ctx, `/zones/${z.id}/email/routing/rules`),
        );
        for (const r of rules) {
          const kinds = (r.matchers ?? []).map((m) => (m.type === "all" ? "all" : "address"));
          out.push({
            source: "cloudflare",
            id: r.tag,
            zone: z.name,
            name: r.name ?? r.tag,
            enabled: r.enabled !== false,
            ...(r.priority !== undefined ? { priority: r.priority } : {}),
            matches: kinds.length ? [...new Set(kinds)] : [],
            actions: [...new Set((r.actions ?? []).map((a) => a.type))],
            destinations: (r.actions ?? []).reduce(
              (n, a) => n + (a.type === "forward" ? (a.value ?? []).length : 0),
              0,
            ),
            catchAll: kinds.includes("all"),
          });
        }
      }
      return out;
    },
  },
  notOffered: {
    sending:
      "this release reads inbound Email Routing and the domains' email DNS records, not outbound sending (spec 109, tasks L005)",
  },
});

/** The posture facts the two kinds add, only for what was read. */
function cloudflareFacts(readings: Reading[]): Record<string, string | number | boolean> {
  const facts: Record<string, string | number | boolean> = {};
  for (const r of readings) {
    if (r.kind === "email" && r.capability === "domains") {
      facts["emailDomains"] = r.items.length;
      facts["emailDomainsMissingSpf"] = r.items.filter((d) => d.spf === undefined).length;
      facts["emailDomainsMissingDmarc"] = r.items.filter((d) => d.dmarc === undefined).length;
      facts["emailDomainsMissingDkim"] = r.items.filter((d) => !d.dkim).length;
      facts["emailRoutingOn"] = r.items.filter((d) => d.routing === true).length;
    }
    if (r.kind === "email" && r.capability === "routing") {
      facts["emailRoutes"] = r.items.length;
      facts["emailCatchAll"] = r.items.filter((x) => x.catchAll && x.enabled).length;
    }
  }
  return facts;
}

/** Cloudflare, the connector of spec 067 with the two kinds of spec 109 behind it. */
export const cloudflareFamily: Connector = withIntegrations(cloudflare, {
  integrations: [cloudflareDns, cloudflareEmail],
  headers: (cred) => ({ Authorization: `Bearer ${cred["token"] ?? ""}` }),
  posture: (readings) => cloudflareFacts(readings),
  policies(o) {
    // Only where the integrations read the domains: an observation made before them has none of these policies.
    if (o.posture["emailDomains"] === undefined) return [];
    const none = (v: unknown): boolean => v === 0;
    const show = (v: string | number | boolean): string =>
      `${v} of ${o.posture["emailDomains"]} email domain(s) lack it`;
    const fix = "dash.cloudflare.com > the zone > DNS > Records";
    return [
      check(o, {
        id: "cf-email-spf",
        title: "Every email domain publishes an SPF record",
        scf: ["NET-39"],
        fact: "emailDomainsMissingSpf",
        want: none,
        show,
        fix: `${fix} > Add a TXT record at the domain: v=spf1 include:_spf.mx.cloudflare.net ~all (or your sending service's)`,
      }),
      check(o, {
        id: "cf-email-dmarc",
        title: "Every email domain publishes a DMARC record",
        scf: ["NET-39"],
        fact: "emailDomainsMissingDmarc",
        want: none,
        show,
        fix: `${fix} > Add a TXT record _dmarc: v=DMARC1; p=quarantine; rua=mailto:<your reports address>`,
      }),
      check(o, {
        id: "cf-email-dkim",
        title: "Every email domain publishes a DKIM key",
        scf: ["NET-39"],
        fact: "emailDomainsMissingDkim",
        want: none,
        show,
        fix: `${fix} > Add the DKIM record your sending service gives (selector._domainkey)`,
        warnOnly: true,
      }),
    ];
  },
});
