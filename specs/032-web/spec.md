# Feature Specification: HTTPS on every server

> **Revised by spec 064:** the machine restricts no network; who reaches this service is the
> router's decision. Statements below about the local networks only no longer hold.

**Feature Branch**: `032-web` (committed directly to main) **Created**: 2026-11-12 **Status**:
Implemented **Input**: Every managed Ubuntu server is HTTPS-ready right after its first boot, with a
welcome page. A modern reverse proxy (Traefik) on 443, open by default, publishes the server's
services, its LXD guests, and its containers (Podman, by label), with Let's Encrypt certificates.
Ports 80 and 443 are open to everyone at the server, and Traefik restricts no network: who reaches
the server is the router's decision (the firewall at the edge, outside the machine; revised). Each
server's name is a public Cloudflare record with its private address.

## User Scenarios & Testing _(mandatory)_

1. **Given** a server reinstalled with `deno task boot reinstall`, **When** its first boot finishes,
   **Then** Traefik serves the certificate carried from the previous install from its first start,
   and the reinstall's log, the boot window, and the email say so.
1. **Given** a freshly installed server, **When** someone on the LAN opens
   `https://alpha.lab.example.net`, **Then** the welcome page answers: health (last archon run,
   install record, certificate), services with links, and how to work on the server.
1. **Given** the boot machine holds the Cloudflare DNS token, **When** a server installs, **Then**
   it creates its A records (`alpha.<domain>`, `*.alpha.<domain>` to its private address) and
   Traefik obtains a Let's Encrypt certificate for both names through Cloudflare's DNS challenge;
   until then Traefik's self-signed certificate answers.
1. **Given** `web: { routes: [{ name: "grafana", port: 3000 }] }` in a host model, **When** it
   converges, **Then** `https://grafana.alpha.<domain>` reaches `127.0.0.1:3000`. Cockpit is
   `cockpit.alpha.<domain>`; Traefik's dashboard `traefik.alpha.<domain>`.
1. **Given** an LXD guest with `web: { port: 8080 }`, **When** it converges, **Then**
   `https://<guest>.alpha.<domain>` reaches the guest by its `.lxd` name.
1. **Given** a Podman container run as root with the label `traefik.enable=true`, **When** it
   starts, **Then** it is `https://<container>.alpha.<domain>` with no change to the model.
1. **Given** a request from any network the router lets through, **When** it reaches 443, **Then**
   Traefik serves it: the machine filters no network for the web (the router does).

## Requirements _(mandatory)_

- **FR-001**: Traefik is the official release binary (tools catalog, servers only,
  checksum-verified, Article 5), run by `traefik.service` as a dynamic user with only
  `CAP_NET_BIND_SERVICE`, state in `/var/lib/traefik` (ACME account and certificates). The tools
  sync restarts it after an upgrade.
