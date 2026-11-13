# Feature Specification: Boot and install (UEFI HTTP Boot, autoinstall)

**Feature Branch**: `004-install` (committed directly to main) **Created**: 2026-11-10 **Status**:
Implemented **Input**: A host is created from its model by PXE (TFTP) or UEFI HTTP Boot served by
`archon-boot` on the boot machine (Windows or Linux) and Ubuntu's unattended installer (Article 18).

## User Scenarios & Testing _(mandatory)_

### User Story 1: Zero-touch install (Priority: P1)

As the owner, I want to power on a server and have it installed from its model with no further
input.

**Acceptance Scenarios**:

1. **Given** `host add alpha` was run and `deno task boot serve` is running, **When** alpha
   HTTP-boots from its own Boot URI `http://<boot-machine>:8080/boot/alpha/bootx64.efi` (set once in
   its BIOS), **Then** Ubuntu's signed shim and GRUB load (Secure Boot on), the boot server gives
   GRUB alpha' config (it remembers which address asked for alpha' Boot URI), the installer streams
   the verified ISO from the boot machine, fetches alpha' autoinstall config (secrets filled in at
   request time), and installs unattended.
2. **Given** the install finished, **Then** the installer reports `done` and alpha is disarmed: its
   next network boot boots its own disk.
3. **Given** an unarmed host network-boots, **Then** it boots its own disk and the boot server logs
   why; nothing is reinstalled.
4. **Given** the router's DHCP names the boot machine as next-server with boot file `bootx64.efi`
   (UniFi: _Network Boot_), and `deno task boot arm alpha --claim` was run, **When** a machine
   PXE-boots within 30 minutes, **Then** shim, GRUB, its menu, kernel, and initrd arrive over TFTP,
   the machine becomes alpha (its MAC is remembered for later installs), and the installer fetches
   the ISO and its config over HTTP.
5. **Given** a machine boots the generic URI `/boot/bootx64.efi` (for example firmware that takes
   its URL from DHCP), **Then** it gets the config of the host whose model has its MAC, if any;
   otherwise a menu of the armed hosts whose default (after 60 seconds) boots the local disk.
   Someone at the console picks the host; nothing is erased without that choice.
6. **Given** a host installed without a MAC in its model, **Then** its netplan matches the NIC it
   network-booted from (GRUB reports `net_default_mac` in the install URL), and
   `deno task boot status` shows that MAC.
7. **Given** a downloaded Ubuntu file does not match its pin, **Then** archon-boot stops and serves
   nothing.

## Requirements _(mandatory)_

- **FR-001**: `archon host add <name> [--mac <mac>]` writes `fleets/<fleet>/hosts/<name>/host.ts`,
  creates the host's ed25519 deploy key with `ssh-keygen` (native on Windows and Ubuntu), registers
  it on the repository with write access through `gh`, arms the host, and prints its Boot URI. The
  MAC is optional: a host is recognized by its Boot URI.
- **FR-002**: `deno task boot serve` downloads Ubuntu's netboot files (shim `bootx64.efi`, network
  GRUB `grubx64.efi`, `linux`, `initrd`) and the live-server ISO, verifies each against
  `src/archon-boot/pins.ts`, caches them under `%LOCALAPPDATA%\archon\boot`, and serves TFTP on UDP
  69 (PXE) and HTTP on port 8080. TFTP reads go through the same handler as HTTP, so both serve
  identical files and menus.
- **FR-003**: Routes: `/boot/[<host>/]{bootx64.efi,grubx64.efi}` (a host name in the path ties the
  requesting address to that host for 15 minutes), `/boot/linux`, `/boot/initrd`,
  `/boot/grub/grub.cfg` (that host's menu, else by-MAC dispatch), `/boot/hosts/<mac>.cfg` (the host
  with that MAC, else the menu of armed hosts), `/iso/<iso>` (with HTTP ranges),
  `/install/<host>/<token>/[<boot-mac>/]{user-data,meta-data,vendor-data}`, and `POST …/done`. Host
  names `hosts`, `grub`, `linux`, and `initrd` are reserved.
- **FR-004**: Install tokens: armed by `host add` or `deno task boot arm <host>`, valid until the
  install reports done or two hours after first use.
- **FR-005**: The autoinstall config sets locale, keyboard, time zone, netplan (DHCP on the boot NIC
  by MAC: the model's, else the one GRUB booted from), the admin account (password hash, SSH keys,
  no password SSH), Ubuntu's guided storage layout (lvm by default), security updates, and hands
  cloud-init the first-boot step (spec 005). Secrets are filled in only at request time.
- **FR-006**: Site options on `boot serve`: `--proxy` (installer and first boot use it; apt switches
  to Ubuntu's HTTPS mirrors, since many proxies tunnel HTTPS only), `--ca-file` (served at
  `/site-ca.crt` and trusted by the installer, the installed system, and Deno), and `--github-api`
  (GitHub Enterprise or a releases mirror for tool lookups).
