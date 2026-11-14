#!/usr/bin/env bash
# Stolos bootstrap for Linux and macOS (spec 062).
#
# Makes this computer a Stolos controller: the PC you manage a fleet from. In
# order, each step checking first and doing nothing when it is already done
# (so running it again is always safe):
#
#   1. Deno, at least the engine's minimum version (Deno's official installer).
#   2. Git (Linux: apt or dnf; macOS: Homebrew, or Apple's command line tools).
#   3. gh, GitHub's command line (Ubuntu's own package first, then GitHub's).
#   4. Your GitHub sign-in (gh auth login, in the browser), and Git told to use
#      it (gh auth setup-git): no SSH key or token to make by hand.
#   5. The fleet repository: cloned into --in (default ~/fleet) when it is not
#      there; brought up to date (deno task stolos update) when it is.
#   6. A shortcut: `stolos ...` for `deno task stolos ...`, in ~/.bashrc and
#      ~/.zshrc (skip it with --no-shortcut).
#
# This is the engine's example. A fleet repository carries its own copy as
# bin/bootstrap.sh, written by `deno task stolos fleet init` and refreshed by
# `deno task stolos fleet upgrade`, with the fleet's repository filled in below
# (DEFAULT_REPO). Both are the same script: this one needs --repo.
#
# Run it (bash, not sh; the <(...) form keeps your terminal for the prompts):
#
#   bash <(curl -fsSL https://raw.githubusercontent.com/intellectual-frontiers/stolos/<tag>/bin/bootstrap-example.sh) --repo <owner>/<fleet-repo>
#
# Options:
#   --repo <owner/name>   the fleet repository on GitHub (or a Git URL or path)
#   --in <folder>         where the fleet goes (default: ~/fleet)
#   --destroy-existing    remove that folder first, then clone it fresh (it
#                         must be a checkout of the same repository; work not on
#                         GitHub yet is listed and needs the folder's name typed)
#   --no-shortcut         do not add the `stolos` shortcut
#   --dry-run             say what each step would do; change nothing
#   --help                this text
#
# It needs sudo only to install Git or gh, and only when they are missing.

set -euo pipefail

# The fleet's repository: empty in the engine's example (then --repo is required).
DEFAULT_REPO=""
# The engine's minimum Deno (src/archon/update/operator.ts MIN_DENO); the engine's tests keep them equal.
DENO_MIN="2.9.6"

repo="$DEFAULT_REPO"
in="$HOME/fleet"
destroy=0
dry=0
shortcut=1

usage() {
  cat <<EOF
Stolos bootstrap: Deno, Git, gh, your GitHub sign-in, and the fleet in one folder.

  bash bootstrap.sh [--repo <owner/name>] [--in <folder>] [--destroy-existing]
                    [--no-shortcut] [--dry-run]

  --repo <owner/name>   the fleet repository${DEFAULT_REPO:+ (default: $DEFAULT_REPO)}
  --in <folder>         where it goes (default: ~/fleet); already there: stolos update
  --destroy-existing    remove that folder first, then clone it fresh
  --no-shortcut         do not add the stolos shortcut to ~/.bashrc and ~/.zshrc
  --dry-run             say what each step would do; change nothing
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
  --repo) repo="${2:?--repo needs <owner>/<name>}"; shift 2 ;;
  --repo=*) repo="${1#*=}"; shift ;;
  --in) in="${2:?--in needs a folder}"; shift 2 ;;
  --in=*) in="${1#*=}"; shift ;;
  --destroy-existing) destroy=1; shift ;;
  --no-shortcut) shortcut=0; shift ;;
  --dry-run) dry=1; shift ;;
  -h | --help) usage; exit 0 ;;
  *) echo "unknown option: $1 (see --help)" >&2; exit 2 ;;
  esac
done

# ---------------------------------------------------------------- output

ok() { printf '[ok] %-16s %s\n' "$1" "$2"; }
todo() { printf '[..] %-16s %s\n' "$1" "$2"; }
fail() {
  printf '[FAIL] %-14s %s\n' "$1" "$2" >&2
  [ -n "${3:-}" ] && printf '       %-14s fix: %s\n' "" "$3" >&2
  exit 1
}
# Run a command, or (--dry-run) only say it.
act() {
  if [ "$dry" = 1 ]; then printf '       would run: %s\n' "$*"; else "$@"; fi
}

[ -n "$repo" ] || fail "Repository" "which fleet repository?" "add --repo <owner>/<name>"

case "$(uname -s)" in
Linux) os=linux ;;
Darwin) os=macos ;;
*) fail "System" "$(uname -s) is not Linux or macOS" "on Windows: bootstrap.windows.ps1" ;;
esac
SUDO=""
[ "$(id -u)" -eq 0 ] || SUDO="sudo"

