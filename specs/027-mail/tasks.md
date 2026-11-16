# Tasks: 027-mail

- [x] T001 `fleet.mail`; `PackageDef.debconf`
- [x] T002 Postfix null client relaying to Cloudflare (implicit TLS, SASL, verified certificate)
- [x] T003 Sender and recipient maps; checked with postconf and postmap
- [x] T004 Token: install delivery, `archon mail credential`, `bun run stolos boot mail-setup` and
      `mail-push`
- [x] T005 `archon mail test`; doctor's Email phase; bounces in the watcher
- [x] T006 Docs: Cloudflare steps, mail from programs; troubleshooting
- [ ] T007 Owner: onboard the domain and create the token in Cloudflare; then `mail-setup`,
      `mail-push alpha`
