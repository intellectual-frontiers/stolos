#!/bin/sh
# Stolos integrate for Linux and macOS (spec 069): run on a machine to bring it into a fleet.
#
# You do not need to know the details: the person who runs your fleet gives you
# this command, already filled in. It tells you what it will do and asks once.
#
#   --discover     (the default) Change nothing: print this machine's facts as a
#                  check-in code, so the fleet knows it exists.
#   --adopt        Let the fleet look at this machine (read only, never change it):
#                  turn on SSH if it is off, install a small read-only script
#                  (~/.local/bin/stolos-probe), and allow the fleet's probe key to
#                  run that script and nothing else.
#   --osquery      With --adopt: install osquery, so the fleet can ask SQL questions.
#   --server       An Ubuntu server installed by hand: SSH on, and the fleet admin's
#                  GitHub keys allowed, ready for: bun run stolos host bootstrap.
#   --workstation  Make this machine (Ubuntu or WSL) a managed fleet workstation.
#
#   --fleet <id> --key '<probe public key>' --engine <tag> --probe-sha256 <hash>
#                  Filled in for you by: bun run stolos host integrate.
#   --github <login> (--server)   --repo <owner/name> (--workstation)
#   --ssh-port <n> When this machine's SSH server listens on another port than 22.
#   --dry-run      Say what it would do; change nothing.   --yes   Do not ask.
#   --undo         Remove what --adopt added (the script and the key's line).
#
# At the end it prints one line, the check-in code: copy it into the Stolos
# Console (Add a machine), or send it to the person who runs your fleet. It holds
# only public facts (names, addresses, the machine's public SSH keys).
set -u
LC_ALL=C; export LC_ALL

discover=0; adopt=0; osq=0; server=0; ws=0; dry=0; yes=0; undo=0
fleet=""; key=""; engine=""; probesha=""; github=""; repo=""; port=22
while [ $# -gt 0 ]; do
  case "$1" in
    --discover) discover=1 ;;
    --adopt) adopt=1 ;;
    --osquery) osq=1 ;;
    --server) server=1 ;;
    --workstation) ws=1 ;;
    --dry-run) dry=1 ;;
    --yes) yes=1 ;;
    --undo) undo=1 ;;
    --fleet) fleet=${2:-}; shift ;;
    --key) key=${2:-}; shift ;;
    --engine) engine=${2:-}; shift ;;
    --probe-sha256) probesha=${2:-}; shift ;;
    --github) github=${2:-}; shift ;;
    --repo) repo=${2:-}; shift ;;
    --ssh-port) port=${2:-22}; shift ;;
    -h|--help) sed -n '2,30p' "$0" 2>/dev/null || echo "see the comments at the top of integrate.sh"; exit 0 ;;
    *) echo "integrate: unknown option $1 (try --help)" >&2; exit 2 ;;
  esac
  shift
done
[ $((adopt + osq + server + ws + undo)) -eq 0 ] && discover=1

