#!/bin/bash
# End-to-end install in CI (spec 004 SC-001, specs 046 to 049): a blank UEFI
# VM with Secure Boot network-boots from archon-boot and installs as host e2e
# of a throwaway fleet, built from THIS checkout of the engine:
#
#   - the fleet repository (fleets/e2e) is made here, its tip signed with a
#     fresh key that signers.ts lists, and served over HTTP on the lab bridge,
#     with this checkout as its @stolos/ (so the VM runs the engine under test);
#   - the boot server runs from that fleet repository;
#   - done when the boot server records the event boot.ready (spec 049); then
#     the runner asks the VM through its MCP server (archon fleet query).
#
# Needs: root through sudo, KVM, qemu-system-x86, ovmf, dnsmasq-base, Deno.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
ENGINE=$(cd "$HERE/../.." && pwd)
W=${E2E_WORK:-/tmp/archon-e2e}
BR=10.77.0.1
MAC=52:54:00:12:34:56
TIMEOUT_MIN=${E2E_TIMEOUT_MIN:-80}
rm -rf "$W" && mkdir -p "$W/www" "$HERE/work"
export ARCHON_REPO="$W/fleet" ARCHON_FLEET=e2e
log() { echo "e2e: $*"; }
# Whatever happens, the logs can be uploaded (QEMU writes its console as root).
trap 'sudo chmod -R a+rX "$HERE/work" 2>/dev/null || true' EXIT

# On failure: everything the boot server recorded, and what the VM says about itself.
diagnose() {
  echo "::group::boot.log (every event the boot server recorded)"
  sed 's/\x1b\[[0-9;]*m//g' "$HERE/work/boot.log" || true
  echo "::endgroup::"
  local ip
  # The installed system's address: the one its last event came from (the
  # installer had another lease, with the same MAC).
  ip=$(sed 's/\x1b\[[0-9;]*m//g' "$HERE/work/boot.log" | grep -E ' e2e ' | grep -oE '10\.77\.0\.[0-9]+' | tail -n 1)
  [ -n "$ip" ] || return 0
  echo "::group::the VM ($ip): archon state, archon verify, its run logs"
  local s=(ssh -i "$W/admin" -o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new tester@"$ip")
  "${s[@]}" 'archon state; archon verify; archon query "select problems from archon_install"; for f in $(ls -t /var/log/archon/*.log 2>/dev/null | head -n 3); do echo "== $f"; tail -n 80 "$f"; done' \
    2>&1 | sed 's/\x1b\[[0-9;]*m//g' | tee "$HERE/work/vm-diagnosis.txt" || true
  echo "::endgroup::"
}

# ------------------------------------------------------------ the lab network
log "bridge, NAT, DHCP with the network-boot file"
sudo ip link show archbr0 >/dev/null 2>&1 || {
  sudo ip link add archbr0 type bridge
  sudo ip addr add $BR/24 dev archbr0
}
sudo ip link set archbr0 up
sudo ip link show archtap0 >/dev/null 2>&1 || {
  sudo ip tuntap add dev archtap0 mode tap user "$(id -un)"
  sudo ip link set archtap0 master archbr0
}
sudo ip link set archtap0 up
sudo sysctl -q -w net.ipv4.ip_forward=1
sudo sysctl -q -w net.ipv4.ip_unprivileged_port_start=69 # archon-boot's TFTP, as this user
sudo iptables -t nat -C POSTROUTING -s 10.77.0.0/24 ! -o archbr0 -j MASQUERADE 2>/dev/null ||
  sudo iptables -t nat -A POSTROUTING -s 10.77.0.0/24 ! -o archbr0 -j MASQUERADE
sudo iptables -I FORWARD -i archbr0 -j ACCEPT
sudo iptables -I FORWARD -o archbr0 -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT
sudo dnsmasq --interface=archbr0 --bind-interfaces --port=0 --except-interface=lo \
  --dhcp-range=10.77.0.50,10.77.0.99,12h --dhcp-option=3,$BR --dhcp-option=6,1.1.1.1,9.9.9.9 \
  --no-ping --dhcp-boot=bootx64.efi,,$BR --dhcp-leasefile="$W/leases" \
  --log-dhcp --log-facility="$HERE/work/dnsmasq.log" --pid-file="$W/dnsmasq.pid"

# --------------------------------------------- the engine under test, served
ln -s "$ENGINE" "$W/www/stolos"
deno run -A "$HERE/serve.ts" "$W/www" $BR 8000 >"$HERE/work/http.log" 2>&1 &
for _ in $(seq 50); do curl -fsS -o /dev/null "http://$BR:8000/stolos/src/archon/version.ts" && break; sleep 0.2; done

