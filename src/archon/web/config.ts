// 032-web: the server's HTTPS front door, as data. Traefik (an official
// release binary, spec 010) listens on 80 and 443; 80 only redirects. Every
// route on 443 is limited to the local networks at the entry point, so
// nothing on a server is reachable from outside the LAN through the proxy
// (the router decides what the internet sees, Article 21). Certificates come
// from Let's Encrypt through Cloudflare's DNS challenge when fleet.web is set;
// until then (and without it) Traefik's self-signed certificate answers.
//
// Everything here is pure: the capability renders it, tests read it.

import type { FleetDef, HostDef, HostPlan, WebRoute } from "../model/types.ts";
import { LOCAL_NETWORKS, localNetworks } from "../capabilities/ssh.ts";
import { ACME_DIRECTORIES, providersOf } from "../model/providers.ts";

export const WEB = {
  staticConfig: "/etc/traefik/traefik.yml",
  dynamicDir: "/etc/traefik/dynamic",
  dynamicConfig: "/etc/traefik/dynamic/archon.yml",
  unit: "traefik.service",
  /** The welcome page: archon web serve, on loopback only. */
  welcomeUnit: "archon-web.service",
  /**
   * Its dynamic account. Not the unit's own name: systemd refuses a dynamic
   * account whose name exists, and the group archon-web does.
   */
  welcomeUser: "archon-welcome",
  welcomeAddress: "127.0.0.1",
  welcomePort: 8090,
  /** Root only: the Cloudflare token for archon web dns. */
  credential: "/etc/archon/web/cloudflare.json",
  /** Root only: the same token for Traefik's DNS challenge (read by systemd). */
  env: "/etc/archon/web/cloudflare.env",
  /** Where an install delivers the token (first boot moves it, spec 004). */
  delivered: "/etc/archon/web_credential.json",
  /** May use the Podman socket (Traefik reads container labels there). */
  group: "archon-web",
  podmanSocket: "/run/podman/podman.sock",
  acmeStorage: "/var/lib/traefik/acme.json",
  resolver: "letsencrypt",
} as const;

/** "alpha.lab.example.net", or undefined without fleet.web. */
export function fqdn(fleet: FleetDef, host: { name: string }): string | undefined {
  return fleet.web ? `${host.name}.${fleet.web.domain}` : undefined;
}

/** The Cloudflare zone that holds the domain (default: its last two labels). */
export function zoneOf(web: { domain: string; zone?: string }): string {
  return web.zone ?? web.domain.split(".").slice(-2).join(".");
}

/** Who may reach anything behind the proxy: the local networks and loopback. */
export function lanRanges(fleet: FleetDef): string[] {
  const local = localNetworks(fleet);
  return [...(local.length ? local : LOCAL_NETWORKS), "127.0.0.1/32", "::1/128"];
}

/** Routes from the model: the host's own, and each guest that publishes a port. */
export function hostRoutes(host: HostDef): WebRoute[] {
  return [
    ...(host.web?.routes ?? []).map((r) => ({ ...r, spec: "032-web" as const })),
    ...(host.guests ?? []).filter((g) => g.web).map((g) => ({
      name: g.name,
      port: g.web!.port,
      // LXD's own DNS for its bridge (spec 017), wired into systemd-resolved.
      address: `${g.name}.lxd`,
      https: g.web!.https,
      description: `LXD ${g.kind} ${g.name}`,
      spec: "032-web" as const,
    })),
  ];
}

export function backendUrl(r: Pick<WebRoute, "address" | "port" | "https">): string {
  return `${r.https ? "https" : "http"}://${r.address ?? "127.0.0.1"}:${r.port}`;
}

