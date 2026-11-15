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

## Success criteria

- **SC-001** `tests/integrate069_test.ts`: the code's parsing (and its refusals), the one-liners,
  and integrate.sh for real: discover writes nothing, a wrong checksum installs nothing, adopt and
  undo.
- **SC-002** CI: Debian, Fedora, Arch, and Alpine (BusyBox) containers; macOS; Windows with OpenSSH
  Server turned on by the script and the probe key proven to run the probe and nothing else.
