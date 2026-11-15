# Feature Specification: Platform (Ubuntu Server 26.04 LTS defaults)

**Feature Branch**: `001-platform` (committed directly to main) **Created**: 2026-11-10 **Status**:
Implemented **Input**: Record which Ubuntu Server 26.04 LTS defaults Archon relies on, verify them
on every host, and list every override with its reason (Articles 1 and 2).

## User Scenarios & Testing _(mandatory)_

### User Story 1: Ubuntu decides (Priority: P1)

As the owner, I want Archon to use Ubuntu's own components exactly as Ubuntu ships them, so that
hosts are modern by default and Archon stays a thin layer.

**Independent Test**: on a freshly installed host, `archon verify` checks every default below and
reports any that drifted.

**Acceptance Scenarios**:

1. **Given** a host installed by Ubuntu's installer from Archon's config, **When** `archon verify`
   runs, **Then** every platform check passes with no Archon changes made for them.
2. **Given** a default Archon relies on is missing (for example chrony removed by hand), **When**
   `archon verify` runs, **Then** it fails that check with a fix.

### Edge Cases

- A default Archon does not use (for example the `ubuntu` cloud-init account) is left alone unless
  an override below says otherwise.

## Requirements _(mandatory)_

### Defaults relied on (verified against the 26.04.1 live-server manifest)

| Area                | Ubuntu 26.04 default                                           | Archon's use                                 |
| ------------------- | -------------------------------------------------------------- | -------------------------------------------- |
| Networking          | netplan.io 1.2 with systemd-networkd                           | Archon renders netplan YAML (spec 008)       |
| DNS                 | systemd-resolved                                               | used as is                                   |
| Time                | chrony 4.8 (systemd-timesyncd is not installed)                | used as is                                   |
| Privilege           | sudo-rs (and sudo)                                             | sudoers drop-ins for personas (spec 006)     |
| Firewall            | ufw (nftables backend)                                         | rules rendered from modeled ports (spec 008) |
| Packages            | apt with deb822 sources; snapd                                 | apt or snap per tool (spec 010)              |
| Updates             | unattended-upgrades                                            | configured, not replaced (spec 009)          |
| Install, first boot | autoinstall (Subiquity), cloud-init 26.1                       | spec 004, spec 005                           |
| SSH                 | OpenSSH 10.2                                                   | drop-in hardening (spec 007)                 |
| Security            | AppArmor 5                                                     | used as is                                   |
| Containers, VMs     | LXD (snap, via lxd-installer)                                  | spec 017                                     |
| Base userland       | rust-coreutils, dracut, git, curl, tmux 3.6, btrfs-progs, zstd | used as is                                   |

### Functional Requirements

- **FR-001**: The `platform` capability verifies each relied-on default (package present, unit
  active or enabled) and installs nothing.
- **FR-002**: Write `/etc/archon/host` with the host's model name; Archon uses it to pick the host
  model.
- **FR-003**: Create `/var/lib/archon` and its state directories through tmpfiles.d.
- **FR-004**: Every override of an Ubuntu default lives in the spec that makes it, in a section
  named "Overrides of Ubuntu defaults", with the reason.
- **FR-006**: Name resolution and discovery (constitution Article 20, the network owner's decision
  of 2026-11-11): services are found by unicast DNS names (UniFi Local DNS, `<host>.localdomain` or
  a service alias such as `otel.localdomain`) or addresses in the model, never by mDNS, DNS-SD, or
  LLMNR. The Servers VLAN stays out of the gateway's mDNS reflector, which is shared with IoT: its
  service filter cannot tell which side an announcement came from, so a compromised IoT device could
  impersonate a server's `_ssh._tcp`, `_otlp-*._tcp`, or `_http._tcp`, and announcements would map
  host names, services, and versions for it. So: `/etc/systemd/resolved.conf.d/50-archon.conf` sets
  `MulticastDNS=no` and `LLMNR=no` explicitly (Ubuntu Server's effective state, now stated and
  verified); `avahi-daemon.service` and `avahi-daemon.socket` are masked and stopped where present,
  their package kept so dependents stay installed; no port 5353 or 5355 is ever opened (spec 008).
- **FR-007**: `archon verify` fails when anything listens on UDP 5353 or 5355, when avahi is not
  masked or absent, or when resolved does not report `-LLMNR -mDNS`.

### Overrides of Ubuntu defaults

- systemd-resolved: `MulticastDNS=no` and `LLMNR=no` stated explicitly (FR-006).
- avahi-daemon, when a package pulls it in, is masked (FR-006).

## Success Criteria _(mandatory)_

- **SC-001**: A host installed from Archon's autoinstall config passes every platform check with
  zero Archon changes for them.

## Assumptions

- The host was installed by Ubuntu's installer from the config Archon rendered (spec 004).
- The network these hosts live on (facts; Archon does not change them): a UniFi Cloud Gateway
  Ultra; servers on the Servers VLAN 30, 10.0.30.0/24, gateway and DNS 10.0.30.1; the boot machine
  at 10.0.1.157 on Default, 10.0.1.0/24. IPv4 only (spec 009). Hosts use the gateway as their only
  resolver (DHCP), because local names live there as UniFi Local DNS records
  (`<host>.localdomain`); Archon never points hosts at public resolvers. The zone firewall lets
  Servers reach Default only at the boot machine (UDP 69, TCP 8080), the gateway only for DNS, DHCP,
  NTP, and mDNS, and the internet.
