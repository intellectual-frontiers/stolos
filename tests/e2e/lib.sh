#!/bin/bash
# The end-to-end lab (spec 004 SC-001, specs 046 to 049), shared by ci.sh (the
# engine's own throwaway fleet) and fleet.sh (a fleet repository's synthetic
# fleet). Sourced; the caller sets:
#
#   F       the fleet repository's working copy (made by the caller)
#   FLEET   the fleet's id         SERVER  the server host's name
#   WS      the workstation's name (empty: no workstation stage)
#   ADMIN   the fleet admin's Unix account (its key is $W/admin)
#   A       how to run archon in $F (an array)
#
# Needs: root through sudo, KVM, qemu-system-x86, qemu-utils, ovmf,
# dnsmasq-base, cloud-image-utils, Deno.
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
W=${E2E_WORK:-/tmp/archon-e2e}
BR=10.77.0.1
MAC=52:54:00:12:34:56
WS_MAC=52:54:00:12:34:57
TIMEOUT_MIN=${E2E_TIMEOUT_MIN:-80}
# A stall: no new event from the boot server for this long ends the run, diagnosed.
STALL_MIN=${E2E_STALL_MIN:-15}
# E2E_SQUEEZE_MB (tests of the lab itself): hold that much of the runner's
# memory, to try a private runner's 8 GB on a public runner's 16.
if [ -n "${E2E_SQUEEZE_MB:-}" ]; then
  sudo mount -o remount,size=$((E2E_SQUEEZE_MB + 512))M /dev/shm
  dd if=/dev/zero of=/dev/shm/archon-e2e-squeeze bs=1M count="$E2E_SQUEEZE_MB" status=none
fi
# How the server is installed, from the runner's memory. GitHub's public
# runners have 16 GB: "network", a blank Secure Boot VM network-boots and
# Ubuntu's installer runs (it holds the whole image in memory: 8 GiB). Private
# runners have 8 GB, too little for that next to the runner itself:
# "bootstrap", Ubuntu's cloud image finished by stolos host bootstrap (the
# path for a server installed by hand). The engine's own lab runs the network
# install on every release. E2E_SERVER_INSTALL chooses either.
HOST_MB=$(($(free -m | awk '/^Mem:/ { print $2 }') - ${E2E_SQUEEZE_MB:-0}))
if [ "$HOST_MB" -ge 12000 ]; then INSTALL=${E2E_SERVER_INSTALL:-network}; else INSTALL=${E2E_SERVER_INSTALL:-bootstrap}; fi
if [ "$INSTALL" = network ]; then SERVER_MB=8192; else SERVER_MB=3584; fi
E2E_VM_MEM=${E2E_VM_MEM:-$SERVER_MB}
WS_MB=${E2E_WS_MEM:-3072}
SERVER_IP=""
OUT="$HERE/work"
EVENTS="$HOME/.local/share/archon/boot/telemetry"
log() { echo "e2e: $*"; }
plain() { sed 's/\x1b\[[0-9;]*m//g'; }

lab_init() {
  rm -rf "$W" && mkdir -p "$W/www" "$OUT"
  # Whatever happens, the logs can be uploaded (QEMU writes its console as root).
  trap 'sudo chmod -R a+rX "$OUT" 2>/dev/null || true' EXIT
  ssh-keygen -q -t ed25519 -N "" -C "" -f "$W/admin"  # the admin's (and ops') SSH key
  ssh-keygen -q -t ed25519 -N "" -C "" -f "$W/signer" # this run's signer
}

# The server's address: known (bootstrap), else the one its last event came
# from (an installer had another lease). Never fails: empty means none yet.
server_ip() {
  if [ -n "$SERVER_IP" ]; then echo "$SERVER_IP"; return; fi
  { plain <"$OUT/boot.log" 2>/dev/null | grep -E " $SERVER " | grep -oE '10\.77\.0\.[0-9]+' | tail -n 1; } || true
}

