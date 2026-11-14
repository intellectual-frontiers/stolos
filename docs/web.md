# HTTPS on every server

Every server answers HTTPS from its first boot (spec 032). Traefik listens on 80 and 443; 80 only
redirects. Everything behind it answers the **local networks only**, whatever the router forwards.

| URL                                     | What                                                           |
| --------------------------------------- | -------------------------------------------------------------- |
| `https://alpha.lab.example.net`         | the server's welcome page: health, services, how to work on it |
| `https://cockpit.alpha.lab.example.net` | Cockpit                                                        |
| `https://traefik.alpha.lab.example.net` | Traefik's dashboard: routers, services, certificates           |
| `https://<app>.alpha.lab.example.net`   | anything you publish (below)                                   |

Before the certificate arrives, or without a Cloudflare token, Traefik answers with its own
self-signed certificate, and `https://<address>` shows the welcome page too.

## Once: the Cloudflare token

In Cloudflare: My Profile > API Tokens > Create Token > "Edit zone DNS" template, named
`archon web`, with **Zone > DNS > Edit** and **Zone > Zone > Read**, for the zone `example.net`.
Then on the boot machine:

```powershell
deno task stolos boot web-setup          # paste it (hidden); checked against the zone; stored on this PC only
deno task stolos boot web-push alpha    # a running server; new installs get it by themselves
```

Each server then keeps two records in Cloudflare, `alpha.lab.example.net` and
`*.alpha.lab.example.net`, to its private address (not proxied, TTL 60), and Traefik gets one Let's
Encrypt certificate for both through Cloudflare's DNS challenge. No reserved IP is needed: the
records follow the address the server has now (its default route's source). `archon web dns-check`
compares it 30 seconds after boot and every 5 minutes, and only a new address (a new DHCP lease)
reaches Cloudflare, journaled (`journalctl -t archon-web`) and mailed. Back the token up with the
other secrets: `deno task stolos vault backup`.

## Reinstalls keep the certificate

`deno task stolos boot reinstall <host>` copies the server's Let's Encrypt store (Traefik's
`/var/lib/traefik/acme.json`) to the boot machine before erasing it, and the new install puts it
back before Traefik first starts: the same trusted certificate from the first minute, and no new
request to Let's Encrypt, which allows only 5 identical certificates a week. The reinstall's output,
the boot server window, and the reinstall email each say whether it was carried. Renewals stay on
the server. The copy is a cache (`hosts/<host>/acme.json` in the secrets folder), never backed up:
losing it only means one new certificate. A brand-new server, or one that could not be reached, asks
Let's Encrypt as usual.

## Publishing a service

- **Something on the server itself**: in its host model (`fleets/<fleet>/hosts/alpha/host.ts`):

  ```ts
  web: { routes: [{ name: "grafana", port: 3000, description: "dashboards" }] },
  ```

  `https://grafana.alpha.lab.example.net` reaches `127.0.0.1:3000`. Add `https: true` for a backend
  that speaks TLS itself, or `address` for another backend address.
- **An LXD guest**:
  `guests: [{ name: "db", kind: "container", image: "ubuntu:26.04", web: { port: 8080 } }]`
  publishes `https://db.alpha.lab.example.net`.
- **A container (Podman)**: no model change. Run it as root with the label:

  ```sh
  sudo podman run -d --name whoami --label traefik.enable=true docker.io/traefik/whoami
  ```

  `https://whoami.alpha.lab.example.net` answers. For a port other than the image's first exposed
  one, add `--label traefik.http.services.whoami.loadbalancer.server.port=8080`.

Then `deno task stolos build`, commit, push, and `archon update` on the server (or wait for the
reconcile timer). The welcome page lists ports that listen but are not published, with the line that
would publish each.

## Checking

```sh
archon web status     # Traefik, the welcome page, the certificate, DNS, every route
archon verify         # includes HTTPS, the certificate, and DNS
journalctl -u traefik -f
```

## Files

| Path                              | What                                                           |
| --------------------------------- | -------------------------------------------------------------- |
| `/etc/traefik/traefik.yml`        | Traefik's static configuration (rendered from the model)       |
| `/etc/traefik/dynamic/archon.yml` | routes, the LAN-only middleware (rendered; Traefik watches it) |
| `/var/lib/traefik/acme.json`      | the Let's Encrypt account and certificates (Traefik only)      |
| `/etc/archon/web/`                | the Cloudflare token, root only                                |

## /etc history (spec 033)

Every server keeps a local git history of `/etc` with etckeeper: a commit around each apt run, one a
day, and one per `archon apply` with its specs. It holds secrets, so it is root-only and never
pushed.

```sh
sudo etckeeper vcs log --stat -5
sudo etckeeper vcs diff
```
