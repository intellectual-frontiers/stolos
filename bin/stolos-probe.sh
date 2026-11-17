#!/bin/sh
# stolos-probe 3: read-only facts for the fleet's Stolos (specs 067, 069). Installed by
# "bun run stolos host adopt" or bin/integrate.sh --adopt; run only by the fleet's probe key
# (authorized_keys forces it). It changes nothing. Remove it with: integrate.sh --undo, or
# bun run stolos host release <name>. POSIX sh; BusyBox (NAS devices) too.
set -u
LC_ALL=C; export LC_ALL
PATH="$PATH:/usr/sbin:/sbin:/usr/local/bin:/opt/homebrew/bin"
req=${SSH_ORIGINAL_COMMAND:-${1:-facts}}
kv() { printf '%s=%s\n' "$1" "$(printf '%s' "$2" | tr '\n' ' ' | sed 's/[[:space:]]*$//')"; }
has() { command -v "$1" >/dev/null 2>&1; }
os=$(uname -s 2>/dev/null || echo unknown)

facts() {
  echo "@probe"; kv version 3; kv at "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "@os"
  kv kernel "$os"; kv release "$(uname -r)"; kv arch "$(uname -m)"; kv hostname "$(hostname 2>/dev/null || uname -n)"
  if [ "$os" = Darwin ]; then
    kv family macos; kv name "$(sw_vers -productName 2>/dev/null)"; kv version "$(sw_vers -productVersion 2>/dev/null)"
    kv serial "$(ioreg -c IOPlatformExpertDevice -d 2 2>/dev/null | awk -F'"' '/IOPlatformSerialNumber/{print $4}')"
    kv model "$(sysctl -n hw.model 2>/dev/null)"
  elif [ -r /etc/os-release ]; then
    . /etc/os-release
    fam=${ID:-linux}; case "${ID_LIKE:-}" in *arch*) [ "$fam" = arch ] || fam="$fam (arch)";; esac
    kv family "$fam"; kv name "${PRETTY_NAME:-$fam}"; kv version "${VERSION_ID:-rolling}"
    [ -d "$HOME/.local/share/omarchy" ] && kv flavor omarchy
    [ -n "${WSL_DISTRO_NAME:-}" ] || grep -qi microsoft /proc/version 2>/dev/null && kv wsl yes
    kv model "$(cat /sys/class/dmi/id/product_name 2>/dev/null)"
  else
    kv family unknown
  fi
  echo "@hardware"
  if [ "$os" = Darwin ]; then
    kv cpus "$(sysctl -n hw.ncpu 2>/dev/null)"; kv memory_mb "$(( $(sysctl -n hw.memsize 2>/dev/null || echo 0) / 1048576 ))"
  else
    kv cpus "$(getconf _NPROCESSORS_ONLN 2>/dev/null)"; kv memory_mb "$(awk '/MemTotal/{print int($2/1024)}' /proc/meminfo 2>/dev/null)"
  fi
  df -Pk / 2>/dev/null | awk 'NR==2{printf "disk_total_gb=%d\ndisk_used_pct=%s\n", $2/1048576, $5}' | tr -d '%'
  echo "@security"
  if [ "$os" = Darwin ]; then
    fdesetup status 2>/dev/null | grep -q "FileVault is On" && kv disk_encryption on || kv disk_encryption off
    /usr/libexec/ApplicationFirewall/socketfilterfw --getglobalstate 2>/dev/null | grep -qi enabled && kv firewall on || kv firewall off
    au=$(defaults read /Library/Preferences/com.apple.SoftwareUpdate AutomaticallyInstallMacOSUpdates 2>/dev/null)
    [ "$au" = 1 ] && kv auto_updates on || kv auto_updates off
    kv admins "$(dscl . -read /Groups/admin GroupMembership 2>/dev/null | sed 's/GroupMembership: //')"
  else
    if lsblk -rno TYPE 2>/dev/null | grep -qx crypt; then kv disk_encryption on; else kv disk_encryption off; fi
    fw=off; for u in ufw firewalld nftables; do systemctl is-active -q "$u" 2>/dev/null && fw=on; done; kv firewall "$fw"
    if systemctl is-enabled -q unattended-upgrades 2>/dev/null || systemctl is-enabled -q dnf-automatic.timer 2>/dev/null; then kv auto_updates on
    elif has pacman; then kv auto_updates manual; else kv auto_updates off; fi
    if has getent; then grp() { getent group "$1"; }; else grp() { grep "^$1:" /etc/group; }; fi
    kv admins "$( (grp sudo; grp wheel; grp admin; grp administrators) 2>/dev/null | cut -d: -f4 | tr ',' ' ')"
  fi
  if [ -r /etc/ssh/sshd_config ]; then
    pa=$(grep -hiE '^[[:space:]]*PasswordAuthentication' /etc/ssh/sshd_config /etc/ssh/sshd_config.d/*.conf 2>/dev/null | head -1 | awk '{print tolower($2)}')
    kv ssh_password_auth "${pa:-default}"
  fi
  echo "@software"
  if has dpkg-query; then kv manager apt; kv packages "$(dpkg-query -f '.\n' -W 2>/dev/null | wc -l)"
    kv pending_updates "$(apt list --upgradable 2>/dev/null | grep -c upgradable)"
  elif has pacman; then kv manager pacman; kv packages "$(pacman -Q 2>/dev/null | wc -l)"
    has checkupdates && kv pending_updates "$(checkupdates 2>/dev/null | wc -l)"
  elif has rpm; then kv manager rpm; kv packages "$(rpm -qa 2>/dev/null | wc -l)"
  fi
  has brew && kv brew_packages "$(brew list 2>/dev/null | wc -l)"
  has osqueryi && kv osquery "$(osqueryi --version 2>/dev/null | awk '{print $NF}')"
  # Spec 112-machine-reported-tags: what the machine says about itself, read as data (never sourced): its
  # /etc/machine-info (systemd machine-info(5)) and its firmware's SMBIOS facts. The fleet reads them as claims.
  echo "@reported"
  mi() { [ -r /etc/machine-info ] && sed -n "s/^$1=//p" /etc/machine-info 2>/dev/null | head -n 1 | sed "s/^[\"']//;s/[\"']\$//"; }
  dmi() { head -n 1 "/sys/class/dmi/id/$1" 2>/dev/null; }
  kv machine_info_deployment "$(mi DEPLOYMENT)"; kv machine_info_location "$(mi LOCATION)"
  kv machine_info_chassis "$(mi CHASSIS)"; kv machine_info_tags "$(mi TAGS)"
  kv smbios_vendor "$(dmi sys_vendor)"; kv smbios_model "$(dmi product_name)"
  kv smbios_chassis_type "$(dmi chassis_type)"; kv smbios_bios_vendor "$(dmi bios_vendor)"
  echo "@listening"
  if has ss; then ss -Hltn 2>/dev/null | awk '{print $4}' | sed 's/.*://' | sort -un | tr '\n' ' ' | sed 's/^/ports=/;s/ *$//'; echo
  elif has lsof; then lsof -nP -iTCP -sTCP:LISTEN 2>/dev/null | awk 'NR>1{print $9}' | sed 's/.*://' | sort -un | tr '\n' ' ' | sed 's/^/ports=/;s/ *$//'; echo
  elif has netstat; then netstat -ltn 2>/dev/null | awk 'NR>2{print $4}' | sed 's/.*://' | sort -un | tr '\n' ' ' | sed 's/^/ports=/;s/ *$//'; echo
  fi
}

case "$req" in
  facts) facts ;;
  version) echo 3 ;;
  osquery\ *)
    has osqueryi || { echo "osquery is not installed here" >&2; exit 3; }
    sql=$(printf '%s' "${req#osquery }" | base64 -d 2>/dev/null) || { echo "not base64" >&2; exit 2; }
    case "$(printf '%s' "$sql" | tr '[:upper:]' '[:lower:]' | sed 's/^[[:space:]]*//')" in
      select*|with*) ;; *) echo "only SELECT" >&2; exit 2 ;;
    esac
    sql=$(printf '%s' "$sql" | sed 's/[[:space:];]*$//')
    case "$sql" in *\;*) echo "one statement" >&2; exit 2 ;; esac
    exec osqueryi --json "$sql" ;;
  *) echo "stolos-probe: unknown probe: $req (facts, osquery, version)" >&2; exit 2 ;;
esac
