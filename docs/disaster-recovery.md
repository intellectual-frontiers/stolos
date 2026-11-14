# Disaster recovery: losing the boot machine

The boot machine (BOOTPC) holds the only live copy of the fleet's secrets: the admin password hash,
each host's deploy key and SSH host keys, the Cloudflare DNS token, and the mail token. Losing it is
routine (constitution Article 22): a new PC becomes the boot machine from the fleet repository plus
your latest backup ZIP (`deno task boot vault backup`, specs 029 and 056), wherever you keep it. The
hosts keep running throughout; they need the boot machine only to install or re-install.

What you need: your latest backup ZIP (and whatever unlocks the place you keep it), your signing
key's passphrase, your **GitHub** login, and, for the network, your **UniFi** account.

## With a backup ZIP

1. **Tools.** On the new PC, in PowerShell:

   ```powershell
   winget install --id DenoLand.Deno
   winget install --id Git.Git
   winget install --id GitHub.cli
   ```

2. **The repository.** In a new PowerShell window:

   ```powershell
   gh auth login --web --git-protocol https
   git clone https://github.com/example/fleet.git C:\archon
   cd C:\archon
   ```

3. **The secrets and your signing key.** `deno task boot vault restore` prints the steps (the same
   as `RESTORE.txt` in the ZIP); it changes nothing. In short: unzip it somewhere private, copy
   `secrets\*` into `%APPDATA%\archon\secrets\` (readable by you only), copy `signing\*` into
   `%USERPROFILE%\.ssh\` and point Git at it (`git config --global user.signingkey ...`), then
   delete the unzipped folder.

4. **Trust the hosts again.** `deno task boot doctor` checks every secret; `known_hosts` comes from
   the hosts' public keys in the fleet repository.

5. **The network.** Network boots and firewall policies 4 and 7 point at the boot server's address,
   10.0.1.157 (`site.bootServer` in `fleets/<fleet>/site.ts`). Either:
   - give the new PC that address: UniFi, Client Devices, the new PC, Settings, Fixed IP Address
     10.0.1.157 (the old PC's reservation goes with its MAC; remove it first); or
   - give it another address, set `site.bootServer.address` (and the BOOTPC entry in `site.devices`)
     to it, and run `deno task archon build`: validation lists every UniFi setting that still points
     at the old address (each network's Network Boot and each policy). Change those in UniFi, then
     commit and push the model (Article 21: the router first, then the model).

6. **Windows Firewall.** As Administrator (the boot server's two ports):

   ```powershell
   New-NetFirewallRule -DisplayName "Archon boot (HTTP)" -Direction Inbound -Protocol TCP -LocalPort 8080 -Profile Any -Action Allow
   New-NetFirewallRule -DisplayName "Archon boot (TFTP)" -Direction Inbound -Protocol UDP -LocalPort 69 -Profile Any -Action Allow
   ```

7. **Check everything.**

   ```powershell
   deno task boot doctor            # this PC, with a fix for each problem
   deno task boot vault status      # every secret back where it belongs
   ssh alpha archon doctor --send  # each host: its network and mail, mailed to the shared mailbox
   ```

## Without a backup

`deno task boot vault status --lost` prints the rebuild plan for every secret. In short:

| Secret                                   | Made again by                                                                                                                                                                                                                                                                                                                                                                   |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| admin password hash                      | `deno task archon fleet init`: it keeps `fleets/<fleet>/fleet.ts` and its admin account, and asks for the password again (the same password changes nothing on the hosts)                                                                                                                                                                                                       |
| each host's SSH host keys and deploy key | while the host runs: `deno task boot vault recover-host-keys <host>`. The same keys come back, so nothing changes on GitHub or for SSH clients. If the host is gone too: `deno task archon host add <host> --claim` (keeps its model, registers a new deploy key on GitHub), then `deno task boot reinstall <host> --confirm-destroy <host>` (it cannot be asked what it holds) |
| Cloudflare DNS token                     | Cloudflare: a new token with Zone: Read and DNS: Edit on the zone; `deno task boot web-setup`, then `deno task boot web-push <host>` for each server                                                                                                                                                                                                                            |
| mail token                               | Cloudflare: a new API token with Email Sending: Edit; `deno task boot mail-setup`, then `deno task boot mail-push <host>` for each server                                                                                                                                                                                                                                       |
| install tokens                           | nothing: `deno task boot arm <host>` makes one when needed. Each server's MAC, as its machine reported it, is in its `registration.ts`, so a rebuilt boot machine still recognizes it; `boot reinstall` reads it from the running host otherwise                                                                                                                                |

Then back everything up at once: `deno task boot vault backup`.

## The gap outside Archon

Two things on the boot machine are yours, not Archon's, and the backup does not hold them:

- **Your own SSH key** (in `%USERPROFILE%\.ssh`), with which you log in to the hosts. Each host
  accepts the keys in `fleet.admin.github.sshKeys` (`fleets/<fleet>/fleet.ts`), so add a **second
  admin SSH key** from another device, or a hardware key (`ssh-keygen -t ed25519-sk`): put its
  public half in that list (and on GitHub), commit, and push; every host picks it up at its next
  reconcile. From a local network your password works too.
- **The `gh` login**, which `host add` uses to register deploy keys: sign in again with
  `gh auth login` on the new PC.

The owner's own secrets (UniFi backups, Wi-Fi passwords, WireGuard keys, the Cloudflare DDNS token,
recovery and MFA codes, including the Microsoft account's) are listed by name in
`src/archon/model/secret-inventory.ts` and in the network reference
(`out/site/network-reference.html`, section "Where secrets live"), each with where it lives and how
to make it again.
