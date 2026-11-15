/**
 * Spec 088: DigitalOcean, read-only, through its public API (v2): the
 * account or team, Droplets (size, region, backups), cloud firewalls and the
 * Droplets they apply to (by id or tag), and volumes. Evidence for asset
 * inventory (SCF AST-04), backups (BCD-24), and network filtering (NET-02).
 *
 * Credential: a personal access token with the Read scope only (Read Access,
 * or a custom scope of the `read` actions). Docs:
 * https://docs.digitalocean.com/reference/api/digitalocean/ and
 * https://docs.digitalocean.com/reference/api/scopes/.
 *
 * @module
 */

import { check, type Connector, fresh, type Observation } from "./connector.ts";
import { bearer, type Ctx, defineConnector } from "./sdk.ts";
import { ACCOUNT, FIREWALL, SERVER, VOLUME } from "./labels.ts";

const API = "https://api.digitalocean.com/v2";
const FIELDS = { token: { secret: true, hint: "a personal access token with the Read scope" } };

interface Droplet {
  id: number;
  name: string;
  status: string;
  size_slug?: string;
  region?: { slug: string };
  features?: string[];
  backup_ids?: number[];
  tags?: string[];
  /** Added here: a cloud firewall applies to it. */
  firewalled?: boolean;
}

interface Firewall {
  id: string;
  name: string;
  droplet_ids?: number[];
  tags?: string[];
  inbound_rules?: unknown[];
}

interface Volume {
  id: string;
  name: string;
  size_gigabytes: number;
  droplet_ids?: number[];
  region?: { slug: string };
}

interface DoAccount {
  uuid: string;
  email?: string;
  status?: string;
  team?: { uuid: string; name: string };
}

/** Every item of a DigitalOcean list (`links.pages.next` is the next page's URL). */
function all<T>(ctx: Ctx<typeof FIELDS>, path: string, key: string): AsyncGenerator<T> {
  return ctx.cursorPages<Record<string, unknown> & { links?: { pages?: { next?: string } } }, T>(
    `${API}/${path}?per_page=200`,
    (b) => b[key] as T[] | undefined,
    (b) => b.links?.pages?.next,
  );
}

/** What one observation has read so far: the firewalls, which the Droplets need. */
const firewalls = new WeakMap<object, Promise<Firewall[]>>();
const firewallsOf = (ctx: Ctx<typeof FIELDS>) => {
  if (!firewalls.has(ctx)) {
    firewalls.set(
      ctx,
      ctx.orGap("firewalls", [] as Firewall[], async () => {
        const out: Firewall[] = [];
        for await (const f of all<Firewall>(ctx, "firewalls", "firewalls")) out.push(f);
        return out;
      }),
    );
  }
  return firewalls.get(ctx)!;
};

