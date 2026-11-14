# Stolos

Stolos turns bare machines into Ubuntu servers that set themselves up, keep themselves right, and
can prove it. You describe your machines in a few TypeScript files; its two commands do the rest:
`stolos` on your PC, for the fleet, and `archon` on each machine, for itself.

```mermaid
---
config:
  theme: base
  themeVariables:
    primaryColor: "#EEF2FF"
    primaryBorderColor: "#6366F1"
    primaryTextColor: "#1E1B4B"
    lineColor: "#64748B"
    edgeLabelBackground: "#F8FAFC"
    clusterBkg: "#F8FAFC"
    clusterBorder: "#CBD5E1"
---
flowchart LR
  A["<b>What you write</b><br/>fleet.ts: domain, mail, admin<br/>hosts/olympia/host.ts"]:::you
  B["<b>What Stolos does</b><br/>installs Ubuntu over the network<br/>applies packages, users, firewall,<br/>HTTPS, tools; checks every piece"]:::gh
  C["<b>What you get</b><br/>servers that match the description,<br/>every 15 minutes, and can prove it"]:::ok
  A --> B --> C
  classDef you fill:#EEF2FF,stroke:#6366F1,stroke-width:2px,color:#1E1B4B
  classDef gh fill:#F1F5F9,stroke:#475569,stroke-width:2px,color:#0F172A
  classDef ok fill:#ECFDF5,stroke:#10B981,stroke-width:2px,color:#064E3B
  classDef no fill:#FEF2F2,stroke:#EF4444,stroke-width:2px,color:#7F1D1D
```

Ubuntu decides; Stolos only adds (see the [constitution](.specify/memory/constitution.md)).

## Why Stolos, and where it fits

Infrastructure as code is a crowded field, and each tool covers part of the job:

| Tool                    | What it does well                          | What it leaves to you                                        |
| ----------------------- | ------------------------------------------ | ------------------------------------------------------------ |
| Ansible                 | runs steps on machines over SSH (YAML)     | the order of steps, drift between runs, installing the OS    |
| Terraform, OpenTofu     | creates cloud resources from a plan        | what happens inside each machine                             |
| Puppet, Chef, Salt      | an agent keeps a machine converged (a DSL) | a server or master to run, the OS install, a second language |
| cloud-init, autoinstall | sets up a machine on its first boot        | everything after the first boot                              |
| NixOS                   | a fully declared system                    | a different distribution from the one you run elsewhere      |

Shahid Shah created Stolos because he wanted **one unified experience** from bare metal to a
verified server: state the intent once, then let every machine converge to it and prove that it did.
No control server, no agent to install, no second language: two commands (`stolos` on your PC,
`archon` on each machine) run by **Deno**, a single binary, and **GitHub** as the only state, fully
versioned. Every change is a signed commit, so the history of each server is the history of its
repository.

```mermaid
---
config:
  theme: base
  themeVariables:
    primaryColor: "#EEF2FF"
    primaryBorderColor: "#6366F1"
    primaryTextColor: "#1E1B4B"
    lineColor: "#64748B"
    edgeLabelBackground: "#F8FAFC"
    clusterBkg: "#F8FAFC"
    clusterBorder: "#CBD5E1"
---
flowchart LR
  I["<b>Intent</b><br/>specs and a typed model<br/>(TypeScript, in Git)"]:::you
  A["<b>Approve</b><br/>a signed commit"]:::you
  C["<b>Converge</b><br/>each machine pulls and<br/>makes itself match"]:::gh
  V["<b>Verify</b><br/>every check, on the machine"]:::ok
  E["<b>Evidence</b><br/>what ran, when, by whom:<br/>Git history and archon.sql"]:::ok
  I --> A --> C --> V --> E
  E -. "drift or a new need" .-> I
  classDef you fill:#EEF2FF,stroke:#6366F1,stroke-width:2px,color:#1E1B4B
  classDef gh fill:#F1F5F9,stroke:#475569,stroke-width:2px,color:#0F172A
  classDef ok fill:#ECFDF5,stroke:#10B981,stroke-width:2px,color:#064E3B
  classDef no fill:#FEF2F2,stroke:#EF4444,stroke-width:2px,color:#7F1D1D
```

