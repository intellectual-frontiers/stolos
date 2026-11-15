# 052: Problems that describe themselves

## Why

The lab showed what trips up someone new: a green summary with a failing exit code, warnings that
only mean "not set up yet", raw errors from other tools ("Host key verification failed",
"dpkg-query: fgets gave an empty string"), and failures swallowed without a word. The tool should
say what happened, why, and what to do, without anyone reading the documentation first.

## Requirements

- **FR-001** Four states, the same in the terminal, the boot window, telemetry, and the records: ✅
  ok, ⏳ not set up yet (pending), ⚠️ warning, ❌ failure. Pending is never a failure nor a warning;
  it is shown under "Not set up yet" with its next step.
- **FR-002** The summary and the exit code always agree: a run ends red with "N failures" exactly
  when it exits non-zero. A failing check is shown at its own level (a fail-level check as a
  failure), never as a warning that still counts as failed.
- **FR-003** A check that exits 3 means "not set up yet" (a relay or Cloudflare token not
  delivered): mail, notify, the server's certificate, and its DNS name wait for their token that
  way. Ready reports `passed/total checks · N not set up yet`.
- **FR-004** Problems carry stable codes (E for problems, P for pending), shown as
  `explain: archon explain <code>`. `archon explain` lists them; `archon explain <code>` gives what
  happened, the likely cause, the fix, and the guide. Every code the engine uses has an explanation
  (a test).
- **FR-005** Raw errors people meet often (ssh host keys and public keys, DNS, apt's lock, damaged
  dpkg state, the engine's integrity against `bun.lock`) are recognized and given their code and
  fix.
- **FR-006** No new silent catches: a test holds the count of `.catch(() => {})` at 60, so each one
  is a decision.

## Success criteria

- **SC-001** `tests/explain052.test.ts`.
- **SC-002** The engine's lab: Ready shows every check passed, with mail and web "not set up yet"
  (the e2e fleet has both, without tokens); `archon verify` after the reboot and on the workstation
  exits 0.
