# Feature Specification: Updates

**Feature Branch**: `009-updates` (committed directly to main) **Created**: 2026-11-10 **Status**:
Implemented **Input**: Ubuntu's unattended-upgrades as Ubuntu configures it, also installing
Ubuntu's stable updates daily (owner's decision, 2026-11-10). Updated 2026-11-11: survive flaky
upstream DNS on IPv4-only networks.

## User Scenarios & Testing _(mandatory)_

### User Story 1: A lost A record is a retry, not a failure (Priority: P1)

On alpha (Ubuntu 26.04.1, apt 3.2.1), 2026-11-11, `apt update`, `apt install`, and `archon apply`
failed intermittently with errors listing only IPv6 addresses
(`Cannot initiate the connection to archive.ubuntu.com:80 (2620:2d:4000:1::102). - connect (101: Network is unreachable)`,
then `no longer has a Release file`). The ISP's resolvers returned SERVFAIL for about 1 in 10 A
lookups of archive and security.ubuntu.com while AAAA always answered; glibc then returned only IPv6
addresses, which this IPv4-only network cannot reach, and apt never tried IPv4. The router now
forwards to 1.1.1.1 and 9.9.9.9, but hosts must not depend on that.

1. **Given** `network.ipv6: false` in the model, **Then** apt resolves and connects over IPv4 only
   and retries failed downloads, for archon apply, unattended-upgrades, and apt-daily alike.
2. **Given** a transient DNS failure during `archon apply`, **Then** apt-get update is retried with
   backoff (about 10 s, 30 s, 60 s); if it still fails, apply reports a WARN ("could not reach the
   Ubuntu archive; the next reconcile tries again"), skips only the installs that need downloads,
   finishes everything else, and the next reconcile recovers.
3. **Given** a real package error (dependencies, dpkg), **Then** it is still a FAIL.
4. **Given** a first boot that met a transient failure, **Then** `installed.json` is not left at
   `"ok": false`: network failures are warnings, and the next successful apply settles the record.

## Requirements _(mandatory)_

- **FR-001**: Verify that unattended-upgrades is installed and enabled and that
  `apt-daily-upgrade.timer` is enabled.
- **FR-002**: `/etc/apt/apt.conf.d/52archon-updates` adds `${distro_id}:${distro_codename}-updates`
  to unattended-upgrades' allowed origins, so Ubuntu's stable updates install daily, not only
  security updates. Ubuntu's phased updates still apply.
- **FR-004**: The first boot ends by starting Ubuntu's daily apt run (`apt-daily.service`,
  `apt-daily-upgrade.service`) in the background, so updates published since the installer image
  install right away instead of within a day.
- **FR-003**: Spec 010 adds the maintainers' PPAs and vendors' repositories it uses
  (`52archon-ppas`).
- **FR-005**: The model has a network property, `network.ipv6` (fleet, overridden per host; default
  true). This fleet sets `false`: the Example Lab network routes no IPv6. With `false`,
  `/etc/apt/apt.conf.d/52archon-network` sets `Acquire::ForceIPv4 "true"`, `Acquire::Retries "5"`,
  and `Acquire::http::Timeout` and `Acquire::https::Timeout` to 30 (apt.conf(5), apt 3.2.1). It also
  covers unattended-upgrades and apt-daily. On alpha, 12 runs of `apt-get download` failed 1 in 12
  with apt's defaults and 0 in 12 with these options. Drop the property when the network gains IPv6.
- **FR-006**: `archon apply`'s Packages step treats network-shaped apt failures
  (`Temporary failure resolving`, `Cannot initiate the connection`, `Could not connect`,
  `Connection timed out`, `Network is unreachable`, and `no longer has a Release file` after
  connection errors) as retryable: apt-get update and install are retried after about 10 s, 30 s,
  and 60 s, then reported as a WARN with the installs that need downloads skipped; the rest of apply
  goes on. Real package errors stay FAILs. Another apt holding a lock is waited for (up to 5
  minutes, `DPkg::Lock::Timeout=300`). The PPA reachability check (spec 010) uses the same retry,
  over IPv4 only when `network.ipv6` is false; after one PPA proves Launchpad unreachable, the next
  is asked once.
- **FR-007**: The Snap Store (`api.snapcraft.io`) times out from this network (SYN-ACKs logged as
  `[UFW BLOCK]`, conntrack INVALID; an upstream SYN challenge is suspected, not confirmed). Archon
  changes neither conntrack nor UFW for it: a snap install that fails is a WARN, retried by the next
  reconcile.
- **FR-008**: First boot records network failures as warnings (`installed.json` stays `"ok": true`
  with them listed under `problems`), and an apply that succeeds settles a record left at
  `"ok": false` (its problems move to `resolved`).
- **FR-009**: `archon verify` warns (never fails) when `getent ahostsv4 archive.ubuntu.com` returns
  nothing ("DNS isn't returning IPv4 addresses; check the router's upstream DNS"), and when the host
  has no global IPv6 default route but `52archon-network` with ForceIPv4 is missing.

### Overrides of Ubuntu defaults

- apt on IPv4-only networks: ForceIPv4, 5 retries, 30-second timeouts (`52archon-network`). Reason:
  FR-005.
- unattended-upgrades also installs the `-updates` pocket (Ubuntu's default config lists it but
  leaves it commented out). Reason: the owner wants every stable fix applied daily on an LTS
  release, not only security fixes.
