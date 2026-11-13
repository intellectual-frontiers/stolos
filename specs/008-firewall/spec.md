# Feature Specification: Firewall

**Feature Branch**: `008-firewall` (committed directly to main) **Created**: 2026-11-10 **Status**:
Implemented **Input**: Ubuntu's native firewall (ufw on nftables), incoming denied except modeled
ports.

## Requirements _(mandatory)_

- **FR-001**: Every capability declares the ports it serves; `/etc/ufw/applications.d/archon` lists
  them as the profile `Archon`.
- **FR-002**: ufw defaults: deny incoming, allow outgoing; `ufw allow Archon`; ufw enabled.
- **FR-003**: Network configuration itself is netplan from the installer (spec 004); bridges for
  guests are added with spec 017.

- **FR-004**: Ports with `from` (spec 022: Cockpit) go into a second ufw application profile,
  `Archon-LAN`, allowed with one rule per source network
  (`ufw allow from <net> to any app Archon-LAN`); all other modeled ports stay in `Archon`, open to
  every network.

- **FR-005**: UFW never opens UDP 5353 (mDNS) or 5355 (LLMNR): the validator refuses those ports
  from any capability (constitution Article 20, spec 001 FR-006). The mDNS port spec 024 opened
  briefly is gone: removing it from the `Archon-LAN` profile and `ufw app update` drop its rules.

### Overrides of Ubuntu defaults

- ufw is enabled (Ubuntu installs it inactive).
