/**
 * # File shares (SMB)
 *
 * Every server can share files with Windows, macOS, and Linux over SMB (Samba). It is an **opt-in
 * service**: **off** until an operator turns it on, and then on, across reboots and reinstalls, until
 * an operator turns it off (specs 037, 040). `archon opt-in` lists every opt-in service and container.
 *
 * ## Turn it on (an operator, once per server)
 *
 * ```sh
 * archon fs smb on --durable  # or --ephemeral: there is no default
 * ```
 *
 * `--durable` or `--ephemeral` is required, with no default (constitution Article 23, spec 044):
 * **durable** when what is in the shares (`/srv/smb`) exists nowhere else (it is archived nightly, and
 * nothing reinstalls or wipes this server without `--confirm-destroy`, typed by a person);
 * **ephemeral** when losing it is harmless. `archon data` shows the server's class and why;
 * `archon data set` changes a choice later.
 *
 * The switch is in this machine's own `archon.sql` (spec 048); a reinstall starts with it off.
 * `archon fs smb off` turns it off the same way. `archon fs smb status` shows whether it is on, who
 * turned it on and when, and who has an SMB password.
 *
 * ## Your username and password
 *
 * The same as on the server itself: your Linux username and password. An account that is not on the
 * server gets no access.
 *
 * SMB clients (Windows, macOS) prove a password with a different kind of hash than Linux keeps, so
 * Samba keeps its own copy of it. Archon keeps that copy in step for you: whenever your password is
 * typed on the server (signing in to Cockpit, `sudo`, a password login, or changing it with `passwd`),
 * the same password goes to Samba for your account. So if you have only ever logged in with an SSH
 * key, sign in to Cockpit once (or run `sudo -v`) before your first connection. `archon fs smb status`
 * shows whose password Samba already knows.
 *
 * ## Connect
 *
 * The address is `smb.<server>.<domain>`, for alpha `smb.alpha.lab.example.net`, from the local
 * networks (or WireGuard) only.
 *
 * | On      | Do                                                                                      |
 * | ------- | --------------------------------------------------------------------------------------- |
 * | Windows | File Explorer, This PC, Map network drive, Folder: `\\smb.alpha.lab.example.net\shared` |
 * | macOS   | Finder, Go, Connect to Server: `smb://smb.alpha.lab.example.net/shared`                 |
 * | Linux   | your file manager's address bar: `smb://smb.alpha.lab.example.net/shared`               |
 *
 * Sign in with your Linux username and password. Two shares:
 *
 * - `shared`: one folder for everyone with an account on the server (`/srv/smb/shared`).
 * - your username: your own home folder, which only you can open
 *   (`\\smb.alpha.lab.example.net\<username>`).
 *
 * The server does not appear under "Network" in Windows or macOS: that discovery uses multicast, which
 * does not cross from your network to the servers' network. Connect by name as above.
 *
 * ## Good to know
 *
 * - Only SMB3 or newer, with encryption whenever the client supports it (all current Windows, macOS,
 *   and Linux do). No guest access.
 * - Samba's copy of each password is in the server's nightly backups (root only); the files in
 *   `shared` are not (they can be large). After a reinstall, Samba learns each password again the
 *   first time it is typed on the server.
 * - Logs: `journalctl -u smbd`.
 *
 * @module
 */

export {};
