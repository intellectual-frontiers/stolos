# 062: Bootstrap a controller PC in one line

## Why

A new controller PC (the PC you run `stolos` on) needed a page of steps before the first `stolos`
command: install Deno, Git and gh, sign in to GitHub, clone the fleet repository into a folder
chosen by hand (`C:\fleet` on Windows only), add the shortcut. The same steps come back after a
disaster (spec 061), on the worst day to get one wrong. One line should do it, the same way on
Windows, macOS and Linux, and be safe to run again.

## Requirements

- **FR-001** The engine carries `bin/bootstrap-example.sh` (Linux and macOS, told apart with
  `uname`) and `bin/bootstrap-example.windows.ps1`, written as explainers: each step says what it
  does and why. In order, each checking first and skipping what is done: Deno at least the engine's
  `MIN_DENO` (Deno's official installer, into the user's folder); Git; gh (Ubuntu's own package
  first, then GitHub's); the GitHub sign-in (`gh auth login --web`) and `gh auth setup-git`; the
  fleet; the shortcut.
- **FR-002** The fleet goes into `--in`, by default `$HOME/fleet` on every system. Not there (or
  empty): cloned. A checkout of the same repository: `deno task stolos update`. Anything else: never
  touched, with the fix.
- **FR-003** `--destroy-existing` removes the folder and clones it fresh, only when it is a checkout
  of the same repository (never `$HOME` or a drive root). Edits, commits not on GitHub, and stashes
  are listed first, and the folder's name must be typed to go ahead; with no terminal to type in,
  nothing is removed.
- **FR-004** The shortcut (`stolos ...` for `deno task stolos ...`) is added by default, once:
  `~/.bashrc` and `~/.zshrc`; on Windows both PowerShell editions' profiles, with the user's own
  execution policy set to RemoteSigned when profiles could not run. `--no-shortcut` skips it.
- **FR-005** The same options on every system: `--repo`, `--in`, `--destroy-existing`,
  `--no-shortcut`, `--dry-run` (says each step; changes nothing), `--help`; PowerShell-style
  (`-Repo`, `-DryRun`) works too. The one-line Windows form runs in the user's session, so a failure
  stops the script, never the window.
- **FR-006** A repository that is not on GitHub (a URL, a path) is cloned as given, without gh.
- **FR-007** `fleet init` writes `bin/bootstrap.sh` and `bin/bootstrap.windows.ps1` into the fleet
  with its GitHub owner/name filled in (from `origin`), and `.gitattributes` keeping `*.sh` LF;
  `fleet upgrade` refreshes them in its signed commit (`bootstrap.sh` executable).
- **FR-008** READMEs, the disaster recovery guide, `RESTORE.txt`, and every message: the one line
  first; `$HOME/fleet`, not `C:\fleet`.

## Success criteria

- **SC-001** `tests/bootstrap062_test.ts`: the template's Deno minimum equals `MIN_DENO`; a fleet's
  copy has its repository; shellcheck is clean; the PowerShell script parses (where pwsh is); on
  Linux, for real in a throwaway home with no terminal: a clone, the shortcut once, `--dry-run`
  changes nothing, a second run updates, another folder is never touched, `--destroy-existing`
  clones fresh, and work only there is listed and kept.
- **SC-002** CI runs `tests/bootstrap/windows-check.ps1` on Windows, in PowerShell 7 and Windows
  PowerShell 5.1: the same checks, and the one-line form leaves the session running after a failure.
  A release is tagged only when it passes.
