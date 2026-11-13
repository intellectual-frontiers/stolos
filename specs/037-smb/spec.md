# Feature Specification: File shares over SMB

**Feature Branch**: `037-smb` (committed directly to main) **Created**: 2026-11-12 **Status**:
Implemented **Input**: An `archon fs smb` command that sets up file sharing over SMB (Samba) so
Windows, macOS, and Linux clients reach `smb.<host>.<domain>` (for alpha,
`smb.alpha.lab.example.net`). Every server has it, off until an operator turns it on with the
command; once on, it stays on across reboots until an operator explicitly turns it off. One share,
`shared`, for everyone with an account, plus each user's own home folder. Encryption desired (not
required). Time Machine later.

## User Scenarios & Testing _(mandatory)_

1. **Given** a freshly installed server, **When** anyone looks, **Then** Samba is installed and
   configured but not running (`smbd` masked); nothing answers on 445.
2. **Given** an operator runs `archon fs smb on`, **When** it finishes, **Then** `smbd` runs, the
   decision is recorded in `state/hosts/<host>/smb.json` (who, when), and every later apply, reboot,
   and reinstall keeps it on.
3. **Given** an account on the server types its Linux password there (Cockpit, `sudo`, a password
   login, `passwd`), **When** PAM accepts or changes it, **Then** Samba gets the same password for
   the same account; an account not on the server has no access.
4. **Given** SMB is on, **When** someone on the local networks maps
   `\\smb.alpha.lab.example.net\shared` (Windows) or `smb://smb.alpha.lab.example.net/shared`
   (macOS, Linux) with their Linux username and password, **Then** they read and write the shared
   folder, and `\\smb.alpha.lab.example.net\<username>` is their home folder.
5. **Given** an operator runs `archon fs smb off`, **When** it finishes, **Then** `smbd` is stopped
   and masked, recorded, and stays off.
6. **Given** a client outside the local networks, or one that only speaks SMB1, or a guest, **When**
   it connects, **Then** it is refused.

## Requirements _(mandatory)_

- **FR-001**: Ubuntu's `samba` package on every server (Article 2: the reference SMB server; ksmbd
  was considered and not chosen: fewer features and a weaker security record). `nmbd` (NetBIOS,
  ports 137 to 139) always masked.
- **FR-002**: `/etc/samba/smb.conf` rendered from the model and checked with `testparm` before it is
  used: standalone server; SMB3 minimum; `server smb encrypt = desired`; no guests
  (`map to guest = never`, `restrict anonymous = 2`); NetBIOS off, port 445 only; `hosts allow` =
  the fleet's local networks and loopback; no printers or user shares; logging to the journal, with
  every SMB sign-in (accepted or refused) audited (`auth_audit:3`); macOS compatibility (`fruit`,
  `streams_xattr`).
- **FR-003**: Shares: `[shared]` at `/srv/smb/shared` (root:smb-shared, 2775,
  `force group = smb-shared`, files 0664, folders 2775) for every account in the model except ops;
  `[homes]` for each of those accounts, their own only, not browsable.
- **FR-004**: The switch: `smbd.service` is on only when `state/hosts/<host>/smb.json` says
  `"enabled": true`; otherwise it is stopped and masked. `archon apply` honors it on every run
  (`UnitDef.switch`), so reboots keep the setting, and a reinstall keeps it too (the state is in the
  repository; `boot reinstall` pushes it first).
- **FR-005**: `archon fs smb on | off` (operators; mutate) set the switch, record who and when,
  apply it at once, journal it, and email the mailbox. `archon fs smb status` (read): on or off and
  since when, by whom, `smbd`, port 445, the shares, the addresses to use, and whose password Samba
  already knows.
- **FR-006**: Firewall: 445/tcp from the local networks only (open on every server; nothing listens
  while SMB is off). Name: `smb.<host>.<domain>`, covered by each server's wildcard record (spec
  032); no new DNS record.
- **FR-007**: Usernames and passwords are Linux's: no separate SMB accounts or passwords. SMB
  clients need an NT hash, which Linux's password hash cannot check, so Samba keeps its own copy: a
  PAM profile installed with Ubuntu's `pam-auth-update` (`/usr/share/pam-configs/archon-smb`, auth
  and password, `optional pam_exec.so seteuid expose_authtok`, root even when sudo or passwd asks)
  runs `/usr/local/libexec/archon/password-sync` (root, 0700; the one hook for SMB and PostgreSQL,
  spec 039) after a password is accepted or changed, which gives Samba the same password for the
  same account (UID 1000 and up; not root or ops). `invalid users = root ops`. Samba's copy
  (`/var/lib/samba/private`, root only) is in the nightly backups (spec 016); share contents are
  not. After a reinstall, Samba learns each password again the first time it is typed on the server.
- **FR-008**: `archon verify`: when the switch is on, `smbd` is active and 445 answers; when off,
  `smbd` is not running.
- **FR-009**: The guide (welcome page, `archon guide`, `docs/smb.md`, served at /guide/smb) explains
  turning it on, setting a password, and connecting from Windows, macOS, and Linux.

### Overrides of Ubuntu defaults

- A PAM profile through Ubuntu's own `pam-auth-update` (not an edit of /etc/pam.d) so SMB uses the
  Linux password.
- `smbd` masked until an operator turns it on (Ubuntu starts it on install); `nmbd` masked (NetBIOS
  off).

## Non-goals

- Network-neighborhood browsing (WS-Discovery, Bonjour): multicast does not cross into the Servers
  network, and Archon avoids it (Article 20). Connect by name.
- SMB over QUIC; Time Machine targets (later).
