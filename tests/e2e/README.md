# End-to-end install test (spec 004, SC-001)

Installs a blank UEFI virtual machine (Secure Boot on, Microsoft keys) from power-on to its
first-boot push, exactly as a real host is installed: UEFI HTTP Boot from `archon-boot`, Ubuntu's
signed shim and GRUB, Ubuntu's unattended installer, then `archon first-boot`.

Needs a Linux machine with QEMU, OVMF, and dnsmasq
(`apt install qemu-system-x86
ovmf dnsmasq-base`), root (for the bridge and tap device), and a fleet
with a test host:

```sh
deno task archon fleet init
deno task archon host add e2e
sudo tests/e2e/lab-up.sh      # bridge, DHCP with the PXE boot file, archon-boot
deno task boot arm e2e --claim
sudo tests/e2e/vm.sh          # power on the blank VM
tail -f tests/e2e/work/boot.log
```

The run is done when the boot log shows `install finished` and the repository receives
`005-first-boot: e2e installed`. Behind an intercepting proxy, set `ARCHON_BOOT_PROXY` and
`ARCHON_BOOT_CA_FILE` before `lab-up.sh`.
