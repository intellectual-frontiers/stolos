# Feature Specification: Dotfile layers

**Feature Branch**: `031-dotfile-layers` (committed directly to main) **Created**: 2026-11-12
**Status**: Implemented **Input**: The repository keeps managing the fleet's dotfiles with chezmoi,
and also holds per-host and per-user dotfiles in the same monorepo. Every user's message of the day
reminds them how to use chezmoi here, with a local man page that explains everything.

## User Scenarios & Testing _(mandatory)_

1. **Given** `home/` and `dotfiles/users/alice/home/dot_bashrc`, **When** `archon apply` runs on
   alpha, **Then** alice's `~/.bashrc` comes from the user layer and every other file from `home/`.
2. **Given** `dotfiles/hosts/alpha/home/` and `dotfiles/hosts/alpha/users/alice/home/`, **When**
   apply runs on alpha, **Then** they apply on alpha only, the host-user layer last; on another host
   they do not apply.
3. **Given** a layer with a `run_` script, an `encrypted_` file, an external, a `.chezmoiroot`, two
   files with one target, or a directory for a host or user not in the model, **When**
   `archon build` runs, **Then** it fails and names the file.
4. **Given** a user logs in, **When** the banner shows, **Then** it says how to find where a file
   comes from (`archon dotfiles`), preview (`chezmoi diff`), change it (the repo), keep machine-only
   tweaks (`~/.bashrc.local`, `~/.config/fish/local.fish`), what not to run, and
   `man archon-dotfiles`.
5. **Given** a user runs `chezmoi add` or `chezmoi edit`, **When** chezmoi tries to write the
   source, **Then** it cannot (the composed source is root's).

## Requirements _(mandatory)_

- **FR-001**: Layers, most general first: `home/`, `dotfiles/hosts/<host>/home/`,
  `dotfiles/users/<user>/home/`, `dotfiles/hosts/<host>/users/<user>/home/`. Each is a chezmoi
  source directory.
- **FR-002**: A later layer replaces a file with the same target (chezmoi attribute prefixes and
  `.tmpl`/`.literal` suffixes do not change the target). A target directory keeps the source name of
  the most general layer that has it. Root `.chezmoiignore` and `.chezmoiremove` files are
  concatenated in layer order. `README.md` at a layer's root is documentation.
- **FR-003**: Forbidden in every layer: `run_` files and `.chezmoiscripts/` (code belongs in the
  model), `encrypted_`, `.age`, `.asc` (Article 13), `.chezmoiexternal.*` (Article 12),
  `.chezmoiroot`.
- **FR-004**: `archon apply` composes each user's source into `/var/lib/archon-dotfiles/<user>`
  (root:<user's group>, directories 0750, files 0640; the parent 0755), removes files no layer
  provides, then runs `chezmoi verify` and, when it differs, `chezmoi apply --force` as the user.
  `~/.config/chezmoi/chezmoi.json` points `sourceDir` there and carries the template data
  (`.archon.host`, `.archon.user`, `.archon.personas`, `.archon.features`, `.archon.workstation`,
  ...).
- **FR-005**: `archon build` validates every layer for every user on every host (FR-003, one target
  per layer) and that each layer directory names a host and a user in the model.
- **FR-006**: `archon dotfiles [path] [--user <u>]` (read) lists the layers and, for each managed
  file or the one given, the layer and repository file that provide it; an unmanaged file is
  reported as the user's own.
- **FR-007**: The login banner (`/etc/update-motd.d/71-archon-dotfiles`) gives the reminder in
  scenario 4, with emoji and color in the style of archon's own output (Article 19); Archon's own
  banner line (`70-archon`) uses the same style: the server, its HTTPS welcome page and Cockpit, how
  to observe and verify it.
- **FR-008**: `man archon-dotfiles` (section 7) explains layers, application, day-to-day commands,
  changing a file, machine-only files, what not to do, and what a layer may not contain. It is
  rendered from `docs/dotfiles.md`, the single source for both.
- **FR-009**: bash reads `~/.bashrc.local` and fish `~/.config/fish/local.fish` when present; archon
  never manages them.
- **FR-010**: `archon verify` warns, per user, when a home directory differs from its composed
  dotfiles (`chezmoi verify`).

### Overrides of Ubuntu defaults

None.
