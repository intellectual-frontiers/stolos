# dotfiles/: host and user layers (spec 031)

More specific layers on top of `home/` (the fleet layer). Each `home/` below is a chezmoi source
directory; a later layer replaces a file with the same target.

```
dotfiles/hosts/<host>/home/                 everyone on one host
dotfiles/users/<user>/home/                 one user on every host
dotfiles/hosts/<host>/users/<user>/home/    one user on one host
```

`archon dotfiles` shows where each file comes from; `man archon-dotfiles` (or `docs/dotfiles.md`)
explains everything.
