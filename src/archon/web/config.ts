/**
 * 032-web: the server's HTTPS front door, as data. Traefik (an official
 * release binary, spec 010) listens on 80 and 443; 80 only redirects. No
 * route is limited by network: who reaches the server is the router's
 * decision (the firewall at the edge, outside the machine; Article 21 and
 * spec 064). Certificates come
 * from Let's Encrypt through Cloudflare's DNS challenge when fleet.web is set;
 * until then (and without it) Traefik's self-signed certificate answers.
 *
 * Everything here is pure: the capability renders it, tests read it.
 *
 * @module
 */

import type { FleetDef, HostDef, HostPlan, WebRoute } from "../model/types.ts";
import { ACME_DIRECTORIES, providersOf } from "../model/providers.ts";
import type { ARecord } from "./cloudflare.ts";

/** The web front door's fixed paths, units, accounts and ports on a server (spec 032). */
export const WEB = {
  /** Traefik's static configuration (traefikStatic). */
  staticConfig: "/etc/traefik/traefik.yml",
  /** The folder Traefik watches for dynamic configuration. */
  dynamicDir: "/etc/traefik/dynamic",
  /** Archon's dynamic configuration file in it (traefikDynamic). */
  dynamicConfig: "/etc/traefik/dynamic/archon.yml",
  /** Traefik's systemd service. */
  unit: "traefik.service",
  /** The welcome page: archon web serve, on loopback only. */
  welcomeUnit: "archon-web.service",
  /**
   * The Archon Console's own account (spec 065): in the shadow group (PAM
   * checks passwords), archon (reads the model), and archon-ops (hands each
   * command to `archon console exec` through sudo).
   */
  welcomeUser: "archon-console",
  /** The console's PAM service (/etc/pam.d/archon-console). */
  pamService: "archon-console",
  /** The welcome page listens here (loopback: only Traefik reaches it). */
  welcomeAddress: "127.0.0.1",
  /** The welcome page's TCP port. */
  welcomePort: 8090,
  /** Root only: the Cloudflare token for archon web dns. */
  credential: "/etc/archon/web/cloudflare.json",
  /** Root only: the same token for Traefik's DNS challenge (read by systemd). */
  env: "/etc/archon/web/cloudflare.env",
  /** Where an install delivers the token (first boot moves it, spec 004). */
  delivered: "/etc/archon/web_credential.json",
  /** May use the Podman socket (Traefik reads container labels there). */
  group: "archon-web",
  /** Podman's Docker-compatible API socket. */
  podmanSocket: "/run/podman/podman.sock",
  /** Traefik's ACME store: the Let's Encrypt account, certificates and keys. */
  acmeStorage: "/var/lib/traefik/acme.json",
  /** The name of Traefik's certificate resolver. */
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

/** The URL Traefik forwards a route to: http or https, its address (127.0.0.1 by default), and its port. */
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
          // No network restriction here: who reaches this server is the router's decision
          // (the firewall at the edge, outside the machine).
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

/** Traefik's dynamic configuration: the welcome page and every route. */
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
      // Backends on loopback or LXD's bridge with their own self-signed certificates (Cockpit).
      serversTransports: { "backend-tls": { insecureSkipVerify: true } },
      routers,
      services,
    },
  };
  return JSON.stringify(config, null, 2) + "\n";
}

/**
 * The A records a server keeps in Cloudflare: its name and its wildcard, to
 * its address. None without fleet.web.
 */
export function dnsRecords(fleet: FleetDef, host: HostDef, address: string): ARecord[] {
  const name = fqdn(fleet, host);
  if (!name) return [];
  return [name, `*.${name}`].map((n) => ({ type: "A" as const, name: n, content: address }));
}
