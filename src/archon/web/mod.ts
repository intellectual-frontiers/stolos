/**
 * # HTTPS on every server
 *
 * Every server answers HTTPS from its first boot (spec 032). Traefik listens on 80 and 443; 80 only
 * redirects. Traefik restricts no network: **who reaches the server is the router's decision** (the
 * firewall at the edge, outside the machine). Forward nothing to it from the internet unless you mean
 * to publish it. Traefik's dashboard has no password of its own.
 *
 * | URL                                     | What                                                            |
 * | --------------------------------------- | --------------------------------------------------------------- |
 * | `https://alpha.lab.example.net`         | the Archon Console: sign in, then health, actions, logs, guides |
 * | `https://cockpit.alpha.lab.example.net` | Cockpit                                                         |
 * | `https://traefik.alpha.lab.example.net` | Traefik's dashboard: routers, services, certificates            |
 * | `https://<app>.alpha.lab.example.net`   | anything you publish (below)                                    |
 *
 * Before the certificate arrives, or without a Cloudflare token, Traefik answers with its own
 * self-signed certificate, and `https://<address>` shows the Archon Console too.
 *
 * ## The Archon Console
 *
 * `https://<host>.<domain>` is the server in a browser (spec 065). Sign in with your account on the
 * server: the same username and password as SSH (Linux checks them, through PAM). Nothing is shown
 * before you sign in.
 *
 * | Page              | What it is for                                                                          |
 * | ----------------- | --------------------------------------------------------------------------------------- |
 * | Overview          | health, the commit applied and who signed it, a diagram of how the server stays current |
 * | Services          | optional services (PostgreSQL, S3, file sharing, telemetry) and every unit's state      |
 * | Apps, Data        | every HTTPS address; whether the server holds data that exists nowhere else             |
 * | Logs              | the journal, live, for one service or everything                                        |
 * | Actions (6 pages) | every `archon` command as a form, grouped, each with a diagram; output streams live     |
 * | Activity          | every sign-in and every command run from the console: who, from where, the result       |
 * | How it works      | the repositories, signing, and the path of a change, as diagrams                        |
 *
 * Everyone with an account can look. Operators (members of `sudo` or `archon-ops`) can also run
 * commands that change the server; destroying data also needs the password again and the typed
 * confirmation (`--confirm-destroy`). A command runs as you: `archon console exec` checks again, as
 * root, that you may run it, then systemd runs it with your name, so every record names you, and a
 * change is mailed to the fleet's mailbox. Five wrong passwords in a minute pause sign-ins from that
 * address. Only a signed-in browser session is accepted (no HTTP Basic); wrong passwords are throttled
 * by address and by account.
 *
 * ## Once: the Cloudflare token
 *
 * In Cloudflare: My Profile > API Tokens > Create Token > "Edit zone DNS" template, named
 * `archon web`, with **Zone > DNS > Edit** and **Zone > Zone > Read**, for the zone `example.net`.
 * Then on the boot machine:
 *
 * ```powershell
 * deno task stolos boot web-setup          # paste it (hidden); checked against the zone; stored on this PC only
 * deno task stolos boot web-push alpha    # a running server; new installs get it by themselves
 * ```
 *
 * Each server then keeps two records in Cloudflare, `alpha.lab.example.net` and
 * `*.alpha.lab.example.net`, to its private address (not proxied, TTL 60), and Traefik gets one Let's
 * Encrypt certificate for both through Cloudflare's DNS challenge. No reserved IP is needed: the
 * records follow the address the server has now (its default route's source). `archon web dns-check`
 * compares it 30 seconds after boot and every 5 minutes, and only a new address (a new DHCP lease)
 * reaches Cloudflare, journaled (`journalctl -t archon-web`) and mailed. Back the token up with the
 * other secrets: `deno task stolos vault backup`.
 *
 * ## Reinstalls keep the certificate
 *
 * `deno task stolos boot reinstall <host>` copies the server's Let's Encrypt store (Traefik's
 * `/var/lib/traefik/acme.json`) to the boot machine before erasing it, and the new install puts it
 * back before Traefik first starts: the same trusted certificate from the first minute, and no new
 * request to Let's Encrypt, which allows only 5 identical certificates a week. The reinstall's output,
 * the boot server window, and the reinstall email each say whether it was carried. Renewals stay on
 * the server. The copy is a cache (`hosts/<host>/acme.json` in the secrets folder), never backed up:
 * losing it only means one new certificate. A brand-new server, or one that could not be reached, asks
 * Let's Encrypt as usual.
 *
 * ## Publishing a service
 *
 * - **Something on the server itself**: in its host model (`fleets/<fleet>/hosts/alpha/host.ts`):
 *
 *   ```ts ignore
 *   web: { routes: [{ name: "grafana", port: 3000, description: "dashboards" }] },
 *   ```
 *
 *   `https://grafana.alpha.lab.example.net` reaches `127.0.0.1:3000`. Add `https: true` for a backend
 *   that speaks TLS itself, or `address` for another backend address.
 * - **An LXD guest**:
 *   `guests: [{ name: "db", kind: "container", image: "ubuntu:26.04", web: { port: 8080 } }]`
 *   publishes `https://db.alpha.lab.example.net`.
 * - **A container (Podman)**: no model change. Run it as root with the label:
 *
 *   ```sh
 *   sudo podman run -d --name whoami --label traefik.enable=true docker.io/traefik/whoami
 *   ```
 *
 *   `https://whoami.alpha.lab.example.net` answers. For a port other than the image's first exposed
 *   one, add `--label traefik.http.services.whoami.loadbalancer.server.port=8080`.
 *
 * Then `deno task stolos build`, commit, push, and `archon update` on the server (or wait for the
 * reconcile timer). The welcome page lists ports that listen but are not published, with the line that
 * would publish each.
 *
 * ## Checking
 *
 * ```sh
 * archon web status     # Traefik, the welcome page, the certificate, DNS, every route
 * archon verify         # includes HTTPS, the certificate, and DNS
 * journalctl -u traefik -f
 * ```
 *
 * ## Files
 *
 * | Path                              | What                                                           |
 * | --------------------------------- | -------------------------------------------------------------- |
 * | `/etc/traefik/traefik.yml`        | Traefik's static configuration (rendered from the model)       |
 * | `/etc/traefik/dynamic/archon.yml` | routes, the LAN-only middleware (rendered; Traefik watches it) |
 * | `/var/lib/traefik/acme.json`      | the Let's Encrypt account and certificates (Traefik only)      |
 * | `/etc/archon/web/`                | the Cloudflare token, root only                                |
 *
 * ## /etc history (spec 033)
 *
 * Every server keeps a local git history of `/etc` with etckeeper: a commit around each apt run, one a
 * day, and one per `archon apply` with its specs. It holds secrets, so it is root-only and never
 * pushed.
 *
 * ```sh
 * sudo etckeeper vcs log --stat -5
 * sudo etckeeper vcs diff
 * ```
 *
 * @module
 */

export {};
