# 057: Signing keys in one command (archon keys)

## Why

Signing (spec 047) protects every server from a push it did not approve, but setting it up took
about ten manual steps in three tools (ssh-keygen, git config, archon signers), and a mistake showed
up only later, as a server refusing a commit. Replacing a lost key needed a Git command no one
remembers. A newbie should run one command, and see every problem with its one fix.

## Requirements

- **FR-001** `archon keys`: the checks, each with a stable code (`E057-*`, `archon explain`) and its
  fix: OpenSSH 8.2+; the daily key exists, has a passphrase, is not in an ssh-agent; Git signs every
  commit in the fleet repository with it; signers.ts lists it; a recovery key is listed, its private
  file is not on this PC, and it was checked in the last 183 days; the pre-push check is installed.
  Nothing is written; no passphrase is asked. Exit 1 when signing does not work.
- **FR-002** `archon keys setup` is idempotent: it does only what is missing (the daily key, Git's
  settings for this repository only, signers.ts entries, the recovery key in a `fleet-recovery`
  folder on the Desktop, the pre-push hook) and never overwrites a key; a test signature when
  anything changed (or `--test`). Running it again changes nothing.
- **FR-003** `archon keys check-recovery --key <file>` proves the recovery key and its passphrase
  with a test signature and records the date; reminders (archon keys, boot doctor, a weekly email)
  after six months.
- **FR-004** `archon keys rotate`: a new daily key, signers.ts updated, committed signed by the old
  key; the old pair kept as `<file>.retired-<date>`; resumes if interrupted; a second run the same
  day does nothing.
- **FR-005** `archon keys lost --recovery <file> [--stolen]`: a new daily key, committed signed by
  the recovery key; a listed key still here is replaced only with `--stolen`; resumes if
  interrupted; idempotent.
- **FR-006** `archon keys check-push` (the pre-push hook): each pushed tip of the fleet's branch is
  checked against the signers of what the remote has (as servers check it); refused with the fix.
- **FR-007** Passphrases are typed into OpenSSH and Git only; never seen, stored, or passed by
  archon (tests use SSH_ASKPASS and a passphrase honored only inside ARCHON_SANDBOX). No key is
  loaded into an ssh-agent. No `keys` command is offered over MCP.
- **FR-008** `boot doctor`, `archon` (where am I), `archon signers`, `fleet init`'s next steps, and
  the backup's restore steps use these checks and commands.

- **FR-IDENTITY** A fresh clone (a new or restored PC) has no Git identity: `keys setup` (and so
  `vault restore`) sets `user.name` and `user.email` for the checkout from the GitHub account (gh:
  the name and the no-reply address), and `stolos keys` checks it (`E057-IDENTITY`). `fleet upgrade`
  and `update` refuse to start, changing nothing, when this checkout cannot make a signed commit
  (Git not set to sign, no key, no identity), with the fix (`vault restore` or `keys setup`).

## Success criteria

- **SC-001** `tests/keys057.test.ts`: setup twice (the second changes nothing), the checks from
  facts, the pre-push check refusing an unsigned tip, rotate and lost producing commits a server
  accepts, each run twice.