# A GitHub repository is owner/name; anything else (a URL, a path) is cloned as given, without gh.
github=0
case "$repo" in
*://* | /* | ./* | ../* | *@*:*) url="$repo" ;;
*/*) github=1; url="https://github.com/$repo.git" ;;
*) fail "Repository" "$repo is not <owner>/<name>" "for example --repo example/fleet" ;;
esac

echo "==> Stolos bootstrap: $repo into $in ($os)"

# Install packages with the system's package manager (Linux).
pkg_install() {
  if command -v apt-get >/dev/null 2>&1; then
    act $SUDO apt-get update -qq
    act $SUDO apt-get install -y "$@"
  elif command -v dnf >/dev/null 2>&1; then
    act $SUDO dnf install -y "$@"
  else
    fail "Packages" "no apt-get or dnf here to install $*" "install $* yourself, then run this again"
  fi
}

# Whether version $1 is at least $2 (dotted numbers).
at_least() {
  local IFS=. i a b
  read -r -a a <<<"$1"
  read -r -a b <<<"$2"
  for i in 0 1 2; do
    [ "${a[i]:-0}" -gt "${b[i]:-0}" ] && return 0
    [ "${a[i]:-0}" -lt "${b[i]:-0}" ] && return 1
  done
  return 0
}

# ---------------------------------------------------------------- 1. Deno

export PATH="$HOME/.deno/bin:$PATH"
have=""
command -v deno >/dev/null 2>&1 && have="$(deno --version | head -1 | awk '{print $2}')"
if [ -z "$have" ]; then
  todo "Deno" "installing $DENO_MIN (Deno's official installer, into ~/.deno)"
  if [ "$os" = linux ] && ! command -v unzip >/dev/null 2>&1; then pkg_install unzip; fi
  if [ "$dry" = 1 ]; then
    act sh -c "curl -fsSL https://deno.land/install.sh | sh -s -- -y v$DENO_MIN"
  else
    curl -fsSL https://deno.land/install.sh | sh -s -- -y "v$DENO_MIN"
    ok "Deno" "$(deno --version | head -1)"
  fi
elif ! at_least "$have" "$DENO_MIN"; then
  todo "Deno" "$have is older than $DENO_MIN: upgrading"
  act deno upgrade --version "$DENO_MIN"
else
  ok "Deno" "$have (at least $DENO_MIN)"
fi

# ---------------------------------------------------------------- 2. Git

if command -v git >/dev/null 2>&1; then
  ok "Git" "$(git --version)"
elif [ "$os" = linux ]; then
  todo "Git" "installing"
  pkg_install git
elif command -v brew >/dev/null 2>&1; then
  todo "Git" "installing (Homebrew)"
  act brew install git
else
  act xcode-select --install
  fail "Git" "Apple's command line tools are installing (a window opened)" "when they finish, run this again"
fi

# ---------------------------------------------------------------- 3 and 4. gh, and the sign-in

if [ "$github" = 1 ]; then
  if command -v gh >/dev/null 2>&1; then
    ok "gh" "$(gh --version | head -1)"
  elif [ "$os" = linux ]; then
    todo "gh" "installing"
    if command -v apt-get >/dev/null 2>&1 && apt-cache show gh >/dev/null 2>&1; then
      pkg_install gh # Ubuntu's own package (universe): Ubuntu decides
    elif command -v apt-get >/dev/null 2>&1; then
      # GitHub's own apt repository, as cli.github.com documents it.
      act $SUDO mkdir -p -m 755 /etc/apt/keyrings
      act sh -c "curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | $SUDO tee /etc/apt/keyrings/githubcli-archive-keyring.gpg >/dev/null"
      act sh -c "echo 'deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main' | $SUDO tee /etc/apt/sources.list.d/github-cli.list >/dev/null"
      pkg_install gh
    else
      pkg_install gh
    fi
  elif command -v brew >/dev/null 2>&1; then
    todo "gh" "installing (Homebrew)"
    act brew install gh
  else
    # GitHub's signed installer package for macOS, from its latest release.
    todo "gh" "installing (GitHub's package for macOS)"
    v="$(curl -fsSL https://api.github.com/repos/cli/cli/releases/latest | sed -n 's/.*"tag_name": *"v\([^"]*\)".*/\1/p' | head -1)"
    [ -n "$v" ] || fail "gh" "could not find gh's latest release" "install it from https://cli.github.com, then run this again"
    act curl -fsSL -o "/tmp/gh_$v.pkg" "https://github.com/cli/cli/releases/download/v$v/gh_${v}_macOS_universal.pkg"
    act sudo installer -pkg "/tmp/gh_$v.pkg" -target /
  fi

  if [ "$dry" = 0 ] && ! command -v gh >/dev/null 2>&1; then
    fail "gh" "gh is still not on PATH" "open a new terminal, then run this again"
  fi
  if command -v gh >/dev/null 2>&1 && gh auth status --hostname github.com >/dev/null 2>&1; then
    ok "GitHub" "signed in as $(gh api user --jq .login 2>/dev/null || echo you)"
  else
    todo "GitHub" "signing in (your browser opens; paste the code it shows)"
    act gh auth login --hostname github.com --web --git-protocol https
  fi
  # Git uses gh's sign-in for github.com (idempotent).
  act gh auth setup-git --hostname github.com
  if [ "$dry" = 0 ] && ! gh repo view "$repo" --json name >/dev/null 2>&1; then
    fail "GitHub" "your GitHub account cannot see $repo" "check the name, or ask its owner to add you"
  fi
