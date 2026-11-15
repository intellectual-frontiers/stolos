/**
 * Spec 067 (clouds): Hetzner Cloud, read-only: one project's servers,
 * volumes, firewalls, primary IPs, and load balancers.
 *
 * @module
 */

import { type Asset, check, type Connector, fresh, getJson, type Http } from "./connector.ts";

const API = "https://api.hetzner.cloud/v1";

async function all<T>(http: Http, what: string, auth: Record<string, string>): Promise<T[]> {
  const out: T[] = [];
  for (let page = 1; page <= 50; page++) {
    const r = await getJson<
      Record<string, unknown> & { meta?: { pagination?: { next_page: number | null } } }
    >(
      http,
      `${API}/${what}?per_page=50&page=${page}`,
      auth,
    );
    out.push(...((r[what] as T[]) ?? []));
    if (!r.meta?.pagination?.next_page) break;
  }
  return out;
}

interface Server {
  id: number;
  name: string;
  status: string;
  server_type?: { name: string };
  datacenter?: { name: string };
  public_net?: { ipv4?: { ip: string }; ipv6?: { ip: string }; firewalls?: unknown[] };
  backup_window?: string | null;
  protection?: { delete: boolean };
  image?: { description?: string } | null;
}

/** Hetzner Cloud. */
export const hetzner: Connector = {
  id: "hetzner",
  category: "cloud",
  title: "Hetzner Cloud",
  logo: "hetzner",
  connectHelp: [
    "console.hetzner.cloud > your project > Security > API tokens > Generate API token",
    "Permissions: Read (never Read & Write)",
    "Copy it (Hetzner shows it once); one token reads one project",
  ],
  recipe: {
    open: {
      href: "https://console.hetzner.cloud/projects",
      label: "Open your Hetzner Cloud projects (Security > API tokens)",
    },
  },
  fields: [{ name: "token", secret: true, hint: "the project's API token (Read)" }],
  async observe(cred, http, now) {
    const auth = { Authorization: `Bearer ${cred.token}` };
    const assets: Asset[] = [];
    const servers = await all<Server>(http, "servers", auth);
    for (const s of servers) {
      assets.push({
        kind: "server",
        id: String(s.id),
        name: s.name,
        where: s.datacenter?.name,
        facts: {
          status: s.status,
          type: s.server_type?.name ?? "",
          image: s.image?.description ?? "",
          ipv4: s.public_net?.ipv4?.ip ?? "",
          backups: !!s.backup_window,
          firewalls: s.public_net?.firewalls?.length ?? 0,
          deleteProtection: s.protection?.delete === true,
        },
      });
    }
    for (
      const v of await all<
        {
          id: number;
          name: string;
          size: number;
          location?: { name: string };
          server: number | null;
        }
      >(http, "volumes", auth)
    ) {
      assets.push({
        kind: "volume",
        id: String(v.id),
        name: v.name,
        where: v.location?.name,
        facts: { sizeGB: v.size, attached: v.server !== null },
      });
    }
    for (
      const f of await all<{ id: number; name: string; rules?: unknown[]; applied_to?: unknown[] }>(
        http,
        "firewalls",
        auth,
      )
    ) {
      assets.push({
        kind: "firewall",
        id: String(f.id),
        name: f.name,
        facts: { rules: f.rules?.length ?? 0, appliedTo: f.applied_to?.length ?? 0 },
      });
    }
    for (
      const ip of await all<
        { id: number; name: string; ip: string; type: string; assignee_id: number | null }
      >(http, "primary_ips", auth)
    ) {
      assets.push({
        kind: "primary-ip",
        id: String(ip.id),
        name: ip.name,
        facts: { ip: ip.ip, type: ip.type, assigned: ip.assignee_id !== null },
      });
    }
    for (
      const lb of await all<{ id: number; name: string; location?: { name: string } }>(
        http,
        "load_balancers",
        auth,
      )
    ) {
      assets.push({
        kind: "load-balancer",
        id: String(lb.id),
        name: lb.name,
        where: lb.location?.name,
      });
    }
    return {
      at: now.toISOString().replace(/\.\d+Z$/, "Z"),
      provider: "hetzner",
      account: cred.project || "Hetzner Cloud project",
      assets,
      posture: servers.length
        ? ({
          servers: servers.length,
          serversWithBackups: servers.filter((s) => s.backup_window).length,
          serversWithFirewall:
            servers.filter((s) => (s.public_net?.firewalls?.length ?? 0) > 0).length,
          serversDeleteProtected: servers.filter((s) => s.protection?.delete).length,
        } as Record<string, number>)
        : {},
      gaps: [],
    };
  },
  policies(o, now) {
    const every = (v: unknown) => v === o.posture.servers;
    const fix = "console.hetzner.cloud > the server";
    return [
      fresh(o, now, "hetzner"),
      check(o, {
        id: "hz-backups",
        title: "Every server has Hetzner backups on",
        scf: ["BCD-11"],
        fact: "serversWithBackups",
        want: every,
        show: (v) => `${v} of ${o.posture.servers} server(s)`,
        fix: `${fix} > Backups > Enable (or record that its data is backed up another way)`,
        warnOnly: true,
      }),
      check(o, {
        id: "hz-firewall",
        title: "Every server has a Hetzner firewall",
        scf: ["NET-01"],
        fact: "serversWithFirewall",
        want: every,
        show: (v) => `${v} of ${o.posture.servers} server(s)`,
        fix: `${fix} > Firewalls > Apply firewall (the cloud's firewall is this fleet's router)`,
      }),
      check(o, {
        id: "hz-protect",
        title: "Every server is protected from deletion",
        scf: ["BCD-01"],
        fact: "serversDeleteProtected",
        want: every,
        show: (v) => `${v} of ${o.posture.servers} server(s)`,
        fix: `${fix} > the three dots > Change protection > Protect against deletion`,
        warnOnly: true,
      }),
    ];
  },
};