say() { printf '%s\n' "$*"; }
step() { printf '  %s. %s\n' "$1" "$2"; }
has() { command -v "$1" >/dev/null 2>&1; }
die() { printf '\nintegrate: %s\n' "$*" >&2; exit 1; }
os=$(uname -s)
me=$(id -un)
# STOLOS_RAW: where the engine's files are (tests use a local folder).
raw="${STOLOS_RAW:-https://raw.githubusercontent.com/intellectual-frontiers/stolos/${engine:-main}}"
fetch() { case "$1" in /*) cat "$1"; return ;; esac; if has curl; then curl -fsSL "$1"; elif has wget; then wget -qO- "$1"; else die "neither curl nor wget is here"; fi; }
sha() { if has sha256sum; then sha256sum | cut -d' ' -f1; else shasum -a 256 | cut -d' ' -f1; fi; }
asroot() { if [ "$(id -u)" = 0 ]; then "$@"; elif has sudo; then sudo "$@"; else die "this step needs an administrator (sudo is not here): $*"; fi; }
ssh_on() {
  if has ss; then ss -ltn 2>/dev/null | grep -qE "[:.]${port}[[:space:]]"
  elif has nc; then nc -z 127.0.0.1 "$port" >/dev/null 2>&1
  elif [ "$os" = Darwin ]; then launchctl print system/com.openssh.sshd >/dev/null 2>&1
  else netstat -ltn 2>/dev/null | grep -qE "[:.]${port}[[:space:]]"; fi
}
probe_line() { printf 'command="%s/.local/bin/stolos-probe",restrict %s stolos-probe@%s' "$HOME" "$(printf '%s' "$key" | awk '{print $1" "$2}')" "$fleet"; }

[ $((adopt + undo)) -gt 0 ] && [ -z "$fleet" ] && die "--fleet is needed (bun run stolos host integrate fills it in)"
[ "$adopt" = 1 ] && [ -z "$key" ] && die "--key is needed for --adopt (bun run stolos host integrate fills it in)"
[ "$server" = 1 ] && [ -z "$github" ] && die "--github <login> is needed for --server (whose keys may sign in)"
[ "$ws" = 1 ] && [ -z "$repo" ] && die "--repo <owner/name> is needed for --workstation"

# ---------------------------------------------------------------- the plan
n=0; plan=""
add() { n=$((n + 1)); plan="$plan$(printf '  %s. %s' "$n" "$1")
"; }
if [ "$undo" = 1 ]; then
  add "remove ~/.local/bin/stolos-probe and the stolos-probe@$fleet line from ~/.ssh/authorized_keys"
else
  if [ $((adopt + server)) -gt 0 ] && ! ssh_on; then
    add "turn on the SSH server, so the fleet can reach this machine (asks for your password)"
  fi
  [ "$adopt" = 1 ] && add "install the read-only script ~/.local/bin/stolos-probe (checked against the fleet's copy)"
  [ "$adopt" = 1 ] && add "allow the fleet's key to run that script, and nothing else, in ~/.ssh/authorized_keys"
  [ "$osq" = 1 ] && ! has osqueryi && add "install osquery from its maker (asks for your password)"
  [ "$server" = 1 ] && add "allow GitHub user $github's SSH keys to sign in as $me (ssh-import-id)"
  [ "$ws" = 1 ] && add "set up Bun (pinned, its SHA-256 checked), Git, and GitHub sign-in, clone $repo, and make this a fleet workstation"
fi

say ""
say "Stolos integrate${fleet:+ for the fleet $fleet}: $(hostname 2>/dev/null || uname -n) ($os), as $me"
say ""
if [ "$n" = 0 ]; then
  say "Nothing on this machine will change: it only reads its facts."
else
  say "This will:"
  printf '%s' "$plan"
  say ""
  say "Nothing else changes. Undo --adopt any time with --undo."
  if [ "$dry" = 1 ]; then say ""; say "(--dry-run: nothing was changed)"; exit 0; fi
  if [ "$yes" != 1 ]; then
    printf 'Go ahead? [y/N] '
    ans=""; read -r ans </dev/tty 2>/dev/null || ans=""
    case "$ans" in y|Y|yes|YES) ;; *) say "Nothing was changed."; exit 1 ;; esac
  fi
fi

# ---------------------------------------------------------------- doing it
if [ "$undo" = 1 ]; then
  if [ -f "$HOME/.ssh/authorized_keys" ]; then
    grep -v "stolos-probe@$fleet\$" "$HOME/.ssh/authorized_keys" >"$HOME/.ssh/authorized_keys.stolos" || true
    mv "$HOME/.ssh/authorized_keys.stolos" "$HOME/.ssh/authorized_keys"; chmod 600 "$HOME/.ssh/authorized_keys"
  fi
  rm -f "$HOME/.local/bin/stolos-probe"
  say "Done: the fleet can no longer look at this machine. Tell the person who runs your fleet (host release)."
  exit 0
fi

if [ $((adopt + server)) -gt 0 ] && ! ssh_on; then
  say "Turning on SSH ..."
  if [ "$os" = Darwin ]; then
    asroot launchctl enable system/com.openssh.sshd 2>/dev/null
    asroot launchctl bootstrap system /System/Library/LaunchDaemons/ssh.plist 2>/dev/null || true
    ssh_on || die "macOS did not turn SSH on: System Settings > General > Sharing > Remote Login: on, then run this again"
  else
    if ! [ -x /usr/sbin/sshd ]; then
      if has apt-get; then asroot apt-get install -y openssh-server
      elif has dnf; then asroot dnf install -y openssh-server
      elif has pacman; then asroot pacman -S --noconfirm openssh
      else die "install an SSH server with your system's package manager, then run this again"; fi
    fi
    asroot systemctl enable --now ssh 2>/dev/null || asroot systemctl enable --now sshd
  fi
fi

if [ "$adopt" = 1 ]; then
  umask 077
  mkdir -p "$HOME/.local/bin" "$HOME/.ssh"
  tmp="$HOME/.local/bin/.stolos-probe.$$"
  fetch "$raw/bin/stolos-probe.sh" >"$tmp" || die "could not download the probe from $raw"
  if [ -n "$probesha" ] && [ "$(sha <"$tmp")" != "$probesha" ]; then
    rm -f "$tmp"; die "the downloaded probe is not the fleet's copy (checksum differs): nothing was installed"
  fi
  chmod 755 "$tmp" && mv "$tmp" "$HOME/.local/bin/stolos-probe"
  touch "$HOME/.ssh/authorized_keys"
  grep -v "stolos-probe@$fleet\$" "$HOME/.ssh/authorized_keys" >"$HOME/.ssh/authorized_keys.stolos" || true
  probe_line >>"$HOME/.ssh/authorized_keys.stolos"; printf '\n' >>"$HOME/.ssh/authorized_keys.stolos"
  mv "$HOME/.ssh/authorized_keys.stolos" "$HOME/.ssh/authorized_keys"; chmod 600 "$HOME/.ssh/authorized_keys"
  chmod 700 "$HOME/.ssh"
  say "The read-only probe is installed, and only the fleet's key may run it."
fi

if [ "$osq" = 1 ] && ! has osqueryi; then
  say "Installing osquery ..."
  rel=$(fetch https://api.github.com/repos/osquery/osquery/releases/latest | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -1)
  [ -n "$rel" ] || die "could not find osquery's latest release"
  t=$(mktemp -d)
  if [ "$os" = Darwin ]; then
    if has brew; then brew install --cask osquery
    else fetch "https://github.com/osquery/osquery/releases/download/$rel/osquery-$rel.pkg" >"$t/o.pkg" && asroot installer -pkg "$t/o.pkg" -target /; fi
  elif has apt-get; then
    fetch "https://github.com/osquery/osquery/releases/download/$rel/osquery_$rel-1.linux_$(dpkg --print-architecture).deb" >"$t/o.deb" && asroot apt-get install -y "$t/o.deb"
  elif has dnf; then
    fetch "https://github.com/osquery/osquery/releases/download/$rel/osquery-$rel-1.linux.$(uname -m).rpm" >"$t/o.rpm" && asroot dnf install -y "$t/o.rpm"
  else
    say "osquery: install it with your system's packages (Arch: yay -S osquery-bin), then run this again."
  fi
  rm -rf "$t"
fi

if [ "$server" = 1 ]; then
  has ssh-import-id || asroot apt-get install -y ssh-import-id
  ssh-import-id "gh:$github" || die "could not import $github's keys from GitHub"
fi

if [ "$ws" = 1 ]; then
  say "Setting up the workstation (the controller bootstrap, then workstation add) ..."
  fetch "$raw/bin/bootstrap.sh" >"/tmp/stolos-bootstrap.$$" || die "could not download the bootstrap"
  bash "/tmp/stolos-bootstrap.$$" --repo "$repo" --no-shortcut || die "the bootstrap did not finish"
  rm -f "/tmp/stolos-bootstrap.$$"
  # The bootstrap's runtime (~/.bun/bin; ~/.stolos/node where Bun cannot run) is not on this shell's PATH yet.
  PATH="$HOME/.bun/bin:$HOME/.stolos/node/bin:$PATH"
  if bun --version >/dev/null 2>&1; then
    (cd "$HOME/fleet" && bun run stolos workstation add) || die "workstation add did not finish"
  else
    (cd "$HOME/fleet" && node stolos.ts workstation add) || die "workstation add did not finish"
  fi
fi

# ---------------------------------------------------------------- the check-in code
facts() {
  if [ -x "$HOME/.local/bin/stolos-probe" ]; then "$HOME/.local/bin/stolos-probe" facts
  else
    t=$(mktemp); fetch "$raw/bin/stolos-probe.sh" >"$t" 2>/dev/null && sh "$t" facts; rm -f "$t"
  fi
}
addresses() {
  if has ip; then ip -4 -o addr show scope global 2>/dev/null | awk '{print $4}' | cut -d/ -f1
  elif has ifconfig; then ifconfig 2>/dev/null | awk '/inet /&&$2!="127.0.0.1"{print $2}'
  else hostname -I 2>/dev/null | tr ' ' '\n' | grep -E '^[0-9]+(\.[0-9]+){3}$'; fi
}
macs() {
  if [ -d /sys/class/net ]; then for i in /sys/class/net/*; do [ "${i##*/}" = lo ] || cat "$i/address" 2>/dev/null; done
  else ifconfig 2>/dev/null | awk '/ether /{print $2}'; fi
}
kinds=""
[ "$discover" = 1 ] && kinds="$kinds discover"; [ "$adopt" = 1 ] && kinds="$kinds adopt"
[ "$osq" = 1 ] && kinds="$kinds osquery"; [ "$server" = 1 ] && kinds="$kinds server"; [ "$ws" = 1 ] && kinds="$kinds workstation"
code=$( {
  echo "@checkin"; echo "v=1"; echo "fleet=$fleet"; echo "kinds=${kinds# }"; echo "user=$me"; echo "port=$port"
  echo "hostname=$(hostname 2>/dev/null || uname -n)"
  echo "addresses=$(addresses | tr '\n' ' ' | sed 's/ *$//')"
  echo "macs=$(macs | grep -v '^00:00:00:00:00:00$' | sort -u | tr '\n' ' ' | sed 's/ *$//')"
  echo "@hostkeys"
  i=0; for f in /etc/ssh/ssh_host_*_key.pub; do [ -r "$f" ] || continue; i=$((i + 1)); echo "$i=$(awk '{print $1" "$2}' "$f")"; done
  facts
} | base64 | tr -d '\n')

say ""
say "Done. Copy this line into the Stolos Console (Add a machine), or send it to"
say "the person who runs your fleet. It holds only public facts about this machine:"
say ""
say "stolos1:$code"
say ""
