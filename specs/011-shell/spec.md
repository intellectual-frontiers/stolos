# Feature Specification: Shell environment

**Feature Branch**: `011-shell` (committed directly to main) **Created**: 2026-11-10 **Status**:
Implemented **Input**: Persona-driven dotfiles through chezmoi: fish with oh-my-posh (the Archon
status segment), tmux, git identity, Claude Code settings (workstations only, spec 030).

## Requirements _(mandatory)_

- **FR-001**: `archon apply` renders `~/.config/chezmoi/chezmoi.json` per user from personas, so
  `chezmoi apply` never prompts.
- **FR-002**: The fleet's dotfiles live in `home/`, the most general layer of each user's chezmoi
  source (spec 031).
- **FR-003**: Login shells stay bash; developer and operator personas start fish interactively (with
  `SHELL=/usr/bin/fish`, so tmux and editors open fish); the prompt shows the last archon result
  from `/var/lib/archon/status/prompt`.
- **FR-004**: git identity comes from the model (name and noreply address); GitHub access is ops'
  deploy key over SSH.
- **FR-005**: The prompt names the machine: the left block's first segment shows the distro icon and
  the short host name (`{{.Icon}} {{ .HostName }}`; on alpha, `╭─ <ubuntu icon> alpha  ~/...`).
- **FR-006**: The terminal title is `<shell> in <user>@<host>` with the short host name, for example
  `fish in alice@alpha`, and nothing overrides it: oh-my-posh's `console_title_template` is
  `{{ .Shell }} in {{ .UserName }}@{{ .HostName }}`; fish's `fish_title` prints the same
  (`fish in $USER@(prompt_hostname)`, defined before oh-my-posh initializes); bash sets it from
  `PROMPT_COMMAND` (`bash in $USER@${HOSTNAME%%.*}`); tmux has `set-titles on` with
  `#{pane_current_command} in #(whoami)@#h`. Archon manages no PowerShell profile;
  docs/boot-machine.md shows the snippet for the boot machine.
- **FR-007**: The Archon status segment turns amber for `🔐 backup` (spec 029) as for warnings.

### Overrides of Ubuntu defaults

None (bash stays the login shell).