/** Traefik's static configuration (JSON, which is valid YAML). */
export function traefikStatic(plan: Pick<HostPlan, "host" | "fleet" | "units">): string {
  const name = fqdn(plan.fleet, plan.host);
  const otel = plan.units.some((u) => u.unitName === "archon-otelcol.service");
  const email = plan.fleet.web?.acmeEmail ?? plan.fleet.mail?.to;
  const config = {
    global: { checkNewVersion: false, sendAnonymousUsage: false },
    log: { level: "INFO" },
    accessLog: {},
    api: { dashboard: true },
    entryPoints: {
      web: {
        address: ":80",
        http: {
          redirections: { entryPoint: { to: "websecure", scheme: "https", permanent: true } },
        },
      },
      websecure: {
        address: ":443",
        http3: {},
        http: {
          // Local networks only, for every route (file or container).
          middlewares: ["lan@file"],
          tls: name
            ? { certResolver: WEB.resolver, domains: [{ main: name, sans: [`*.${name}`] }] }
            : {},
        },
      },
    },
    ...(name
      ? {
        certificatesResolvers: {
          [WEB.resolver]: {
            acme: {
              ...(email ? { email } : {}),
              caServer: ACME_DIRECTORIES[providersOf(plan.fleet).acme],
              storage: WEB.acmeStorage,
              dnsChallenge: { provider: "cloudflare", resolvers: ["1.1.1.1:53", "1.0.0.1:53"] },
            },
          },
        },
      }
      : {}),
    providers: {
      file: { directory: WEB.dynamicDir, watch: true },
      // Podman's Docker-compatible socket: containers opt in with traefik.enable=true.
      docker: {
        endpoint: `unix://${WEB.podmanSocket}`,
        exposedByDefault: false,
        watch: true,
        ...(name ? { defaultRule: `Host(\`{{ normalize .Name }}.${name}\`)` } : {}),
      },
    },
    ...(otel
      ? {
        metrics: { otlp: { http: { endpoint: "http://127.0.0.1:4318/v1/metrics" } } },
        tracing: { otlp: { http: { endpoint: "http://127.0.0.1:4318/v1/traces" } } },
      }
      : {}),
  };
  return JSON.stringify(config, null, 2) + "\n";
}

/** Traefik's dynamic configuration: the LAN middleware, the welcome page, every route. */
export function traefikDynamic(
  plan: Pick<HostPlan, "host" | "fleet" | "routes">,
): string {
  const name = fqdn(plan.fleet, plan.host);
  const routers: Record<string, unknown> = {
    // Any name or address that no other route claims: the welcome page.
    "welcome-any": { rule: "PathPrefix(`/`)", priority: 1, service: "welcome" },
  };
  const services: Record<string, unknown> = {
    welcome: {
      loadBalancer: { servers: [{ url: `http://${WEB.welcomeAddress}:${WEB.welcomePort}` }] },
    },
  };
  if (name) {
    routers.welcome = { rule: `Host(\`${name}\`)`, service: "welcome" };
    routers.traefik = { rule: `Host(\`traefik.${name}\`)`, service: "api@internal" };
    for (const r of plan.routes) {
      routers[r.name] = { rule: `Host(\`${r.name}.${name}\`)`, service: r.name };
      services[r.name] = {
        loadBalancer: {
          servers: [{ url: backendUrl(r) }],
          ...(r.https ? { serversTransport: "backend-tls" } : {}),
        },
      };
    }
  }
  const config = {
    http: {
      middlewares: { lan: { ipAllowList: { sourceRange: lanRanges(plan.fleet) } } },
      // Backends on loopback or LXD's bridge with their own self-signed certificates (Cockpit).
      serversTransports: { "backend-tls": { insecureSkipVerify: true } },
      routers,
      services,
    },
  };
  return JSON.stringify(config, null, 2) + "\n";
}

/** The A records a server keeps in Cloudflare: its name and its wildcard, to its address. */
export function dnsRecords(fleet: FleetDef, host: HostDef, address: string) {
  const name = fqdn(fleet, host);
  if (!name) return [];
  return [name, `*.${name}`].map((n) => ({ type: "A" as const, name: n, content: address }));
}
