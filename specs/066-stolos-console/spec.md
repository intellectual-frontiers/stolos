# 066: The Stolos Console

## Why

The person who runs the fleet is often a developer, not an operator: they understand code and terms,
not server habits. Their everyday questions (what do we have, is it healthy, what changed, who may
approve, what would an auditor see) should have a page each, on the PC where Stolos runs, without a
new password or key to keep.

## Requirements

- **FR-001** `stolos console` checks with `gh` that the person's GitHub account may push to the
  fleet repository (`--no-github` skips it, offline), listens on 127.0.0.1 (default port 8091), and
  prints and opens a one-time launch link: it works once, within two minutes, and becomes a session
  cookie (HttpOnly, SameSite=Strict, 8 idle hours, gone when the console stops).
- **FR-002** It answers only requests whose Host is 127.0.0.1 or localhost on its port (421
  otherwise); POSTs need the console's own Origin and Datastar's request header.
- **FR-003** Pages: Overview, Machines (managed, adopted, cloud; filter; CSV and evidence JSON
  downloads), one page per machine, Clouds, Ask every machine (fleet query as a table), Changes,
  Trust, Activity, Actions (six groups, each with its diagram), How it works, Guide.
- **FR-004** Commands run as `deno task stolos ...` in the fleet repository, one at a time, with the
  console's terminal as their input: secrets are typed there, never in the browser. Commands that
  change keys and `vault restore` are not offered; the person-only commands agents may not run over
  MCP (apply, fleet upgrade, vault backup, ...) are, because a person is at the PC.
- **FR-005** Form values are single arguments (never a shell), may not start with "-", and are one
  line, as in the Archon Console (spec 065).

- **FR-006** Each server records its last pull (`/var/lib/archon/status/sync.json`: when, the
  commit, and why it stopped) and `archon state` reports it with the applied commit; `fleet status`
  keeps both on the PC. The console shows each server's applied commit (newest, behind, or stuck),
  and a stuck pull's reason in plain words with its fix (an unsigned commit: Apply).
- **FR-007** Changes shows the diff Apply would commit. Activity filters by UTC date and downloads
  as CSV; on a server, a viewer sees only their own entries.
- **FR-008** Text and buttons meet 4.5:1 contrast in light and dark; tables show a shadow where more
  is to the side; diagrams on a phone scroll at a readable size; every page has a skip link.

## Success criteria

- **SC-001** `tests/console066_test.ts`: launch links (once, two minutes), the Host and Origin
  guards, refusals, the query table, what is offered, every page, the downloads, CSV quoting.
- **SC-002** `tests/console/stolos-browser.cjs` (CI's console-browser job): every page at desktop
  and phone width, nothing wider than the screen, every field labeled, no script errors, a run
  streamed, a query answered and a refused one explained, the filter, the search.