/** DigitalOcean. */
export const digitalocean: Connector = defineConnector({
  id: "digitalocean",
  title: "DigitalOcean",
  logo: "digitalocean",
  serviceModels: ["IaaS", "PaaS"],
  markets: ["strategic-cloud-platform-services"],
  connectHelp: [
    "cloud.digitalocean.com > API > Tokens > Generate New Token: stolos-read",
    "Scopes: Read Access only (never Write); pick an expiry you will renew",
    "Copy it (DigitalOcean shows it once); one token reads one team",
  ],
  recipe: {
    open: {
      href: "https://cloud.digitalocean.com/account/api/tokens",
      label: "DigitalOcean: API tokens",
    },
  },
  fields: FIELDS,
  auth: (cred) => Promise.resolve(bearer(cred.token)),
  account: (_cred, records) => records.find((r) => r.label === ACCOUNT.name)?.display_name ?? "",
  resources: {
    account: {
      label: ACCOUNT,
      ocsf: "cloud_resources_inventory_info",
      required: true,
      async *list(ctx) {
        yield (await ctx.json<{ account: DoAccount }>(`${API}/account`)).account;
      },
      map: (a: DoAccount) => ({
        native_id: a.team?.uuid ?? a.uuid,
        display_name: a.team?.name ?? a.email ?? a.uuid,
        props: {},
      }),
      asset: () => undefined,
    },
    droplets: {
      label: SERVER,
      ocsf: "cloud_resources_inventory_info",
      async *list(ctx): AsyncGenerator<Droplet> {
        const fws = await firewallsOf(ctx);
        for await (const d of all<Droplet>(ctx, "droplets", "droplets")) {
          const firewalled = fws.some((f) =>
            f.droplet_ids?.includes(d.id) || f.tags?.some((t) => d.tags?.includes(t))
          );
          yield { ...d, firewalled };
        }
      },
      map: (d: Droplet) => ({
        native_id: String(d.id),
        display_name: d.name,
        ...(d.region?.slug ? { where: d.region.slug } : {}),
        props: {
          status: d.status,
          ...(d.size_slug ? { type: d.size_slug } : {}),
          ...(d.region?.slug ? { region: d.region.slug } : {}),
          backups: !!d.features?.includes("backups"),
          firewalled: !!d.firewalled,
        },
      }),
      asset: (d: Droplet) => ({
        kind: "server",
        facts: {
          size: d.size_slug ?? "",
          backups: !!d.features?.includes("backups"),
          firewall: !!d.firewalled,
        },
      }),
    },
    firewalls: {
      label: FIREWALL,
      ocsf: "cloud_resources_inventory_info",
      async *list(ctx) {
        yield* await firewallsOf(ctx);
      },
      map: (f: Firewall) => ({
        native_id: f.id,
        display_name: f.name,
        props: { rules: f.inbound_rules?.length ?? 0 },
      }),
      asset: (f: Firewall) => ({
        kind: "firewall",
        facts: { droplets: f.droplet_ids?.length ?? 0, tags: (f.tags ?? []).join(" ") },
      }),
    },
    volumes: {
      label: VOLUME,
      ocsf: "cloud_resources_inventory_info",
      list: (ctx) => all<Volume>(ctx, "volumes", "volumes"),
      map: (v: Volume) => ({
        native_id: v.id,
        display_name: v.name,
        ...(v.region?.slug ? { where: v.region.slug } : {}),
        props: {
          size_gb: v.size_gigabytes,
          ...(v.droplet_ids?.length ? { server: String(v.droplet_ids[0]) } : {}),
        },
      }),
      asset: (v: Volume) => ({ kind: "volume", facts: { sizeGb: v.size_gigabytes } }),
    },
  },
  posture(records, _cred, { gaps }): Observation["posture"] {
    const droplets = records.filter((r) => r.label === SERVER.name).map((r) => r.props);
    if (!droplets.length) return {};
    const read = (what: string) => !gaps.some((g) => g.startsWith(`${what}: `));
    return {
      droplets: droplets.length,
      dropletsWithBackups: droplets.filter((p) => p.backups).length,
      ...(read("firewalls")
        ? { dropletsWithFirewall: droplets.filter((p) => p.firewalled).length }
        : {}),
    };
  },
  policies(o, now) {
    const every = (v: unknown) => v === o.posture.droplets;
    const show = (v: string | number | boolean) => `${v} of ${o.posture.droplets} Droplet(s)`;
    return [
      fresh(o, now, "digitalocean"),
      check(o, {
        id: "do-backups",
        title: "Every Droplet has backups on",
        scf: ["BCD-24"],
        fact: "dropletsWithBackups",
        want: every,
        show,
        fix:
          "cloud.digitalocean.com > the Droplet > Backups > Enable (or record that its data is backed up another way)",
        warnOnly: true,
      }),
      check(o, {
        id: "do-firewall",
        title: "Every Droplet has a cloud firewall",
        scf: ["NET-02"],
        fact: "dropletsWithFirewall",
        want: every,
        show,
        fix:
          "Networking > Firewalls > the firewall > Droplets: add it (or tag it with a firewall's tag)",
      }),
    ];
  },
});