- **FR-007**: The install itself adds no packages: anything extra is installed at first boot, where
  a slow mirror cannot fail the install.
- **FR-009**: The TFTP server is read-only and implements RFC 1350 with blksize, tsize, timeout, and
  windowsize options, rolling block numbers over past 65535 (the initrd is about 100 MB). It is
  written in TypeScript on `node:dgram`, so it runs on Windows with no extra software.
- **FR-010**: `deno task boot arm <host> --claim`: for 30 minutes, the first unrecognized machine to
  network-boot becomes that host, and its MAC is kept in the boot machine's install records so later
  installs recognize it.
- **FR-011**: `boot serve` checks the boot machine's firewall read-only (Windows Defender Firewall
  through PowerShell; ufw and firewalld on Linux) and warns, with the exact command, when inbound
  TCP (HTTP) or UDP (TFTP) would be blocked: no allow rule for the active network profile, a block
  rule for Deno (block wins), or allow rules limited to the local subnet. It changes no rule.
- **FR-012** (superseded by FR-013): `boot arm <host>` and the install's `done` callback remove the
  host's old SSH host keys from the boot machine's `known_hosts` (`ssh-keygen -f <file> -R`), by
  name and by every address the host installed from, so connecting after a re-install never fails on
  changed host keys.
- **FR-013**: Each host's SSH host keys (ed25519, ecdsa, rsa) are made once on the boot machine
  (`host add`, or the first install) with `ssh-keygen`, kept in the secret store, and installed by
  cloud-init (`ssh_keys` with all three types, so it generates none) at every install: a host keeps
  its SSH identity across re-installs. `boot arm` and the end of an install write those keys into
  the boot machine's `known_hosts` for the host's name and every address it installed from,
  replacing old entries (this supersedes FR-012's removal).
- **FR-014**: The install records the firmware entry it network-booted from
  (`/etc/archon/netboot-entry`). `archon reboot --netboot` sets UEFI BootNext to it (or the first
  PXE/HTTP IPv4 entry) and reboots; the boot order is never changed.
  `deno task boot reinstall <host>` checks the boot server is running, has the host push its state
  over SSH (stopping if that fails, unless `--force`), arms it, runs `archon reboot --netboot` over
  SSH, and trusts its host keys. An unreachable host is armed with instructions for its console.
- **FR-015**: Progress: the autoinstall `reporting` webhook sends installer events to `…/event`; the
  boot server shows milestones (partitioning, copying Ubuntu, kernel, updates, configuring,
  finishing) once each and every failed step. The first boot reports each Archon phase and a final
  `Ready` (or `Done with problems`) line with its checks. Events are accepted with the install's
  token until three hours after it finished.
- **FR-016**: `deno task boot doctor` checks, read-only: the checkout (uncommitted or unpushed host
  changes, which hosts would not see), the model, secrets (password hash, deploy keys, host keys,
  mail token), Ubuntu's files, LAN addresses, free ports (TCP 8080, UDP 69) unless boot serve is
  running, and the firewall; each problem has its fix.
- **FR-017**: `boot serve` also writes its log to `boot.log` in the boot cache
  (`%LOCALAPPDATA%\archon\boot`), keeping one previous copy past 5 MB.
- **FR-008**: archon-boot speaks HTTP/1.1 itself with canonical header names (GRUB compares
  `Content-Length` case-sensitively), closes the connection after HEAD (UEFI's HTTP driver waits for
  a body otherwise), and accepts shim's `\grubx64.efi` path.
- **FR-009**: The boot server's window shows what this PC's own commands do to it, not only what
  machines ask: arming (`boot arm`, `boot reinstall`, `host add`) and a reinstall's network reboot
  are announced to a running boot server (`POST /local/event`, accepted from loopback only; best
  effort, nothing happens when it is not running), so the window says
  `🎯 alpha armed for one install` at once instead of staying silent until the host network-boots.
- **FR-010**: The firewall check reads PowerShell's empty remote-address entries as "any address",
  so a rule open to every network no longer reports "allowed only from , , ,".

### Pins (Article 12)

The ISO's hash comes from Ubuntu's `SHA256SUMS`. Shim, kernel, and initrd from
`releases.ubuntu.com/26.04/netboot/amd64/` are byte-identical to the ones inside that ISO. The
network GRUB has no published checksum: it is pinned in the repository, and Secure Boot checks
Canonical's signature on it at every boot.

### Overrides of Ubuntu defaults

None: Ubuntu's own boot files, installer, and storage layouts.

## Success Criteria _(mandatory)_

- **SC-001**: The e2e test installs a blank UEFI VM, recognized by its Boot URI with no MAC in the
  model, from power-on to first-boot push with no input.