# The address of a machine that answers SSH, from its card's leases (it can
# hold more than one: an early DHCP client's, then the booted system's).
lease_ip() { # lease_ip <mac>
  local ip="" cand
  for _ in $(seq 60); do
    for cand in $(awk -v m="$1" 'tolower($2) == m { print $1, $3 }' "$W/leases" 2>/dev/null |
      sort -rn | awk '{ print $2 }'); do
      if ssh_to "$ADMIN@$cand" true 2>/dev/null; then ip=$cand; break 2; fi
    done
    sleep 5
  done
  echo "$ip"
}

ssh_to() { # ssh_to <user@address> <command>
  ssh -i "$W/admin" -o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=no \
    -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR "$1" "$2"
}

# On failure: everything the boot server recorded, and what the machines say.
diagnose() {
  if [ -f "$OUT/boot.log" ]; then
    echo "::group::boot.log (every event the boot server recorded)"
    plain <"$OUT/boot.log" || true
    echo "::endgroup::"
  fi
  local ip
  ip=$(server_ip || true)
  if [ -n "$ip" ]; then
    echo "::group::$SERVER ($ip): archon state, archon verify, its run logs"
    ssh_to "$ADMIN@$ip" 'archon state; archon verify; archon query "select problems from archon_install"; for f in $(ls -t /var/log/archon/*.log 2>/dev/null | head -n 3); do echo "== $f"; tail -n 80 "$f"; done' \
      2>&1 | plain | tee "$OUT/vm-diagnosis.txt" || true
    echo "::endgroup::"
  fi
  local c
  for c in "$OUT"/*-console.log; do
    [ -f "$c" ] || continue
    echo "::group::$(basename "$c") (last 80 lines)"
    sudo tail -n 80 "$c" | plain || true
    echo "::endgroup::"
  done
}
fail() { log "FAILED: $*"; diagnose; exit 1; }

lab_network() {
  log "bridge, NAT, DHCP with the network-boot file"
  sudo ip link show archbr0 >/dev/null 2>&1 || {
    sudo ip link add archbr0 type bridge
    sudo ip addr add $BR/24 dev archbr0
  }
  sudo ip link set archbr0 up
  for tap in archtap0 archtap1; do
    sudo ip link show $tap >/dev/null 2>&1 || {
      sudo ip tuntap add dev $tap mode tap user "$(id -un)"
      sudo ip link set $tap master archbr0
    }
    sudo ip link set $tap up
  done
  sudo sysctl -q -w net.ipv4.ip_forward=1
  sudo sysctl -q -w net.ipv4.ip_unprivileged_port_start=69 # archon-boot's TFTP, as this user
  sudo iptables -t nat -C POSTROUTING -s 10.77.0.0/24 ! -o archbr0 -j MASQUERADE 2>/dev/null ||
    sudo iptables -t nat -A POSTROUTING -s 10.77.0.0/24 ! -o archbr0 -j MASQUERADE
  sudo iptables -I FORWARD -i archbr0 -j ACCEPT
  sudo iptables -I FORWARD -o archbr0 -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT
  # The workstation is not network-booted: only the server's card gets the boot file.
  sudo dnsmasq --interface=archbr0 --bind-interfaces --port=0 --except-interface=lo \
    --dhcp-range=10.77.0.50,10.77.0.99,12h --dhcp-option=3,$BR --dhcp-option=6,1.1.1.1,9.9.9.9 \
    --no-ping --dhcp-host=$MAC,set:netboot --dhcp-boot=tag:netboot,bootx64.efi,,$BR \
    --dhcp-leasefile="$W/leases" \
    --log-dhcp --log-facility="$OUT/dnsmasq.log" --pid-file="$W/dnsmasq.pid"
  # $W/www over HTTP on the bridge: the fleet repository, and (ci.sh) the engine.
  deno run -A "$HERE/serve.ts" "$W/www" $BR 8000 >"$OUT/http.log" 2>&1 &
  for _ in $(seq 50); do curl -s -o /dev/null "http://$BR:8000/" && break; sleep 0.2; done
  # The machines look up tool releases through a mirror that holds the job's
  # token (GitHub's shared runner addresses exhaust the anonymous limit).
  deno run -A "$HERE/github-mirror.ts" $BR 8001 >"$OUT/github-mirror.log" 2>&1 &
  for _ in $(seq 50); do curl -s -o /dev/null "http://$BR:8001/rate_limit" && break; sleep 0.2; done
  [ -n "${GITHUB_TOKEN:-}" ] || log "no GITHUB_TOKEN: tool lookups are anonymous (60 an hour per address)"
}

# Commit the working copy, signed with this run's key, and serve it to the hosts.
publish_fleet() {
  (
    cd "$F"
    git add -A
    git -c gpg.format=ssh -c gpg.ssh.program=ssh-keygen -c user.signingkey="$W/signer" \
      commit -q -S -m "e2e: the fleet, as installed by this run"
  )
  git clone -q --bare "$F" "$W/www/fleet.git"
  git -C "$W/www/fleet.git" update-server-info
}

install_server() {
  log "boot server (downloads Ubuntu's boot files and image on its first run)"
  # As a fleet repository's `deno task stolos boot serve` runs it (spec 059: stolos turns
  # the boot server's OpenTelemetry on itself, spec 049).
  (cd "$F" && exec deno run -A --frozen stolos.ts boot serve \
    --fleet "$FLEET" --port 8080 --github-api "http://$BR:8001") >"$OUT/boot.log" 2>&1 &
  for _ in $(seq 600); do curl -fsS -o /dev/null "http://$BR:8080/health" && break; sleep 2; done
  curl -fsS "http://$BR:8080/health"
  if [ -n "${E2E_GUARD_TEST:-}" ]; then guard_test; fi
  log "$SERVER: blank VM, Secure Boot on, network boot (runner ${HOST_MB} MB, VM ${E2E_VM_MEM} MiB)"
  if [ -n "${E2E_GUARD_TEST:-}" ]; then
    # The same machine and disk again (the guard's partition table is still on it).
    sudo E2E_VM_BOOT=disk E2E_VM_MEM="$E2E_VM_MEM" "$HERE/vm.sh"
  else
    sudo E2E_VM_MEM="$E2E_VM_MEM" "$HERE/vm.sh"
  fi
  local deadline result="" seen=0 n last
  deadline=$(($(date +%s) + TIMEOUT_MIN * 60))
  last=$(date +%s)
  while [ "$(date +%s)" -lt "$deadline" ]; do
    if grep -qs '"boot.ready"' "$EVENTS"/otlp-*.jsonl; then result=ready; break; fi
    if grep -qs '"boot.done-with-problems"' "$EVENTS"/otlp-*.jsonl; then result=problems; break; fi
    if grep -qs '"boot.guarded"' "$EVENTS"/otlp-*.jsonl; then result="stopped by the blank-disk guard"; break; fi
    if grep -qs '"boot.stalled"' "$EVENTS"/otlp-*.jsonl; then result="stalled (the installer went quiet)"; break; fi
    if ! sudo kill -0 "$(sudo cat "$OUT/qemu.pid")" 2>/dev/null; then result=vm-stopped; break; fi
    sleep 30
    n=$(wc -l <"$OUT/boot.log")
    if [ "$n" -gt "$seen" ]; then last=$(date +%s); fi
    sed -n "$((seen + 1)),${n}p" "$OUT/boot.log" | plain
    seen=$n
    if [ $(($(date +%s) - last)) -ge $((STALL_MIN * 60)) ]; then result="stalled ($STALL_MIN minutes without an event)"; break; fi
  done
  cp -r "$EVENTS" "$OUT/telemetry" 2>/dev/null || true
  log "install: ${result:-timed out after $TIMEOUT_MIN minutes}"
  [ "$result" = ready ] || fail "the install did not reach Ready"
  # Spec 052: every check passed; what waits for a token is "not set up yet", apart.
  local ready
  ready=$(plain <"$OUT/boot.log" | grep -oE "Ready: [0-9]+/[0-9]+ checks[^·]*(· [0-9]+ not set up yet)?" | tail -n 1)
  log "$ready"
  echo "$ready" | awk '{ split($2, a, "/"); exit !(a[1] == a[2]) }' ||
    fail "Ready, but not every check passed ($ready): a pending item counted as a problem, or a real one"
}

# A server installed by hand, finished from the runner (spec 005): Ubuntu's
# cloud image, then stolos host bootstrap, which runs the same first boot.
bootstrap_server() {
  log "$SERVER: Ubuntu's cloud image, then stolos host bootstrap (runner ${HOST_MB} MB, VM ${E2E_VM_MEM} MiB)"
  sudo E2E_VM_MEM="$E2E_VM_MEM" "$HERE/cloud-vm.sh" "$SERVER" "$MAC" archtap0 "$ADMIN" "$W/admin.pub"
  SERVER_IP=$(lease_ip "$MAC")
  [ -n "$SERVER_IP" ] || fail "$SERVER did not answer SSH"
  ssh_to "$ADMIN@$SERVER_IP" 'cloud-init status --wait >/dev/null || true'
  # The first boot reads /etc/archon/proxy.env, as a network install's does: the mirror.
  ssh_to "$ADMIN@$SERVER_IP" "sudo mkdir -p /etc/archon && echo 'export ARCHON_GITHUB_API=http://$BR:8001' | sudo tee /etc/archon/proxy.env >/dev/null"
  log "$SERVER is at $SERVER_IP; bootstrapping"
  # The boot machine's ssh, for this lab's addresses only: trust each new VM once.
  mkdir -p "$HOME/.ssh"
  printf 'Host 10.77.0.*\n  StrictHostKeyChecking accept-new\n  UserKnownHostsFile /dev/null\n  IdentityFile %s\n  LogLevel ERROR\n' \
    "$W/admin" >>"$HOME/.ssh/config"
  (cd "$F" && "${A[@]}" host bootstrap "$SERVER" --ssh "$ADMIN@$SERVER_IP" </dev/null) 2>&1 | plain |
    tee "$OUT/bootstrap.txt" || fail "stolos host bootstrap failed"
  log "$SERVER: bootstrapped"
}

# Spec 051: a machine whose disk is not blank, claimed: the installer must
# stop before writing anything, and power off; then a person's
# --confirm-destroy lets the same machine install.
guard_test() {
  log "$SERVER: a machine with a partition table on its disk, claimed: the guard must stop it"
  sudo E2E_DIRTY_DISK=1 E2E_VM_MEM="$E2E_VM_MEM" "$HERE/vm.sh"
  local deadline
  deadline=$(($(date +%s) + 15 * 60))
  until grep -qs '"boot.guarded"' "$EVENTS"/otlp-*.jsonl; do
    [ "$(date +%s)" -lt "$deadline" ] || fail "the blank-disk guard did not stop the install"
    grep -qs '"boot.ready"' "$EVENTS"/otlp-*.jsonl && fail "a disk that was not blank was erased without --confirm-destroy"
    sleep 10
  done
  plain <"$OUT/boot.log" | grep -E "machine reports|install stopped" | tail -n 2 || true
  plain <"$OUT/boot.log" | grep -q "install stopped: its disks are not blank" ||
    fail "the guard stopped the install, but not because the disk was not blank"
  for _ in $(seq 60); do sudo kill -0 "$(sudo cat "$OUT/qemu.pid")" 2>/dev/null || break; sleep 2; done
  sudo kill -0 "$(sudo cat "$OUT/qemu.pid")" 2>/dev/null && fail "the guarded machine did not power off"
  log "the guard stopped it before writing anything, and it powered off"
  # The guard's event is in the telemetry: move it aside so Ready is waited for afresh.
  mkdir -p "$OUT/guard-telemetry"
  mv "$EVENTS"/otlp-*.jsonl "$OUT/guard-telemetry/" 2>/dev/null || true
  (cd "$F" && deno run -A --frozen stolos.ts boot arm "$SERVER" --claim --confirm-destroy "$SERVER" --fleet "$FLEET") ||
    fail "boot arm --confirm-destroy failed"
}

# Spec 049: the boot server's "install <host>" trace, continued by the host's first boot.
check_trace() {
  sleep 10 # the last batches
  deno run -A "$HERE/trace.ts" "$EVENTS" "$SERVER" ||
    fail "the host's first boot did not continue the install's trace"
  log "the host's first boot continued the install's trace"
}

# A fleet query's table has a row for the server whose ok column is 1.
answered() { grep -qE "^${SERVER}[[:space:]]+1([[:space:]]|\$)" "$1"; }

# The operator's view, from the runner (as the boot machine): stolos fleet query over MCP.
query_from_runner() {
  local ip
  ip=$(server_ip)
  [ -n "$ip" ] || fail "no address for $SERVER in the boot log"
  log "$SERVER is at $ip"
  echo "$ip $SERVER" | sudo tee -a /etc/hosts >/dev/null
  mkdir -p "$HOME/.ssh" && cp "$W/admin" "$HOME/.ssh/id_ed25519" && chmod 600 "$HOME/.ssh/id_ed25519"
  (cd "$F" && "${A[@]}" fleet query "select host, ok, passed, total from archon_install") |
    tee "$OUT/fleet-query.txt" || fail "fleet query failed"
  answered "$OUT/fleet-query.txt" || fail "fleet query did not answer ok for $SERVER"
  # Spec 051: what the machine is, as it reported itself.
  (cd "$F" && "${A[@]}" fleet query "select host, model, cpus, mem_mib, macs from archon_inventory") |
    tee "$OUT/fleet-inventory.txt" || fail "fleet query of archon_inventory failed"
  grep -q "^$SERVER" "$OUT/fleet-inventory.txt" || fail "no inventory from $SERVER"
}

# Power the server off and on again with less memory (the installer needed
# more; the workstation needs room): it must come back by itself, verified.
reboot_server() {
  local ip
  ip=$(server_ip)
  # Spec 054: as archon poweroff does, wait until nothing changes packages first.
  # The first boot starts Ubuntu's unattended upgrades at its end; Ubuntu's own
  # shutdown hook then waits for them, for as long as that day's updates take.
  local apt_wait
  apt_wait=$(date +%s)
  # (By command line: unattended-upgrade-shutdown always runs, and ps cuts names to 15 characters.)
  ssh_to "$ADMIN@$ip" 'for i in $(seq 240); do ps -eo args= | awk "{print \$1; print \$2}" | sed "s#.*/##" | grep -qxE "apt|apt-get|aptitude|dpkg|unattended-upgrade" || exit 0; sleep 5; done; exit 1' ||
    fail "$SERVER was still changing packages after 20 minutes"
  log "$SERVER: nothing changes packages ($(($(date +%s) - apt_wait)) seconds waited)"
  log "$SERVER: shut down (the power button), then on again from its disk (${E2E_SERVER_MEM:-2048} MiB)"
  # A clean shutdown, as an operator's would be: right after an install,
  # Ubuntu's unattended-upgrades may still be running apt, and its shutdown
  # hook waits for it. Cutting the power then can break dpkg's state.
  local pid start waited pidf sock console
  if [ "$INSTALL" = network ]; then
    pidf="$OUT/qemu.pid" sock="$OUT/monitor.sock" console="$OUT/console.log"
  else
    pidf="$OUT/$SERVER-qemu.pid" sock="$OUT/$SERVER-monitor.sock" console="$OUT/$SERVER-console.log"
  fi
  pid=$(sudo cat "$pidf")
  start=$(date +%s)
  echo system_powerdown | sudo nc -U -q 1 "$sock" >/dev/null 2>&1 || true
  for _ in $(seq 300); do sudo kill -0 "$pid" 2>/dev/null || break; sleep 2; done
  waited=$(($(date +%s) - start))
  if sudo kill -0 "$pid" 2>/dev/null; then
    sudo kill "$pid" 2>/dev/null || true
    fail "$SERVER did not shut down within $waited seconds of the power button"
  fi
  log "$SERVER shut down cleanly in $waited seconds"
  sudo mv "$console" "${console%.log}-install.log"
  if [ "$INSTALL" = network ]; then
    sudo E2E_VM_BOOT=disk E2E_VM_MEM="${E2E_SERVER_MEM:-2048}" "$HERE/vm.sh"
  else
    sudo E2E_VM_BOOT=disk E2E_VM_MEM="${E2E_SERVER_MEM:-2048}" "$HERE/cloud-vm.sh" "$SERVER" "$MAC" archtap0 "$ADMIN" "$W/admin.pub"
  fi
  for _ in $(seq 90); do ssh_to "$ADMIN@$ip" true 2>/dev/null && break; sleep 5; done
  ssh_to "$ADMIN@$ip" 'systemctl is-system-running --wait >/dev/null; archon verify' 2>&1 | plain |
    tee "$OUT/verify-after-reboot.txt" || fail "archon verify failed after a reboot"
  log "$SERVER came back from a reboot, verified"
}

