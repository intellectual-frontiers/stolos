/**
 * Spec 067 (clouds), declared with spec 091's SDK: Hetzner Cloud, read-only:
 * one project's servers, volumes, firewalls, primary IPs, and load
 * balancers. Every list is needed: a denied one fails the observation.
 *
 * @module
 */

import { check, type Connector, fresh, type Observation } from "./connector.ts";
import { type Ctx, defineConnector, type FieldDef, mustRead } from "./sdk.ts";
import { FIREWALL, IP_ADDRESS, LOAD_BALANCER, SERVER, VOLUME } from "./labels.ts";

const API = "https://api.hetzner.cloud/v1";

/** Every item of one list (each a required read: a denial fails the observation). */
async function* all<T>(ctx: Ctx<{ token: FieldDef }>, what: string): AsyncGenerator<T> {
  const out = await mustRead(async () => {
    const items: T[] = [];
    for (let page = 1; page <= 50; page++) {
      const r = await ctx.json<
        Record<string, unknown> & { meta?: { pagination?: { next_page: number | null } } }
      >(`${API}/${what}?per_page=50&page=${page}`);
      items.push(...((r[what] as T[]) ?? []));
      if (!r.meta?.pagination?.next_page) break;
    }
    return items;
  });
  yield* out;
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

interface Volume {
  id: number;
  name: string;
  size: number;
  location?: { name: string };
  server: number | null;
  protection?: { delete: boolean };
}

interface Firewall {
  id: number;
  name: string;
  rules?: unknown[];
  applied_to?: unknown[];
}

interface PrimaryIp {
  id: number;
  name: string;
  ip: string;
  type: string;
  assignee_id: number | null;
}

interface LoadBalancer {
  id: number;
  name: string;
  location?: { name: string };
}

/** Hetzner Cloud. */
export const hetzner: Connector = defineConnector({
  id: "hetzner",
  title: "Hetzner Cloud",
  logo: "hetzner",
  serviceModels: ["IaaS"],
  markets: ["strategic-cloud-platform-services"],
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
  fields: { token: { secret: true, hint: "the project's API token (Read)" } },
  auth: (cred) => Promise.resolve({ Authorization: `Bearer ${cred.token}` }),
  // A credential written by hand may name its project.
  account: (cred) => (cred as Record<string, string>).project || "Hetzner Cloud project",
  resources: {
    servers: {
      label: SERVER,
      ocsf: "cloud_resources_inventory_info",
      list: (ctx) => all<Server>(ctx, "servers"),
      map: (s: Server) => ({
        native_id: String(s.id),
        display_name: s.name,
        ...(s.datacenter?.name ? { where: s.datacenter.name } : {}),
        props: {
          status: s.status,
          ...(s.server_type?.name ? { type: s.server_type.name } : {}),
          ...(s.datacenter?.name ? { region: s.datacenter.name } : {}),
          backups: !!s.backup_window,
          protected: s.protection?.delete === true,
          firewalled: (s.public_net?.firewalls?.length ?? 0) > 0,
        },
      }),
      asset: (s: Server) => ({
        kind: "server",
        facts: {
          status: s.status,
          type: s.server_type?.name ?? "",
          image: s.image?.description ?? "",
          ipv4: s.public_net?.ipv4?.ip ?? "",
          backups: !!s.backup_window,
          firewalls: s.public_net?.firewalls?.length ?? 0,
          deleteProtection: s.protection?.delete === true,
        },
      }),
    },
    volumes: {
      label: VOLUME,
      ocsf: "cloud_resources_inventory_info",
      list: (ctx) => all<Volume>(ctx, "volumes"),
      map: (v: Volume) => ({
        native_id: String(v.id),
        display_name: v.name,
        ...(v.location?.name ? { where: v.location.name } : {}),
        props: {
          size_gb: v.size,
          ...(v.server !== null && v.server !== undefined ? { server: String(v.server) } : {}),
          ...(v.protection ? { protected: v.protection.delete === true } : {}),
        },
      }),
      asset: (v: Volume) => ({
        kind: "volume",
        facts: { sizeGB: v.size, attached: v.server !== null },
      }),
    },
    firewalls: {
      label: FIREWALL,
      ocsf: "cloud_resources_inventory_info",
      list: (ctx) => all<Firewall>(ctx, "firewalls"),
      map: (f: Firewall) => ({
        native_id: String(f.id),
        display_name: f.name,
        props: { rules: f.rules?.length ?? 0 },
      }),
      asset: (f: Firewall) => ({
        kind: "firewall",
        facts: { rules: f.rules?.length ?? 0, appliedTo: f.applied_to?.length ?? 0 },
      }),
    },
    primaryIps: {
      label: IP_ADDRESS,
      ocsf: "cloud_resources_inventory_info",
      list: (ctx) => all<PrimaryIp>(ctx, "primary_ips"),
      map: (ip: PrimaryIp) => ({
        native_id: String(ip.id),
        display_name: ip.name,
        props: {
          address: ip.ip,
          type: ip.type,
          ...(ip.assignee_id !== null && ip.assignee_id !== undefined
            ? { assigned_to: String(ip.assignee_id) }
            : {}),
        },
      }),
      asset: (ip: PrimaryIp) => ({
        kind: "primary-ip",
        facts: { ip: ip.ip, type: ip.type, assigned: ip.assignee_id !== null },
      }),
    },
    loadBalancers: {
      label: LOAD_BALANCER,
      ocsf: "cloud_resources_inventory_info",
      list: (ctx) => all<LoadBalancer>(ctx, "load_balancers"),
      map: (lb: LoadBalancer) => ({
        native_id: String(lb.id),
        display_name: lb.name,
        ...(lb.location?.name ? { where: lb.location.name } : {}),
        props: lb.location?.name ? { region: lb.location.name } : {},
      }),
      asset: () => ({ kind: "load-balancer" }),
    },
  },
  posture(records): Observation["posture"] {
    const servers = records.filter((r) => r.label === SERVER.name).map((r) => r.props);
    if (!servers.length) return {};
    return {
      servers: servers.length,
      serversWithBackups: servers.filter((p) => p.backups).length,
      serversWithFirewall: servers.filter((p) => p.firewalled).length,
      serversDeleteProtected: servers.filter((p) => p.protected).length,
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
        scf: ["BCD-24"],
        fact: "serversWithBackups",
        want: every,
        show: (v) => `${v} of ${o.posture.servers} server(s)`,
        fix: `${fix} > Backups > Enable (or record that its data is backed up another way)`,
        warnOnly: true,
      }),
      check(o, {
        id: "hz-firewall",
        title: "Every server has a Hetzner firewall",
        scf: ["NET-02"],
        fact: "serversWithFirewall",
        want: every,
        show: (v) => `${v} of ${o.posture.servers} server(s)`,
        fix: `${fix} > Firewalls > Apply firewall (the cloud's firewall is this fleet's router)`,
      }),
      check(o, {
        id: "hz-protect",
        title: "Every server is protected from deletion",
        scf: ["BCD-02"],
        fact: "serversDeleteProtected",
        want: every,
        show: (v) => `${v} of ${o.posture.servers} server(s)`,
        fix: `${fix} > the three dots > Change protection > Protect against deletion`,
        warnOnly: true,
      }),
    ];
  },
});
