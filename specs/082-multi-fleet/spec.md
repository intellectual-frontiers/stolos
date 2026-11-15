# 082: multi-fleet for providers (MSPs and vCISOs)

Issue intellectual-frontiers/stolos#24.

## Why

Small companies buy security through managed service providers and virtual CISOs, so a provider who
can run many clients' fleets from one PC is the main route to market. Each client must stay entirely
its own (its repository, its vault, its signers), and the provider still needs one view across them
all: who is failing, who is stale, who drifted, whose evidence is old.

## Requirements

- **FR-001** A provider-level registry of client checkouts on the provider's PC, never in any
  client's repository: `clients.json` in Stolos's config folder (`P.provider`), JSON in the form
  `stolos-clients/1`, each client's id (lowercase letters, digits, hyphens), title, the absolute
  path of its checkout, its fleet within it, and the day it was added. Written readable by its owner
  only; it holds no secret.
- **FR-002** `stolos clients add <path> [--fleet <id>] [--id <id>] [--title <t>]`, `clients list`,
  `clients remove <id>` (forgets; deletes nothing), `clients use <id>` and `clients use --clear`
  (the chosen client, in the provider's folder, for every command until changed). A checkout that is
  another client's, inside it, or holding it is refused: one checkout, one client.
- **FR-003** `stolos --client <id> <command>` (global, and the chosen client otherwise) runs any
  command in that client's scope: ARCHON_REPO, ARCHON_FLEET, and ARCHON_CLIENT, so every path
  (`P.repo`, `P.fleetDir`, `P.out`) is the client's checkout, and the per-user folders move under
  `stolos/clients/<id>/`: state (`P.state`, `P.userState`), secrets (`P.secrets`), the key store
  (beside the secrets), the vault's backup ledger, and a backup ZIP's name. The catalogs (public
  reference data) and the boot cache stay shared. `--client` with a `clients` command is refused;
  `--fleet` that is not the client's fleet is refused; an unknown client is refused (exit 2).
  ARCHON_CLIENT that is not a client id is refused (it names folders). Sudo keeps ARCHON_CLIENT.
- **FR-004** Within one process (the console, the summary), a client's scope is entered with
  `withClient`: work for one client runs only while no other client's is in progress, so two
  clients' paths are never live at once; work for the same client may overlap.
- **FR-005** `stolos clients summary [--since <rev or date>] [--json]` and the shared
  `ClientSummary`: per client, read in its own scope, only numbers and dates: controls passing,
  failing, partial, without evidence, and with stale evidence; machines; drift since `--since`
  (default one day: controls changed, and worse); the last observation; open POA&M items (failing
  checks, open register risks, open vulnerabilities); the newest evidence bundle's day. A client
  that cannot be read is "not read", with a general reason (never what its checkout holds).
- **FR-006** `stolos clients report --out <folder>`: `<folder>/<id>/report.md`, `summary.json`, and
  `compliance.json` per client, each read in its scope, then `<folder>/summary.md` and
  `summary.json` (numbers only). A folder inside any client's checkout is refused.
- **FR-007** Per-client evidence bundles, OSCAL exports, and Trust Center pages are the existing
  commands under `--client`: they resolve the client's checkout, folders, and `signers.ts`; a key
  not on that client's list is refused.
- **FR-008** `stolos clients console [--port] [--no-open]`: the provider's console on 127.0.0.1 with
  a one-time launch link. `/clients` shows the summary and an Open button per client. Opening (a
  same-origin POST to `/clients/switch`) ends the session and starts a new one scoped to that
  client; every other page and `/v1/` is then served by that client's own Stolos Console (spec 066),
  built and run in its scope, with its own sessions, caches, activity record, and estate cache, its
  commands run in its checkout with its scope. The session's cookie is mapped to one session in one
  client's console: reaching another client takes another switch, and the old cookie stops working.
  The top bar names the client and links back to All clients; no other client's name is on a
  client's pages. `/v1/clients` (and `/v1/clients/<id>`) return the summary. Without a chosen
  client, pages redirect to `/clients` and `/v1/` answers 409.
- **FR-009** Docs: the `clients` guide (`src/archon/clients/mod.ts`), registered in
  `src/archon/core/guides.ts`: setting up clients, what stays apart, what the summary shows, the
  provider's console.

## Decisions

- The registry is JSON, not TypeScript: it is the provider's own file outside every fleet repository
  (Article 4 governs a fleet's configuration), written by commands, never by hand.
- One engine runs every client in the summary, the report, and the provider's console (the one this
  PC runs), whatever each client's repository pins. A client's commands from the console run with
  `bun run stolos` in its checkout, so with its pinned engine.
- The provider's console does not check GitHub push access per client (the single-fleet console
  does): the launch link and 127.0.0.1 are its sign-in.
- The boot server's log is not shown on a client's pages in the provider's console: it is this PC's,
  about installs at any client's site.
- The auditor portal (spec 083) is per client: `stolos --client <id> audit portal <engagement>`.

## Tests

`tests/multifleet082.test.ts`: a scope moves every per-user folder and two clients never share one;
concurrent work for two clients never sees the other's paths; the registry's refusals; a summary has
numbers and dates only; two fixture client repositories (different fleets, vault folders, and
signers) through `clients add`, `--client`, an evidence bundle for one holding nothing of the other,
a bundle refused for a key that is not the client's signer, the summary, the reports, and
`clients use`; the provider's console: one client per session, a switch is a new session, the old
cookie stops working, and one client's console never accepts another's session.
