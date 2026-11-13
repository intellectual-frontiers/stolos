# Plan: 027-mail

- `src/archon/capabilities/mail.ts`: packages (postfix preseeded, libsasl2-modules), `main.cf`, the
  sender and recipient maps, the unit, the token check.
- `src/archon/model/types.ts`: `FleetDef.mail`; `PackageDef.debconf`, applied in `apply.ts` before
  installing.
- `src/archon/notify/transport.ts`: `sasl_passwd` format and parsing; curl SMTP for archon's own
  messages.
- `src/archon/notify/commands.ts`: `archon mail credential`, `archon mail test`.
- `src/archon/doctor/email.ts`: DNS records, relay login, Postfix state and queue.

## Decisions

- Postfix, not a smaller relay-only agent: it is Ubuntu's default MTA, in main, with security
  support; programs and Ubuntu's own tools expect its `sendmail`.
- archon's own messages do not go through Postfix: archon keeps its queue, dedupe, and outage
  summary, and the boot machine (Windows) uses the same path.
- `texthash:` for the token: Postfix reads it directly, so there is no `.db` copy to keep in step.
- Verified with Ubuntu's Postfix package: `postconf -n` accepts every parameter; `postmap -q` shows
  the sender rewrite, the local recipients going to the mailbox, outside recipients untouched, and
  the token lookup.
