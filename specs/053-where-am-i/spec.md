# 053: Where am I, and what next

## Why

Setting up a fleet takes steps in an order (the fleet, the engine pin, signers, this machine's
signing, the admin password, tokens, each server, a signed push), and each refusal along the way can
feel arbitrary to someone new. The tool should say where they are and the one command to run next,
from the real state, without anyone reading the documentation first.

## Requirements

- **FR-001** `archon` with no arguments (or only global options), and `archon where`, show every
  step for the active fleet, each ✅ done, 👉 next (exactly one), ▫️ to do, or ⏳ not set up yet,
  and end with `next: <command>`. `archon help` lists the commands.
- **FR-002** Each step is computed from the real state every time (Git, the secret store, the boot
  server's tokens, what hosts recorded, registration.ts); nothing about progress is stored.
- **FR-003** Not set up yet (mail and Cloudflare tokens) never blocks the next step; when it is all
  that is left, it is what to do next.
- **FR-004** On a host, `archon` with no arguments is `archon state`.
- **FR-005** `host add` warns, with its code, when the fleet has no daily signer (the host would
  refuse every change after its install).

## Success criteria

- **SC-001** `tests/where053_test.ts`.
