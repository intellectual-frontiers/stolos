# 105: Calm output

Issue intellectual-frontiers/stolos (an adversarial user-acceptance review of a real `stolos update` log on the owner's Windows PC,
approved by the owner). Constitution Article 19 ("Calm Output") is the home of the contract.

## Why

`stolos update` printed about 40 lines of which 6 were useful. It repeated one failure (a mistyped signing passphrase) about six
times; printed green checks on phases that held a to-do; said "boot doctor: all well" beside a lightning mark; nested four full
command runs (own header, own "finished", own "next:", three log files) inside one `update`; printed the same raw EPERM warning three
times under "Needs attention"; pushed an unseen commit without showing what it was; ended with "next: bun run stolos (where you
are)"; called Stolos's own half-finished engine upgrade "3 change(s) of yours not sent yet"; printed "Install the engine v0.127.0"
after the lock had moved to v0.135.0; and its suggested fix would have looped.

Before (the log, shortened):

```text
🛰️  Stolos update  ·  alice-pc
✅ Pull             up to date; 1 commit(s) of yours not pushed yet (bun run stolos apply)
✅ Send             nothing sent
   ⚡ your 3 change(s) stay here, not sent; the engine upgrade waits for them
✅ Install          the engine v0.127.0, as bun.lock holds it
✅ Doctor           boot doctor: all well
== Needs attention ==============================
⚠️  doctor          EPERM: operation not permitted, unlink ...   (three times)
✨ update finished in 41s · log: C:\Users\alice\AppData\Local\stolos\log\20261117T0912-4411.log
   next: bun run stolos (where you are)
```

After (the same state, calm):

```text
🛰️  Stolos update  ·  lab
Signing 3 files: engine upgrade to v0.136.0
⚡ Back up your secrets: intrepid's probe key, olympia's deploy key, 6 more [E022-BACKUP]
   run: bun run stolos vault backup
👉 Remote access is not set up: bun run stolos docs remote-access
✨ Updated to v0.136.0 · 1 for you · 1 optional
next: bun run stolos vault backup
```

## Ontology

The terms this spec uses, defined in `ontology/stolos/` with this spec as their source: `stolos:OutputClass` (the code list
`stolos:output-report`, `stolos:output-action`), `stolos:Verbosity` (`stolos:verbosity-quiet`, `stolos:verbosity-calm`,
`stolos:verbosity-verbose`, `stolos:verbosity-json`) and `stolos:LineKind` (`stolos:line-step`, `stolos:line-problem`,
`stolos:line-yours`, `stolos:line-waiting`, `stolos:line-hint`, `stolos:line-outcome`); and, from earlier specs,
`stolos:OutcomeLevel` and `stolos:CommandTier`. `bun run gen` writes them as `OutputClass`, `OUTPUT_CLASSES`, `Verbosity`,
`VERBOSITIES`, `LineKind` and `LINE_KINDS` in `src/archon/ontology.auto.ts`; the registry and `Ui` import them.

## The classification

Every registry command declares `output` (`report` or `action`); a test fails for one with none. The rule applied, with its
exceptions:

- **report** (default verbose, exactly as before): every command of tier `read` (boot doctor, boot serve, boot status, boot observe,
  where, console, fleet status, host check, device check, estate/compliance/controls/risks/people/audit reports, keys, signers,
  vault status and list, docs, explain, guide, mesh, devices, discover, doctor, verify, version, log, and every long-running server:
  web serve, mcp, notify watch, the TUIs); `vault status` and `vault list` are tier `repo` but reports. The boot server's own
  commands (`stolos boot ...`, `src/archon-boot/`) are not registry commands: `boot doctor`, `boot serve`, `boot status` and
  `boot observe` are reports and keep their output; they answer `--quiet` and `--verbose` too.
- **action** (default calm): every command of tier `repo`, `mutate` or `destructive` (update, apply, fleet upgrade, fleet init,
  pair, host add, host adopt, host release, vault backup, vault restore, keys setup, signers add, devices approve, pg ensure, ...),
  and four commands of tier `read` that change local state or send data (`fleet use`, `clients add`, `clients remove`, `clients use`,
  `export run`, `fs s3 key`).

## Requirements

