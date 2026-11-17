# 098: Pairing with a short code

Issue intellectual-frontiers/stolos#34. Spec 107-pairing-and-query (issue #39) changed what is true of the session: many machines, no
expiry, wrong codes per address; the requirements below say what is true now.

## Why

Adopting a machine through `host integrate` (spec 069) prints a command about 300 characters long,
carrying the fleet, the probe's public key, the engine tag and the probe's SHA-256, to copy onto the
machine by hand, and then a `stolos1:` check-in code to copy back. It works, and it is the opposite
of how people expect to trust a device. Device login is the model: one short command that never
changes, and a short code, approved on the side that is already trusted.

```mermaid
sequenceDiagram
  participant PC as Controller PC (stolos pair)
  participant M as The machine
  PC->>PC: shows the line and the code
  M->>PC: GET /device/pair (the script, from this engine)
  M->>PC: POST /device/pair/hello (nonce, hostname; HMAC under the code)
  PC->>M: ok, name, probe key, probe SHA-256 (HMAC under the code)
  M->>M: SSH on, the probe installed (checked), only the key may run it
  M->>PC: POST /device/pair/checkin (host keys, facts; HMAC under the code)
  PC->>PC: the person approves (name, OS, address, host key)
  PC->>M: ok: adopted
```

The session behind it takes many machines, each through this same exchange (spec 107-pairing-and-query).

## Ontology

The terms this spec uses, defined in `ontology/stolos/` with this spec as their source where it is
theirs: `stolos:PairingCode`, `stolos:TrustedNetwork`, `stolos:AdoptedMachine`,
`stolos:Controller`, `stolos:Fleet`, `stolos:PairingSession` (spec 107), and the integration kinds of `stolos:IntegrationKind`
(`stolos:integration-adopt`, `stolos:integration-osquery`).

## Requirements

- **FR-001** `stolos pair [--name] [--address] [--port] [--title] [--owner]` opens a session that waits on the LAN for
  machines (as many as come, spec 107-pairing-and-query), and shows one short line to run there per door that is up, HTTPS first
  (`curl -fsSL <base> | sh`, or `irm <base>/w | iex` in an administrator PowerShell, where `<base>` is
  `https://<console name>/device/pair` or `http://<pc>:8080/device/pair`) and a code. Pairing is the
  routes under `/device/pair` of two of the controller's three ports (constitution Article 29, spec
  103-three-ports): TCP 8080 (plain HTTP, the boot server's, or `stolos pair`'s own pair-only server
  when boot serve is not running) and TCP 443 (the console's TLS, when it serves the LAN). There is no
  port of its own: the old TCP 7457 is gone, and `--port` is an explicit choice of another port for
  the plain HTTP door.
- **FR-002** The code is 8 characters from an alphabet without look-alikes (`ABCDEFGHJKMNPQRSTUVWXYZ23456789`,
  about 39 bits), shown as two groups of four, chosen without bias. It is the session's code, **used by every machine
  of the session**, and it **never expires**: the session lasts until the person stops it (spec 107-pairing-and-query
  FR-001). Wrong signatures are counted per client address, and after 5 that address is refused for the rest of the
  session (107 FR-004). Typed in any case, with or without the dash.
- **FR-003** The PC serves this engine's own scripts (`bin/integrate.sh`,
  `bin/integrate.windows.ps1`, both probes) with the pairing filled in: nothing comes from elsewhere
  and nothing is typed but the code. On Windows, the loader runs the script in a child PowerShell,
  so a stop never closes the person's window.
- **FR-004** Every message after the script is signed with HMAC-SHA256 under the code (sent as
  `X-Stolos-Mac`, lowercase hex). The machine's `/hello` carries a fresh nonce; the PC's answer
  carries the machine's name, the probe key and the probe's SHA-256 for the machine's OS, signed over
  the nonce and those three. The machine refuses an answer not so signed, and installs only a probe
  with that checksum. A wrong signature costs its address a try (107 FR-004).
- **FR-005** The machine asks once whether to install osquery (unless it is there), says what it
  will do, asks once to go ahead, turns on SSH, installs the probe, and posts its check-in (the
  same text as a `stolos1:` code). It prints the PC's answer instead of a code.
- **FR-006** The PC shows who asked (the name, OS, account and address, MAC, the SSH host key's
  fingerprint, osquery) and asks the person, for each machine in turn (107 FR-002). Nothing is written to the fleet repository before yes.
  On yes, the machine is adopted as `host adopt --check-in` would (host keys pinned from the signed
  check-in, observed over SSH with its probe key, policies reported).
- **FR-007** A name that is a managed server's, or not a DNS label, is refused before anything is
  installed, with what to type on the PC. (A code is no longer one machine's: every machine of the session uses it and has its own
  prompt, spec 107-pairing-and-query FR-002.)
- **FR-008** Plain HTTP on the boot server's port is deliberate (constitution Article 28): the PC
  says so when it shows the line, and the guide says to pair a machine outside the LAN over a zero
  trust mesh network (`--address` with the PC's mesh address), never over the internet. The firewall
  is checked (read-only) for the ports the doors use (TCP 8080, and 443 for the HTTPS door).
- **FR-010** `stolos mesh` (read-only, guidance only) explains Article 28: what a zero trust mesh
  network is, the common choices (Tailscale, Headscale, NetBird, ZeroTier, Nebula, WireGuard by
  hand) without preferring one, what to look for, and this PC's mesh addresses (by the clients'
  interface names, or 100.64.0.0/10), with the `pair --address` line to use. Stolos installs and
  configures no network product.
- **FR-009** `host integrate` and `host adopt --check-in` keep working; `host integrate` points to
  `pair` as the easy way.

## Success criteria

- **SC-001** `tests/pair098.test.ts`: the code (alphabet, length, no bias in the sampler's
  limit), normalization, HMAC agreeing with `openssl dgst -hmac`, the session (tries per address, no expiry,
  many machines, signed answers), and the real `integrate.sh` paired end to end against the PC's server
  (the probe installed and only the fleet's key allowed; the check-in reaches the approval).
- **SC-002** Windows: the loader and `integrate.windows.ps1 --pair` are exercised by
  `tests/integrate/windows-check.ps1` in CI (as administrator).

## Decisions

- **Plain HTTP on a trusted network, TLS where the console serves** (the owner's): no public relay,
  no domain to run for the plain door; the console's TLS door (spec 103-three-ports) adds a
  certificate where the fleet has one. A machine elsewhere joins over a zero trust mesh network the fleet chooses (FR-010).
- **The session is open until the person closes it** (spec 107-pairing-and-query, the owner's): no expiry, no join window; an open
  session is less safe than a short one, so the terminal says so and protects the code with per-address blocking.
- **The code is typed on the machine, approved on the PC.** The PC is the trusted side: the person
  sees the machine there, and the commit that follows is signed there.
- **openssl on the machine.** A POSIX shell has no HMAC; openssl is on macOS and every distribution
  the probe supports. Without it the script stops before changing anything.
