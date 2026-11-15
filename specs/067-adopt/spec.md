# 067: Adopted machines: observed and checked, not managed

## Why

A fleet is more than its managed servers. The people who run it also own laptops, desktops, WSL
distributions, and machines someone else installed. An auditor asks about all of them: what they
are, whether their disks are encrypted, whether they update themselves, who administers them. Stolos
should answer for every machine, while managing only the ones it installed.

## The ladder

1. **Managed:** installed by Stolos, converged by Archon (every earlier spec).
2. **Adopted:** someone else's install. Stolos observes it over SSH with a probe key that may run
   one read-only script and nothing else, records what it found in Git, and checks it against a
   policy pack. It never changes the machine.
3. **Discovered:** seen (on the network, in a cloud account), not yet adopted. Later work.

## Requirements

- **FR-001** `stolos host adopt <name> --ssh user@address[:port]` pins the machine's host keys
  (`ssh-keyscan`, shown for the person to compare), makes a probe key in the vault
  (`adopted/<name>/probe_key`), installs `~/.local/bin/stolos-probe` and the key's line over the
  person's own SSH, takes a first observation, and writes
  `fleets/<fleet>/adopted/<name>/machine.ts`.
- **FR-002** The probe key's line is
  `command="$HOME/.local/bin/stolos-probe",restrict <key> stolos-probe@<fleet>`: no shell, no PTY,
  no forwarding. The probe answers `facts`, `version`, and `osquery <base64 SELECT>` only; anything
  else exits 2 with nothing on standard output.
- **FR-003** The probe is POSIX sh, needs no root, listens on nothing, and works on macOS and Linux
  (Debian, Ubuntu, Fedora, Arch and Omarchy, WSL). What it cannot know it reports as `unknown`.
- **FR-004** `stolos host observe [name]` writes `observed.ts` (GENERATED; `git log -p` is the
  machine's history). `stolos host check [name] [--json]` reports the policy pack: each policy names
  its Secure Controls Framework controls and says how to fix it on that OS.
- **FR-005** `stolos fleet query "<sql>"` asks every machine, managed and adopted, one osquery
  SELECT and prints one table with a machine column. The same refusal as `archon query` applies on
  the PC (one statement, allowlisted tables); servers check again; the probe accepts one SELECT.
- **FR-006** `stolos host release <name>` removes the probe and its key line over the person's own
  SSH, then the model and the probe key.

## Success criteria

- **SC-001** `tests/adopt067_test.ts`: parsing, observation, policies, the authorized_keys line, and
  the probe itself (facts here; refusals of anything else; one SELECT through a fake osqueryi).
- **SC-002** Against a real sshd: adopt, observe, check, query, release; the probe key opens no
  shell, runs no other command, and forwards no port.

## Clouds (visibility only)

- **FR-007** `stolos cloud connect <provider>` (cloudflare, microsoft, aws, hetzner, in that order
  of importance) shows how to make a read-only credential, reads it without echoing, keeps it in the
  vault (`clouds/<provider>/credential.json`), and observes once.
- **FR-008** `stolos cloud observe` writes `fleets/<fleet>/clouds/<provider>.ts` (GENERATED): the
  account's assets and posture facts. It only reads (GET; Microsoft's token request is the one
  POST). A part the credential may not read is a gap, not a failure. Assets named after a fleet
  machine (a DNS record in the fleet's domain, a server, an instance) are marked as that machine's.
- **FR-009** `stolos cloud check` reports each provider's posture policies with SCF controls;
  `stolos cloud assets` lists every asset from Git, without the network.
- **FR-010** AWS requests are signed (SigV4) in TypeScript; no provider CLI or SDK is installed.
- **FR-011** Out of scope: creating, changing, or deleting anything in a cloud; costs (later).

- **SC-003** `tests/cloud067_test.ts`: each provider against a fake API (inventory, gaps, posture),
  AWS's published SigV4 example, and only GET requests (Microsoft's token POST aside).

## Discovered

- **FR-012** `stolos discover` lists machines the fleet does not know, from what this PC already
  has: its neighbor table (`ip neigh`, `arp -an`, `arp -a`) and the cloud observations in Git
  (servers and instances no fleet machine owns). It scans nothing and records nothing; each one can
  be adopted with `host adopt`.
- **SC-004** `tests/adopt067_test.ts`: the three neighbor-table formats (macOS's unpadded octets
  included) and the match against the fleet by MAC, address, and name.

## Later

Approved actions on adopted machines (a named, signed change the owner allows, such as installing
osquery), user-space dotfiles and tools for adopted workstations, cloud costs, and daily cloud
change summaries.
