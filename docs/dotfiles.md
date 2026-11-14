# Dotfiles: how they work and how to change them

Every account's dotfiles (bash, fish, the prompt, tmux, git, and on workstations Claude Code's
settings) are managed by chezmoi from the fleet repository. Nothing in your home directory is edited
by hand on purpose: archon applies the repository's version at every converge.

## Shell features: one line

Archon's shell features (the modern `ls`, `ll`, `la`, and `tree` from eza; `cat` from bat; `fd`;
fzf's keys: Ctrl+R history, Ctrl+T files, Alt+C folders; zoxide's `z`; delta for git diffs; the
terminal title; and the prompt) come from one line in your shell's startup file:

| Shell | Line                               | In                           |
| ----- | ---------------------------------- | ---------------------------- |
| bash  | `eval "$(archon shell emit bash)"` | `~/.bashrc`                  |
| zsh   | `eval "$(archon shell emit zsh)"`  | `~/.zshrc`                   |
| fish  | `archon shell emit fish \| source` | `~/.config/fish/config.fish` |

The fleet's dotfiles include the line for bash and fish, for everyone. A layer of your own that
leaves it out gets none of these features: the shell keeps its own defaults. `archon shell status`
says which of your shells have it. The originals are always one step away: `command ls`,
`command cat` (bash also takes `\ls`).

The prompt is plain, without icons, on a console terminal (the server's own screen or a serial
line), and colorful everywhere else. The colorful prompt needs a Nerd Font on the computer you
connect from; if you see boxes, install one there, or choose the plain prompt with
`set -Ux ARCHON_PROMPT plain` (fish) or `export ARCHON_PROMPT=plain` in `~/.bashrc.local` (bash).
`ARCHON_PROMPT=pretty` asks for the colorful one even on a console.

## Layers

Your chezmoi source is composed from up to five layers, most general first. A later layer replaces a
file with the same target in your home directory. The first comes with the engine (its `home/`
folder, carried inside the engine); the others are folders of your fleet repository, under the
fleet's own folder.

| Layer                                         | Applies to                                  |
| --------------------------------------------- | ------------------------------------------- |
| the engine's `home/`                          | everyone in every fleet (the engine's base) |
| `fleets/<id>/home/`                           | everyone on every host of this fleet        |
| `fleets/<id>/hosts/<host>/home/`              | everyone on one host                        |
| `fleets/<id>/users/<user>/home/`              | one user on every host                      |
| `fleets/<id>/hosts/<host>/users/<user>/home/` | one user on one host                        |

To change a file the engine provides, do not change the engine: copy it into `fleets/<id>/home/`
(everyone in your fleet) or a more specific layer, and edit the copy.

Each layer is an ordinary chezmoi source directory: `dot_bashrc` is `~/.bashrc`,
`dot_config/fish/config.fish.tmpl` is a template for `~/.config/fish/config.fish`, and `private_`,
`executable_`, and the other chezmoi attributes work as usual. `dot_bashrc` and `dot_bashrc.tmpl`
have the same target, so either one in a more specific layer replaces the other. The
`.chezmoiignore` and `.chezmoiremove` of every layer are combined, in layer order.

Templates get the same data everywhere: `.archon.host`, `.archon.user`, `.archon.fullName`,
`.archon.email`, `.archon.personas`, `.archon.features` (fish, ohMyPosh, tmux, devTools,
archonCompletions), and `.archon.workstation`.

## How it is applied

1. `archon apply` (and so `archon update` and the reconcile timer) composes your layers into
   `/var/lib/archon-dotfiles/<you>`, owned by root and readable by you.
2. `~/.config/chezmoi/chezmoi.json` points chezmoi at that directory and holds your template data.
3. `chezmoi verify` decides whether anything differs; if so, `chezmoi apply --force` brings your
   home directory to the composed state.

## Day to day

```sh
archon dotfiles                    # every managed file and the layer it comes from
archon dotfiles ~/.bashrc          # the one repository file that provides ~/.bashrc
chezmoi diff                       # what the next converge would change in your home
chezmoi apply                      # apply the composed source now, without waiting
```

## Changing a dotfile

1. Run `archon dotfiles <file>` to find the repository file that provides it.
2. To change it for everyone, edit it there. To change it for one host or one person, copy it into
   the more specific layer (for example
   `fleets/<id>/users/<you>/home/dot_config/fish/config.fish.tmpl`) and edit the copy.
3. Commit with the spec ID (for example `031-dotfile-layers: fish abbreviations for <you>`) and push
   to `main`.
4. `archon update` on the host, or wait for the reconcile timer (15 minutes).

Run `deno task stolos build` before pushing: it checks every layer.

## This machine only

Tweaks that belong to one machine and no repository go in files archon never manages:
`~/.bashrc.local` (read by bash) and `~/.config/fish/local.fish` (read by fish). Any other file
chezmoi does not manage is yours too; `archon dotfiles <file>` says so.

## What not to do

- `chezmoi add`, `chezmoi edit`, `chezmoi re-add`, `chezmoi forget`: they write to the source, which
  is composed by archon (and not writable by you). Change the repository instead.
- `chezmoi init` or `chezmoi update`: they would point chezmoi at another source or pull a different
  repository.
- Editing a managed file in place: the next converge puts the repository's version back.

## What a layer may not contain

`stolos build` rejects these:

- scripts (`run_` files, `.chezmoiscripts/`): anything that must run belongs in the model
- secrets (`encrypted_` files, `.age` or `.asc` files): secrets never go in the repository
  (Article 13)
- externals (`.chezmoiexternal.*`): downloads without a pinned checksum (Article 12)
- `.chezmoiroot`
- two files with the same target in one layer
- a layer for a host or user that is not in the model

## Files

| Path                               | What                                                                     |
| ---------------------------------- | ------------------------------------------------------------------------ |
| `/srv/archon/home/`                | the fleet layer                                                          |
| `/srv/archon/dotfiles/`            | host, user, and host-user layers                                         |
| `/var/lib/archon-dotfiles/<user>/` | your composed chezmoi source (written by archon apply)                   |
| `~/.config/chezmoi/chezmoi.json`   | chezmoi's configuration and your template data (written by archon apply) |

See also archon(1), archon-dotfiles(1), archon-personas(7), chezmoi(1).
