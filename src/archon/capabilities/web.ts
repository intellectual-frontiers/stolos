/**
 * 032-web: every server is HTTPS-ready from its first boot. Traefik (the
 * official release binary, installed by the tools sync) on 80 and 443, open
 * to everyone at the server's firewall; every route behind it is limited to
 * the local networks. A welcome page (archon web serve, loopback only)
 * answers https://<host>.<domain> and any name or address nothing else
 * claims. Podman (Ubuntu's package) is the container runtime: containers
 * that carry traefik.enable=true get <container>.<host>.<domain>.
 *
 * Overrides of Ubuntu defaults: Traefik is not Ubuntu's (Ubuntu's nginx and
 * Apache cannot obtain certificates by themselves; Traefik's official binary
 * does Let's Encrypt's DNS challenge with Cloudflare built in, and reads
 * container labels). The Podman socket is group archon-web, mode 0660.
 *
 * @module
 */

import type { Capability, UnitDef } from "../model/types.ts";
import { header, ini } from "../render/systemd.ts";
import { fqdn, hostRoutes, traefikDynamic, traefikStatic, WEB } from "../web/config.ts";

const SPEC = "032-web" as const;

/** HTTPS from the first boot: Traefik, the welcome page, and Cloudflare DNS (spec 032). */
export const web = (): Capability => ({ host, fleet }) => {
  const name = fqdn(fleet, host);
  const units: UnitDef[] = [
    {
      unitName: "podman.socket",
      managed: false,
      state: "enabled",
      start: true,
      verify: "systemctl is-active podman.socket",
      spec: SPEC,
    },
    {
      unitName: WEB.unit,
      managed: true,
      content: ini({
        Unit: {
          Description: "Archon: Traefik, the HTTPS front door",
          Documentation: ["man:archon-web(1)", "https://doc.traefik.io/traefik/"],
          After: ["network-online.target", "podman.socket"],
          Wants: "network-online.target",
          // Installed by the tools sync, which then restarts this unit.
          ConditionPathExists: "/usr/local/bin/traefik",
          // A broken setup fails after 5 tries in a minute instead of looping forever.
          StartLimitIntervalSec: 60,
          StartLimitBurst: 5,
        },
        Service: {
          ExecStart: `/usr/local/bin/traefik --configFile=${WEB.staticConfig}`,
          // The Cloudflare token, when the boot machine has delivered it (root only; read by systemd).
          EnvironmentFile: `-${WEB.env}`,
          User: "traefik",
          Group: "traefik",
          SupplementaryGroups: WEB.group,
          AmbientCapabilities: "CAP_NET_BIND_SERVICE",
          CapabilityBoundingSet: "CAP_NET_BIND_SERVICE",
          NoNewPrivileges: true,
          StateDirectory: "traefik",
          StateDirectoryMode: "0700",
          ProtectSystem: "strict",
          ProtectHome: true,
          PrivateTmp: true,
          Restart: "on-failure",
          RestartSec: 5,
          LimitNOFILE: 65536,
        },
        Install: { WantedBy: "multi-user.target" },
      }, SPEC),
      state: "enabled",
      start: true,
      verify: `systemctl is-active ${WEB.unit}`,
      spec: SPEC,
    },
    {
      unitName: WEB.welcomeUnit,
      managed: true,
      content: ini({
        Unit: {
          Description: "Archon: this server's welcome page (loopback, behind Traefik)",
          Documentation: "man:archon-web-serve(1)",
          After: "network.target",
        },
        Service: {
          ExecStart: "/usr/local/bin/archon web serve",
          Environment: [
            "ARCHON_AGENT=web",
            "NO_COLOR=1",
            "OTEL_DENO=false",
            // Deno's cache, writable under ProtectSystem=strict.
            "HOME=/var/cache/archon-web",
            "DENO_DIR=/var/cache/archon-web/deno",
          ],
          CacheDirectory: "archon-web",
          // Reads the model, the status line, and the reports; writes nothing.
          DynamicUser: true,
          User: WEB.welcomeUser,
          SupplementaryGroups: ["archon", "archon-ops"],
          ProtectSystem: "strict",
          ProtectHome: true,
          PrivateTmp: true,
          NoNewPrivileges: true,
          MemoryMax: "128M",
          Restart: "on-failure",
          RestartSec: 5,
        },
        Install: { WantedBy: "multi-user.target" },
      }, SPEC),
      state: "enabled",
      start: true,
      verify: `systemctl is-active ${WEB.welcomeUnit}`,
      spec: SPEC,
    },
  ];
  if (name) {
    // Keep <host>.<domain> and its wildcard pointing at this server in Cloudflare.
    units.push(
      {
        unitName: "archon-web-dns.service",
        managed: true,
        content: ini({
          Unit: {
            Description: "Archon: this server's DNS records in Cloudflare",
            Documentation: "man:archon-web-dns(1)",
            After: "network-online.target",
            Wants: "network-online.target",
            ConditionPathExists: WEB.credential,
          },
          Service: {
            Type: "oneshot",
            // Quiet unless the address changed (a new DHCP lease) or a day passed.
            ExecStart: "/usr/local/bin/archon web dns-check",
            Environment: "ARCHON_AGENT=timer",
          },
        }, SPEC),
        state: "ignore",
        verify: "systemctl cat archon-web-dns.service",
        spec: SPEC,
      },
      {
        unitName: "archon-web-dns.timer",
        managed: true,
        content: ini({
          Unit: {
            Description: "Archon: follow this server's address in Cloudflare (no reserved IPs)",
          },
          // At boot, then every 5 minutes: a new lease reaches Cloudflare within
          // minutes, and its records' TTL is 60 seconds.
          Timer: { OnBootSec: "30s", OnUnitActiveSec: "5min", AccuracySec: "30s" },
          Install: { WantedBy: "timers.target" },
        }, SPEC),
        state: "enabled",
        verify: "systemctl is-enabled archon-web-dns.timer",
        spec: SPEC,
      },
    );
  }
  return {
    spec: SPEC,
    packages: [{ name: "podman", spec: SPEC }],
    ports: [
      { port: 80, protocol: "tcp", spec: SPEC },
      { port: 443, protocol: "tcp", spec: SPEC },
      { port: 443, protocol: "udp", spec: SPEC },
    ],
    routes: hostRoutes(host),
    units,
    files: [
      {
        path: "/etc/sysusers.d/archon-web.conf",
        // Traefik's own account (its state directory, the ACME store), in the
        // group that may read Podman's socket.
        content: header(SPEC) +
          [
            `g ${WEB.group} - - -`,
            `u traefik - "Archon Traefik" /var/lib/traefik /usr/sbin/nologin`,
            `m traefik ${WEB.group}`,
          ].join("\n") + "\n",
        mode: "0644",
        owner: "root",
        spec: SPEC,
        onChange: [{ kind: "run", argv: ["systemd-sysusers", "/etc/sysusers.d/archon-web.conf"] }],
      },
      {
        // Traefik reads container labels from Podman's Docker-compatible socket.
        path: "/etc/systemd/system/podman.socket.d/50-archon.conf",
        content: ini({ Socket: { SocketGroup: WEB.group, SocketMode: "0660" } }, SPEC),
        mode: "0644",
        owner: "root",
        spec: SPEC,
        onChange: [{ kind: "daemon-reload" }, { kind: "restart", unit: "podman.socket" }],
      },
    ],
    checks: [
      {
        name: "HTTPS answers with the welcome page",
        command:
          `sh -c 'curl -sk --max-time 5 -o /dev/null -w "%{http_code}" https://127.0.0.1/ | grep -q 200'`,
        level: "fail",
        fix: `systemctl status ${WEB.unit} ${WEB.welcomeUnit}; archon web status`,
        spec: SPEC,
      },
      ...(name
        ? [
          {
            name: `${name} has a trusted certificate`,
            // Spec 052: without the Cloudflare token, not set up yet (exit 3).
            command:
              `sh -c 'test -s ${WEB.credential} || exit 3; curl -s --max-time 5 -o /dev/null --resolve ${name}:443:127.0.0.1 https://${name}/'`,
            level: "warn" as const,
            code: "P032-WEB-TOKEN",
            fix:
              "archon web status (the Cloudflare token: deno task stolos boot web-setup, then web-push <host>)",
            spec: SPEC,
          },
          {
            name: `${name} resolves to this server`,
            command:
              `sh -c 'test -s ${WEB.credential} || exit 3; getent ahostsv4 ${name} | grep -q .'`,
            level: "warn" as const,
            code: "P032-WEB-TOKEN",
            fix: "sudo archon web dns",
            spec: SPEC,
          },
        ]
        : []),
    ],
    derive: (plan) => [
      {
        path: WEB.staticConfig,
        content: traefikStatic(plan),
        mode: "0644",
        owner: "root",
        spec: SPEC,
        onChange: [{ kind: "restart", unit: WEB.unit }],
      },
      {
        // Traefik watches this directory: no restart needed.
        path: WEB.dynamicConfig,
        content: traefikDynamic(plan),
        mode: "0644",
        owner: "root",
        spec: SPEC,
      },
    ],
    notes: [
      name
        ? `HTTPS: https://${name} (welcome page), apps at <app>.${name}, Traefik's dashboard at traefik.${name}; local networks only.`
        : "HTTPS: https://<this server>/ with a self-signed certificate (set fleet.web for names and Let's Encrypt).",
      "Ports 80 and 443 are open; 80 redirects to 443. Containers publish with the label traefik.enable=true (Podman).",
    ],
  };
};
