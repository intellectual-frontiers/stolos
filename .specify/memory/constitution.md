# Archon Constitution

Archon is the thinnest layer on Ubuntu Server LTS that turns bare metal into a
converged, verified host, for any number of fleets on any network. The engine
lives in one public repository; each operator's fleets live in their own
repository, which pins the engine. Operators (people, or an agent on their
workstation) work through `archon` commands. These articles govern every spec,
plan, task, and line of code of the engine. Amend them only with a commit whose
subject starts with `constitution:`.

**Version**: 5.0.1 · **Ratified**: 2026-11-13 · **Last amended**: 2026-11-16

## Article 1: Ubuntu Server LTS Only

Hosts run Ubuntu Server 26.04 LTS. A new LTS is adopted by amending this
article, never piecemeal.

## Article 2: Platform Defaults First

Use what Ubuntu ships and how Ubuntu configures it: netplan (with
systemd-networkd), systemd-resolved, chrony, sudo, snapd, unattended-upgrades,
nftables, cloud-init, and autoinstall. Archon only adds what Ubuntu does not
do. Every override of a default is listed, with its reason, in the spec that
makes it. Something non-native is allowed only when it is clearly more modern,
and its spec says so.

## Article 3: Reuse Before Inventing

Prefer existing formats, vocabularies, and tools (Ubuntu's, systemd's,
GitHub's, W3C's) to new ones.

## Article 4: Code Over Config

Everything that is ours is TypeScript, checked by TypeScript 7 and run by Bun, with
Node 26 as the backup, on IFC TypeScript (the commons' kernel and runtime). Third-party formats (autoinstall,
cloud-init, netplan, GRUB, systemd units, nftables, sudoers, polkit) are
rendered from the model and never edited by hand.

## Article 5: Binaries Only, Newest Stable

The platform (kernel, systemd, networking, OpenSSH, apt itself) comes from
Ubuntu's archive and is never replaced. A user-facing tool comes from its
newest stable release: through apt from its maintainers' own PPA or the
vendor's official apt repository (signing key pinned) when there is one, kept
current by unattended-upgrades, else from the upstream
project's official binary release, verified against the published SHA-256
digest, else from Ubuntu's archive or snaps. Nothing
is built from source on a host or a boot machine without the owner's explicit
approval.
Pre-releases are never used. Self-updating tools (an agent's command
line, on workstations) update themselves; Archon records their versions.

## Article 6: One Registry

Every capability is a command in one registry. From it Archon generates the
CLI, the MCP tool, the man page, the shell completions, and the agent's
permissions.

## Article 7: Multi-Fleet, Multi-Host by Design

The model describes fleets: each fleet has its identity, personas, site, and
one folder per host, under `fleets/<id>/` of the operator's repository. One
repository holds as many fleets as its operator manages; a fleet that must not
be visible to another fleet's hosts gets its own repository. Nothing assumes a
single machine or a single fleet.

## Article 8: Grow by Spec

Every change goes through Spec Kit (`specs/NNN-short-name/`): specify, clarify,
plan, tasks, implement. Commit subjects start with the spec ID.

## Article 9: Approval Means a Signed Origin Main

Pushing to `main` of the fleet repository is approval, and a host applies only
a tip of `main` signed by a key on the fleet's list of signers, newer than the
last commit it applied. The list of signers changes only through a commit
signed by a key already on it. Hosts converge to that and nothing else.

## Article 10: TypeScript Validates First

The model is validated by TypeScript (types plus explicit rules, each with a
message and a fix) before anything is rendered, installed, or applied. An
invalid model changes nothing. RDF is an export of the model, not part of
validation.

## Article 11: Idempotent Convergence

Applying the same model twice changes nothing the second time. Archon never
removes users, packages, data, or guests on its own; removal needs an
`approve: destructive` marker in the governing spec and a request from the
owner.

## Article 12: Integrity of Downloads

Every downloaded binary or image is verified against a published checksum (or
signature) before use. A mismatch stops the step.

## Article 13: No Plaintext Secrets

Secrets never appear in git, in rendered output, in logs, in telemetry, or in
reports. Secrets live on the boot machine, as files readable by their owner
only; a signing key is also encrypted with a passphrase that is typed, never
stored. Their only other copy is an encrypted backup in the fleet's vault
provider, made by `boot vault backup`. The engine holds an inventory of secret
names, never values. A secret reaches a host during its install, or when the
owner pushes it to that host.

## Article 14: State Implies Backup

Anything that holds state declares how it is backed up and restored.

## Article 15: Everything Is Verifiable

Every managed thing has a verification command. `archon verify` runs them all
and records the results.

## Article 16: Provenance Is Automatic

Every run that changes a host records what it did, as data that can be
exported as RDF (W3C PROV).

## Article 17: The Agent Is a Workstation Layer

Servers run no AI agent and hold no AI credentials. An agent (any MCP client)
runs on an operator's workstation and reaches each server only as
`ops`, over SSH, through `archon mcp`: the server, not the client, limits it to
the tiers the model allows (reading what a machine observed is the read tier,
`archon query`), and it never gets the destructive tier. It never
holds the owner's personal credentials. Choosing the agent and its model
(cloud or local) is a workstation decision; servers do not change for it.

## Article 18: Install Is Declarative

A host is created from its model by network boot (UEFI HTTP Boot served by
`archon-boot`) and Ubuntu's unattended installer. No human steps after
power-on. Re-creating a host is the way to
reset it.

## Article 19: Calm Output

