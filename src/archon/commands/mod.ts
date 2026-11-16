/**
 * # Working on a host
 *
 * `ssh alpha` lands you in fish with the Archon prompt (bash stays the account's login shell for
 * scripts and file copies; set `ARCHON_NO_FISH=1` to stay in bash).
 *
 * From your local network (any private address: 10.0.x.x, 10.x.x.x, 172.16-31.x.x) your account's
 * password works as well as your SSH key; from anywhere else only keys work. Which networks count as
 * local is `ssh.passwordFrom` in `fleets/<fleet>/fleet.ts` (`[]` for keys only). Root never logs in
 * over SSH.
 *
 * ## Commands
 *
 * ```sh
 * archon verify              # every check, with a fix for anything failing
 * archon doctor              # can this host reach what it needs? network and email, with where to look
 * archon capture             # drift from the model (writes nothing)
 * archon drift               # what changed outside Stolos, with who and when (spec 095)
 * archon state               # what this machine recorded: install, latest verify, switches, data
 * archon query "select * from archon_verify"   # ask this machine anything, in SQL (osquery)
 * sudo archon update         # pull from GitHub, validate, apply, tools, verify
 * archon tools sync --report-only   # tool versions, and upgrades available
 * archon backup verify       # restore-test the newest backup
 * archon notify status       # where notifications go, and the last send
 * archon reboot --netboot    # boot from the network once (a re-install, if armed)
 * man archon                 # every command; man archon-<command> for one
 * ```
 *
 * Host-changing commands elevate through sudo by themselves; members of `archon-ops` (you and `ops`)
 * are not asked for a password for `archon`.
 *
 * ## The Archon segment in the prompt
 *
 * The right side of the prompt shows what Archon last did on this host, for example
 * `✓ reconcile  ⇡ push`:
 *
 * | You see                            | It means                                                                              | Do                                                                 |
 * | ---------------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
 * | `✓ reconcile` (or another command) | the last archon run (here the 15-minute converge timer) finished cleanly              | nothing                                                            |
 * | `⚠ <command>` (yellow)             | it finished with warnings                                                             | `archon verify`; each warning prints its fix                       |
 * | `✗ <command>` (red)                | it failed                                                                             | `archon verify`, then the run log it names (`/var/log/archon/...`) |
 * | `🔒 2`                             | two disruptive changes (for example to SSH) were held back so they cannot cut you off | from the console or AMT: `sudo archon apply --include-disruptive`  |
 * | `⇡ push`                           | the checkout has local commits that are not on GitHub                                 | `git -C /srv/archon log origin/main..`                             |
 *
 * A host records nothing in the repository (spec 048): its install record, its latest verify, its
 * apply history, and the operators' switches stay in its own `/var/lib/archon/archon.sql` (readable
 * SQL; `archon.auto.sqlite.db` is built from it for osquery). The last icon is the segment's Archon
 * mark.
 *
 * ## Observing a machine
 *
 * Every server and workstation records itself with Ubuntu's own tools, and speaks OpenTelemetry (OTLP)
 * when anything leaves the machine (spec 021):
 *
 * | What                               | Stored by                                      | Look with                                     | Kept, at most                                               |
 * | ---------------------------------- | ---------------------------------------------- | --------------------------------------------- | ----------------------------------------------------------- |
 * | Logs                               | journald                                       | `journalctl -f`, `journalctl -u <unit>`       | 3 months and 1 GB; journald also keeps 15% of the disk free |
 * | Metrics                            | PCP (pmcd, pmlogger)                           | `btop` (live), `pmstat`, `archon observe tui` | 1 year and 2 GB; pruned first when the disk runs low        |
 * | Archon's own traces, metrics, logs | the local OpenTelemetry Collector (OTLP files) | `archon observe tui`                          | 7 days and 64 MB                                            |
 *
 * On servers, **Cockpit** shows all of it in a browser: `https://alpha:9090` from your local network,
 * logging in with your account's password (spec 022; the browser asks once to accept Cockpit's own
 * certificate). Its graphs come from the same PCP history; port 9090 is closed to other networks.
 *
 * ```sh
 * archon observe            # each store: size, how far back, limits
 * archon observe tui        # otel-tui: PCP's metrics live, Archon's runs as traces (q quits)
 * btop                      # live system view
 * ```
 *
 * All of it is ephemeral: bounded, never backed up, and the first thing to give way when the disk runs
 * low (`archon observe prune`, daily). The limits are `observability` in `fleets/<fleet>/fleet.ts` (or
 * per host), for example `observability: { metricsDays: 90, logsMaxSize: "512M" }`. Nothing is sent
 * anywhere until a central collector exists. Every 15 minutes each machine looks for one (spec 024):
 * `telemetry.collector` in `fleets/<fleet>/fleet.ts`, else the name `otel.localdomain` in your
 * router's DNS, else the boot PC itself (spec 049): while `bun run stolos boot serve` runs, it
 * accepts OpenTelemetry at `http://<boot PC>:8080/otlp` (the port servers already reach) and keeps it
 * a week under the boot cache (`telemetry/fleet/`), handing it to otel-tui when that runs on the PC.
 * When one answers OpenTelemetry, the machine forwards its logs, metrics, and Archon's own telemetry
 * to it (queued on disk, bounded, if it goes away); `archon observe` shows what was found.
 * `archon observe
 * discover` looks right away. Every signal Archon emits is listed in
 * `man 7 archon-telemetry`.
 *
 * ## Name resolution and discovery
 *
 * Hosts find each other and every service by **unicast DNS names**: the router's Local DNS records
 * (`<host>.localdomain`, for example `alpha.localdomain`, or a service alias such as
 * `otel.localdomain`), or an address written in the model. Never by multicast (constitution Article
 * 20):
 *
 * - hosts use the router (10.0.30.1 for Servers) as their only DNS resolver; never point them at
 *   public resolvers, because the local names live in the router;
 * - systemd-resolved keeps mDNS and LLMNR off, Avahi is masked if a package installed it, and the
 *   firewall never opens UDP 5353 or 5355; `archon verify` checks all three;
 * - the Servers VLAN stays out of the router's mDNS reflector, which is shared with IoT devices: an
 *   announcement could be impersonated from there, and would hand them a map of hosts and services.
 *
 * **To make a service findable**, add a UniFi Local DNS record for it (Settings, Routing, DNS, or
 * Policy Table, depending on the UniFi version) and put that name in the model, for example
 * `telemetry: { collector: "http://otel.localdomain:4318" }` in `fleets/<fleet>/fleet.ts`.
 *
 * ## Notifications
 *
 * Every server emails the fleet's shared mailbox about what matters, from `root+<host>.<tag>@<domain>`
 * (`root+alpha.lab@example.net`), subject `[Archon] <host>: <event>` (spec 025), through Cloudflare
 * Email Service. Set up once on the boot machine ([how](../../archon-boot/mod.ts#email-once-recommended)).
 *
 * | Sent when                                                                                                                                                     | Level                                                                      |
 * | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
 * | an install finishes: `✓ Ready` or `✗ Done with problems`, with `installed.json`                                                                               | info or fail                                                               |
 * | `boot reinstall` starts; `host add`                                                                                                                           | info                                                                       |
 * | apply starts failing, recovers, or still fails a day later (never for runs that stay ok)                                                                      | fail, info                                                                 |
 * | a verify check that passed now fails                                                                                                                          | fail                                                                       |
 * | updates need a reboot (once per boot); every `archon reboot`; every boot, and whether the previous one ended cleanly                                          | warn, info                                                                 |
 * | a backup fails; a weekly summary of good ones                                                                                                                 | fail, info                                                                 |
 * | the daily report, attached                                                                                                                                    | info                                                                       |
 * | guests created or deleted; tools sync fails                                                                                                                   | info, warn                                                                 |
 * | **someone logs in over SSH**: user, address and its name, local network or not, method, key fingerprint and name (once per user, address, and method an hour) | info; warn from outside the local networks or a new address; fail for root |
 * | failed SSH logins: one summary an hour, by address, with the user names tried                                                                                 | warn                                                                       |
 * | a console login (keyboard or AMT), `su`, a refused `sudo`                                                                                                     | warn, fail                                                                 |
 * | accounts or groups changed outside `archon apply`; any `authorized_keys` file changed                                                                         | warn                                                                       |
 * | out-of-memory kills, disk or filesystem errors, a read-only remount, hardware errors                                                                          | fail                                                                       |
 * | a system unit fails; a filesystem passes 90% (97%: fail)                                                                                                      | warn                                                                       |
 *
 * Logins and server events come from `archon-notify-watch`, which follows the journal (Ubuntu already
 * records all of it; nothing is added to sshd or PAM).
 *
 * ```sh
 * archon notify status       # mailbox, last send and its result, messages waiting
 * archon notify test         # send "[Archon] alpha: notification test" now
 * archon notify send --subject "disk replaced" --body "sdb swapped"
 * archon notify send --subject "Lab Network Runbook Change Log: VLAN 40" \
 *   --body-file notes.txt --attach runbook.html
 * ```
 *
 * A subject starting with `Lab` or `[` is sent as written. `--key <k>` sends a message once per hour
 * for that key; `--level warn|fail` marks it. Attachments are trimmed or gzipped to about 1 MB, and
 * secrets (tokens, keys, password hashes) are redacted from everything sent. If Cloudflare cannot be
 * reached, messages wait in `/var/spool/archon/notify` and are retried with backoff; a long outage
 * arrives as one summary. Sending never slows or fails the command it reports on. `archon verify`
 * warns if notifications are not configured or the last send failed.
 *
 * ### Mail from programs
 *
 * Every server runs Postfix as a send-only relay (spec 027), so any program can send mail the ordinary
 * way: `/usr/sbin/sendmail`, or SMTP to `localhost:25` with no login. It relays to Cloudflare Email
 * Service over TLS; every message goes out as `<user>+<host>.lab@example.net` (the user kept, the
 * machine in the subaddress; only example.net is onboarded in Cloudflare), and mail addressed to
 * `root`, `ops`, or any local account goes to the fleet's mailbox. Postfix accepts nothing from the
 * network and delivers nothing locally.
 *
 * ```sh
 * archon mail test                    # one message for root, through Postfix
 * mailq                               # anything Postfix is still holding
 * journalctl -t postfix/smtp -f       # what Cloudflare answered
 * ```
 *
 * A message Cloudflare refuses for good is reported as `mail to <address> bounced`.
 *
 * ## When the network misbehaves
 *
 * `archon doctor` takes a few seconds and checks, in order: the link (route, carrier, errors), the
 * gateway (loss, latency, full-size packets), DNS (five uncached lookups to catch a flaky upstream,
 * each server directly), IPv6, the clock, proxy and firewall, then every site this host depends on,
 * taken from its own configuration (each apt repository, GitHub, the tools' downloads, the Snap Store,
 * the telemetry collector), each with its DNS, connect, and TLS times, and finally email (spec 026).
 * Every new server, and every server given a new mail token, mails these email findings to the shared
 * mailbox by itself, through archon and through Postfix. Each problem says what it means and where to
 * look. It changes nothing.
 *
 * ```sh
 * archon doctor           # the quick look
 * archon doctor --trace   # also where the path to a failing site stops (mtr; slower)
 * archon doctor --send    # also mail the email findings to the shared mailbox (archon and Postfix)
 * ```
 *
 * By hand, the same tools: `resolvectl query archive.ubuntu.com`, `dig @10.0.30.1 archive.ubuntu.com`,
 * `mtr -n --tcp --port 443 archive.ubuntu.com`, `tracepath -n archive.ubuntu.com`, `chronyc tracking`,
 * `ip -s link`, `ethtool <interface>`, `sudo tcpdump -ni <interface> port 53`.
 *
 * ## What runs by itself
 *
 * | Timer                        | When                                              | Does                                                                                           |
 * | ---------------------------- | ------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
 * | `archon-reconcile`           | every 15 minutes                                  | pulls from GitHub and converges the host                                                       |
 * | `archon-capture`             | daily 05:47                                       | records state and drift                                                                        |
 * | `archon-backup`              | daily 02:37                                       | archives the host's state into `/var/backups/archon`                                           |
 * | `archon-web-dns`             | daily                                             | keeps `<host>.<domain>` and its wildcard in Cloudflare ([the web guide](../web/mod.ts))                      |
 * | `archon-daily-report`        | daily 06:23                                       | writes `/var/lib/archon/reports/daily-<date>.md` (facts only; mailed as the daily message)     |
 * | `archon-tools-sync`          | Mondays 04:00                                     | upgrades tools that come as release binaries                                                   |
 * | `archon-observe-prune`       | daily 04:41                                       | keeps PCP's metric archives within their size and free-space limits                            |
 * | `archon-notify-flush`        | every 5 minutes, and at once for each new message | sends queued notifications                                                                     |
 * | `archon-notify-watch`        | always (a service)                                | emails logins and other server events                                                          |
 * | `archon-observe-discover`    | every 15 minutes                                  | looks for a central OpenTelemetry collector and forwards to it if one answers                  |
 * | Ubuntu's `apt-daily-upgrade` | daily                                             | installs Ubuntu's security and stable updates, and the tools from PPAs and vendor repositories |
 *
 * ## Where tools come from
 *
 * Each tool at its newest stable release (constitution, Article 5):
 *
 * | Tool                                                         | Source                                                                           | Updated by                  |
 * | ------------------------------------------------------------ | -------------------------------------------------------------------------------- | --------------------------- |
 * | git                                                          | `ppa:git-core/ppa` (Ubuntu Git Maintainers)                                      | unattended-upgrades, daily  |
 * | fish                                                         | `ppa:fish-shell/release-4` (the fish developers)                                 | unattended-upgrades, daily  |
 * | gh                                                           | GitHub's apt repository (signing key pinned in this repository)                  | unattended-upgrades, daily  |
 * | tmux                                                         | Ubuntu (no official binaries or PPA)                                             | Ubuntu updates              |
 * | btop                                                         | Ubuntu                                                                           | Ubuntu updates              |
 * | Bun, chezmoi, oh-my-posh, OpenTelemetry Collector, otel-tui | official release binaries, SHA-256 verified, under `/opt/tools/<tool>/<version>` | `archon tools sync`, weekly |
 *
 * `sudo archon tools sync` upgrades the release-binary tools at once.
 *
 * ## An agent
 *
 * No agent runs on a server (spec 030). Claude Code runs on your workstation and reaches each server
 * as `ops` over SSH, where `archon mcp` serves the commands up to the fleet's tier and journals every
 * call (`journalctl -t archon-mcp`). See [the agent guide](../mcp/mod.ts).
 *
 * ## Changing a host
 *
 * Every change follows the spec loop in [`AGENTS.md`](../../../AGENTS.md): spec, model, `stolos build`,
 * `archon apply --check`, commit and push, then `archon apply` (or wait for the converge timer),
 * `archon verify`. Never change a host by hand outside that loop. If a change was made by hand
 * anyway, it has a way back into the model: `archon drift`, then `sudo archon propose`, and on your
 * PC `bun run stolos proposal accept` ([proposals](../proposal/mod.ts)).
 *
 * @module
 */

export {};
