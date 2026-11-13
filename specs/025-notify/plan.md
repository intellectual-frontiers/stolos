# Plan: 025-notify

## Shape

- `src/archon/notify/mime.ts`: RFC 5322 with MIME (text, HTML, attachments), base64 and base64url.
- `src/archon/notify/redact.ts`: secret shapes and exact strings.
- `src/archon/notify/transport.ts`: the credential (a Cloudflare API token); curl's SMTP
  configuration on stdin; send, and log in without sending; Postfix's `sasl_passwd` format (spec
  027).
- `src/archon/notify/notify.ts`: sites (host or boot machine), `compose`, `enqueue` (dedupe),
  `collapse`, `flush` (backoff), `kick`, status.
- `src/archon/notify/events.ts`: the Archon events: `applyTransition` (pure) and `applyOutcome`,
  `rebootCheck`, `verifyOutcome`, `backupOutcome`; health in `/var/lib/archon/status/health.json`.
- `src/archon/notify/watch.ts`: the journal follower: `classify` and `eventFor` (pure),
  `failedSummary`, key, disk, and boot checks.
- `src/archon/notify/commands.ts`: `archon notify *` and `installCredential`.
- `src/archon/capabilities/notify.ts` (in `foundation()`): tmpfiles for the spool and credential
  directories, `archon-notify-flush` service and timer, `archon-notify-watch` service, the verify
  warning.
- `src/archon-boot/mail.ts`: `mail-setup` (the Cloudflare steps, the token checked by logging in),
  `mail-push`, `notify`.
- Delivery at install: `render/autoinstall.ts` writes `/etc/archon/mail_credential.json` (0600);
  first boot installs it as Postfix's `sasl_passwd` and removes the copy.

## Decisions

- One relay for everything (revised 2026-11-11): Cloudflare Email Service, because programs on
  servers need ordinary SMTP (spec 027), and the sending domain is already on Cloudflare. The Gmail
  API is removed.
- curl for archon's own sends: Cloudflare's own example client, present on Ubuntu and Windows; its
  configuration on stdin keeps the token out of argv; `--ipv4` matches spec 009.
- The queue first, the send after: sending is never on the path of the action it reports.
- The journal, not PAM hooks or auditd, for logins and server events: Ubuntu already records them
  (Article 2), and one follower covers sshd, sudo, su, accounts, the kernel, and systemd.
- Workstations do not carry the capability by default; `notify()` can be added to one.
