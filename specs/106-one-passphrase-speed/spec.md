# 106: One passphrase per command, and a quick one

Wave 2, part 1 of spec 105-calm-output (L001 and L002 of its tasks): the two things the adversarial review of a real `stolos update`
on the owner's Windows PC found that calm output did not touch. The update took 41 seconds; the signing passphrase was typed once
for each signed commit (a send, then an engine upgrade, then more); every step was its own process (a header, a log, a model load,
a `git fetch` each); and the firewall check read every rule of Windows Defender through PowerShell, twice.

Before (an update that sends a record and upgrades the engine, as the owner saw it):

```text
Enter passphrase for "C:\Users\alice\.ssh\fleet-signing":        <- the record, 1st
Enter passphrase for "C:\Users\alice\.ssh\fleet-signing":        <- the engine upgrade, 2nd
update finished in 41s
```

After:

```text
Enter your daily key's passphrase (kept in memory until this command ends):    <- once
Signing 1 file: olympia's registration (from its install)
Signing 6 files: engine upgrade to v0.137.0
Sent: every server applies it within 15 minutes
Updated to v0.137.0
```

## Ontology

The terms this spec uses, defined in `ontology/stolos/` with this spec as their source: `stolos:PassphraseSession`,
`stolos:SigningOutcome` (the code list `stolos:signing-unlocked`, `stolos:signing-refused`, `stolos:signing-failed`),
`stolos:ProbeCache` and `stolos:PhaseTiming`; and, from spec 105, `stolos:Verbosity`. `bun run gen` writes the code list as
`SigningOutcome` and `SIGNING_OUTCOMES` in `src/archon/ontology.auto.ts`; the passphrase session imports them.

## Requirements

### One passphrase

- **FR-001** (L001) A command that signs asks for the daily key's passphrase at most once per key, however many commits it signs
  (a send, an engine upgrade, a record) and however it runs them: in its own process, in a run nested in it in process, or in a
  child process started by it (`fleet upgrade`, the publish and the rest after an upgrade). `update`, `apply`, `fleet upgrade`,
  `people` and `risk` commands that sign, and a command the Stolos Console launches, all do. A command that signs nothing asks
  nothing.
- **FR-002** The passphrase lives only in the memory of the command's process, as bytes, from the first time it is asked to the end
  of the command, and is zeroed then (success, failure, or the process exiting). It reaches a signing tool only through a per-run
  askpass helper (`SSH_ASKPASS`, `SSH_ASKPASS_REQUIRE=force`; a `.cmd` file on Windows) that asks the command over 127.0.0.1, on a
  port chosen by the system, with a token made for this run. It is never in an environment variable, a file, a log, a command's
  arguments, telemetry, a report or an MCP tool, and Stolos never keeps or sees it beyond that lifetime. The token is not the
  passphrase: it only lets a process of the same user, started by the command, ask for it, and it dies with the command. A
  child process (a nested run that needs a new engine) inherits the helper and the token and asks the same command: one place
  holds the passphrase. The helper's own files hold no secret and are removed at the end. Nothing waits for the helper or the
  person for ever: the person has five minutes, an askpass program the environment names is stopped at that limit, and the end of
  the command does not wait on the broker's own close. **On Windows the broker is not used** (v0.139.0): the first release with it
  made every signing command time out on Windows CI (see the tasks), so Windows keeps spec 105's way, OpenSSH's own askpass or
  terminal for each signing, and a command that signs twice asks twice, until the broker has had a real Windows test. Every other
  system keeps the broker.
- **FR-003** A wrong passphrase is retried in place, three tries in all, saying "That passphrase didn't unlock your daily key (2
  left)" (spec 105-calm-output FR-013, unchanged). What was typed is kept for the rest of the command only after it unlocked the
  key (`stolos:signing-unlocked`); a passphrase the key refused (`stolos:signing-refused`) is thrown away, and one kept before is
  not replaced by it; a failure for another reason (`stolos:signing-failed`) throws away what was typed for that attempt. After
  the third refusal nothing is kept and the command fails as spec 105 FR-007 says.
