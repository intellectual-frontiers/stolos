# Tasks: 009-updates

- [x] T001 Implement (milestone 3)
- [ ] T002 Pass the e2e install test
- [x] T003 `network.ipv6` in the model (fleet, host override); this fleet: false
- [x] T004 `52archon-network` (ForceIPv4, Retries, Timeouts) when ipv6 is false
- [x] T005 Packages step: network-shaped failures retried with backoff, then WARN; real errors FAIL;
      PPA check retried over IPv4
- [x] T006 Snap installs that fail are WARNs, retried by the next reconcile
- [x] T007 First boot: network failures are warnings; a successful apply settles installed.json
- [x] T008 verify warnings: `getent ahostsv4 archive.ubuntu.com`; ForceIPv4 present without an IPv6
      route
- [x] T009 Tests: tests/network_test.ts (a simulated DNS failure: retried, WARN, recovered)