fi

# ---------------------------------------------------------------- 5. The fleet

norm() { printf '%s' "$1" | sed -E 's#\.git/?$##; s#/+$##' | tr '[:upper:]' '[:lower:]'; }
# Whether folder $1 is a checkout of the repository asked for.
same_repo() {
  local have
  have="$(git -C "$1" remote get-url origin 2>/dev/null)" || return 1
  if [ "$github" = 1 ]; then
    norm "$have" | grep -Eq "github\.com[:/]$(norm "$repo")$"
  elif [ -d "$url" ] && [ -d "$have" ]; then
    [ "$(cd "$url" && pwd -P)" = "$(cd "$have" && pwd -P)" ]
  else
    [ "$(norm "$have")" = "$(norm "$url")" ]
  fi
}
empty_dir() { [ -d "$1" ] && [ -z "$(ls -A "$1")" ]; }
clone() {
  todo "Fleet" "cloning $repo into $in"
  act git clone "$url" "$in"
  [ "$dry" = 1 ] || ok "Fleet" "$in"
}

if [ ! -e "$in" ] || empty_dir "$in"; then
  clone
elif ! same_repo "$in"; then
  fail "Fleet" "$in is there and is not a checkout of $repo" "choose another folder: --in <folder>"
elif [ "$destroy" = 1 ]; then
  real="$(cd "$in" && pwd -P)"
  if [ "$real" = "$(cd "$HOME" && pwd -P)" ] || [ "$real" = / ]; then
    fail "Fleet" "refusing to remove $real" "choose the fleet's own folder: --in <folder>"
  fi
  # Work that exists only here: edits, commits not on GitHub, stashes.
  lost="$(
    git -C "$in" status --porcelain
    git -C "$in" log --branches --not --remotes --oneline
    git -C "$in" stash list
  )"
  if [ -n "$lost" ]; then
    echo "These exist only in $in and would be lost:"
    printf '%s\n' "$lost" | sed 's/^/    /'
    name="$(basename "$real")"
    if [ "$dry" = 1 ]; then
      echo "       would ask you to type \"$name\" to remove it"
    elif (: </dev/tty) 2>/dev/null; then
      printf 'Type "%s" to remove it anyway: ' "$name"
      read -r answer </dev/tty
      [ "$answer" = "$name" ] || fail "Fleet" "not removed (you typed \"$answer\")" "push or save that work first, then run this again"
    else
      fail "Fleet" "not removed: no terminal to confirm in" "run it in a terminal, or push that work first"
    fi
  fi
  todo "Fleet" "removing $in (--destroy-existing)"
  act rm -rf "$in"
  clone
else
  todo "Fleet" "$in is there: bringing it up to date"
  if [ "$dry" = 1 ]; then
    act sh -c "cd '$in' && deno task stolos update"
  else
    (cd "$in" && deno task stolos update) || fail "Fleet" "deno task stolos update did not finish" "read its output above; then run this again"
  fi
fi

# ---------------------------------------------------------------- 6. The shortcut

if [ "$shortcut" = 1 ]; then
  line='stolos() { deno task stolos "$@"; } # stolos shortcut (bootstrap): in the fleet folder'
  files=("$HOME/.bashrc")
  [ "$os" = macos ] || [ -f "$HOME/.zshrc" ] && files+=("$HOME/.zshrc")
  added=""
  for f in "${files[@]}"; do
    grep -qF '# stolos shortcut (bootstrap)' "$f" 2>/dev/null && continue
    if [ "$dry" = 1 ]; then printf '       would add to %s: %s\n' "$f" "$line"; else printf '\n%s\n' "$line" >>"$f"; fi
    added="$added ${f/#$HOME/~}"
  done
  ok "Shortcut" "${added:+added to$added; }type stolos ... in $in (new terminals)"
fi

echo
echo "==> done. Next, in a new terminal:"
echo "    cd $in"
echo "    deno task stolos                       where you are, and the next step"
echo "    first PC for this fleet:  deno task stolos keys setup   (then the README's setup)"
echo "    restoring a lost PC:      deno task stolos vault restore <your backup ZIP>"
