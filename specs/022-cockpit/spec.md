# Feature Specification: Cockpit

> **Revised by spec 064:** the machine restricts no network; who reaches this service is the
> router's decision. Statements below about the local networks only no longer hold.

**Feature Branch**: `022-cockpit` (committed directly to main) **Created**: 2026-11-11 **Status**:
Implemented **Input**: A local web view of each server, Ubuntu's own: Cockpit, with the metric
history spec 021 keeps, reachable from the local networks only.

## User Scenarios & Testing _(mandatory)_

1. **Given** a server, **When** the owner opens `https://<host>:9090` from a local network, **Then**
   Cockpit asks for their account's password and shows the system, services, the journal, storage,
   and PCP's metric history.
2. **Given** a connection from outside the local networks, **Then** port 9090 is closed.

## Requirements _(mandatory)_

- **FR-001**: Package `cockpit` (on Ubuntu 26.04 its `cockpit-bridge` provides `cockpit-pcp`, the
  PCP history), installed without recommended extras (Archon's apt never installs recommends), so no
  NetworkManager, PackageKit, or udisks next to netplan and apt.
- **FR-002**: `cockpit.socket` enabled and started (socket activation on 9090).
- **FR-003**: Port 9090/tcp is modeled with `from` = the fleet's local networks
  (`fleet.ssh.passwordFrom`, default the private ranges, spec 007). The firewall (spec 008) renders
  local-only ports into a second ufw application profile, `Archon-LAN`, allowed only from each of
  those networks. With `passwordFrom: []`, Cockpit is installed but closed.
- **FR-004**: Logins are the accounts' own (PAM); Cockpit refuses root by default. Its certificate
  is Cockpit's self-signed one; the browser asks once to accept it.
- **FR-005**: Servers only; workstations (spec 020) do not get Cockpit.

### Overrides of Ubuntu defaults

None: Cockpit as Ubuntu packages it, minus apt's recommended extras.

## Success Criteria _(mandatory)_

- **SC-001**: `archon verify` passes with `cockpit.socket` active; 9090 answers from a local network
  and not from elsewhere.
