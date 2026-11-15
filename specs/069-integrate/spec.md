# 069: integrate: one command on any machine, device, or cloud to bring it into the fleet

## Why

Bringing a machine into the fleet meant knowing SSH, keys, and where things go. The person whose
laptop it is often does not. They should run one line someone gives them, read what it will do in
plain words, say yes once, and copy one line back.

## Requirements

- **FR-001** `bin/integrate.sh` (Linux, macOS, WSL; POSIX sh, BusyBox too) and
  `bin/integrate.windows.ps1` (Windows PowerShell 5.1 and 7), published with each release, run on
  the machine: `--discover` (the default: changes nothing), `--adopt` (SSH on, the read-only probe,
  the probe key's forced-command line), `--osquery`, `--server` (a hand-installed Ubuntu ready for
  `host bootstrap`), `--workstation` (a managed workstation, through the bootstrap); `--dry-run`,
  `--yes`, `--undo`, `--ssh-port`. They list every change and ask once before any.
- **FR-002** The probe is a file (`bin/stolos-probe.sh`, `bin/stolos-probe.ps1`), embedded in the
  engine and downloaded by the script, which refuses it unless its SHA-256 matches the one in the
  command (`--probe-sha256`). The Windows probe answers the same requests with the same output:
  BitLocker, Windows Firewall, Windows Update, Defender (a new anti-malware policy, SCF END-04),
  local Administrators.
- **FR-003** The script ends with a check-in code (`stolos1:` and base64 of the probe's format, with
  `@checkin` and `@hostkeys` sections): public facts only. `host adopt <name> --check-in <code>`
  pins the host keys from it (no first-connection trust) and observes; if the PC cannot reach the
  machine, it keeps the code's own observation. `discover --import <code>` records the machine in
  `fleets/<fleet>/discovered.ts`.
- **FR-004** `host integrate <name> --as discover|adopt|osquery|server|workstation` prints the line
  to run (both POSIX and Windows where they apply), at this engine's tag, with the fleet, the probe
  key (made now in the vault), and the probe's checksum filled in.

- **FR-005** Devices: `device add | observe | check | remove` read printers, routers, switches,
  access points, NAS boxes, cameras, and UPSes over SNMPv3 with authentication and privacy only
  (HMAC-SHA-96 or HMAC-192-SHA-256, AES-128-CFB), in TypeScript, sending only GET and GETNEXT.
  Passphrases are typed in the terminal and kept in the vault (`devices/<name>/snmp.json`).
  Policies: observed recently, read over encrypted SNMPv3, an owner and location (SCF AST-03),
  restarted in the last 400 days (firmware).
- **FR-006** Clouds: each provider has a recipe for its read-only credential (a page to open, or a
  command for the provider's own browser shell: AWS CloudShell, Azure Cloud Shell); cloud servers no
  fleet machine owns appear under Machines, with Adopt.
- **FR-007** The Stolos Console's **Add a machine** asks what it is in plain words (a laptop, just
  record it, a device, a cloud account, a server to manage, a workstation), shows the line to run
  with a copy button, and takes the check-in code in a box. Machines lists discovered machines and
  devices.

## Success criteria

- **SC-001** `tests/integrate069_test.ts`: the code's parsing (and its refusals), the one-liners,
  and integrate.sh for real: discover writes nothing, a wrong checksum installs nothing, adopt and
  undo.
- **SC-003** `tests/snmp069_test.ts`: RFC 3414's key localization vector, NIST SP 800-38A's
  AES-CFB128 vector, and, where snmpd is installed (CI), SHA-256 and SHA-1 users with AES, a walk,
  and a wrong passphrase and an unknown user refused in plain words.
- **SC-002** CI: Debian, Fedora, Arch, and Alpine (BusyBox) containers; macOS; Windows with OpenSSH
  Server turned on by the script and the probe key proven to run the probe and nothing else.
