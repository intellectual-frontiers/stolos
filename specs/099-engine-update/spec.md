# 099: Updating the engine is one command, or one button

## Why

A newer Stolos release meant three steps for the owner: `stolos fleet upgrade <tag>`, then
sending the signed commit, then waiting. `stolos update` already found the newest release and made
the signed commit, but stopped there and asked for the next command; and the consoles did not say
which engine runs, or that a newer one is out. The owner asked: Stolos does all the work, shows the
version in both web consoles, and updates from there too. Nothing tells the owner to run `git push`:
`stolos apply` is how a change leaves the PC (spec 060).

## Requirements

- **FR-001** `bun run stolos update` does every step itself, stopping only where a person must
  decide:
  - pulls (fast-forward), or, when the owner's own commits and GitHub's went different ways and
    nothing is uncommitted, puts the owner's on top (`git rebase`); a conflict is undone and named;
  - sends the owner's own commits not on GitHub yet (`stolos apply`) before upgrading;
  - finds the newest release itself (`git ls-remote --tags` of the engine's repository), moves the
    pin (`fleet upgrade`: validated, locked, one signed commit), and sends it (`stolos apply`), so
    every server follows within 15 minutes;
  - uncommitted changes are never committed for the owner: it says so, and what to run.
- **FR-002** Both consoles show the engine running there in the header, and, when a newer release
  is out, a link to update. The lookup is cached for an hour, and an unreachable GitHub shows
  nothing rather than something wrong.
- **FR-003** The Stolos Console's Overview says when a newer release is out, with **Update to
  vX** (it runs `stolos update`; the passphrase is typed in the terminal, never the browser). The
  Archon Console's Engine card says the same, explains that the fleet moves when its operator
  updates (the change is signed on the PC), and offers **Update now** to an operator (`archon
update`: follow GitHub at once instead of within 15 minutes).
- **FR-004** No message, guide or diagram tells the owner to run `git push`: each says
  `bun run stolos apply`.
- **FR-005** A passphrase a console-run command needs is asked on the page that ran it, never in
  the terminal: OpenSSH asks through `SSH_ASKPASS` (with `SSH_ASKPASS_REQUIRE=force`) a helper that
  asks the console on 127.0.0.1 with a token made for that console only; the page shows a password
  field; the answer goes to OpenSSH and nowhere else (not logged, not stored; the activity record
  says only that one was typed or cancelled). On plain HTTP the field first says: "⚠️ Warning,
  you're about to type in your passphrase on an unencrypted channel. Only do this on a trusted
  network, or do this at the command line:" with the same command. Unanswered in five minutes,
  or cancelled, OpenSSH is told no and nothing is signed.
- **FR-006** Expected is not alarming. Files Stolos writes itself as records (an install's
  `registration.ts`, an adopted machine's `machine.ts` and `observed.ts`, `discovered.ts`, devices'
  and connected accounts' observations) are named for what they are ("olympia's registration (from
  its install)"): the doctor lists them as "not sent yet" (no warning, no failure), and
  `stolos update` sends them itself (one signed commit). A person's own edits are a warning, never
  a failure, and `stolos update` asks before sending them. An engine upgrade waiting for them is
  "next", not a warning; what the doctor finds after an update is reported as warnings with their
  fixes, not as the update failing.
- **FR-007** A step that is the operator's to take is ⚡ (action), with the command: neither a
  warning (⚠️) nor an error (❌), never counted as one, never failing a run; a run's close lists
  them under "Your move", between "Needs attention" and "Not set up yet" (⏳). The marks, their
  ASCII fallbacks (`[you]`, `[todo]`) and the order are commons' (0006-signals FR-022 and FR-027),
  so every command line of Intellectual Frontiers says it the same way; Stolos takes them from
  commons' palette. Uses: changes not sent yet (records and your own), commits not sent, an engine
  upgrade waiting for them, and secrets newer than the last backup (a warning only once a week
  overdue, or host keys never backed up). The consoles' live output shows ⚡ lines in their own
  colour.
- **FR-008** The compliance impact of a change (spec 074) reads the previous commit's fleet files
  from a scratch copy inside the repository's own Git folder (`.git/stolos-impact-*`, never
  tracked), so Bun and Node find the checkout's `node_modules` the way they always do, by looking
  in each folder above. No link is made: making one on Windows needs administrator rights or
  Developer Mode, and failed there with EPERM.

## Success criteria

- **SC-001** `tests/update099.test.ts`: the newest tag and the cache (no network when fresh); both
  consoles' header and overview with and without a newer release; update rebases the owner's
  commit on top of GitHub's and undoes a conflict; update runs apply after an upgrade; no
  user-facing `git push` advice in the engine's sources; the HTTP warning; a real `ssh-keygen -Y
sign` through the helper and the console (answered, refused without the token, cancelled);
  records told from a person's edits, and update sending a record by itself; the ⚡ level (its mark
  from commons, its section, not a warning, exit 0).
