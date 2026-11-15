# Feature Specification: archon doctor

**Feature Branch**: `026-doctor` (committed directly to main) **Created**: 2026-11-11 **Status**:
Implemented **Input**: The network has caused most of alpha' problems (upstream DNS losing A
records, unreachable IPv6 addresses, Snap Store and GitHub API timeouts). Every server needs one
quick command that says whether it can reach the internet, its package sources, its security and
time services, GitHub, and the mail service, and if not, what is wrong and where to look. Use the
Linux ecosystem's well-known tools; invent nothing.

## User Scenarios & Testing _(mandatory)_

1. **Given** a healthy host, **When** `archon doctor` runs, **Then** it finishes in seconds and
   shows each phase as ok with its key facts (address, gateway latency, DNS servers, clock offset,
   each endpoint with its DNS, connect, and TLS times).
2. **Given** the router's upstream DNS drops some answers, **Then** the DNS phase reports how many
   of five uncached lookups failed, and whether a public resolver answers (the router, not the
   internet, is the problem).
3. **Given** a site that times out, **When** `archon doctor --trace` runs, **Then** mtr shows where
   the path stops.
4. **Given** the Cloudflare token was revoked or the sending domain is not onboarded, **Then** the
   Email phase fails with the fix, without sending anything.

## Requirements _(mandatory)_

- **FR-001**: `archon doctor` (read-only, elevated through sudo for the firewall and the notify
  credential), an operation with phases, each problem with what it means and where to look,
  finishing in seconds. `--trace` adds mtr (TCP, three cycles) to up to three failing sites.
- **FR-002**: Link: the default route, carrier, duplex, MTU, and interface error counters (`ip -j`,
  sysfs).
- **FR-003**: Gateway: five pings (loss, average latency) and one full-size don't-fragment ping
  (MTU).
- **FR-004**: DNS: the servers in use (`resolvectl dns`); five uncached lookups of
  archive.ubuntu.com through systemd-resolved (`resolvectl query -4 --cache=no`); each server
  directly (`dig`); only when every server fails, 1.1.1.1, to tell the router's DNS from the
  internet's; and this host's `<host>.localdomain` record (Article 20).
- **FR-005**: IPv6: a default route; without one, whether sites publish IPv6 addresses while apt is
  not limited to IPv4 (spec 009); with one, whether it works.
- **FR-006**: Time: `timedatectl` NTPSynchronized, `chronyc tracking` (reference, offset),
  `chronyc sources` (TLS needs the right time).
- **FR-007**: Proxy and firewall: proxy variables and apt proxy settings, UFW's default outgoing
  policy.
- **FR-008**: Internet: every endpoint taken from the machine's own configuration, never a list kept
  in Archon: each enabled apt repository's InRelease (`/etc/apt/sources.list.d`,
  `/etc/apt/sources.list`), the checkout's remote (over SSH, `git ls-remote` as ops with the deploy
  key), GitHub's API and a release download followed through its redirect (the tools catalog), each
  tool installer (Claude Code, on workstations), the model's OpenTelemetry collector, and the Snap
  Store through snapd's own `snap debug connectivity`. Each probe is curl with its own timings; a
  failure is explained by curl's exit code (DNS, refused or unreachable, timeout, TLS, certificate,
  reset). Over IPv4 only where `network.ipv6` is false.
- **FR-009**: Email (specs 025, 027), shared with `bun run stolos boot doctor`: the sending domain's
  records (Cloudflare's SPF, DKIM, and MX on `cf-bounce.<domain>`, DMARC on `_dmarc.<domain>`), a
  login to the relay with the stored token (curl: EHLO, AUTH, NOOP; nothing sent), and on servers
  Postfix: active, its relayhost, its queue (`postqueue -j`) with the first delay reason. archon
  notify's queue and last send.
- **FR-010**: Tools: Ubuntu 26.04 Server already ships each tool the doctor calls (`ubuntu-minimal`:
  iproute2, iputils-ping, netcat-openbsd, chrony; `ubuntu-standard`: bind9-dnsutils, mtr-tiny,
  iputils-tracepath, ethtool, tcpdump; `ubuntu-server`: curl). The `doctor()` capability declares
  them on servers and workstations so a smaller install still has them. Nothing is built or
  downloaded outside apt.
- **FR-012**: `--send` (`archon doctor --send`, `bun run stolos boot doctor --send`) also mails the
  Email phase's findings to the shared mailbox (the fleet's message queue), through archon's own
  sender (waiting for the relay's answer) and, on servers, through Postfix as root. It happens by
  itself after `bun run stolos boot mail-setup` stores a token, on every server's first boot
  ("installed"), and when a server receives a token (`archon mail credential`, from `mail-push`).
  The message lists every finding; the token never appears in it.
- **FR-011**: Every tool runs with a time limit (coreutils `timeout`) and `LC_ALL=C`, so the doctor
  cannot hang and its parsing does not depend on the locale.

### Overrides of Ubuntu defaults

None.

## Success Criteria _(mandatory)_

- **SC-001**: On alpha, `archon doctor` finishes in under 30 seconds with the network healthy.
- **SC-002**: The parsers match the tools' real output (tests use the formats from iputils,
  systemd's resolvectl.c, chrony's client.c, and snapd's own tests).
