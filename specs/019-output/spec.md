# Feature Specification: Operator output

**Feature Branch**: `019-output` (committed directly to main) **Created**: 2026-11-10 **Status**:
Implemented **Input**: Calm output for every operation (Article 19).

## Requirements _(mandatory)_

- **FR-001**: One line per phase with a mark and a result; progress while working; every problem
  with a fix and its run-log line, collected again under "Needs attention".
- **FR-002**: Run logs in `/var/log/archon/` (root) or `~/.local/state/archon/log/` (users), kept 30
  days.
- **FR-003**: `-v` for every item, `--json` for machine-readable output, `ARCHON_PLAIN=1` for ASCII
  marks, `NO_COLOR=1` for no color.
- **FR-004**: Emoji and color wherever the terminal can show them: a UTF-8 locale (Linux), or on
  Windows, which sets no locale, Windows Terminal (`WT_SESSION`), VS Code and others
  (`TERM_PROGRAM`), and ConEmu; macOS terminals (`TERM_PROGRAM`). `ARCHON_PLAIN=1` turns emoji off,
  `ARCHON_EMOJI=1` on; `NO_COLOR` turns color off, `FORCE_COLOR` on without a terminal. The header
  is the title in bold cyan with a dim rule; phase names are bold.
- **FR-005**: The boot server's window (`bun run stolos boot serve`): each event on one line with an
  icon for what happened (🥾 boot files, 🐧 kernel and initrd, 🧭 GRUB menu, 🎯 armed, 💿 installer
  image, 🔑 install config, 📦 installer step, 🏁 install finished, 🔐 host keys trusted, 🚀 first boot,
  ✅ a step, ⚠️ a warning, ❌ a failure, 🎉 Ready, 👉 next steps), the time (24-hour) and address
  dimmed, the host in its own highlighted column, success green, problems amber or red. GRUB's and
  the shim's probing for files they do without (`revocations.efi`, `grub/x86_64-efi/*.lst`) is kept
  out of the window (it stays in `boot.log`; `ARCHON_VERBOSE=1` shows it), and a line repeated
  within 3 seconds is shown once. `boot.log` keeps every line, plain. Its telemetry starts
  in-process (spec 023), with no settings on the command line, so the command `bun run stolos boot`
  echoes is short.
