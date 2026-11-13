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

# The address a host's last event came from (an installer had another lease).
# (Never fails: an empty answer means none yet; set -e would end the run.)
server_ip() {
  { plain <"$OUT/boot.log" | grep -E " $SERVER " | grep -oE '10\.77\.0\.[0-9]+' | tail -n 1; } || true
}

ssh_to() { # ssh_to <user@address> <command>
  ssh -i "$W/admin" -o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=no \
    -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR "$1" "$2"
}

# On failure: everything the boot server recorded, and what the machines say.
diagnose() {
  echo "::group::boot.log (every event the boot server recorded)"
  plain <"$OUT/boot.log" || true
  echo "::endgroup::"
  local ip
  ip=$(server_ip || true)
  if [ -n "$ip" ]; then
    echo "::group::$SERVER ($ip): archon state, archon verify, its run logs"
    ssh_to "$ADMIN@$ip" 'archon state; archon verify; archon query "select problems from archon_install"; for f in $(ls -t /var/log/archon/*.log 2>/dev/null | head -n 3); do echo "== $f"; tail -n 80 "$f"; done' \
      2>&1 | plain | tee "$OUT/vm-diagnosis.txt" || true
    echo "::endgroup::"
  fi
  if [ -f "$OUT/ws-console.log" ]; then
    echo "::group::workstation console (last 80 lines)"
    sudo tail -n 80 "$OUT/ws-console.log" | plain || true
    echo "::endgroup::"
  fi
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
  # With OpenTelemetry on, as a fleet repository's `deno task boot` runs it (spec 049).
  (cd "$F" && OTEL_DENO=true OTEL_SERVICE_NAME=archon-boot OTEL_EXPORTER_OTLP_PROTOCOL=http/json \
    OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4319 exec deno run -A --frozen boot.ts serve \
    --fleet "$FLEET" --port 8080) >"$OUT/boot.log" 2>&1 &
  for _ in $(seq 600); do curl -fsS -o /dev/null "http://$BR:8080/health" && break; sleep 2; done
  curl -fsS "http://$BR:8080/health"
  log "$SERVER: blank VM, Secure Boot on, network boot"
  sudo "$HERE/vm.sh"
  local deadline result="" seen=0 n
  deadline=$(($(date +%s) + TIMEOUT_MIN * 60))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    if grep -qs '"boot.ready"' "$EVENTS"/otlp-*.jsonl; then result=ready; break; fi
    if grep -qs '"boot.done-with-problems"' "$EVENTS"/otlp-*.jsonl; then result=problems; break; fi
    if ! sudo kill -0 "$(sudo cat "$OUT/qemu.pid")" 2>/dev/null; then result=vm-stopped; break; fi
    sleep 30
    n=$(wc -l <"$OUT/boot.log")
    sed -n "$((seen + 1)),${n}p" "$OUT/boot.log" | plain
    seen=$n
  done
  cp -r "$EVENTS" "$OUT/telemetry" 2>/dev/null || true
  log "install: ${result:-timed out after $TIMEOUT_MIN minutes}"
  [ "$result" = ready ] || fail "the install did not reach Ready"
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

# The operator's view, from the runner (as the boot machine): archon fleet query over MCP.
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
}

# Power the server off and on again with less memory (the installer needed
# more; the workstation needs room): it must come back by itself, verified.
reboot_server() {
  local ip
  ip=$(server_ip)
  log "$SERVER: shut down (the power button), then on again from its disk (${E2E_SERVER_MEM:-2048} MiB)"
  # A clean shutdown, as an operator's would be: right after an install,
  # Ubuntu's unattended-upgrades may still be running apt, and its shutdown
  # hook waits for it. Cutting the power then can break dpkg's state.
  local pid start waited
  pid=$(sudo cat "$OUT/qemu.pid")
  start=$(date +%s)
  echo system_powerdown | sudo nc -U -q 1 "$OUT/monitor.sock" >/dev/null 2>&1 || true
  for _ in $(seq 300); do sudo kill -0 "$pid" 2>/dev/null || break; sleep 2; done
  waited=$(($(date +%s) - start))
  if sudo kill -0 "$pid" 2>/dev/null; then
    sudo kill "$pid" 2>/dev/null || true
    fail "$SERVER did not shut down within $waited seconds of the power button"
  fi
  log "$SERVER shut down cleanly in $waited seconds"
  sudo mv "$OUT/console.log" "$OUT/console-install.log"
  sudo E2E_VM_BOOT=disk E2E_VM_MEM="${E2E_SERVER_MEM:-2048}" "$HERE/vm.sh"
  for _ in $(seq 90); do ssh_to "$ADMIN@$ip" true 2>/dev/null && break; sleep 5; done
  ssh_to "$ADMIN@$ip" 'systemctl is-system-running --wait >/dev/null; archon verify' 2>&1 | plain |
    tee "$OUT/verify-after-reboot.txt" || fail "archon verify failed after a reboot"
  log "$SERVER came back from a reboot, verified"
}

# A workstation (spec 020): Ubuntu's cloud image, the repository at
# /srv/archon, archon workstation add, then the agent's path to the server:
# archon fleet query from the workstation, over MCP (spec 030).
workstation_stage() {
  [ -n "${WS:-}" ] || return 0
  log "$WS: Ubuntu cloud image"
  sudo "$HERE/ws-vm.sh" "$ADMIN" "$W/admin.pub"
  local ip="" s cand
  # Its card can hold more than one lease (an early DHCP client, then the
  # booted system's): try each, newest first, until one answers SSH.
  for _ in $(seq 60); do
    for cand in $(awk -v m="$WS_MAC" 'tolower($2) == m { print $1, $3 }' "$W/leases" 2>/dev/null |
      sort -rn | awk '{ print $2 }'); do
      if ssh_to "$ADMIN@$cand" true 2>/dev/null; then ip=$cand; break 2; fi
    done
    sleep 5
  done
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
deno run -A --frozen archon.ts --fleet $FLEET workstation add $WS"
  ssh_to "$ADMIN@$ip" "$s" 2>&1 | plain | tee "$OUT/workstation-add.txt" ||
    fail "archon workstation add failed"
  log "$WS: set up; now the agent's path to $SERVER"
  scp -i "$W/admin" -o BatchMode=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
    -o LogLevel=ERROR "$W/admin" "$ADMIN@$ip:.ssh/id_ed25519"
  ssh_to "$ADMIN@$ip" "chmod 600 ~/.ssh/id_ed25519; archon verify && cd /srv/archon && archon fleet query 'select host, ok from archon_install'" \
    2>&1 | plain | tee "$OUT/workstation-query.txt" || fail "the workstation could not query $SERVER"
  answered "$OUT/workstation-query.txt" || fail "the workstation's fleet query did not answer ok for $SERVER"
  log "$WS reached $SERVER over MCP"
}

run_lab() {
  install_server
  check_trace
  query_from_runner
  reboot_server
  workstation_stage
  log "passed"
}
