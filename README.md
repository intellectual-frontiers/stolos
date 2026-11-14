# Stolos

Stolos turns bare machines into Ubuntu servers that set themselves up, keep themselves right, and
can prove it. You describe your machines in a few TypeScript files; its command, `archon`, does the
rest.

```
  what you write                      what Stolos does                      what you get
┌───────────────────┐        ┌──────────────────────────────┐        ┌────────────────────────┐
│ fleet.ts          │        │ installs Ubuntu over the     │        │ servers that match the │
│  domain, mail,    │  ───▶  │ network (no USB, no clicks)  │  ───▶  │ description, every 15  │
│  admin, ...       │        │ applies packages, users,     │        │ minutes, and can say   │
│ hosts/olympia/    │        │ firewall, HTTPS, tools       │        │ so: archon verify,     │
│  host.ts          │        │ checks every piece           │        │ archon fleet status    │
└───────────────────┘        └──────────────────────────────┘        └────────────────────────┘
```

Ubuntu decides; Stolos only adds (see the [constitution](.specify/memory/constitution.md)).

## Two kinds of repository

This repository is the **engine**: public, with no real machines in it. Each fleet lives in a
**fleet repository** of its own, private, that uses the engine by version.

```
intellectual-frontiers/stolos (public)          your fleet repository (private)
┌──────────────────────────────────┐            ┌──────────────────────────────────────┐
│ the engine: archon, boot server, │  tag       │ deno.json   "use engine vX.Y.Z"      │
│ guides, an example fleet         │  vX.Y.Z    │ deno.lock   a fingerprint of every   │
│                                  │ ─────────▶ │             engine file              │
│ every change: a new version,     │            │ fleets/<id>/fleet.ts, hosts/...      │
│ tested, tagged, never changed    │            │ fleets/<id>/signers.ts (who approves)│
└──────────────────────────────────┘            └──────────────────┬───────────────────┘
                                                                    │ each server pulls it
                                                                    ▼ (read only)
                                                          ┌──────────────────────┐
                                                          │ your servers         │
                                                          └──────────────────────┘
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

```
you: git commit (passphrase) ──▶ GitHub ──▶ server: sealed by a key in signers.ts?
                                                 yes ──▶ apply the change
                                                 no  ──▶ refuse (archon explain E047-UNTRUSTED)
```

The fingerprints in `deno.lock` make your seal cover the engine's code too: a server runs exactly
the engine files you approved.

## Set up a fleet repository

You need Deno, Git, and `gh` (GitHub's command line, signed in).

1. Create an empty private repository on GitHub and clone it.
2. Make your signing key, and tell Git to use it for every commit (the passphrase is never stored):

   ```sh
   ssh-keygen -t ed25519 -f ~/.ssh/fleet-signing -C "<your name> fleet signing"
   git config --global gpg.format ssh
   git config --global user.signingkey ~/.ssh/fleet-signing
   git config --global commit.gpgsign true
   ```

   Make a second, **recovery** key the same way and keep it somewhere safe and apart (an encrypted
   vault): it replaces the first if your PC is lost.
3. Start the fleet with the engine's latest version (it writes `deno.json`, `deno.lock`, and
   `fleets/<id>/fleet.ts` from your GitHub account):

   ```sh
   deno run -A https://raw.githubusercontent.com/intellectual-frontiers/stolos/v<version>/src/archon/main.ts fleet init <id>
   ```

4. List your keys as the fleet's signers, then commit and push (signed):

   ```sh
   deno task archon signers add <you> --role daily --key ~/.ssh/fleet-signing.pub
   deno task archon signers add <you>-recovery --role recovery --key <recovery>.pub
   git add -A && git commit -m "<id>: the fleet" && git push
   ```

5. From here, `deno task archon` shows where you are and the one command to run next: tokens, your
   first server (`deno task archon host add <name> --claim`), and installing it
   (`deno task boot serve`).

The full walk-through: [docs/fleet-repository.md](docs/fleet-repository.md) and
[docs/boot-machine.md](docs/boot-machine.md).

## How a machine becomes a server

```
boot machine                                   the new machine
────────────                                   ───────────────
host add olympia --claim
boot serve  ◀─────────── network boot ──────── power on
            ── Ubuntu's installer ───────────▶
            ◀── "my disks are: ..." ──────────  (nothing erased unless blank or confirmed)
            ── ok ───────────────────────────▶ installs Ubuntu, then the fleet's description
            ◀── Packages, Tools, Verify, Ready  (shown live in the boot window)
```

## Every day

- `deno task archon`: where you are, and what to do next.
- Change a file under `fleets/<id>/`, `deno task archon build`, then commit (signed) and push: every
  server applies it within 15 minutes.
- `deno task archon fleet status`: every server, how it is.
- `archon explain <code>`: what a problem means and how to fix it.
- `deno task archon fleet upgrade v<version>`: adopt a newer engine.

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
deno task archon validate     # the example fleet, examples/fleets/lab
deno task archon build        # renders its machines into examples/out/lab/
deno task test
```

Every change to this repository is a new version ([`src/archon/version.ts`](src/archon/version.ts)),
tested (including a full install of a virtual machine), and tagged `v<version>`.
