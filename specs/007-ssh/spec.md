# Feature Specification: SSH

**Feature Branch**: `007-ssh` (committed directly to main) **Created**: 2026-11-10 **Status**:
Implemented **Input**: SSH keys from anywhere; passwords as well from local networks (owner's
decision, 2026-11-11).

## Requirements _(mandatory)_

- **FR-001**: The installer sets `allow-pw: false` and installs the fleet admin's GitHub keys (spec
  004).
- **FR-002**: `/etc/ssh/sshd_config.d/50-archon.conf`: no root login; public keys only, except from
  the networks in `fleet.ssh.passwordFrom` (default: 10.0.0.0/8, 172.16.0.0/12, 10.0.0.0/16,
  fc00::/7, fe80::/10), where an OpenSSH `Match Address` block also accepts the account's password
  (`AuthenticationMethods publickey password`). `passwordFrom: []` means keys only everywhere.
  Validated with `sshd -t` before it takes effect. The installer's `allow-pw: false` covers the
  minutes before the first boot applies this.
- **FR-003**: Port 22/tcp is modeled, so the firewall (spec 008) admits it.
- **FR-004**: `/etc/ssh/ssh_known_hosts` holds GitHub's published host key, so no account is asked
  to trust github.com by hand.

### Overrides of Ubuntu defaults

- Password authentication is off except from local networks, and keyboard-interactive is off (Ubuntu
  allows both from anywhere by default). Root never logs in over SSH.
