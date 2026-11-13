# Feature Specification: Intent and identity in Git; approval by signature

**Feature Branch**: `047-intent-and-identity` (committed directly to main) **Created**: 2026-11-13
**Status**: In progress (v0.3.0: signers and signed approval; v0.10.0: decisions in Git) **Input**:
Constitution Articles 9 and 25. Git holds what each machine should be, who belongs, and what
operators decided; hosts only read it. Approval is a tip of `main` signed by a fleet signer (a daily
key in a passphrase-protected file on the operator's machine, never in an agent; a recovery key kept
only in the vault), and newer than what the host applied. The list of signers changes only through a
commit signed by a key already on it.

## User Scenarios & Testing _(mandatory)_

1. **Given** a fleet with signers, **When** an operator pushes an unsigned commit (or one signed by
   an unknown key) to `main`, **Then** every host refuses to move to it, says why in its journal
   (`archon-approval`), and stays where it was.
2. **Given** a signed tip, **Then** hosts fast-forward to it, including the unsigned commits below
   it: the tip's signature covers the history it names.
3. **Given** a tip older than the commit a host applied (a rollback, a rewritten history), **Then**
   the host refuses it.
4. **Given** someone with push access adds their own key to `signers.ts` and signs that commit with
   it, **Then** hosts refuse it: they check with the list they already trust.
5. **Given** a new host, **When** it is installed, **Then** `/etc/archon/allowed_signers` holds the
   fleet's signers, and the first boot runs nothing from the repository unless its tip verifies.
6. **Given** every signing key is lost, **When** a person logged in to a host runs
   `archon signers trust <key> --name <n>`, **Then** that host trusts the key (never over MCP or by
   an agent) and the mailbox is told.
7. **Given** an operator, **When** they run `archon signers`, **Then** they see the signers and
   whether their own setup signs with SSH, protects the key with a passphrase, and keeps it out of
   an ssh-agent.

## Requirements _(mandatory)_

- **FR-001** `fleets/<id>/signers.ts` lists
  `SignerDef { name, role: "daily" | "recovery", key, added }` as a default export in one fixed form
  (sorted by name), written by `archon signers add/remove`. `archon build` fails when it is not in
  that form, when no daily signer exists, when names repeat, or when a key is not ed25519 (plain or
  `sk-`).
- **FR-002** Every server's `/etc/archon/allowed_signers` (Git's format, principal = signer name,
  `namespaces="git"`) is rendered from the signers of the commit it applies, plus
  `/etc/archon/allowed_signers.local` (emergency keys). The install writes the first one.
- **FR-003** Before a host fast-forwards (`archon update`, the reconcile timer), `checkTip`
  requires: the tip descends from the current commit, and `git verify-commit` of the tip succeeds
  against the current `allowed_signers` (with `gpg.ssh.program=ssh-keygen`). Otherwise nothing moves
  and the reason is journaled. A host enforces this when it has `/etc/archon/allowed_signers` (every
  installed server); a workstation, the operator's own machine, does not.
- **FR-004** The first-boot script verifies the clone's `HEAD` the same way before it runs anything
  from the repository, and reports a refusal to the boot server.
- **FR-005** `archon signers` (read) lists the signers and checks the caller's signing setup;
  `signers add` and `signers remove` (repo tier) change `signers.ts`; `signers trust` (mutate, never
  over MCP, key typed by a person) writes the local emergency list and notifies the mailbox.

- **FR-006** Operators' decisions are in Git: `fleets/<id>/hosts/<host>/decisions.ts` (a typed
  literal in one form, checked by `archon build`), written by
  `archon decide <opt-in> on|off [--durable|--ephemeral] --host <host>` (repo tier, never over MCP)
  on a workstation. A decision there wins over the host's own record (`archon.sql`): the model,
  `apply`'s unit switches, and the data class (Article 23) all follow it, so it survives a
  re-install and the boot machine knows a host's class while it is offline. Durable to ephemeral
  needs `--confirm-destroy <host>`, typed by a person. Turning an opt-in on or off on the host
  itself still works and says how to record it in Git.

## Open (next versions)

- Read-only deploy keys, with hosts no longer pushing (spec 048 removes `archon push` and
  `capture`).
- `registration.ts` (host public keys, deploy-key fingerprint, hardware id) and `known_hosts`
  generated from it.
- `decisions.ts`: opt-ins and their data class decided on the workstation and committed, instead of
  host records.
- `archon doctor` on the boot machine runs the signing-setup checks.

## Success Criteria

- **SC-002** `tests/decisions_test.ts`: `decide` writes the fixed form; the model and the data class
  follow Git's decision with no record on any machine; durable to ephemeral needs
  `--confirm-destroy`; a hand edit out of form fails `build`.
- **SC-001** `tests/signers_test.ts`: a signed tip is accepted; unsigned, unknown-signer, rollback,
  and self-added signers are refused; the install checks before it runs anything.
