# Stolos

Stolos is a general fleet engine: you describe each host in TypeScript, and its command, `archon`,
turns bare metal into a converged, verified **Ubuntu Server 26.04 LTS** host. It renders Ubuntu's
own formats (autoinstall, netplan, systemd units, nftables, sudoers) from the model, installs each
host over the network with no human steps after power-on, and keeps it converged.

Ubuntu decides; Archon only adds. See the [constitution](.specify/memory/constitution.md).

## Engine and fleets

This repository is the **engine**. It holds no real fleet. Your fleets live in a repository of your
own, which imports the engine by version:

```
your fleet repository (private)            this repository (public)
───────────────────────────────            ────────────────────────
deno.json   "@stolos/": ".../v0.1.0/src/"   src/archon/        the archon command
deno.lock   (pins every engine file)       src/archon-boot/   the boot server
archon.ts   runs the pinned engine         specs/ docs/ home/ carried as a module
fleets/<id>/
  fleet.ts  site.ts                        examples/fleets/lab/  a complete example
  hosts/<host>/host.ts
```

- `deno.json` maps `@stolos/` to a tagged raw GitHub URL, for example
  `https://raw.githubusercontent.com/intellectual-frontiers/stolos/v0.1.0/src/`, and `deno.lock`
  pins every file of it.
- `archon.ts` is two lines:

  ```ts
  import { run } from "@stolos/archon/main.ts";
  await run();
  ```

- Each host checks out the fleet repository at `/srv/archon`, knows its fleet from
  `/etc/archon/fleet`, and runs `archon` (the launcher runs `archon.ts` with the lockfile frozen).
- To adopt a newer engine: `deno task archon fleet upgrade v0.8.0`, then `git push`. It checks the
  tag is a release, locks every engine file in `deno.lock`, validates every fleet, and makes one
  signed commit (see [docs/fleet-repository.md](docs/fleet-repository.md): why the lock is a
  security control, and what to do when it complains).

Every push to this repository's `main` raises the version in
[`src/archon/version.ts`](src/archon/version.ts) (0.1.0, 0.2.0, ...), and CI tags the commit
`v<version>`.

## Try it on the example lab

```sh
deno task archon validate     # the example fleet, examples/fleets/lab
deno task archon build        # renders every host into examples/out/lab/
deno task test
```

From a fleet repository, `archon` finds the fleet the same way: `ARCHON_REPO` (the repository) and
`ARCHON_FLEET` (the fleet), else the nearest folder with `fleets/` and its only fleet, else
`/srv/archon` and `/etc/archon/fleet`.

## Documentation

| Read                                                                           | For                                                                                                                  |
| ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| [docs/fleet-repository.md](docs/fleet-repository.md)                           | Your fleet repository: the pin, the lock (and why they are security), upgrading the engine, signing, troubleshooting |
| [docs/telemetry.md](docs/telemetry.md)                                         | Logs, metrics, and traces: the headless Collector, collecting in one place, the web UI (OpenObserve), the boot PC    |
| [docs/releasing.md](docs/releasing.md)                                         | Changing the engine: spec, version, `deno task ci`, tags, and protecting them                                        |
| [docs/boot-machine.md](docs/boot-machine.md)                                   | The boot machine: tools, firewall, router, `boot serve`, `boot doctor`, mail, the secrets vault                      |
| [docs/hosts.md](docs/hosts.md)                                                 | Adding, installing, and re-installing hosts                                                                          |
| [docs/install-timeline.md](docs/install-timeline.md)                           | What happens during an install, in order                                                                             |
| [docs/workstation.md](docs/workstation.md)                                     | Ubuntu on WSL as a workstation                                                                                       |
| [docs/daily-use.md](docs/daily-use.md)                                         | Working on a host: commands, the prompt, observing, updates                                                          |
| [docs/web.md](docs/web.md)                                                     | HTTPS on every server, publishing services, guests, containers                                                       |
| [docs/dotfiles.md](docs/dotfiles.md)                                           | Dotfile layers and how chezmoi applies them                                                                          |
| [docs/agent.md](docs/agent.md)                                                 | The agent layer: any MCP client on a workstation, limited by each server                                             |
| [docs/sql.md](docs/sql.md)                                                     | SQL over infrastructure: osquery, DuckDB                                                                             |
| [docs/pg.md](docs/pg.md), [docs/s3.md](docs/s3.md), [docs/smb.md](docs/smb.md) | PostgreSQL, S3, SMB                                                                                                  |
| [docs/disaster-recovery.md](docs/disaster-recovery.md)                         | Losing the boot machine                                                                                              |
| [docs/troubleshooting.md](docs/troubleshooting.md)                             | Symptoms, causes, and fixes                                                                                          |
| [AGENTS.md](AGENTS.md)                                                         | How to change the engine (people and agents)                                                                         |

## Status

The version is in [`src/archon/version.ts`](src/archon/version.ts). The engine started as it stood
in its first fleet, made general (`046-engine-instance`: the engine/fleet split, per-fleet secrets,
the example lab, versioning). Since then:

- `047-intent-and-identity`: hosts apply only a tip of `main` signed by one of the fleet's signers
  (`fleets/<id>/signers.ts`, `archon signers`).
- `048-observe-by-query`: each machine keeps its own state in `/var/lib/archon/archon.sql` (readable
  SQL; `archon.auto.sqlite.db` is built from it for osquery). `archon state`, `archon query`, and
  `archon fleet query` read machines live over SSH; hosts never push, and their deploy keys are
  read-only.

- `049-telemetry`: OpenTelemetry everywhere (one list of signals, traces across machines, events
  structured at their source; the boot PC as the default collector).
- `050-telemetry-ui`: the telemetry web UI (OpenObserve) as an opt-in on any server.
- The `e2e` workflow installs a blank Secure Boot VM from network boot to `Ready` on every push.

Next: decisions and registration in Git (`decisions.ts`, `registration.ts`), and an install as one
trace from `boot arm` to `Ready`.
