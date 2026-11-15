# Feature Specification: Retire a server

**Feature Branch**: `045-retire` (committed directly to main) **Created**: 2026-11-13 **Status**:
Implemented **Input**: A server leaves the fleet for good, the reverse of `archon host add`: one
command on the boot machine removes everything that names it, with its name repeated by a person.
The same hardware may then join as a new host.

## User Scenarios & Testing _(mandatory)_

1. **Given** alpha in the model, **When** the operator runs `bun run stolos boot retire alpha`,
   **Then** it refuses, saying what alpha holds (durable or ephemeral) and that
   `--confirm-destroy alpha` is needed; nothing changes.
2. **Given** `--confirm-destroy alpha`, **Then** alpha's DNS records leave Cloudflare, its deploy
   key leaves GitHub, this PC forgets its install token, secrets, and SSH trust, and its model and
   records leave the checkout; the mailbox is told; the next steps say to build, commit, push, clear
   the router's record, and back up the vault.
3. **Given** a durable alpha, **Then** retiring warns that its data is lost with it, after the same
   confirmation.
4. **Given** the same machine then added as beta (`archon host add beta`), **Then** it installs as a
   new host with its own identity; nothing of alpha is reused.

## Requirements _(mandatory)_

- **FR-001** `bun run stolos boot retire <host> --confirm-destroy <host>`: the host must be in the
  model; the name must be repeated, by a person (refused with `ARCHON_AGENT` set). Without it,
  nothing changes.
- **FR-002** It asks the host over SSH (`archon data --json`) whether it is durable, else reads its
  records, and says which before removing anything; a durable host is retired only with the same
  confirmation and a warning that its data goes with it.
- **FR-003** DNS: with the fleet's web domain and the Cloudflare token on this PC, the A records
  `<host>.<domain>` and `*.<host>.<domain>` are deleted, and nothing else. Without the token, a
  warning names the records to remove by hand.
- **FR-004** GitHub: every deploy key titled `archon host <host>` is deleted from the repository
  (`gh`).
- **FR-005** This PC: the host's install token, its secrets folder (deploy key, SSH host keys, the
  carried Let's Encrypt store), and its `known_hosts` lines (its name, DNS name, IP, and install
  addresses) are removed.
- **FR-006** The checkout: `fleets/<fleet>/hosts/<host>/host.ts` and `state/hosts/<host>/` are
  removed, then built, committed (`045-retire: retire <host>`), and pushed: only those paths and
  what `archon build` renders from them (`.mcp.json`, the agent's permissions, the man pages),
  retrying a push that lost a race by rebasing. `--no-push` leaves the change uncommitted; running
  the command again with the model already gone but still committed finishes it. `archon host add`
  ends the same way (`004-install: add host <name>`, `--no-push` to leave it). The machine itself is
  not touched.
- **FR-007** The router's local DNS record is the owner's to remove (Article 21), then its line in
  `fleets/<fleet>/site.ts`; the next steps name it when the site has one. The vault keeps the old
  secrets until the next `bun run stolos boot vault backup`.
- **FR-008** The mailbox is told what was removed.

## Success Criteria

- **SC-001** After retiring and pushing, nothing in the repository, on this PC, in Cloudflare, or on
  GitHub names the host, except the router's record until the owner removes it, and the docs'
  examples.
