# 060: `stolos apply` (or `stolos push`): one command, one passphrase

## Why

Sending a change to the fleet took four commands (build, git add, git commit, git push), a signing
passphrase for each signed step, and knowing what to check first. One command should do it, check
before it changes anything, and ask for the passphrase once.

## Requirements

- **FR-001** `stolos apply` (canonical; `stolos push` is an alias), on your PC, in order, stopping
  at the first problem with its fix: checks (a fleet is chosen, the checkout is on its branch, the
  keys can sign: spec 057's fail-level checks); catch up (fetch, fast-forward only, keeping
  uncommitted edits; a diverged history is named with what to do); build (an invalid model commits
  nothing); show what changes, by fleet and host; one signed commit of everything (`-m`, or a
  message written from what changed); verify (the commit is signed by a key servers trust, as
  `keys check-push` checks); push (a race with GitHub is reported, nothing lost); then the backup
  reminder when a secret changed.
- **FR-002** Idempotent: with nothing to commit or push, it says "up to date" and does nothing.
  `--check` stops before the commit and changes nothing.
- **FR-003** A new repository (no commits, no branch on GitHub yet) works: the first push sets the
  upstream.
- **FR-004** Every message that said `git push` (keys setup, rotate, lost, update, fleet upgrade,
  decide, host add, retire, workstation add, where, doctor) says `stolos apply`; the READMEs too.
- **FR-005** No passphrase is remembered (a possible later spec: an opt-in, time-limited agent).
- **FR-006** Nothing changed here, but commits at the top not signed by a fleet signer (made
  elsewhere: a tool, the GitHub website): `apply` lists them and approves them with one signed
  (empty) commit on top, verified and pushed, so servers accept GitHub's branch again.

## Success criteria

- **SC-001** `tests/fleetapply060_test.ts`: `--check` changes nothing; the first apply of a new
  repository is one signed commit that a server accepts, pushed through the real pre-push check;
  again: up to date; `push` is the same; the message is written from what changed.
