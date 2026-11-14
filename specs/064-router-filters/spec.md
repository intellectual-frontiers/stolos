# 064: The router filters networks; the machine restricts none

## Why

Who may reach a server is decided in one place: the router (the firewall at the edge, outside the
machine), as constitution Article 21 already has it for the internet. Archon also restricted
networks on each machine: an IP allow list in Traefik on every web route, ufw rules opening Cockpit
(9090), SMB (445), and the OpenTelemetry intake (4318) to the local networks only, `hosts allow` in
smb.conf, and `pg publish --local-only`. Two places to decide the same thing disagree: a PC on
192.168.x got "Forbidden" from every page of a newly installed server while the router let it in.

## Requirements

- **FR-001** Every port a host opens is open to every network: one ufw application profile
  (`Archon`), no per-network rules. A port's model (`PortDef`) has no `from`.
- **FR-002** An earlier engine's `Archon-LAN` ufw rules are deleted, by number, before the profile
  is applied, so a running server loses them on its next update.
- **FR-003** Traefik applies no IP allow list (revises spec 032 FR-002); smb.conf has no
  `hosts allow`/`hosts deny` (revises 037 FR-006); Cockpit's 9090 (revises 022 FR-003) and the
  OpenTelemetry intake's 4318 (revises 050) are open to every network.
- **FR-004** `archon pg publish` has no `--local-only`: a published instance admits every address in
  `pg_hba.conf` (TLS and scram-sha-256 always; `postgres` never over a network) and the firewall
  (revises 038 FR-014). A recorded `localOnly` from before is ignored.
- **FR-005** Unchanged, because they decide how a person signs in, not who reaches a port: SSH
  passwords only from the fleet's local networks (spec 007, `fleet.ssh.passwordFrom`), and Cockpit
  closed when the fleet allows no passwords at all (keys only).
- **FR-006** Messages, the guide, the login banner, and the docs say who reaches what is the
  router's decision.

## Success criteria

- **SC-001** `tests/install_test.ts`: one profile with every port, no `Archon-LAN`, the cleanup
  first; the cleanup, run against a fake ufw, deletes every `Archon-LAN` rule (IPv4 and IPv6) and
  nothing else.
- **SC-002** `tests/web_test.ts`, `smb_test.ts`, `pg_test.ts`, `otelui_test.ts`: no allow list in
  Traefik or smb.conf; 445, 9090, 4318 and a published 5432 open; no `--local-only`.
