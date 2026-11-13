# Feature Specification: Notifications by email

**Feature Branch**: `025-notify` (committed directly to main) **Created**: 2026-11-11 **Status**:
Implemented **Input**: Major events on every server, workstation, and the boot machine should reach
the owner without anyone watching a terminal: email to the shared mailbox fleet@example.net, from
`root+<host>.lab@example.net`. Then: logins and other events an operator must know about, with
enough detail to tell whether someone is on a server who should not be.

## User Scenarios & Testing _(mandatory)_

### User Story 1: major Archon events (P1)

1. **Given** the boot machine ran `deno task boot mail-setup`, **When** a host installs, **Then** it
   receives the credential with the install and its first message is "[Archon] alpha: ✓ Ready" (or
   "✗ Done with problems") with `installed.json` attached.
2. **Given** a host whose reconcile starts failing, **Then** exactly one "✗ apply failing since
   HH:MM" message arrives with the failing lines and the log; when it succeeds again, exactly one "✓
   apply recovered"; while it keeps failing, one reminder a day.
3. **Given** the relay cannot be reached, **Then** the action that wanted to send finishes as if
   nothing happened, the message waits on disk and is retried with backoff, and after a long outage
   the backlog arrives as one "N messages were queued" summary.
4. **Given** a person on a host (or an agent through MCP), **When** they run
   `archon notify send --subject "Lab Network Runbook Change Log: VLAN 40" --body-file notes.txt --attach runbook.html`,
   **Then** that message arrives with the attachment.

### User Story 2: logins and other server events (P1)

1. **Given** someone logs in to a server over SSH, **Then** a message names the user, the address
   and its DNS name, whether that is a local network, the method, and the key's fingerprint and
   comment. Repeated logins by the same user, address, and method are reported once an hour; a login
   from outside the local networks, or from an address never seen for that user, is a warning; any
   root login is a failure.
2. **Given** failed SSH logins, **Then** one summary an hour lists each address with its count and
   the user names tried.
3. **Given** a console login, `su`, a refused `sudo`, an account or group changed outside
   `archon apply`, or a changed `authorized_keys`, **Then** a message says what happened and what to
   look at.
4. **Given** the kernel kills a process for memory, reports a disk or filesystem error, remounts a
   filesystem read-only, or logs a hardware error; a system unit fails; the machine boots (after a
   clean shutdown or not); or a filesystem passes 90% full, **Then** a message says so, once per
   occurrence (and per hour or day where they repeat).

## Requirements _(mandatory)_

- **FR-001**: The model: `fleet.mail { to, domain, relay? }` (spec 027; was
  `notify { to, fromDomain }`). archon's messages come from `root+<host>.<tag>@<domain>` on servers
  and `<user>+<pc>.<tag>@<domain>` from the boot machine (`alice+bootpc.lab@example.net`), named
  `<machine> (Archon)`, with `Reply-To:` the shared mailbox.
- **FR-002**: Transport (revised 2026-11-11, spec 027): Cloudflare Email Service's authenticated
  SMTP submission, `smtp.mx.cloudflare.net:465`, implicit TLS, user `api_token`, the password a
  Cloudflare API token with Email Sending: Edit; Cloudflare signs with DKIM for the onboarded
  sending domain. archon's own messages go there with curl (its configuration, token included, on
  stdin: never in argv), IPv4 only where `network.ipv6` is false; programs on servers go through
  Postfix (spec 027) with the same token. Superseded: the Gmail API with OAuth (`gmail.send`) and
  the App Password fallback, removed so that one relay serves archon and every program alike.
- **FR-003**: The sending domain `example.net` is onboarded under Email Service > Email Sending (the
  machine is in the subaddress, so new machines need no Cloudflare change); Cloudflare's onboarding
  adds its MX, SPF, and DKIM records on `cf-bounce.<domain>` and DMARC on `_dmarc.<domain>`.
  Messages keep their `From:` address (no rewriting by the mailbox provider).
- **FR-004**: `deno task boot mail-setup` lists the two dashboard steps (onboard the domain; create
  an account API token with Email Sending: Edit), reads the token hidden, logs in to the relay
  without sending (EHLO, AUTH, NOOP) and stores it only if Cloudflare accepts it, in the boot
  machine's secrets folder (`mail.json`, never in git), says how to revoke it, then runs the
  doctor's email checks and mails their findings to the shared mailbox (spec 026 FR-012).
