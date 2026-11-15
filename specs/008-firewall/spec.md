# Feature Specification: Firewall

**Feature Branch**: `008-firewall` (committed directly to main) **Created**: 2026-11-10 **Status**:
Implemented **Input**: Ubuntu's native firewall (ufw on nftables), incoming denied except modeled
ports.

Who may reach a port is governed by spec 064: every modeled port is open to every network, in one
profile.

## Requirements _(mandatory)_

- **FR-001**: Every capability declares the ports it serves; `/etc/ufw/applications.d/archon` lists
  them as the profile `Archon`.
- **FR-002**: ufw defaults: deny incoming, allow outgoing; `ufw allow Archon`; ufw enabled.
- **FR-003**: Network configuration itself is netplan from the installer (spec 004); bridges for
  guests are added with spec 017.
- **FR-005**: UFW never opens UDP 5353 (mDNS) or 5355 (LLMNR): the validator refuses those ports
  from any capability (constitution Article 20, spec 001 FR-006).

### Overrides of Ubuntu defaults

- ufw is enabled (Ubuntu installs it inactive).
