# End-to-end install test (spec 004, SC-001)

Installs a blank UEFI virtual machine (Secure Boot on, Microsoft keys) from power-on to `Ready`,
exactly as a real host is installed: UEFI network boot from `archon-boot`, Ubuntu's signed shim and
GRUB, Ubuntu's unattended installer, then `archon first-boot`.

## In CI

The lab is [`lib.sh`](lib.sh); two scripts set it up:

- [`ci.sh`](ci.sh), run by `.github/workflows/e2e.yml` on every push to `main` (and by hand): a
  throwaway fleet repository (`fleets/e2e`, a fresh signer, its tip signed), served with **this
  checkout of the engine**, built and packed as a release is (`tools/release.ts`), over HTTP on the
  lab bridge, so the machines run the engine under test.
- [`fleet.sh`](fleet.sh), run by the reusable `.github/workflows/fleet-e2e.yml` from a fleet
  repository: its synthetic fleet, with the engine its `package.json` pins (checked against its
  `bun.lock`). See
  [The fleet repository](https://intellectual-frontiers.github.io/stolos/latest/archon/fleet/mod.ts/index.html),
  "The synthetic fleet".

Either way, a run:

1. installs the server, one of two ways (`E2E_SERVER_INSTALL`, by default from the runner's memory):
   - `network` (16 GB runners): starts the boot server from the fleet repository and network-boots a
     blank Secure Boot VM, which installs to the boot server's event `boot.ready` (spec 049), then
     checks that the host's first boot continued the install's trace;
   - `bootstrap` (8 GB runners, where Ubuntu's installer does not fit): Ubuntu's cloud image,
     finished with `stolos host bootstrap`;
2. (network only: the trace check, above);
3. asks the server through its MCP server, from the runner (`stolos fleet query`);
4. powers the server off and on again, with less memory, and runs `archon verify` on it;
5. starts a workstation from Ubuntu's cloud image (verified against Ubuntu's `SHA256SUMS`), clones
   the repository to `/srv/archon`, runs `stolos workstation add`, `archon verify`, and
   `stolos fleet query` from there: the agent's path to the server (spec 030).

Every key and password of a run is made by it and thrown away. The logs are the run's artifact. A
run with no new event for 15 minutes ends, diagnosed. `E2E_PREPARE_ONLY=1 tests/e2e/fleet.sh ...`
prepares a fleet repository's synthetic fleet (frozen engine, keys, signer, build, signed tip)
without any machine; `squeeze_mb` (e2e.yml, by hand) tries a private runner's memory on a public
runner.

## By hand

Installs a blank UEFI virtual machine (Secure Boot on, Microsoft keys) from power-on to its
first-boot push, exactly as a real host is installed: UEFI HTTP Boot from `archon-boot`, Ubuntu's
signed shim and GRUB, Ubuntu's unattended installer, then `archon first-boot`.

Needs a Linux machine with QEMU, OVMF, and dnsmasq
(`apt install qemu-system-x86 ovmf dnsmasq-base`), root (for the bridge and tap device), and a fleet
with a test host:

```sh
bun run stolos fleet init
bun run stolos host add e2e
sudo tests/e2e/lab-up.sh      # bridge, DHCP with the PXE boot file, archon-boot
bun run stolos boot arm e2e --claim
sudo tests/e2e/vm.sh          # power on the blank VM
tail -f tests/e2e/work/boot.log
```

The run is done when the boot log shows `install finished` and the repository receives
`005-first-boot: e2e installed`. Behind an intercepting proxy, set `ARCHON_BOOT_PROXY` and
`ARCHON_BOOT_CA_FILE` before `lab-up.sh`.