# A workstation (spec 020): Ubuntu's cloud image, the repository at
# /srv/archon, stolos workstation add, then the agent's path to the server:
# stolos fleet query from the workstation, over MCP (spec 030).
workstation_stage() {
  [ -n "${WS:-}" ] || return 0
  log "$WS: Ubuntu cloud image"
  sudo E2E_VM_MEM="$WS_MB" "$HERE/cloud-vm.sh" "$WS" "$WS_MAC" archtap1 "$ADMIN" "$W/admin.pub"
  local ip s
  ip=$(lease_ip "$WS_MAC")
  [ -n "$ip" ] || fail "the workstation did not answer SSH on any of its leases"
  log "$WS is at $ip"
  local deno_v sip
  deno_v=$(deno --version | head -n 1 | cut -d' ' -f2)
  sip=$(server_ip)
  s="set -e
cloud-init status --wait >/dev/null || true
echo '$sip $SERVER' | sudo tee -a /etc/hosts >/dev/null
sudo apt-get install -y -q unzip >/dev/null
curl -fsSL https://deno.land/install.sh | sh -s -- -y v$deno_v >/dev/null
export PATH=\$HOME/.deno/bin:\$PATH
sudo mkdir -p /srv/archon && sudo chown \$USER: /srv/archon
git clone -q http://$BR:8000/fleet.git /srv/archon
cd /srv/archon
export ARCHON_GITHUB_API=http://$BR:8001
deno run -A --frozen stolos.ts --fleet $FLEET workstation add $WS"
  ssh_to "$ADMIN@$ip" "$s" 2>&1 | plain | tee "$OUT/workstation-add.txt" ||
    fail "stolos workstation add failed"
  log "$WS: set up; now the agent's path to $SERVER"
  scp -i "$W/admin" -o BatchMode=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
    -o LogLevel=ERROR "$W/admin" "$ADMIN@$ip:.ssh/id_ed25519"
  ssh_to "$ADMIN@$ip" "chmod 600 ~/.ssh/id_ed25519; archon verify && cd /srv/archon && /usr/local/bin/deno run -A --frozen stolos.ts --fleet $FLEET fleet query 'select host, ok from archon_install'" \
    2>&1 | plain | tee "$OUT/workstation-query.txt" || fail "the workstation could not query $SERVER"
  answered "$OUT/workstation-query.txt" || fail "the workstation's fleet query did not answer ok for $SERVER"
  log "$WS reached $SERVER over MCP"
}

run_lab() {
  if [ "$INSTALL" = network ]; then
    install_server
    check_trace
  else
    bootstrap_server
  fi
  # Spec 051: the network card, as the machine reported it, is now registered.
  grep -q 'macSource: "installed"' "$F/fleets/$FLEET/hosts/$SERVER/registration.ts" ||
    fail "registration.ts does not hold the MAC the machine reported"
  log "registration.ts: $(grep -oE 'mac: "[0-9a-f:]+"' "$F/fleets/$FLEET/hosts/$SERVER/registration.ts"), as the machine reported it"
  query_from_runner
  reboot_server
  workstation_stage
  log "passed"
}
