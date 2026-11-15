# 054: Safe power

## Why

In the lab, cutting a server's power right after its install (Ubuntu's unattended-upgrades was
running apt) left dpkg's files empty: 45 package checks failed after the reboot. Pulling the plug is
what people do when unsure; the tool should make the safe way the easy one.

## Requirements

- **FR-001** `archon reboot` and the new `archon poweroff` wait until nothing changes packages (apt,
  apt-get, dpkg, unattended-upgrades; PackageKit idling alone does not count), up to 15 minutes,
  saying what they wait for; then reboot or shut down cleanly in 5 seconds (so they work over SSH).
  After 15 minutes they stop with E009-APT-BUSY. `--now` does not wait.
- **FR-002** `archon state` (and so `archon` with no arguments on a host) warns, with E009-APT-BUSY,
  while packages change: do not power off.

## Success criteria

- **SC-001** `tests/power054.test.ts`.
- **SC-002** The lab's reboot is a clean shutdown (the power button), and fails if one does not come
  within 10 minutes.

## Open

- A "propose" role for newcomers (pull requests checked by CI, approved by a signer's push): CI on a
  private fleet repository spends its Actions minutes; decide with the owner first.
- `archon practice` (the synthetic fleet's lab on demand): the lab's scripts live in the engine's
  repository, not in what a fleet repository imports (`src/`). Until then: the fleet repository's
  e2e workflow, by hand.