One line per phase, progress while working, every problem with a fix and a
log line, collected again at the end. Full detail goes to the run log.

## Article 20: Names, Not Announcements

Every service a host offers is found by a unicast DNS name (a record in the
router's local DNS, such as `<host>.localdomain` or a service alias such as
`otel.localdomain`) or by an address in the model, never by multicast
discovery (mDNS, DNS-SD, LLMNR). Hosts neither announce nor answer multicast
name resolution: an announcement can be impersonated by any device that shares
a reflector with the host, and it maps names, services, and versions for
anyone listening. 

## Article 21: The Site Is Modeled; the Router Is the Authority

Archon describes the site's network (zones, networks, firewall policies, DNS,
the mDNS proxy, Wi-Fi, VPN) as typed data and checks hosts against it, but
never changes the router. Router changes are made by the owner (or the network
assistant) and the model is updated to match. When the model and the router
disagree, the router is right and the model is fixed.

## Article 22: Losing the Boot Machine Is Routine

Every secret change is followed by a vault backup, and Archon says so until it
is done. A new PC becomes the boot machine from the repo plus the vault, by a
documented procedure that is rehearsed, not improvised.

## Article 23: Ephemeral by Default, Durable by Data

Any service or guest that can hold data from end users is either **ephemeral**
(losing its data is harmless) or **durable** (its data exists nowhere else).
The operator chooses which when turning it on; there is no default. A host is
durable when anything on it is durable, and ephemeral otherwise. Archon works
out the class from the host's records each time and never stores it; where a
choice is missing or cannot be read, the data counts as durable. Nothing
reinstalls, wipes, or overwrites durable data without `--confirm-destroy`
naming it, typed by a person (never by an agent). Durable data is backed up
(Article 14) and is to keep a copy off the host. Home directories on servers
are ephemeral: they are not kept across a reinstall. "Durable" describes data
and hosts, not a transaction.

## Article 24: The Engine Holds No Fleet's Facts

The engine is general: it names no fleet, host, domain, address, or person, and
its tests and examples use neutral data (`examples/fleets/lab/`). A fleet
repository imports the engine as modules through `@intellectual-frontiers/stolos`,
a Git dependency pinned to a tag and checked by its lockfile, which holds the
tag's commit. Every push to the engine's `main` raises its version, kept in
TypeScript (`src/archon/version.ts`), and is tagged `v<version>`; the tag is the
release. A fleet adopts a new engine by changing its pin in a signed commit.

## Article 25: Git Holds Intent, Identity, and Decisions

The fleet repository holds what each machine should be (the model), who
belongs (registration: hosts, public keys, signers), and what operators decided
(opt-ins and whether their data is durable). Each machine keeps its own state
(what it observed, verified, and did) on itself, canonically as readable SQL
(`archon.sql`), from which an `.auto.` SQLite file is built for osquery; it is
read over SSH, never pushed. Hosts only read the repository.

## Article 26: Generated Files Say So

A file generated from another carries `.auto.` in its name wherever the name is
Archon's to choose (`assets.auto.ts`, `archon.auto.sqlite.db`), and a header
saying what generates it. Generated files are never edited by hand.

## Article 27: Telemetry by OpenTelemetry

Every run reports through OpenTelemetry, by IFC TypeScript's signals: traces,
metrics, and logs, under names declared once in the engine, with the trace carried across
SSH, MCP, and installs. It is silent and harmless when no collector listens.

## Amendments

| Version | Date | Change |
|---|---|---|
| 2.0.0 | 2026-11-10 | Archon v2 on Ubuntu Server 26.04 LTS. |
| 2.0.x | 2026-11-10 | Article 5: newest upstream binaries; maintainers' PPAs first; vendors' official apt repositories. |
| 2.1.0 | 2026-11-11 | Article 20 (names, not announcements); Article 13 amended (encrypted vault backup, secret inventory); Article 21 (the site is modeled, the router is the authority); Article 22 (losing the boot machine is routine). |
| 3.0.0 | 2026-11-12 | Article 17 redefined: the agent is a workstation layer (no agent or AI credentials on servers; MCP over SSH as `ops`, limited by the server). Article 18: no sign-in step after power-on. Preamble, Articles 5 and 6 no longer name Claude Code. |
| 3.1.0 | 2026-11-13 | Article 23 (ephemeral by default, durable by data): a forced choice for every source of end users' data; durable hosts guarded by `--confirm-destroy`, typed by a person. |
| 4.0.0 | 2026-11-13 | The engine stands alone (the Stolos repositories). Article 7: many fleets per repository. Article 9: approval is a signed tip of `main`. Article 13: file-based secrets, passphrase-protected signing keys, the fleet's vault provider. Articles 20 and 21 no longer name a site. New: Article 24 (the engine holds no fleet's facts; versioned and tagged on every push), Article 25 (Git holds intent, identity, and decisions; machines keep their own state as `archon.sql`), Article 26 (generated files are named `.auto.`), Article 27 (telemetry by OpenTelemetry). |
| 5.0.0 | 2026-11-15 | The engine on Bun and IFC TypeScript (spec 096): Article 4 names TypeScript 7, Bun with Node 26 as the backup, and the commons' kernel and runtime; Article 27 reports through IFC TypeScript's OpenTelemetry. No Deno. |
| 5.0.1 | 2026-11-16 | Article 24 names the engine's package, `@intellectual-frontiers/stolos`, as a Git dependency pinned to a tag whose commit the lockfile holds; the tag is the release (spec 096, no GitHub release). |
