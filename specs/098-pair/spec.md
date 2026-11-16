# 098: Pairing with a short code

Issue intellectual-frontiers/stolos#34.

## Why

Adopting a machine through `host integrate` (spec 069) prints a command about 300 characters long,
carrying the fleet, the probe's public key, the engine tag and the probe's SHA-256, to copy onto the
machine by hand, and then a `stolos1:` check-in code to copy back. It works, and it is the opposite
of how people expect to trust a device. Device login is the model: one short command that never
changes, and a short code that expires, approved on the side that is already trusted.

```mermaid
sequenceDiagram
  participant PC as Controller PC (stolos pair)
  participant M as The machine
  PC->>PC: shows the line and the code
  M->>PC: GET / (the script, from this engine)
  M->>PC: POST /hello (nonce, hostname; HMAC under the code)
  PC->>M: ok, name, probe key, probe SHA-256 (HMAC under the code)
  M->>M: SSH on, the probe installed (checked), only the key may run it
  M->>PC: POST /checkin (host keys, facts; HMAC under the code)
  PC->>PC: the person approves (name, OS, address, host key)
  PC->>M: ok: adopted
```

## Ontology

The terms this spec uses, defined in `ontology/stolos/` with this spec as their source where it is
theirs: `stolos:PairingCode`, `stolos:TrustedNetwork`, `stolos:AdoptedMachine`,
`stolos:Controller`, `stolos:Fleet`, and the integration kinds of `stolos:IntegrationKind`
(`stolos:integration-adopt`, `stolos:integration-osquery`).

## Requirements

- **FR-001** `stolos pair [--name] [--address] [--port 7457] [--title] [--owner]` listens on the
  LAN for one machine, and shows one short line to run there (`curl -fsSL http://<pc>:7457 | sh`,
  or `irm http://<pc>:7457/w | iex` in an administrator PowerShell) and a code.
- **FR-002** The code is 8 characters from an alphabet without look-alikes (`ABCDEFGHJKMNPQRSTUVWXYZ23456789`,
  about 39 bits), shown as two groups of four, chosen without bias; it is good for one machine, for
  10 minutes, and for 5 wrong signatures in all. Typed in any case, with or without the dash.
- **FR-003** The PC serves this engine's own scripts (`bin/integrate.sh`,
  `bin/integrate.windows.ps1`, both probes) with the pairing filled in: nothing comes from elsewhere
  and nothing is typed but the code. On Windows, the loader runs the script in a child PowerShell,
  so a stop never closes the person's window.
- **FR-004** Every message after the script is signed with HMAC-SHA256 under the code (sent as
  `X-Stolos-Mac`, lowercase hex). The machine's `/hello` carries a fresh nonce; the PC's answer
  carries the machine's name, the probe key and the probe's SHA-256 for the machine's OS, signed over
  the nonce and those three. The machine refuses an answer not so signed, and installs only a probe
  with that checksum. A wrong signature costs a try.
- **FR-005** The machine asks once whether to install osquery (unless it is there), says what it
  will do, asks once to go ahead, turns on SSH, installs the probe, and posts its check-in (the
  same text as a `stolos1:` code). It prints the PC's answer instead of a code.
- **FR-006** The PC shows who asked (the name, OS, account and address, MAC, the SSH host key's
  fingerprint, osquery) and asks the person. Nothing is written to the fleet repository before yes.
  On yes, the machine is adopted as `host adopt --check-in` would (host keys pinned from the signed
  check-in, observed over SSH with its probe key, policies reported).
- **FR-007** A name that is a managed server's, or not a DNS label, is refused before anything is
  installed, with what to type on the PC. A second machine cannot use a code another is using.
- **FR-008** Plain HTTP is deliberate (constitution Article 28): the PC says so when it shows the
  line, and the guide says to pair a machine outside the LAN over a zero trust mesh network
  (`--address` with the PC's mesh address), never over the internet. The firewall is checked
  (read-only) for the port.
- **FR-010** `stolos mesh` (read-only, guidance only) explains Article 28: what a zero trust mesh
  network is, the common choices (Tailscale, Headscale, NetBird, ZeroTier, Nebula, WireGuard by
  hand) without preferring one, what to look for, and this PC's mesh addresses (by the clients'
  interface names, or 100.64.0.0/10), with the `pair --address` line to use. Stolos installs and
  configures no network product.
- **FR-009** `host integrate` and `host adopt --check-in` keep working; `host integrate` points to
  `pair` as the easy way.

## Success criteria

- **SC-001** `tests/pair098.test.ts`: the code (alphabet, length, no bias in the sampler's
  limit), normalization, HMAC agreeing with `openssl dgst -hmac`, the session (tries, expiry, one
  machine, signed answers), and the real `integrate.sh` paired end to end against the PC's server
  (the probe installed and only the fleet's key allowed; the check-in reaches the approval).
- **SC-002** Windows: the loader and `integrate.windows.ps1 --pair` are exercised by
  `tests/integrate/windows-check.ps1` in CI (as administrator).

## Decisions

- **HTTP only, on a trusted network** (the owner's): no certificate, no public relay, no domain to
  run. A machine elsewhere joins over a zero trust mesh network the fleet chooses (FR-010).
- **The code is typed on the machine, approved on the PC.** The PC is the trusted side: the person
  sees the machine there, and the commit that follows is signed there.
- **openssl on the machine.** A POSIX shell has no HMAC; openssl is on macOS and every distribution
  the probe supports. Without it the script stops before changing anything.
