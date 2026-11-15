/**
 * # Telemetry: where logs, metrics, and traces go
 *
 * This guide is for anyone who looks after a fleet. It explains what every server does with its
 * telemetry on its own, how to collect it in one place when you want to, and what to do when something
 * looks wrong.
 *
 * ## On every server, always: the headless Collector
 *
 * Every server runs the official **OpenTelemetry Collector** (`archon-otelcol.service`). Nothing to
 * set up:
 *
 * - It receives OpenTelemetry (OTLP) from Archon itself and from any app on the server, on
 *   `127.0.0.1:4317` (gRPC) and `127.0.0.1:4318` (HTTP). Point an app's OpenTelemetry SDK there.
 * - It reads the server's logs (journald) and metrics (PCP).
 * - It keeps a short local copy (`/var/cache/archon-otel`), next to journald and PCP's own archives.
 *   All of it is **ephemeral**: bounded by age and size (`observability` in `fleet.ts`), the oldest
 *   goes first. `archon observe` shows how far back each one goes.
 *
 * Look at it on the server itself with `archon observe tui` (a terminal view), `journalctl`, and
 * `btop`. Nothing leaves the server until a **collector** is found.
 *
 * ## Collecting in one place (optional)
 *
 * Every 15 minutes, each server looks for a collector (`archon observe discover`), in this order, and
 * forwards to the first that answers:
 *
 * 1. **The telemetry web UI on this very server**, if it is on here (see below).
 * 2. **`telemetry.collector`** in `fleets/<id>/fleet.ts`, if you set one.
 * 3. **`otel.localdomain`**: a name in your router's local DNS.
 * 4. **The boot PC**, while its boot server runs (`bun run stolos boot serve`). It keeps a week of
 *    what it receives, in its boot cache (`telemetry/fleet/`), and shows it in otel-tui when that runs
 *    on the PC. It is optional: when it is not running, servers say so (`archon observe discover`
 *    prints how to start it) and keep their telemetry locally.
 *
 * **Only what happens after a collector is found is forwarded.** What a server kept before stays on
 * it, and expires as usual. Nothing is replayed.
 *
 * ## The telemetry web UI (OpenObserve), on any server
 *
 * OpenObserve is a web UI for logs, metrics, and traces together. It is an opt-in on every server, off
 * until you turn it on, like S3 or PostgreSQL.
 *
 * ### Turn it on
 *
 * On the server that should hold the fleet's telemetry (any server; pick one with disk to spare):
 *
 * ```sh
 * sudo archon otel ui on --ephemeral      # telemetry is usually ephemeral; --durable keeps it in backups
 * archon otel ui status                   # on, ready, its address
 * archon otel ui password --show          # the sign-in (admin@archon.local and a generated password)
 * ```
 *
 * Then open `https://otel.<host>.<domain>` from your local network and sign in.
 *
 * That server now **collects for the fleet**. Its Collector forwards everything it gathers to
 * OpenObserve (with the credential, which never leaves the server), and accepts OpenTelemetry from the
 * other servers on port 4318 (the router decides who reaches it).
 *
 * ### Make the other servers send there
 *
 * Pick one:
 *
 * - **Router DNS (simplest):** add a local DNS record `otel.localdomain` pointing at that server's
 *   address (Article 21: the router first, then `site.ts` to match).
 * - **The model:** set `telemetry: { collector: "http://<that server>:4318" }` in
 *   `fleets/<id>/fleet.ts`, commit signed, and push.
 *
 * Within 15 minutes every server forwards there (or run `sudo archon observe discover` on one to see
 * it happen now). Check from the boot machine:
 * `bun run stolos fleet query "select * from
 * archon_install"` works as before; in the UI, each
 * server shows up by its `host.name`.
 *
 * ### Turn it off
 *
 * ```sh
 * sudo archon otel ui off
 * ```
 *
 * The container stops and its page goes away; its data (`/srv/otel-ui`) and credentials are kept. The
 * server's Collector goes back to local only (or to another collector it finds), and stops accepting
 * telemetry from the network.
 *
 * ## Troubleshooting
 *
 * | What you see                                              | What it means                                                 | What to do                                                                                                                                                             |
 * | --------------------------------------------------------- | ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
 * | `archon observe discover`: `none found: local only`       | no collector answered                                         | nothing is wrong; turn on the web UI somewhere, or start the boot PC's boot server, if you want telemetry in one place                                                 |
 * | `the boot PC (...) is not collecting`                     | its boot server is not running                                | on the boot PC: `bun run stolos boot serve` (or ignore it if you do not use it)                                                                                      |
 * | `archon otel ui status`: `on, but not answering yet`      | OpenObserve is starting (the first start downloads its image) | wait a minute; `systemctl status archon-otel-ui`; `journalctl -u archon-otel-ui`                                                                                       |
 * | other servers do not appear in the UI                     | they have not found it yet                                    | check `otel.localdomain` resolves to the UI server (`getent hosts otel.localdomain` on one of them), or set `telemetry.collector`; then `sudo archon observe discover` |
 * | `otel ui on` refuses without `--durable` or `--ephemeral` | the forced choice of Article 23                               | telemetry is usually `--ephemeral`                                                                                                                                     |
 *
 * @module
 */

export {};