**Why Ubuntu 26.04, for now.** Stolos is built for an **AI-native era**: people decide what their
servers and workspaces should be, and AI agents carry out most of the operations. An agent that
works from loose notes drifts, so the intent has to be precise and checkable: specs (Spec Kit, in
`specs/`), a constitution, and a typed ontology of fleets, hosts, capabilities, and checks. Doing
that well for one operating system matters more than doing it loosely for many, so Stolos targets
Ubuntu 26.04 LTS servers (and Ubuntu on WSL as a workstation), and Ubuntu decides everything it does
not need to add. Agents reach servers only through `archon`'s MCP server, limited by each server,
and can never approve a change: only a signature can.

**Compliance as code.** Because the intent and the infrastructure (physical machines, VMs,
containers, workstations) are all type-safe TypeScript, they can be read as data, not just run. The
same model that installs a server says what it should be, its checks say whether it is, and the
signed history says who approved each change and when. That is the raw material of SOC 2, HIPAA, and
similar audits; Stolos is designed so that their controls and evidence can be generated from code
rather than written by hand. (Generating those reports is the direction, not yet a command.)

## What you need

`stolos` runs on **Windows, macOS, or Linux**. All it needs is **[Deno](https://deno.com) 2.9.6 or
newer** (2.x), a single program with no other dependencies, plus Git and `gh` (GitHub's command
line) to work with your fleet repository. Servers need nothing installed by you: Stolos puts Deno
and `archon` on each one as it installs it.

### Bootstrap your PC in one line

The PC you run `stolos` on is the fleet's **controller**. One line makes a PC one. It installs Deno,
Git and `gh`, signs you in to GitHub in the browser, clones your fleet repository into
**`$HOME/fleet`** (on Windows, `C:\Users\<you>\fleet`), and adds the `stolos` shortcut. Replace
`<owner>/<fleet-repo>` with your fleet repository:

| System                                  | Run                                                                                                                                                              |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Windows (PowerShell, not Administrator) | `& ([scriptblock]::Create((irm https://raw.githubusercontent.com/intellectual-frontiers/stolos/v0.59.0/bin/bootstrap.windows.ps1))) --repo <owner>/<fleet-repo>` |
| macOS or Linux (Terminal)               | `bash <(curl -fsSL https://raw.githubusercontent.com/intellectual-frontiers/stolos/v0.59.0/bin/bootstrap.sh) --repo <owner>/<fleet-repo>`                        |

```mermaid
---
config:
  theme: base
  themeVariables:
    primaryColor: "#EEF2FF"
    primaryBorderColor: "#6366F1"
    primaryTextColor: "#1E1B4B"
    lineColor: "#64748B"
    edgeLabelBackground: "#F8FAFC"
---
flowchart LR
  D["Deno 2.9.6+"]:::step --> G["Git"]:::step --> H["gh"]:::step
  H --> S["GitHub sign-in<br/>(browser)"]:::you
  S --> F{"$HOME/fleet?"}:::gh
  F -- "not there" --> C["clone"]:::ok
  F -- "there" --> U["deno task stolos update"]:::ok
  C --> K["stolos shortcut"]:::step
  U --> K
  classDef step fill:#F1F5F9,stroke:#475569,stroke-width:2px,color:#0F172A
  classDef you fill:#EEF2FF,stroke:#6366F1,stroke-width:2px,color:#1E1B4B
  classDef gh fill:#FFFBEB,stroke:#F59E0B,stroke-width:2px,color:#78350F
  classDef ok fill:#ECFDF5,stroke:#10B981,stroke-width:2px,color:#064E3B
```

Each step checks first and skips what is already done, so running it again is always safe: on a PC
that already has the fleet, it brings it up to date (`deno task stolos update`). Options, the same
on every system:

| Option                | What it does                                                                                                                                                                     |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--repo <owner/name>` | the fleet repository (required here; a fleet's own copy in its `bin` knows it)                                                                                                   |
| `--in <folder>`       | where the fleet goes (default `$HOME/fleet`)                                                                                                                                     |
| `--destroy-existing`  | remove that folder first, then clone it fresh. Only a checkout of the same repository; edits or commits not on GitHub yet are listed, and you type the folder's name to go ahead |
| `--no-shortcut`       | do not add the `stolos` shortcut                                                                                                                                                 |
| `--dry-run`           | say what each step would do; change nothing                                                                                                                                      |

**How it works, line by line.** [`bin/bootstrap.sh`](bin/bootstrap.sh) (Linux and macOS; it tells
them apart itself) and [`bin/bootstrap.windows.ps1`](bin/bootstrap.windows.ps1) are written to be
read: each step says what it does and why. They prefer the system's own packages (Ubuntu's `gh`
before GitHub's), never need Administrator on Windows (Deno goes into your own folder; `winget` asks
if it must), and use `sudo` on Linux only to install Git or `gh` when they are missing.

**Your fleet's own copy.** `deno task stolos fleet init` writes `bin/bootstrap.sh` and
`bin/bootstrap.windows.ps1` into the fleet repository with its name filled in (so `--repo` is not
needed), and `deno task stolos fleet upgrade` keeps them in step with the engine. A private fleet
repository's files cannot be downloaded before you sign in, so a new PC starts from the engine's
public bootstrap above; the fleet's copy is for running again later, from `$HOME/fleet`.

<details>
<summary><b>By hand instead</b>: the same installs, one system at a time</summary>

<details>
<summary><b>Windows</b> (PowerShell)</summary>

```powershell
winget install --id DenoLand.Deno      # or: irm https://deno.land/install.ps1 | iex
winget install --id Git.Git
winget install --id GitHub.cli
```

Open a new PowerShell window, then check: `deno --version` (2.9.6 or newer) and `gh auth login`.
Windows is the usual **boot machine** (the PC that installs new servers); see
[docs/boot-machine.md](docs/boot-machine.md) for its firewall and network settings.

</details>

<details>
<summary><b>macOS</b> (Terminal)</summary>

```sh
brew install deno git gh               # with Homebrew (https://brew.sh)
# or Deno alone: curl -fsSL https://deno.land/install.sh | sh
```

Then `deno --version` (2.9.6 or newer) and `gh auth login`.

</details>

<details>
<summary><b>Linux</b> (Ubuntu, or Ubuntu on WSL)</summary>

```sh
curl -fsSL https://deno.land/install.sh | sh      # Deno, into ~/.deno/bin
sudo apt install -y git gh unzip
```

Open a new terminal, then `deno --version` (2.9.6 or newer) and `gh auth login`. Servers need
nothing installed by you: Stolos puts Deno and `archon` on each one as it installs it.

</details>

</details>

## Two commands: `stolos` and `archon`

| Where                                 | Command                                              | For                                                                                   |
| ------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------- |
| your PC, in the fleet repository      | `deno task stolos ...` (or just `stolos ...`, below) | the fleet: keys, adding and installing machines (`stolos boot ...`), backups, updates |
| each server or workstation (over SSH) | `archon ...`                                         | that machine: its state, `verify`, `update`, `reboot`, PostgreSQL, data               |

Each points at the other: `archon keys setup` on a server says to run `deno task stolos keys setup`
on your PC, and `stolos apply` says to run `archon apply` on the machine. With no arguments,
`stolos` shows where you are and the next step; `archon` shows the machine's state.

**A shortcut: `stolos` instead of `deno task stolos`.** It works in the fleet folder (where
`deno.json` is), and runs the engine version pinned there. The bootstrap adds it for you (unless
`--no-shortcut`); by hand:

<details>
<summary><b>Windows</b> (PowerShell)</summary>

```powershell
if (!(Test-Path $PROFILE)) { New-Item -Force $PROFILE | Out-Null }
Add-Content $PROFILE 'function stolos { deno task stolos @args }'
. $PROFILE
```

If PowerShell says "running scripts is disabled on this system", allow your own profile once:
`Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`, then open a new window.

</details>

<details>
<summary><b>macOS and Linux</b></summary>

zsh (macOS's default): `echo 'stolos() { deno task stolos "$@"; }' >> ~/.zshrc`; bash:
`echo 'stolos() { deno task stolos "$@"; }' >> ~/.bashrc`; then open a new terminal. In fish (the
fleet's workstations): `function stolos; deno task stolos $argv; end; funcsave stolos`.

</details>

The rest of this README writes `deno task stolos`, which always works.

## Two kinds of repository

This repository is the **engine**: public, with no real machines in it. Each fleet lives in a
**fleet repository** of its own, private, that uses the engine by version.

```mermaid
---
config:
  theme: base
  themeVariables:
    primaryColor: "#EEF2FF"
    primaryBorderColor: "#6366F1"
    primaryTextColor: "#1E1B4B"
    lineColor: "#64748B"
    edgeLabelBackground: "#F8FAFC"
    clusterBkg: "#F8FAFC"
    clusterBorder: "#CBD5E1"
---
flowchart LR
  subgraph engine["stolos: public"]
    E["the engine: stolos, archon, the boot server,<br/>guides, an example fleet<br/><i>every change: a new version, tested, tagged</i>"]:::gh
  end
  subgraph fleet["your fleet: private"]
    F["deno.json: use engine vX.Y.Z<br/>deno.lock: a fingerprint of every engine file<br/>fleets/‹id›/fleet.ts, hosts/...<br/>fleets/‹id›/signers.ts: who approves"]:::you
  end
  S["your servers"]:::ok
  E -- "tag vX.Y.Z" --> F
  F -- "each server pulls it (read only)" --> S
  classDef you fill:#EEF2FF,stroke:#6366F1,stroke-width:2px,color:#1E1B4B
  classDef gh fill:#F1F5F9,stroke:#475569,stroke-width:2px,color:#0F172A
  classDef ok fill:#ECFDF5,stroke:#10B981,stroke-width:2px,color:#064E3B
  classDef no fill:#FEF2F2,stroke:#EF4444,stroke-width:2px,color:#7F1D1D
```

A fleet repository holds descriptions only. Its passwords and keys stay on one PC (the **boot
machine**, which also installs new machines); what each machine records about itself stays on that
machine, where `archon` asks it.

## Why changes are signed

Your servers take their instructions from the fleet repository on GitHub. If anyone or anything that
can push to it could change your servers (a stolen GitHub password, a leaked token, an automated
tool, an AI agent), that would be the weak point. So every change must be **signed**.

Signing uses a **key pair**: two files made together.

- The **private key** is yours alone. It stays on your PC, locked with a passphrase you type each
  time. Like a wax seal: only you hold it.
- The **public key** (the same file name with `.pub`) can be shared with anyone. Like a picture of
  the seal: anyone can check that a letter was sealed by you, but no one can seal with it.

Git seals each commit with your private key. The fleet lists the public keys it trusts in
`signers.ts`. Each server checks every new commit: sealed by a listed key, and following on from the
commit it already runs (no going back). Otherwise it refuses, and nothing changes.

```mermaid
---
config:
  theme: base
  themeVariables:
    primaryColor: "#EEF2FF"
    primaryBorderColor: "#6366F1"
    primaryTextColor: "#1E1B4B"
    lineColor: "#64748B"
    edgeLabelBackground: "#F8FAFC"
    clusterBkg: "#F8FAFC"
    clusterBorder: "#CBD5E1"
---
flowchart LR
  Y["you: git commit<br/>(type your passphrase)"]:::you --> G["GitHub"]:::gh --> Q{"server: sealed by a key<br/>in signers.ts?"}
  Q -- yes --> A["apply the change"]:::ok
  Q -- no --> R["refuse; nothing changes<br/>(archon explain E047-UNTRUSTED)"]:::no
  classDef you fill:#EEF2FF,stroke:#6366F1,stroke-width:2px,color:#1E1B4B
  classDef gh fill:#F1F5F9,stroke:#475569,stroke-width:2px,color:#0F172A
  classDef ok fill:#ECFDF5,stroke:#10B981,stroke-width:2px,color:#064E3B
  classDef no fill:#FEF2F2,stroke:#EF4444,stroke-width:2px,color:#7F1D1D
```

The fingerprints in `deno.lock` make your seal cover the engine's code too: a server runs exactly
the engine files you approved.

## Set up a fleet repository

1. Create an empty private repository on GitHub, then bootstrap this PC with it (above:
   `--repo <owner>/<new-repo>`). It clones the empty repository into `$HOME/fleet`; `cd` into it.
2. Start the fleet with the engine's latest version (it writes `deno.json`, `deno.lock`, and
   `fleets/<id>/fleet.ts` from your GitHub account):

   ```sh
   deno run -A https://raw.githubusercontent.com/intellectual-frontiers/stolos/v<version>/src/stolos/main.ts fleet init <id>
   ```

3. Set up your signing keys. One command does it all, and is safe to run again at any time: it makes
   your daily key and a recovery key (`ssh-keygen` asks for each passphrase; neither is ever
   stored), tells Git to sign every commit in this repository, lists both keys in `signers.ts`,
   installs a check that runs before every push, and makes a test signature:

   ```sh
   deno task stolos keys setup
   ```

   The recovery key lives in this PC's key store (`%APPDATA%\stolos\keys`; Linux and macOS:
   `~/.config/stolos/keys`), and every backup (`deno task stolos vault backup`) holds both keys with
   every secret: one ZIP is everything a disaster needs. `deno task stolos keys` checks everything
   later.
4. Commit and push (Git signs it; type your passphrase):

   ```sh
   deno task stolos apply -m "<id>: the fleet"
   ```

5. From here, `deno task stolos` shows where you are and the one command to run next: tokens, your
   first server (`deno task stolos host add <name> --claim`), and installing it
   (`deno task stolos boot serve`).
6. Back up: `deno task stolos vault backup` writes one ZIP with every secret and your signing key;
   move it somewhere safe and encrypted.

The full walk-through: [docs/fleet-repository.md](docs/fleet-repository.md) and
[docs/boot-machine.md](docs/boot-machine.md).

## How a machine becomes a server

```mermaid
---
config:
  theme: base
  themeVariables:
    primaryColor: "#EEF2FF"
    primaryBorderColor: "#6366F1"
    primaryTextColor: "#1E1B4B"
    lineColor: "#64748B"
    edgeLabelBackground: "#F8FAFC"
    clusterBkg: "#F8FAFC"
    clusterBorder: "#CBD5E1"
---
flowchart LR
  H["boot machine:<br/>host add olympia --claim<br/>boot serve"]:::you
  M["the new machine: power on,<br/>network boot"]:::gh
  I["Ubuntu's installer asks:<br/>these are my disks"]:::gh
  D{"blank, or erasing<br/>confirmed?"}
  X["stop; nothing written"]:::no
  U["install Ubuntu, then the fleet:<br/>Packages, Tools, Verify, Ready<br/>(live in the boot window)"]:::ok
  H --> M --> I --> D
  D -- no --> X
  D -- yes --> U
  classDef you fill:#EEF2FF,stroke:#6366F1,stroke-width:2px,color:#1E1B4B
  classDef gh fill:#F1F5F9,stroke:#475569,stroke-width:2px,color:#0F172A
  classDef ok fill:#ECFDF5,stroke:#10B981,stroke-width:2px,color:#064E3B
  classDef no fill:#FEF2F2,stroke:#EF4444,stroke-width:2px,color:#7F1D1D
```

Nothing on a disk is erased unless the disk is blank or you confirm it (`--confirm-destroy <host>`,
typed by a person).

## Every day

Open a terminal in your fleet repository (`cd ~/fleet`; on Windows, in PowerShell,
`cd $HOME\fleet`), then:

```sh
deno task stolos update           # instead of git pull: pulls, checks signatures, moves to a newer
                                  # engine release, repairs keys, and runs the doctor
deno task stolos                  # where you are, and the one command to run next
deno task stolos fleet status     # every server, how it is
```

Then, after changing anything in the fleet repository, one command sends it to every machine:

```sh
deno task stolos apply -m "what changed"   # (or: deno task stolos push)
```

It checks your keys and the model, catches up with GitHub, builds, makes **one** signed commit (your
passphrase, once), checks that the servers will trust it, and pushes. With nothing new, it says so
and does nothing; `--check` shows what it would do. Every machine applies it within 15 minutes.

## Common tasks, step by step

The examples use `server-hostname` for a server and `my-fleet` for the fleet: put your own names in
their place. Every change you push is signed (Git asks for your passphrase); every server applies it
within 15 minutes.

<details>
<summary><b>Add a server</b></summary>

1. Describe it and get it ready to install. `--claim` means "the next unknown machine that boots
   from the network becomes this server" (within 30 minutes):

   ```sh
   deno task stolos host add server-hostname --claim
   ```

   If you know its network card's MAC address, use that instead, so only that machine can take the
   name: `--mac-address 1c:83:41:30:25:f2`.

2. Start the boot server on the boot machine, and leave it running:

   ```sh
   deno task stolos boot serve
   ```

3. Power the new machine on and make it boot from the network (the boot menu key at power-on: F7,
   F12, or F11, then the "UEFI PXE IPv4" entry for its wired port).
4. Watch the boot server's window: the installer reports each step, then `server-hostname: ✓ Ready`.
   About 15 to 30 minutes.
5. Save what the machine reported about itself (its MAC address), signed:

   ```sh
   deno task stolos apply -m "my-fleet: server-hostname installed"
   ```

6. Log in: `ssh server-hostname`. On the server, `archon` (no arguments) shows its state and
   `archon verify` checks every piece.

**If the disk is not blank**, the install stops before writing anything and the boot window says
what it found (`archon explain E051-DISK-NOT-BLANK`). When you are sure it may be erased, say so,
yourself (never an agent), for this one install, then boot it again:

```sh
deno task stolos boot arm server-hostname --claim --confirm-destroy server-hostname
```

**If it has less than 8 GB of RAM**, a network install stalls. Install Ubuntu 26.04 Server from a
USB stick instead, then: `deno task stolos host bootstrap server-hostname --ssh you@<its address>`.

</details>

<details>
<summary><b>Add a workstation (your PC's Ubuntu on WSL)</b></summary>

In PowerShell: `wsl --install -d Ubuntu-26.04`, open Ubuntu, create your account, then in Ubuntu:

```sh
sudo apt update && sudo apt install -y git gh unzip
gh auth login --web --git-protocol https && gh auth setup-git
sudo mkdir -p /srv/archon && sudo chown "$USER": /srv/archon
git clone https://github.com/<you>/<fleet repository>.git /srv/archon
curl -fsSL https://deno.land/install.sh | sh -s -- -y && exec bash
cd /srv/archon && deno task stolos workstation add
deno task stolos apply -m "my-fleet: add workstation"
```

Open a new Ubuntu tab: the fleet's tools, prompt, and Claude Code are ready. Details:
[docs/workstation.md](docs/workstation.md).

</details>

<details>
<summary><b>Change something on a server</b></summary>

Edit its file, `fleets/my-fleet/hosts/server-hostname/host.ts` (or `fleets/my-fleet/fleet.ts` for
every server), then:

```sh
deno task stolos apply -m "my-fleet: what changed"   # checks, builds, signs, pushes
deno task stolos fleet status     # within 15 minutes, each server has applied it
```

In a hurry: `ssh -t server-hostname archon update` applies it now (it asks for your password).

</details>

<details>
<summary><b>Turn on PostgreSQL (or S3, SMB): durable or ephemeral data</b></summary>

Anything that holds people's data must be marked, when you turn it on, as one of:

- **durable**: it exists nowhere else. The server is backed up every night, and nothing reinstalls
  or wipes it unless you type `--confirm-destroy server-hostname`.
- **ephemeral**: losing it is harmless (test data, a cache). Reinstalls go ahead without asking.

There is no default: you choose.

```sh
deno task stolos decide pg on --durable --host server-hostname
deno task stolos apply -m "my-fleet: PostgreSQL on server-hostname"
```

Check later: `ssh server-hostname archon data` lists each source of data and its choice. Going from
ephemeral to durable is always allowed. Going from durable to ephemeral removes the protection, so
it needs the confirmation:

```sh
deno task stolos decide pg on --ephemeral --host server-hostname --confirm-destroy server-hostname
```

</details>

<details>
<summary><b>Reinstall a server</b></summary>

Everything comes back from the repository and the boot machine (the same SSH identity, so
`ssh server-hostname` still works); anything only on the server is lost. With `boot serve` running:

```sh
deno task stolos boot reinstall server-hostname
```

A durable server (or one that cannot be asked) is reinstalled only with
`--confirm-destroy server-hostname`. Copy off anything you need first.

</details>

<details>
<summary><b>Restart or turn off a server</b></summary>

On the server: `archon reboot` or `archon poweroff` (they ask for your password). Both wait for any
update in progress to finish first. Never pull the power during an update: it can damage the package
database.

</details>

<details>
<summary><b>Retire a server for good</b></summary>

```sh
deno task stolos boot retire server-hostname                                     # only shows what it holds
deno task stolos boot retire server-hostname --confirm-destroy server-hostname   # removes it from the fleet
```

Its DNS names, deploy key, secrets, and files leave the fleet; the machine itself is not touched.

</details>

<details>
<summary><b>Keys: a new PC, a lost key, a yearly change</b></summary>

| Situation                                 | Run                                                                    |
| ----------------------------------------- | ---------------------------------------------------------------------- |
| check everything                          | `deno task stolos keys`                                                |
| a new PC, or anything is wrong            | `deno task stolos keys setup` (safe to run again)                      |
| a planned change of key                   | `deno task stolos keys rotate`, then `deno task stolos apply`          |
| the daily key is lost                     | `deno task stolos keys lost`, then push                                |
| the laptop was stolen (key may be copied) | the same, with `--stolen`                                              |
| a new recovery key (yearly)               | `deno task stolos keys rotate-recovery`, then `deno task stolos apply` |
| twice a year                              | `deno task stolos keys check-recovery`                                 |

</details>

<details>
<summary><b>Back up the boot machine</b></summary>

After anything that made a secret (a new server, a new token, a new key):

```sh
deno task stolos vault backup
```

It writes one ZIP and tells you where. Move it somewhere safe and encrypted (a password manager, an
encrypted USB drive, OneDrive's Personal Vault).

On a new PC, after cloning the fleet repository, one command puts it all back (every secret, both
keys, Git's signing):

```sh
deno task stolos vault restore <path to the ZIP>
```

</details>

<details>
<summary><b>Adopt a newer engine</b></summary>

`deno task stolos update` does it when a newer release is out: it checks the new version against
your fleet, makes one signed commit, and tells you to run `deno task stolos apply`; your servers
pick it up within 15 minutes. To choose a version yourself:
`deno task stolos fleet upgrade v<version>`, then `deno task stolos apply`.

</details>

## When something goes wrong

Most messages end with `explain: archon explain <code>`: run it for what it means and how to fix it.
`deno task stolos boot doctor` checks the boot machine; `archon doctor` checks a server.

| You see                                               | What to do                                                                                                                              |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `no fleet chosen in ...`                              | the repository holds several fleets: `deno task stolos fleet use my-fleet` (once per checkout; remembered)                              |
| `push refused here: ... is not signed`                | `git commit --amend --no-edit -S`, then `deno task stolos apply` again. `deno task stolos keys` shows what is missing                   |
| a server does not pick up your change                 | `deno task stolos fleet status`; on the server, `journalctl -t archon-approval` says why it refused (usually `E047-UNSIGNED`)           |
| the boot window shows nothing when the machine boots  | `deno task stolos boot doctor` (the firewall, and the router's network boot setting); is the machine booting from the network (F7/F12)? |
| `disk is not blank` in the boot window                | it protected the disk. If it may be erased: `deno task stolos boot arm server-hostname --claim --confirm-destroy server-hostname`       |
| the install stops after `installer image`             | the machine has less than 8 GB of RAM: install from USB, then `host bootstrap` (above)                                                  |
| `ssh server-hostname` warns that the host key changed | stop: do not accept it. `deno task stolos boot doctor`, then `archon explain E047-HOST-KEY`                                             |
| you forgot your daily key's passphrase                | it cannot be recovered: `deno task stolos keys lost`                                                                                    |
| `integrity check failed` or `lockfile is out of date` | stop: never regenerate `deno.lock` to make it go away. See [docs/fleet-repository.md](docs/fleet-repository.md#troubleshooting)         |
| `the repository has uncommitted changes`              | commit (or `git stash`) your other change first                                                                                         |

## Documentation

- **Reference**, from the code, with diagrams:
  <https://intellectual-frontiers.github.io/stolos/latest/> (or `deno task docs` here).
- **Guides**, in [`docs/`](docs/):

| Read                                                                           | For                                                                  |
| ------------------------------------------------------------------------------ | -------------------------------------------------------------------- |
| [docs/fleet-repository.md](docs/fleet-repository.md)                           | Your fleet repository: versions, upgrading, signing, troubleshooting |
| [docs/boot-machine.md](docs/boot-machine.md)                                   | The boot machine: tools, firewall, router, mail, the secrets vault   |
| [docs/hosts.md](docs/hosts.md)                                                 | Adding, installing, re-installing, and retiring machines             |
| [docs/install-timeline.md](docs/install-timeline.md)                           | What happens during an install, in order                             |
| [docs/daily-use.md](docs/daily-use.md)                                         | Working on a server: commands, observing, updates                    |
| [docs/workstation.md](docs/workstation.md)                                     | Your PC's Ubuntu (WSL) as a workstation                              |
| [docs/web.md](docs/web.md)                                                     | HTTPS on every server, publishing services                           |
| [docs/telemetry.md](docs/telemetry.md)                                         | Logs, metrics, traces, and the optional web UI                       |
| [docs/agent.md](docs/agent.md)                                                 | AI agents and other MCP clients, limited by each server              |
| [docs/pg.md](docs/pg.md), [docs/s3.md](docs/s3.md), [docs/smb.md](docs/smb.md) | PostgreSQL, S3, SMB                                                  |
| [docs/sql.md](docs/sql.md)                                                     | SQL over the fleet: osquery, DuckDB                                  |
| [docs/disaster-recovery.md](docs/disaster-recovery.md)                         | Losing the boot machine                                              |
| [docs/troubleshooting.md](docs/troubleshooting.md)                             | Symptoms, causes, and fixes                                          |
| [docs/releasing.md](docs/releasing.md), [AGENTS.md](AGENTS.md)                 | Changing the engine itself                                           |

## Try it

```sh
deno task stolos validate     # the example fleet, examples/fleets/lab
deno task stolos build        # renders its machines into examples/out/lab/
deno task test
```

Every change to this repository is a new version ([`src/archon/version.ts`](src/archon/version.ts)),
tested (including a full install of a virtual machine), and tagged `v<version>`.
