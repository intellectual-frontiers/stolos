#!/usr/bin/env bash
# Stolos bootstrap for Linux and macOS (spec 062).
#
# Makes this computer a Stolos controller: the PC you manage a fleet from. In
# order, each step checking first and doing nothing when it is already done
# (so running it again is always safe):
#
#   1. Bun, the engine's runtime, at the version the engine pins: its official
#      release archive for this computer, unpacked (into ~/.bun/bin) only when
#      its SHA-256 is the pinned one. Node 26 instead, with --runtime node, or
#      where Bun cannot run here (the same code runs on both).
#   2. Git (Linux: apt or dnf; macOS: Homebrew, or Apple's command line tools).
#   3. gh, GitHub's command line (Ubuntu's own package first, then GitHub's).
#   4. Your GitHub sign-in (gh auth login, in the browser), and Git told to use
#      it (gh auth setup-git): no SSH key or token to make by hand.
#   5. The fleet repository: cloned into --in (default ~/fleet) when it is not
#      there, and its engine installed (bun install --frozen-lockfile: exactly
#      what its bun.lock holds); brought up to date (bun run stolos update) when
#      it is.
#   6. A shortcut: `stolos ...` for `bun run stolos ...`, in ~/.bashrc and
#      ~/.zshrc (skip it with --no-shortcut).
#
# This is the bootstrap, published with every Stolos release: a new PC runs it
# from here, since a private fleet repository cannot be downloaded before you
# sign in. It needs --repo. A fleet repository also carries a copy as
# bin/bootstrap.sh (written by `bun run stolos fleet init`, refreshed by
# `bun run stolos fleet upgrade`) with its repository filled in below
# (DEFAULT_REPO), for running again later. Both are the same script.
#
# Run it (bash, not sh; the <(...) form keeps your terminal for the prompts):
#
#   bash <(curl -fsSL https://raw.githubusercontent.com/intellectual-frontiers/stolos/<tag>/bin/bootstrap.sh) --repo <owner>/<fleet-repo>
#
# Options:
#   --repo <owner/name>   the fleet repository on GitHub (or a Git URL or path)
#   --in <folder>         where the fleet goes (default: ~/fleet)
#   --destroy-existing    remove that folder first, then clone it fresh (it
#                         must be a checkout of the same repository; work not on
#                         GitHub yet is listed and needs the folder's name typed)
#   --no-shortcut         do not add the `stolos` shortcut
#   --runtime <bun|node>  the runtime (default: bun; node: Node 26, the backup)
#   --dry-run             say what each step would do; change nothing
#   --help                this text
#
# It needs sudo only to install Git, gh or unzip, and only when they are missing.

set -euo pipefail

# The fleet's repository: empty in the engine's copy (then --repo is required).
DEFAULT_REPO=""
# The pinned runtimes (src/archon/core/bun-pin.ts; the engine's tests keep them equal).
BUN_VERSION="1.4.4"
NODE_VERSION="26.13.1"
# The SHA-256 of bun-<target>.zip, from Bun's release (commons pins.ttl, pmid:pin-bun).
bun_sha256() {
  case "$1" in
  linux-x64) echo bf8ccbfb2b0b80159e0f9a6d15c55317add8077534dbc6130a3edb52fccb395c ;;
  linux-x64-baseline) echo e0446eb55995772eb9894bebae9a6be368d985a8b9271ee124486f9946eedd76 ;;
  linux-aarch64) echo baa6bb36f51d6e58561e02bbea825038a9df454f673d6d776e8bbf86f8c7850e ;;
  darwin-x64) echo 50a3491f73abc2fe81673171a85762d3bc2cc1680ccecadd983de99adf77977e ;;
  darwin-x64-baseline) echo d4a155adfbfd09155eb3ba05c9e3a544f39297d7a68616d3c7759f67ab5c47dc ;;
  darwin-aarch64) echo c240d7f0ccb90c263a849fcdb09b7ee62630d921348ed6aafda86b9d577bc510 ;;
  esac
}
# The SHA-256 of node-v<version>-<target>.tar.gz, from Node's SHASUMS256.txt.
node_sha256() {
  case "$1" in
  linux-x64) echo 518674de2b621728a5e4486f5fb3b7d2900bb3cc4aa97969edaa463db99f9778 ;;
  linux-arm64) echo 80a330b35415382878df18d41afbd106ea89bfb3be0087d6608e289a14c5cc7d ;;
  darwin-x64) echo 82bb96078a24ca50b9c9a38f2379e6be6d87171fcd400fc14c8934b3bce96e2f ;;
  darwin-arm64) echo aec2514ea1ceb2ba52455e9ec65986f6749a06dd759e5db2a72e6889668c9735 ;;
  esac
}

repo="$DEFAULT_REPO"
in="$HOME/fleet"
destroy=0
dry=0
shortcut=1
runtime="${STOLOS_RUNTIME:-bun}"