- **FR-005**: Servers get the token with the install (delivered 0600, installed by first boot) or
  with `deno task boot mail-push <host>` (SSH, `archon mail credential` on stdin, which then mails
  the doctor's email findings through archon and Postfix). It lives in Postfix's
  `/etc/postfix/sasl_passwd`, root only; archon reads the same file.
- **FR-006**: Commands:
  `archon notify send --subject <s> [--body <text> | --body-file <f>] [--attach <file>]... [--level info|warn|fail] [--key <k>] [--wait]`;
  `archon notify test` ("[Archon] <host>: notification test", waits for the relay);
  `archon notify status [--check]` (mailbox, credential, last send and result, queue);
  `archon notify flush`; `archon notify watch` (User Story 2); `archon mail credential` and
  `archon mail test` (spec 027). On the boot machine: `deno task boot notify <same options>`,
  `notify test`, `notify status`. A subject starting with `[` or `Lab` is sent as given (the network
  change log); any other becomes `[Archon] <host>: <subject>`.
- **FR-007**: Archon events, major only: install finished (with `installed.json`); `boot reinstall`
  started and the host's Ready message when it finishes; `host add`; apply state changes (ok to
  failing, failing to ok, still failing after 24 hours) with the failing lines and log; verify
  regressions (checks that passed and now fail); updates that need a reboot (once per boot) and
  every `archon reboot`; backup failures and a weekly success summary; the daily report (spec 013)
  as the daily message; guests created and deleted (spec 017); tools-sync failures.
- **FR-008**: Format: subject `[Archon] <host>: <event>`; body with the host, time in UTC and local,
  the commit, what happened, what to do, and the log path; text and HTML parts. Attachments: text
  redacted, trimmed to its last 256 KB, gzipped above 64 KB, about 1 MB in all.
- **FR-009**: Never a secret: the subject, body, and every text attachment pass through redaction of
  private keys, GitHub, Anthropic, Cloudflare (`cfat_`, `cfut_`, `api_token:`), and Google tokens
  and secrets, password hashes, `key=value` secrets, bearer headers, and the exact strings of the
  credential in use. Send errors are redacted too.
- **FR-010**: Reliability: messages are queued in `/var/spool/archon/notify` (0700 root; on the boot
  machine beside its cache) before anything is sent; `archon-notify-flush` (every 5 minutes, and
  started by every new message) sends them oldest first with backoff of 1, 5, 15, 60, then 180
  minutes, stopping at the first failure; a message with the same `--key` within an hour is dropped;
  five or more messages older than an hour are sent as one summary. Queuing never throws and never
  waits for the relay: sending cannot fail or slow the action it reports.
- **FR-011**: `archon verify` warns (never fails) when notifications are not configured, the last
  send failed, or a message has waited more than 6 hours (`archon notify status --check`).
- **FR-012**: `archon-notify-watch` (a service, restarted if it stops and when the checkout changes)
  follows the journal from a saved cursor and reports, per User Story 2: SSH logins (`sshd`,
  `sshd-session`), failed logins (hourly summary by address), root logins, console logins (`login`),
  `su`, refused `sudo` and `su`, account and group changes (`useradd`, `usermod`, `groupadd`,
  `gpasswd`, `passwd`, `chpasswd`, `userdel`, `groupdel`) unless `archon` is converging the host at
  the time, kernel out-of-memory kills, disk and filesystem errors, read-only remounts,
  machine-check errors, and failed units other than Archon's own, and mail Postfix could not deliver
  (`status=bounced`; deferrals retry by themselves). Every ten minutes it compares every
  `authorized_keys` file's fingerprints with the last look and checks each filesystem (warn at 90%
  used, fail at 97%, once per mount a day). At start it reports a new boot and whether the previous
  one ended cleanly. Its state (cursor, addresses seen per user, pending failures, key fingerprints)
  is `/var/lib/archon/status/watch.json` (0600).
- **FR-013**: The watcher only reads what Ubuntu already logs: nothing is added to sshd, PAM, or
  auditd, and `sudo` successes (Archon elevates through sudo constantly) are not reported.

### Overrides of Ubuntu defaults

None.

## Success Criteria _(mandatory)_

- **SC-001**: `archon notify test` and `archon mail test` on alpha, and `deno task boot notify test`
  on BOOTPC, arrive in the mailbox from their own addresses.
- **SC-002**: A forced apply failure produces exactly one "failing" and one "recovered" message
  (tested in `tests/notify_test.ts`).
- **SC-003**: No secret appears in any message (tested).
- **SC-004**: An SSH login to alpha arrives within a minute, naming the user, address, and key.