- **FR-001** (A) Every registry command declares `output: "report" | "action"` (the ontology's `stolos:OutputClass`). A report is
  meant to be read by a person as a whole and is verbose by default, every line shown as before; an action does something and is
  calm by default.
- **FR-002** (A) Global options on every command: `--verbose` / `-v` (every step, either class), `--quiet` / `-q` (one verdict line
  and the exit code, nothing else; the run log still has everything) and `--json` (unchanged). The verbosity of a run is the
  ontology's `stolos:Verbosity`: quiet, calm, verbose or json. There was no earlier `--quiet` or `-q` option to clash with.
- **FR-003** (B) Calm shows a green step line never (`--verbose` shows it). Always shown: failures and warnings, what is the
  person's to do, the outcome lines the person needs ("Sent: every server applies it within 15 minutes"), and progress while working
  (a spinner on a terminal, which leaves no residue in the scrollback after a prompt or at the end). These are the ontology's
  `stolos:LineKind`.
- **FR-004** (D) Marks are honest: a phase shows ✅ only if it recorded no failure, warning, your-move item or waiting item; a phase
  that holds only a ⚡ shows ⚡, one that holds a ⏳ shows ⏳ (commons palette marks). The closing verdict states counts
  (`✨ Up to date · 1 for you · 1 optional`, or `❌ <cause>`) and never says "all well", "done" or "finished". A contradictory
  line such as "✅ Pull up to date; 1 commit(s) of yours not pushed yet" is a ⚡.
- **FR-005** (C) One run, one header, one summary. A stolos run inside another (update calls apply, fleet upgrade, boot doctor, through
  the `stolos([...])` helper) is a phase of its parent: its process has `STOLOS_NESTED` set and prints no header, no closing summary,
  no `next:` line and opens no log of its own (it appends to the parent's, `ARCHON_LOG`); it hands its problems and your-move items
  to the parent through the `STOLOS_SUMMARY` file, now a JSON list of every problem, and the parent merges them into the phase.
- **FR-006** (E) The closing block is, in order: problems (❌ ⚠️), your move (⚡), not set up yet (⏳, only for what waits on time
  or on someone else), hints, the verdict line, then exactly one `next:` line: the command of the most important ⚡ (or, after a
  failure, the one command that fixes it), else none. "next: bun run stolos (where you are)" is gone.
- **FR-007** (F) A failure is printed once: not inline and in a section and by the parent and by the child. Its text says what
  happened to the person's data ("Nothing was sent. Your 3 files are safe.") and gives one command. A parent never re-reports a
  child's failure as more failures; the verdict names the root cause once. (bun's own trailing `error: script "stolos" exited
with code 1` cannot be removed from inside the engine; the `stolos` shortcut avoids it: wave 2.)
- **FR-008** (B) An optional feature that is merely off (remote access not set up) is a hint (the palette's `hint` mark, 👉), not a
  waiting item: shown at most once per 7 days for each hint id (kept in this PC's local state, `hints.json` beside the run logs,
  never in Git), always shown with `--verbose`, never with `--quiet`.
- **FR-009** (G) Raw system errors (EPERM, a git or ssh message) go to the run log; the screen shows a plain sentence with a stable
  code (`stolos explain <code>`); `--verbose` shows the raw text. Every failure, warning and your-move item carries a code. A
  limitation of Stolos itself that the operator cannot act on is logged and shown at most as a hint, never as a problem.
- **FR-010** (H) `stolos log [--last N] [--path]` (a report) prints the last run's log, or its path. A problem line no longer prints
  a long `log: C:\...` path (only `--verbose` does).
- **FR-011** (I) A `run:`, `next:` or `fix:` line holds only the command, on its own line; any instruction is another line.
- **FR-012** (J) Pushing is approval (Article 9): when `update` or `apply` sends commits or files Stolos did not write itself, it
  lists their subject lines (and the file list of uncommitted changes) before the passphrase prompt; Stolos-written records and
  engine upgrades are named for what they are (`fleet/records.ts`). One clear line says what is being signed ("Signing 3 files:
  engine upgrade to v0.136.0"); OpenSSH's own prompt is kept.
- **FR-013** (K) A signed commit that fails because the key could not be decrypted (incorrect passphrase) is retried in place, up
  to 3 times, saying "That passphrase didn't unlock your daily key (2 left)"; after the third it fails with the cause-first message
  of FR-007. The passphrase is never stored.
- **FR-014** (L) A resumable engine upgrade: `fleet upgrade` that fails at signing leaves `package.json`, `bun.lock` and the
  workflow file changed. `stolos update` and `stolos apply` recognize "an engine upgrade waiting for its signature" (the pin differs
  from HEAD's and only those files changed), say so, and finish it with the automatic message `stolos: adopt the engine
stolos-vX.Y.Z`, then send it. It is never called "your changes", in the doctor either.
- **FR-015** (M) After the engine changes during `update`, the remaining steps run on the new engine (a fresh nested process), so what
  is reported is what runs; the Install line never reports the old version.
- **FR-016** (N) After an engine upgrade, "What's new": up to 5 bullets from the engine repository's commit subjects between the old
  and new tag (the public compare API, unauthenticated, failure ignored silently), spec-prefix noise stripped but the id kept,
  deduplicated; every commit-body line beginning `Operator action:` is a ⚡ item. The convention is in `AGENTS.md`.
- **FR-017** (O) The secrets reminder is grouped by machine in words ("intrepid's probe key, olympia's deploy key, 6 more"), in one
  place only (the ⚡ item; no second "a secret changed" line), with the command on its own line.
- **FR-018** (P) Golden user-acceptance tests (`tests/calm105.test.ts`) run the real `update`, `apply` and a report (`boot doctor`)
  in sandbox fleets with real temporary Git repositories and assert the default output in each state, with invariants (no ✅ step in
  calm output; no "all well", "done" or "finished" beside a ⚡; one failure once; one header; every command classed; every problem
  coded).
- **FR-019** (Q) The ontology defines `OutputClass`, `Verbosity` and `LineKind` as code lists citing this spec, generated into
  `src/archon/ontology.auto.ts`; the registry and `Ui` import them.
- **FR-020** (R) Constitution Article 19 states the contract (version 6.2.0).