usage() {
  cat <<EOF
Stolos bootstrap: Bun, Git, gh, your GitHub sign-in, and the fleet in one folder.

  bash bootstrap.sh [--repo <owner/name>] [--in <folder>] [--destroy-existing]
                    [--no-shortcut] [--runtime <bun|node>] [--dry-run]

  --repo <owner/name>   the fleet repository${DEFAULT_REPO:+ (default: $DEFAULT_REPO)}
  --in <folder>         where it goes (default: ~/fleet); already there: stolos update
  --destroy-existing    remove that folder first, then clone it fresh
  --no-shortcut         do not add the stolos shortcut to ~/.bashrc and ~/.zshrc
  --runtime <bun|node>  the runtime (default: bun; node: Node $NODE_VERSION, the backup)
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
  --runtime) runtime="${2:?--runtime needs bun or node}"; shift 2 ;;
  --runtime=*) runtime="${1#*=}"; shift ;;
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
case "$runtime" in
bun | node) ;;
*) fail "Runtime" "$runtime is not bun or node" "--runtime bun (the default) or --runtime node" ;;
esac

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

# ---------------------------------------------------------------- 1. The runtime: Bun (or Node 26)

export PATH="$HOME/.bun/bin:$HOME/.stolos/node/bin:$PATH"
# Folders this script put a runtime in, for the shell's startup files.
new_paths=()

# A file's SHA-256 (Linux: sha256sum; macOS: shasum).
sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  else
    shasum -a 256 "$1" | cut -d' ' -f1
  fi
}
# Download $1 into folder $3 as $fetched, kept only when its SHA-256 is $2 ($4 names the step).
fetch_pinned() {
  local got
  fetched="$3/${1##*/}"
  curl -fsSL --retry 3 -o "$fetched" "$1" || fail "$4" "could not download $1" "check the network, then run this again"
  got="$(sha256_of "$fetched")"
  if [ "$got" != "$2" ]; then
    rm -f "$fetched"
    fail "$4" "${1##*/} is not the pinned one (SHA-256 $got, not $2): nothing was unpacked" "run this again; if it says the same, tell the engine's maintainers"
  fi
}
# The version a runtime reports, without a leading v or a suffix ("" when it is not here or cannot run).
version_of() {
  local v
  v="$("$1" --version 2>/dev/null | head -1)" || v=""
  v="${v#v}"
  printf '%s' "${v%%-*}"
}

# The Bun build for this computer (the baseline one for an x86-64 processor without AVX2).
bun_target() {
  case "$os:$(uname -m)" in
  linux:x86_64) if grep -qw avx2 /proc/cpuinfo 2>/dev/null; then echo linux-x64; else echo linux-x64-baseline; fi ;;
  linux:aarch64 | linux:arm64) echo linux-aarch64 ;;
  macos:arm64 | macos:aarch64) echo darwin-aarch64 ;;
  macos:x86_64)
    if [ "$(sysctl -n sysctl.proc_translated 2>/dev/null)" = 1 ]; then
      echo darwin-aarch64 # Apple silicon, in a Rosetta terminal
    elif sysctl -n machdep.cpu.leaf7_features 2>/dev/null | grep -qi avx2; then
      echo darwin-x64
    else
      echo darwin-x64-baseline
    fi
    ;;
  esac
}
node_target() {
  case "$os:$(uname -m)" in
  linux:x86_64) echo linux-x64 ;;
  linux:aarch64 | linux:arm64) echo linux-arm64 ;;
  macos:arm64 | macos:aarch64) echo darwin-arm64 ;;
  macos:x86_64) if [ "$(sysctl -n sysctl.proc_translated 2>/dev/null)" = 1 ]; then echo darwin-arm64; else echo darwin-x64; fi ;;
  esac
}

# The pinned Bun, into ~/.bun/bin; where there is none for this computer, Node instead.
install_bun() {
  local t sum tmp
  t="$(bun_target)"
  sum="$(bun_sha256 "$t")"
  if [ -z "$t" ] || [ -z "$sum" ]; then
    todo "Bun" "no Bun is pinned for $(uname -s) $(uname -m): Node $NODE_VERSION instead"
    runtime=node
    return
  fi
  local url="https://github.com/oven-sh/bun/releases/download/bun-v$BUN_VERSION/bun-$t.zip"
  todo "Bun" "installing $BUN_VERSION (bun-$t.zip, its SHA-256 checked, into ~/.bun/bin)"
  if [ "$dry" = 1 ]; then
    printf '       would run: curl -fsSL -o bun-%s.zip %s\n' "$t" "$url"
    printf '       would check: SHA-256 %s, then unzip bun into ~/.bun/bin\n' "$sum"
    return
  fi
  if ! command -v unzip >/dev/null 2>&1; then pkg_install unzip; fi
  tmp="$(mktemp -d)"
  fetch_pinned "$url" "$sum" "$tmp" "Bun"
  unzip -q -o "$fetched" -d "$tmp"
  mkdir -p "$HOME/.bun/bin"
  install -m 0755 "$tmp/bun-$t/bun" "$HOME/.bun/bin/bun"
  rm -rf "$tmp"
  new_paths+=("\$HOME/.bun/bin")
  hash -r
  if [ "$(version_of bun)" = "$BUN_VERSION" ]; then
    ok "Bun" "$BUN_VERSION (~/.bun/bin/bun)"
  else
    todo "Bun" "Bun $BUN_VERSION does not run on this computer: Node $NODE_VERSION instead"
    runtime=node
  fi
}

