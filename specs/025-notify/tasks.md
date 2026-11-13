# Tasks: 025-notify

- [x] T001 `fleet.notify` in the model; senders per role
- [x] T002 MIME, redaction, SMTP to Cloudflare Email Service (curl with config on stdin, IPv4 where
      needed); the Gmail API removed
- [x] T003 Queue, dedupe by key, backoff, collapse after an outage, status
- [x] T004 `archon notify send | test | status [--check] | flush | credential`; repeatable
      `--attach`
- [x] T005 Capability: spool and credential directories, flush timer, verify warning
- [x] T006 Boot machine: `mail-setup` (Cloudflare token, checked by logging in), `mail-push`,
      `notify`
- [x] T007 Delivery with the install; first boot installs the credential and sends Ready or Done
      with problems
- [x] T008 Events: reinstall, host add, apply transitions, verify regressions, reboot needed and
      `archon reboot`, backups, daily report, guests, tools sync
- [x] T009 `archon notify watch`: logins, failed logins, root, console, su, sudo refusals, accounts,
      authorized_keys, kernel, failed units, boots, disk space
- [x] T010 Tests: MIME, redaction, dedupe, collapse, backoff, apply transitions, journal parsing,
      login messages
- [x] T011 Docs: Notifications in daily-use.md and boot-machine.md; troubleshooting
- [ ] T012 On alpha and BOOTPC: `mail-setup`, `mail-push alpha`, `archon notify test` (needs the
      owner's Cloudflare dashboard steps)
