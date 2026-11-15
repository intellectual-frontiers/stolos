# Feature Specification: Outbound mail

**Feature Branch**: `027-mail` (committed directly to main) **Created**: 2026-11-11 **Status**:
Implemented **Input** (revised 2026-11-11: one onboarded domain, the machine in the subaddress:
`root+alpha.lab@example.net`, `alice+bootpc.lab@example.net`, so new servers never need a Cloudflare
change): Apps, services, cron, and unattended-upgrades on every server need to send mail the
ordinary way (`sendmail`, SMTP on localhost), not through a mail provider's API. example.net is on
Cloudflare (registrar and DNS), and the owner has the Workers Paid plan: relay through Cloudflare
Email Service, with DKIM for `example.net`. Replace the Gmail API.

## User Scenarios & Testing _(mandatory)_

1. **Given** a server with the token, **When** any program runs `sendmail` or speaks SMTP to
   `localhost:25`, **Then** the message leaves through Cloudflare from
   `<user>+<host>.lab@example.net`, DKIM-signed, and arrives.
2. **Given** a cron job or a service that mails `root` (or `ops`, or a local user), **Then** the
   message arrives in the fleet's shared mailbox.
3. **Given** Cloudflare is unreachable, **Then** Postfix keeps the message and retries; a message
   Cloudflare refuses for good (for example, the domain not onboarded) is reported by
   `archon notify watch` as "mail to <address> bounced".
4. **Given** `archon doctor`, **Then** the Email phase shows whether the domain's records exist,
   whether the relay accepts the token (logging in, sending nothing), and whether Postfix runs,
   relays to Cloudflare, and has an empty queue.

## Requirements _(mandatory)_

- **FR-001**: The model: `fleet.mail { to, domain, tag?, relay? }` (here `example.net` and `lab`),
  relay default `smtp.mx.cloudflare.net:465`. Without it, no mail capability is applied.
- **FR-002**: Postfix (Ubuntu's default mail server) on every server, installed with its debconf
  question preseeded to "No configuration" (`PackageDef.debconf`, set with `debconf-set-selections`
  before install), and `libsasl2-modules` (the SASL PLAIN mechanism).
- **FR-003**: `/etc/postfix/main.cf`, rendered: a send-only null client (Postfix's
  STANDARD_CONFIGURATION_README): `inet_interfaces = loopback-only`, `mydestination =` empty,
  `local_transport = error:local delivery is disabled`, `myorigin = <host>.<domain>`,
  `myhostname = <host>.<domain>`, `inet_protocols = ipv4` where `network.ipv6` is false;
  `relayhost = [smtp.mx.cloudflare.net]:465` with `smtp_tls_wrappermode = yes` (Cloudflare offers
  implicit TLS only), `smtp_tls_security_level = secure` (the certificate verified against the
  relay's name, CA file `/etc/ssl/certs/ca-certificates.crt`), `smtp_sasl_auth_enable = yes`,
  `smtp_sasl_password_maps = texthash:/etc/postfix/sasl_passwd` (no postmap step), `noanonymous`;
  `message_size_limit` 25 MiB (Cloudflare's limit). Changes restart Postfix; `postfix check` runs
  after each write.
- **FR-004**: Senders: every envelope and header sender keeps its user, drops any subaddress it had,
  and gets the machine as its subaddress (RFC 5233) at the one onboarded domain:
  `<user>+<host>.<tag>@<domain>`, `root+alpha.lab@example.net` (`sender_canonical_maps`, regexp;
  idempotent). archon's own messages: `root+<host>.<tag>@<domain>` from servers,
  `<user>+<pc>.<tag>@<domain>` from the boot machine, with a display name (`alpha (Archon)`) and
  `Reply-To:` the shared mailbox, so replies never go to an address nobody reads. Recipients:
  unqualified local accounts become `<user>@<host>.<tag>.<domain>` (`myorigin`, an internal name
  only, never a sender); any address on `localhost`, `<host>`, `<host>.localdomain`, or
  `<host>.<tag>.<domain>` goes to `mail.to` (`virtual_alias_maps`, regexp). Other addresses,
  including real ones at `<domain>`, are relayed as written.
- **FR-005**: The token: `/etc/postfix/sasl_passwd`, one line
  `[smtp.mx.cloudflare.net]:465 api_token:<token>`, root only, written by `archon mail credential`
  (install delivery and `bun run stolos boot mail-push`), which reloads Postfix. Never in the model,
  a spec, git, or a log.
- **FR-006**: `archon mail test` hands a message for root to `/usr/sbin/sendmail`: the path every
  program uses. `archon verify` checks that Postfix is active and warns while the token is missing.
- **FR-007**: Cloudflare, once (the owner, in the dashboard): onboard `example.net` under Compute >
  Email Service > Email Sending (Cloudflare adds MX, SPF, and DKIM on `cf-bounce.example.net`, DMARC
  `p=reject` on `_dmarc.example.net`), and create an API token (account `cfat_` or user `cfut_`)
  with Email Sending: Edit. New servers need no Cloudflare change. The Workers Paid plan includes
  3,000 messages a month.

### Overrides of Ubuntu defaults

- Postfix's `main.cf`: Ubuntu's debconf would generate one for an "Internet Site" that receives
  mail. A server here must not receive mail from the network or deliver locally, and must relay with
  SASL over implicit TLS, which debconf cannot express; so debconf writes nothing ("No
  configuration") and archon renders the file. Postfix has no drop-in directory.

## Success Criteria _(mandatory)_

- **SC-001**: `archon mail test` on alpha arrives in the mailbox from `root+alpha.lab@example.net`,
  with DKIM passing (Gmail's "Show original").
- **SC-002**: The rendered `main.cf` and maps pass Postfix's own `postconf` and `postmap -q`
  (checked against Ubuntu's Postfix package).