- **FR-002**: Static configuration `/etc/traefik/traefik.yml` and dynamic configuration
  `/etc/traefik/dynamic/archon.yml` are rendered from the model (JSON, valid YAML). Entry points:
  `:80` redirects permanently to HTTPS; `:443` (HTTP/1.1, HTTP/2, HTTP/3) serves every route, file
  or container, with no IP allow list (revised: the earlier `lan` middleware is gone; network
  filtering is the router's duty).
- **FR-003**: Firewall (spec 008): 80/tcp, 443/tcp, and 443/udp open to every network. The router
  decides what the internet reaches (Article 21).
- **FR-004**: `fleet.web = { domain, zone?, acmeEmail? }`. A server answers as `<host>.<domain>`;
  routes as `<name>.<host>.<domain>`. One certificate per server: `<host>.<domain>` and
  `*.<host>.<domain>`, through Let's Encrypt's DNS challenge with Cloudflare (Traefik's built-in
  provider). Without `fleet.web`, the server still answers HTTPS (self-signed) with the welcome
  page.
- **FR-005**: Routes come from capabilities (`Contribution.routes`; Cockpit contributes `cockpit`
  over TLS), the host model (`host.web.routes`), and guests (`guest.web.port`, reached as
  `<guest>.lxd`, which `archon-lxd-dns.service` wires into systemd-resolved from LXD's own DNS).
  Route names are DNS labels, unique per host; `traefik` and `cockpit` are taken.
- **FR-006**: Podman (Ubuntu's package) is the container runtime. `podman.socket` is enabled; its
  socket is group `archon-web`, mode 0660, for Traefik's Docker provider (`exposedByDefault: false`,
  default rule `Host(<container>.<host>.<domain>)`). Only rootful containers are visible.
- **FR-007**: The welcome page: `archon web serve` on `127.0.0.1:8090` (`archon-web.service`, a
  dynamic user in the archon groups, read-only), rendered per request; Traefik routes
  `<host>.<domain>` and any otherwise unclaimed name or address to it. It lists listening ports that
  are not published, with the model line that would publish one.
- **FR-008**: The Cloudflare token (Zone: Read, DNS: Edit on the zone) lives on the boot machine
  (`web.json`, secret inventory, vault). `deno task boot web-setup` stores it after checking it can
  see the zone; installs deliver it; `deno task boot web-push <host>` sends it to a running server,
  where `archon web credential` stores it root-only in `/etc/archon/web/` (JSON for archon, an
  environment file for Traefik) and restarts Traefik.
- **FR-009**: `archon web dns` keeps the server's two A records (not proxied, TTL 60) at the address
  it reaches the network from now (the source of its default route), so servers need no reserved
  IPs. It runs at first boot and when a token arrives; `archon web dns-check`
  (`archon-web-dns.timer`: 30 seconds after boot, then every 5 minutes) runs it whenever that
  address changed or a day has passed, quietly otherwise (no run log), and a change is journaled
  (`archon-web`) and mailed.
- **FR-010**: `archon web status` shows Traefik, the welcome service, the certificate's issuer and
  expiry, DNS, and every route. `archon verify`: HTTPS answers with the welcome page (fail); the
  certificate is trusted (warn); the name resolves (warn).
- **FR-011**: Traefik's metrics and traces go to the local OpenTelemetry Collector (spec 021) over
  OTLP/HTTP.
- **FR-012**: A server's Let's Encrypt certificates survive its re-install.
  `deno task boot reinstall` runs `archon web acme-export` on the server before rebooting it
  (Traefik's ACME store, with each certificate's names and expiry) and keeps it on the boot machine
  as `hosts/<host>/acme.json`, a cache in the secret inventory that is never backed up. The install
  delivers it unless a certificate expires within a day; the first boot puts it in Traefik's state
  directory (owner `traefik`, 0600) before Traefik first starts, so the new install serves the
  trusted certificate at once and does not ask Let's Encrypt again (Let's Encrypt allows 5 identical
  certificates a week). Renewals stay on the server. Every outcome (carried, none yet, too close to
  expiry, unreadable) is one sentence in the reinstall's log, the boot server window, and the
  reinstall email; the first boot reports "Certificate" in the boot window.
- **FR-013**: Traefik runs as the system user `traefik` (home and state `/var/lib/traefik`, member
  of `archon-web`), so the first boot can hand it the carried store.

### Overrides of Ubuntu defaults

- Traefik instead of Ubuntu's nginx or Apache (Article 2): neither obtains certificates by itself;
  Traefik's official binary does Let's Encrypt's DNS challenge with Cloudflare built in (Caddy would
  need a custom build, Article 5) and reads container labels.
- `podman.socket`: group `archon-web`, mode 0660 (Ubuntu's default: root only), so Traefik can read
  container labels. Access to the socket is root-equivalent; only Traefik's service has the group.

## Non-goals

- Routes reachable from the internet (every route is LAN-only).
- Rootless containers' labels.