# ----------------------------------------------------- the throwaway fleet
log "fleet repository e2e, signed"
F="$W/fleet"
mkdir -p "$F/fleets/e2e"
ssh-keygen -q -t ed25519 -N "" -C "" -f "$W/admin"     # the admin's (and ops') SSH key
ssh-keygen -q -t ed25519 -N "" -C "" -f "$W/signer"    # the fleet's signer
cat >"$F/deno.json" <<EOF
{ "imports": { "@stolos/": "http://$BR:8000/stolos/src/" } }
EOF
printf 'import { run } from "@stolos/archon/main.ts";\n\nawait run();\n' >"$F/archon.ts"
printf 'import { run } from "@stolos/archon-boot/main.ts";\n\nawait run();\n' >"$F/boot.ts"
# Every engine module, so deno.lock pins them all (archon runs with --frozen).
printf 'import "@stolos/archon/modules.auto.ts";\n' >"$F/engine.ts"
cat >"$F/fleets/e2e/fleet.ts" <<EOF
// The end-to-end test's fleet (tests/e2e/ci.sh): made for one run, thrown away.
import type { FleetDef } from "@stolos/archon/model/types.ts";

export const fleet: FleetDef = {
  id: "e2e",
  title: "End-to-end test fleet",
  repository: { slug: "e2e/fleet", url: "http://$BR:8000/fleet.git" },
  ubuntu: { release: "26.04", codename: "resolute" },
  timezone: "America/New_York",
  locale: "en_US.UTF-8",
  keyboard: "us",
  network: { ipv6: false },
  admin: {
    user: "tester",
    uid: 1000,
    github: {
      login: "tester",
      id: 1,
      name: "End-to-end tester",
      email: "1+tester@users.noreply.github.com",
      sshKeys: ["$(cut -d' ' -f1,2 "$W/admin.pub")"],
    },
  },
};
EOF
cd "$F"
printf "out/\n" >.gitignore
git init -q -b main
git config user.name "e2e"
git config user.email "e2e@example.invalid"
deno cache --allow-import --lock=deno.lock archon.ts boot.ts engine.ts >/dev/null
A=(deno run -A --frozen archon.ts)
"${A[@]}" signers add e2e-daily --role daily --key "$W/signer.pub"
# The admin password: a hash only (never used to log in here).
mkdir -p "$HOME/.config/archon/secrets/e2e"
openssl passwd -6 "$(openssl rand -hex 16)" >"$HOME/.config/archon/secrets/e2e/admin-password.hash"
chmod 600 "$HOME/.config/archon/secrets/e2e/admin-password.hash"
"${A[@]}" host add e2e --mac $MAC --no-deploy-key --no-push
"${A[@]}" build
git add -A
git -c gpg.format=ssh -c gpg.ssh.program=ssh-keygen -c user.signingkey="$W/signer" \
  commit -q -S -m "e2e: the fleet"
git clone -q --bare "$F" "$W/www/fleet.git"
git -C "$W/www/fleet.git" update-server-info
cd "$ENGINE"

# ------------------------------------------------- boot server, then the VM
log "boot server (downloads Ubuntu's boot files and image on its first run)"
(cd "$F" && exec deno run -A --frozen boot.ts serve --port 8080) >"$HERE/work/boot.log" 2>&1 &
for _ in $(seq 600); do curl -fsS -o /dev/null "http://$BR:8080/health" && break; sleep 2; done
curl -fsS "http://$BR:8080/health"
log "blank VM, Secure Boot on, network boot"
sudo "$HERE/vm.sh"

# ------------------------------------------- wait for the event boot.ready
EVENTS="$HOME/.local/share/archon/boot/telemetry"
deadline=$(($(date +%s) + TIMEOUT_MIN * 60))
result=""
while [ "$(date +%s)" -lt "$deadline" ]; do
  if grep -qs '"boot.ready"' "$EVENTS"/otlp-*.jsonl; then result=ready; break; fi
  if grep -qs '"boot.done-with-problems"' "$EVENTS"/otlp-*.jsonl; then result=problems; break; fi
  if ! sudo kill -0 "$(sudo cat "$HERE/work/qemu.pid")" 2>/dev/null; then result=vm-stopped; break; fi
  sleep 30
  # Every event since the last look (the full log is printed on failure too).
  n=$(wc -l <"$HERE/work/boot.log")
  sed -n "$((${seen:-0} + 1)),${n}p" "$HERE/work/boot.log" | sed 's/\x1b\[[0-9;]*m//g'
  seen=$n
done
cp -r "$EVENTS" "$HERE/work/telemetry" 2>/dev/null || true
log "install: ${result:-timed out after $TIMEOUT_MIN minutes}"
if [ "$result" != ready ]; then diagnose; exit 1; fi

# ------------------------- ask the VM through its MCP server, as an operator
ip=$(sed 's/\x1b\[[0-9;]*m//g' "$HERE/work/boot.log" | grep -E ' e2e ' | grep -oE '10\.77\.0\.[0-9]+' | tail -n 1)
log "e2e is at $ip"
echo "$ip e2e" | sudo tee -a /etc/hosts >/dev/null
mkdir -p "$HOME/.ssh" && cp "$W/admin" "$HOME/.ssh/id_ed25519" && chmod 600 "$HOME/.ssh/id_ed25519"
cd "$F"
if ! "${A[@]}" fleet query "select host, ok, passed, total from archon_install" | tee "$HERE/work/fleet-query.txt" ||
  ! grep -q "e2e" "$HERE/work/fleet-query.txt"; then
  diagnose
  exit 1
fi
log "passed"
