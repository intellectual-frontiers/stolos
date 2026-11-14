# 063: Check what a server will run before it is armed

## Why

A new server installed in ten minutes, then its first boot ran nothing: the newest commit on GitHub
was not signed by a fleet signer (an agent had pushed commits signed by its own key, skipping the
pre-push check), and the host's own model had never been pushed. Both were knowable on the PC before
the machine was powered on, and neither was checked. Recovering took commands nobody had written
down, because a first boot run again kept the clone it had refused.

## Requirements

- **FR-001** `boot arm` (and `boot reinstall`) first fetch the fleet's branch from GitHub and
  refuse, arming nothing, when its newest commit is not signed by a key in signers.ts
  (`E063-TIP-UNSIGNED`) or does not hold `fleets/<fleet>/hosts/<host>/host.ts`
  (`E063-HOST-NOT-PUSHED`), each with its fix (`deno task stolos apply`). Offline, the last fetched
  commit is checked and that is said. A fleet not on GitHub (the lab) is not checked.
- **FR-002** `boot serve` makes the same check for every armed host at start, as warnings.
- **FR-003** The first-boot script, run again, fetches the branch and checks the newest commit (not
  the one it refused); the deploy key is used by those git commands only.
- **FR-004** A refusal says how to recover, in the host's log and the boot server's window: on the
  PC, `deno task stolos apply`; then on the host, `sudo /usr/local/sbin/archon-first-boot`.

## Success criteria

- **SC-001** `tests/keys057_test.ts`: with real keys and a bare repository as GitHub, `boot arm`
  refuses an unsigned tip, then a host not pushed, then arms once both are in order.
- **SC-002** `tests/install_test.ts`: the rendered first-boot script fetches on a re-run, checks the
  fetched commit, never exports the deploy key's ssh command to archon, says the fix, and is valid
  shell.