# The pinned Node, into ~/.stolos/node.
install_node() {
  local t sum tmp
  t="$(node_target)"
  sum="$(node_sha256 "$t")"
  [ -n "$t" ] && [ -n "$sum" ] || fail "Node" "no Node is pinned for $(uname -s) $(uname -m)" "install Node 26 yourself, then run this again"
  local url="https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-$t.tar.gz"
  todo "Node" "installing $NODE_VERSION (node-v$NODE_VERSION-$t.tar.gz, its SHA-256 checked, into ~/.stolos/node)"
  if [ "$dry" = 1 ]; then
    printf '       would run: curl -fsSL -o node-v%s-%s.tar.gz %s\n' "$NODE_VERSION" "$t" "$url"
    printf '       would check: SHA-256 %s, then unpack it into ~/.stolos/node\n' "$sum"
    return
  fi
  tmp="$(mktemp -d)"
  fetch_pinned "$url" "$sum" "$tmp" "Node"
  rm -rf "$HOME/.stolos/node"
  mkdir -p "$HOME/.stolos/node"
  tar -xzf "$fetched" -C "$HOME/.stolos/node" --strip-components=1
  rm -rf "$tmp"
  new_paths+=("\$HOME/.stolos/node/bin")
  hash -r
  [ "$(version_of node)" = "$NODE_VERSION" ] || fail "Node" "Node $NODE_VERSION does not run on this computer" "install Node 26 yourself, then run this again"
  ok "Node" "$NODE_VERSION (~/.stolos/node/bin/node)"
}

if [ "$runtime" = bun ]; then
  have="$(version_of bun)"
  if [ -z "$have" ]; then
    install_bun
  elif ! at_least "$have" "$BUN_VERSION"; then
    todo "Bun" "$have is older than $BUN_VERSION: installing the pinned one"
    install_bun
  else
    ok "Bun" "$have (at least $BUN_VERSION)"
  fi
fi
if [ "$runtime" = node ]; then
  have="$(version_of node)"
  if [ -n "$have" ] && at_least "$have" 26.0.0; then
    ok "Node" "$have (at least 26; Bun is the runtime of record)"
  else
    install_node
  fi
fi
# How the fleet's commands run: its package.json's script with Bun, its stolos.ts with Node.
if [ "$runtime" = bun ]; then stolos_cmd="bun run stolos"; else stolos_cmd="node stolos.ts"; fi

# A new terminal finds the runtime installed here.
for f in "$HOME/.bashrc" "$HOME/.zshrc"; do
  [ "${#new_paths[@]}" -gt 0 ] || break # (an empty array is unset to bash 3.2, macOS's)
  [ "$f" = "$HOME/.zshrc" ] && [ "$os" != macos ] && [ ! -f "$f" ] && continue
  for p in "${new_paths[@]}"; do
    grep -qF "$p" "$f" 2>/dev/null && continue
    printf '\n%s\n' "export PATH=\"$p:\$PATH\" # stolos runtime (bootstrap)" >>"$f"
  done
done

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
# The fleet's engine, exactly as its bun.lock holds it (by Bun, which checks it, on either runtime).
engine_install() {
  if [ "$dry" = 1 ]; then
    printf '       would run: cd %s && bun install --frozen-lockfile (when it has a package.json)\n' "$in"
    return
  fi
  [ -f "$in/package.json" ] || return 0
  if [ -z "$(version_of bun)" ]; then
    fail "Engine" "the engine is installed by Bun (it checks bun.lock), and Bun does not run here" "run this on a computer where Bun runs, or install Bun $BUN_VERSION yourself"
  fi
  todo "Engine" "bun install --frozen-lockfile (exactly what bun.lock holds)"
  (cd "$in" && bun install --frozen-lockfile) ||
    fail "Engine" "bun install --frozen-lockfile did not finish" "an integrity error means a download is not what bun.lock holds: do not regenerate bun.lock (bun run stolos explain E046-LOCK-INTEGRITY); otherwise check the network, then run this again"
  ok "Engine" "installed, as bun.lock holds it"
}
clone() {
  todo "Fleet" "cloning $repo into $in"
  act git clone "$url" "$in"
  [ "$dry" = 1 ] || ok "Fleet" "$in"
  engine_install
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
    act sh -c "cd '$in' && $stolos_cmd update"
  else
    [ -d "$in/node_modules" ] || engine_install
    (cd "$in" && $stolos_cmd update) || fail "Fleet" "$stolos_cmd update did not finish" "read its output above; then run this again"
  fi
fi

# ---------------------------------------------------------------- 6. The shortcut

if [ "$shortcut" = 1 ]; then
  line="stolos() { $stolos_cmd \"\$@\"; } # stolos shortcut (bootstrap): in the fleet folder"
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
echo "    $stolos_cmd                        where you are, and the next step"
echo "    first PC for this fleet:  $stolos_cmd keys setup   (then the README's setup)"
echo "    restoring a lost PC:      $stolos_cmd vault restore <your backup ZIP>"
