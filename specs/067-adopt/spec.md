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
