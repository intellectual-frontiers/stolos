#!/bin/bash
# Bridge archbr0 (10.77.0.1/24) with a tap for the VM, dnsmasq handing out the
# PXE boot file (as a home router's Network Boot setting does), and archon-boot.
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/../.." && pwd)
W=$HERE/work
mkdir -p "$W"
ip link show archbr0 >/dev/null 2>&1 || { ip link add archbr0 type bridge; ip addr add 10.77.0.1/24 dev archbr0; }
ip link set archbr0 up
ip link show archtap0 >/dev/null 2>&1 || { ip tuntap add dev archtap0 mode tap; ip link set archtap0 master archbr0; }
ip link set archtap0 up
[ -f "$W/dnsmasq.pid" ] && kill "$(cat "$W/dnsmasq.pid")" 2>/dev/null || true
dnsmasq --interface=archbr0 --bind-interfaces --port=0 --except-interface=lo \
  --dhcp-range=10.77.0.50,10.77.0.99,12h --dhcp-option=3,10.77.0.1 --no-ping \
  --dhcp-boot=bootx64.efi,,10.77.0.1 \
  --log-dhcp --log-facility="$W/dnsmasq.log" --pid-file="$W/dnsmasq.pid"
pkill -f "stolos/main.ts boot serve" || true
cd "$REPO"
setsid bun src/stolos/main.ts boot serve --port 8080 </dev/null >"$W/boot.log" 2>&1 &
echo "lab up: tail -f $W/boot.log"