- **FR-004** Where the passphrase is asked, once: at the terminal, by Stolos itself, with no echo (`Ctrl+C` cancels); else through
  the askpass helper the environment already names (the Stolos Console asks on its page, spec 099-engine-update FR-005; a test
  or a desktop's askpass); else nowhere, and signing fails with the cause. A terminal's prompt is Stolos's, so it says what is
  being signed first (spec 105 FR-012).
- **FR-005** The `keys` commands are unchanged: OpenSSH asks for the passphrase on the terminal itself, Stolos never sees it, and no
  `keys` command is offered over MCP. No command run for an MCP client gets the helper.

### A quick one

- **FR-006** (L002) A run nested in another (spec 105-calm-output FR-005) runs in the same process wherever the engine did not
  change: the send before an engine upgrade, the resumed upgrade's send, the keys step and the boot doctor. It is a phase of the
  parent exactly as before (no header, no summary, its problems and outcomes merged once). A child process is started only where
  a new engine process is required after the pin moved: `fleet upgrade` (it installs the new engine and validates the fleet with
  it), the publish of the upgrade, and the rest of the update on the new engine. The log says for each nested run whether it ran in
  process or as a child.
- **FR-007** `update`, `apply` and `fleet status` with nothing to do finish in under 3 seconds on a warm checkout (the fleet
  repository cloned, its engine installed, GitHub reachable) on an ordinary PC. A test fails where a no-op `update` against a
  sandbox fleet takes more than a bound that is generous (a CI machine, Windows, other tests running at once) and says why; a
  second test fails where it starts any child process.
- **FR-008** The firewall check (read-only, spec 004-install) is kept in `probe-cache.json` in the program's state folder for five
  minutes, for the same needs on the same system, so the next run does not ask the system again: it holds the warnings, never the
  rules. It never makes a run wrong for more than those five minutes after a rule changed. It is not used, and not written, by a
  report (verbose by default: `boot doctor`, `boot serve`), by `--verbose`, or by `--fresh` (a global option on every command: do not
  use what an earlier run remembered), and a check that could not be completed is not kept. Within one run the system is asked at
  most once (the console's check and the boot server's share it), and the check runs while the doctor's other checks do. Reading
  the firewall has a hard limit of 20 seconds, on every system: past it the check stops its programs, does not wait for them,
  says as one warning that the firewall could not be checked and how to look by hand (and `--fresh`), is not kept, and the command
  neither fails nor waits any longer. A bind that an account may not do on a port below 1024 (`EACCES`) is no failure of the
  doctor's port check: it is a warning that the port could not be checked.
- **FR-009** One run asks Git and the model once where it can: `git fetch origin` is done once per run (the update's, the send's and
  the doctor's share it), and the fleet's `fleet.ts` and signers are read once per run until a file of them changes.
- **FR-010** Every phase writes a timing line to the run log, never to the screen (`TIME <phase> <milliseconds>ms`), and a run ends with
  `TIME total <milliseconds>ms`, so that `stolos log` finds what is slow.

### Documents

- **FR-011** The documents say what is true now: spec 057-keys FR-007 says the passphrase is typed into OpenSSH by the `keys`
  commands and held in memory only by the commands that sign (this spec), the modules' guides say it, and spec 105's wave 2 marks
  L001 and L002 built.

## Success criteria

- **SC-001** `tests/passphrase106.test.ts`: the session's memory, retry and wipe as units; the helper and the broker over loopback
  with a token; a real `ssh-keygen` asking a counting askpass once for an `update` that signs two commits and runs a child.
- **SC-002** `tests/speed106.test.ts`: a no-op `update` inside its bound with no child process; the probe cache's hits, misses,
  expiry, bypasses and its refusal to keep an incomplete check; the once-per-run fetch; the timing lines.
