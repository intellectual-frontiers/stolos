/**
 * # Hosts: add, install, re-install
 *
 * ## Add a host
 *
 * Say how its machine will be recognized when it network-boots, with exactly one of:
 *
 * ```powershell
 * bun run stolos host add alpha --claim                          # the next unknown machine to network-boot in 30 minutes becomes alpha
 * bun run stolos host add alpha --mac-address 1c:83:41:30:25:f2  # only the machine with this network card
 * ```
 *
 * There is no default: without either, `host add` refuses and shows both. `--claim` needs nothing
 * typed about the machine; its MAC is learned from it. `--mac-address` accepts colons, dashes, or
 * none; a mistyped one is noticed (an unknown machine that boots while alpha waits for another card is
 * named in the boot window, and nothing installs).
 *
 * This writes `fleets/<fleet>/hosts/alpha/host.ts` and `registration.ts`, creates alpha' GitHub deploy
 * key (registered on this repository with your `gh` login; the private half stays on the boot machine)
 * and its SSH host keys (its identity, kept across re-installs), and arms one install. It then builds,
 * commits, and pushes the new model (`--no-push` leaves it), because hosts install from GitHub, and
 * `bun run stolos boot doctor` flags host changes that are not pushed yet.
 *
 * When it installs, the MAC its machine reported is written to `registration.ts`
 * (`macSource: "installed"`): commit and push it, signed. From then on `boot arm alpha` (a re-install)
 * needs neither option.
 *
 * **The blank-disk guard.** Before Ubuntu's installer touches a disk, the machine reports its own
 * facts (make, model, serial, RAM, disks, and what is on them) to the boot server, which shows them.
 * The install goes on by itself only if every disk is blank, or the machine already installed as this
 * host (or `boot reinstall` reached it). Otherwise it stops before writing anything, powers off, and
 * the boot window says what it found and the command that lets it go on. When you know the disks may
 * be erased, say so up front, typed by you (never an agent), for this one install:
 *
 * ```powershell
 * bun run stolos host add alpha --claim --confirm-destroy alpha
 * bun run stolos boot arm alpha --mac-address 1c:83:41:30:25:f2 --confirm-destroy alpha
 * ```
 *
 * With `--claim`, that means the next unknown machine to network-boot is erased whatever it holds.
 *
 * ## First install
 *
 * **Memory.** A server installed by network boot needs at least 8 GB of RAM: Ubuntu's netboot
 * installer downloads the whole installer image (about 3 GB) into memory and runs from there. With
 * less, it stalls before partitioning, with nothing on the boot server's screen after "installer image
 * (whole)". (Found by the end-to-end lab: machines with 5.75 and 7 GiB stalled there; 8 GiB installs.)
 * `bun run stolos boot serve --stall-watch` names such a machine after 6 minutes; it is off by
 * default, because it guesses the machine from DHCP leases and is a hint, not a guarantee. For a
 * smaller machine, install Ubuntu by hand, then bootstrap (below).
 *
 * 1. Start the boot server on the PC and leave it running ([boot machine](boot-machine.md)):
 *
 *    ```powershell
 *    bun run stolos boot serve
 *    ```
 *
 * 2. In a second window, just before you power the server on:
 *
 *    ```powershell
 *    bun run stolos boot arm alpha --claim
 *    ```
 *
 *    For the next 30 minutes, the first unrecognized machine that network-boots becomes alpha, and the
 *    boot server remembers its MAC for later installs.
 *
 * 3. Set the server's firmware to network-boot (once per server). At its console or AMT KVM, enter
 *    setup (Del at power-on on a Minisforum MS-01):
 *
 *    1. **Advanced → Network Stack Configuration:** enable _Network Stack_ and _IPv4 PXE Support_.
 *    2. Keep **Secure Boot** on: the boot chain is Ubuntu's signed shim and GRUB.
 *    3. Save, and at the next power-on pick _UEFI PXE IPv4_ for the wired port from the boot menu (F7
 *       on an MS-01), or put it first in the boot order.
 *
 * 4. Watch the boot server's window. With no further input the server installs, reboots, runs its
 *    first boot, and reports `alpha: ✓ Ready: 45/45 checks`, then `alpha: ready. Next:` with how to
 *    connect, its Cockpit address, and how to observe it (also later:
 *    `bun run stolos fleet status`). The [install timeline](install-timeline.md) lists every step.
 *    Then:
 *
 *    ```powershell
 *    ssh alpha
 *    ```
 *
 *    The PC already trusts alpha' SSH host keys, so there is no "authenticity can't be established"
 *    question. To manage it with an agent, see [agent.md](agent.md): nothing is installed on the
 *    server for that.
 *
 * The first boot pushes `archon.sql alpha/installed.json` to GitHub: `"ok": true`, or the steps that
 * failed under `problems`.
 *
 * A host is installed only while it is armed, and the install disarms it. An unrecognized machine with
 * nothing claimed gets a menu of the armed hosts at its console whose default (after 60 seconds) boots
 * its own disk, so nothing is erased by accident.
 *
 * ## Re-install
 *
 * Everything a host needs comes back from the repository and the boot machine. Anything only on the
 * host is lost (copy off your own data first): home directories are not kept. A **durable** host
 * (constitution Article 23: something on it holds end users' data that exists nowhere else, see
 * `archon data`) is re-installed only when you repeat its name with `--confirm-destroy alpha`; the
 * same goes for a host that cannot be asked. With the boot server running:
 *
 * ```powershell
 * bun run stolos boot reinstall alpha
 * ```
 *
 * It:
 *
 * 1. checks the boot server is running;
 * 2. connects to alpha over SSH, asks `archon data` whether it is durable (and stops unless
 *    `--confirm-destroy alpha` was given, when it is or cannot say), and goes on (what alpha recorded
 *    about itself stays on alpha and goes with the re-install, spec 048);
 * 3. arms alpha;
 * 4. runs `archon reboot --netboot` on alpha: the firmware boots from the network once (UEFI BootNext,
 *    to the entry the last install booted from), so nobody needs to press F7. The boot order is not
 *    changed, so ordinary reboots never wait for a network boot;
 * 5. trusts alpha' SSH host keys on the PC.
 *
 * Then watch the boot server's window until `alpha: ✓ Ready`. alpha comes back with the same SSH
 * identity, so `ssh alpha` simply works. If alpha does not answer over SSH (powered off, hung), the
 * command arms it anyway and tells you to power it on and pick network boot once from its boot menu.
 *
 * By hand, the same is: `bun run stolos boot arm alpha` on the PC (alpha installed before, so its
 * MAC is registered), then `archon reboot --netboot` on the host (or power it on and press F7). On new
 * hardware for an existing host name, use `bun run stolos boot arm alpha --claim`.
 *
 * ## HTTP Boot instead of PXE
 *
 * Firmware with a _Boot URI_ field can boot over HTTP instead: set it to the host's own URI, for
 * example `http://10.0.1.157:8080/boot/alpha/bootx64.efi` (`bun run stolos boot status` prints it).
 * The URI names the host, so no claim is needed. Firmware without the field can get the URL from DHCP
 * (vendor class `HTTPClient`: option 60 `HTTPClient`, option 67 the URI); PXE is simpler on most
 * routers.
 *
 * ## Install Ubuntu by hand, then bootstrap
 *
 * If a server cannot network-boot (or you would rather install from a USB stick), install a plain
 * Ubuntu Server (or Ubuntu's cloud image) and let Archon finish it over SSH. The result is the same as
 * a network install: the host gets its fleet, the signers it trusts, and the SSH host keys registered
 * for it in Git (`registration.ts`), which replace the ones its installer made. Your first `ssh` to it
 * by address asks once to trust the installer's keys; after the bootstrap, `stolos fleet trust` puts
 * the registered ones in your known_hosts.
 *
 * **a. Get Ubuntu Server 26.04 LTS** from <https://ubuntu.com/download/server> (or
 * `https://releases.ubuntu.com/26.04/ubuntu-26.04.1-live-server-amd64.iso`) and check it against
 * Ubuntu's `SHA256SUMS` in the same folder:
 *
 * ```powershell
 * Get-FileHash .\ubuntu-26.04.1-live-server-amd64.iso -Algorithm SHA256
 * ```
 *
 * Write it to a USB stick with Rufus or balenaEtcher (or attach it as virtual media through AMT) and
 * boot the server from it.
 *
 * **b. Install with Ubuntu's defaults**, choosing only these:
 *
 * | Installer screen      | Choose                                                                                                                         |
 * | --------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
 * | Type of installation  | **Ubuntu Server** (the default, not "minimized")                                                                               |
 * | Network               | DHCP on the wired port (the default)                                                                                           |
 * | Proxy, mirror         | leave as is                                                                                                                    |
 * | Storage               | **Use an entire disk**, with **Set up this disk as an LVM group** (the default)                                                |
 * | Profile               | your name; server name = the host name you gave `host add`; **username = the `user` in `fleets/<fleet>/fleet.ts`**; a password |
 * | Ubuntu Pro            | skip for now                                                                                                                   |
 * | SSH                   | **Install OpenSSH server**; **Import SSH key: from GitHub**, your GitHub username; leave password authentication off           |
 * | Featured server snaps | none                                                                                                                           |
 *
 * Remove the USB stick, reboot, and note the server's address (`ip -br addr` at its console).
 *
 * **c. Add the host** if you have not (`host add`, commit, push), then **bootstrap it** from the PC:
 *
 * ```powershell
 * bun run stolos host bootstrap alpha --ssh alice@10.0.30.57
 * ```
 *
 * It copies alpha' deploy key and first-boot files over SSH and runs the same first boot a network
 * install runs (it asks for your password once, for sudo). Later re-installs can use
 * `bun run stolos boot reinstall alpha` (network boot) like any other host.
 *
 * ## Guests
 *
 * Containers and VMs are LXD guests declared in the host's model, for example
 * `guests: [{ name: "web", kind: "container", image: "ubuntu:26.04" }]`, created by
 * `archon guest sync`.
 *
 * ## Retire a host
 *
 * When a server leaves the fleet for good (the same hardware may come back as a new host), from the
 * boot machine:
 *
 * ```powershell
 * bun run stolos boot retire alpha --confirm-destroy alpha
 * ```
 *
 * Without `--confirm-destroy alpha` it only says what alpha holds (durable or ephemeral, asked over
 * SSH) and changes nothing. With it:
 *
 * 1. its DNS records leave Cloudflare (`alpha.<domain>` and `*.alpha.<domain>`);
 * 2. its deploy key leaves the repository on GitHub;
 * 3. this PC forgets its install token, its secrets (deploy key, SSH host keys, the carried
 *    certificate), and its `known_hosts` lines;
 * 4. `fleets/<fleet>/hosts/alpha/host.ts` and `archon.sql alpha/` leave this checkout.
 *
 * 5. the removal is built, committed (`045-retire: retire alpha`), and pushed; only these paths and
 *    what `stolos build` renders from them (`.mcp.json`, the agent's permissions, the man pages) are
 *    committed. `--no-push` leaves it for you, and running the same command again later finishes it.
 *
 * Then remove alpha's local DNS record in the router and its line in `fleets/<fleet>/site.ts` (the
 * router first, Article 21), and back up again (`bun run stolos vault backup`). The machine itself
 * is not touched: power it off, or install it as a new host with
 * `bun run stolos host add <name> --claim`.
 *
 * @module
 */

export {};
