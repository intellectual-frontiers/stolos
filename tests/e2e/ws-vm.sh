#!/bin/bash
# A workstation: Ubuntu's cloud image of the fleet's release (verified against
# Ubuntu's SHA256SUMS), with a NoCloud seed that creates the admin's account
# with the given SSH key and passwordless sudo, as a desktop or WSL Ubuntu has
# for its first user. Usage: ws-vm.sh <user> <public-key-file>
set -eu
W=$(cd "$(dirname "$0")" && pwd)/work
U=$1
KEY=$(cut -d' ' -f1,2 "$2")
IMG_DIR=${E2E_CACHE:-$HOME/.cache/archon-e2e}
BASE=https://cloud-images.ubuntu.com/resolute/current
IMG=resolute-server-cloudimg-amd64.img
mkdir -p "$W" "$IMG_DIR"
sums=$(curl -fsSL "$BASE/SHA256SUMS")
want=$(echo "$sums" | grep " \*$IMG\$" | cut -d' ' -f1)
if [ ! -f "$IMG_DIR/$IMG" ] || [ "$(sha256sum "$IMG_DIR/$IMG" | cut -d' ' -f1)" != "$want" ]; then
  curl -fsSL -o "$IMG_DIR/$IMG" "$BASE/$IMG"
fi
[ "$(sha256sum "$IMG_DIR/$IMG" | cut -d' ' -f1)" = "$want" ] || { echo "cloud image checksum mismatch" >&2; exit 1; }
rm -f "$W/ws.qcow2" "$W/ws-seed.iso"
qemu-img create -q -f qcow2 -F qcow2 -b "$IMG_DIR/$IMG" "$W/ws.qcow2" 20G
cat >"$W/ws-user-data" <<YAML
#cloud-config
hostname: ws
users:
  - name: $U
    shell: /bin/bash
    sudo: "ALL=(ALL) NOPASSWD:ALL"
    ssh_authorized_keys: ["$KEY"]
YAML
printf 'instance-id: ws\nlocal-hostname: ws\n' >"$W/ws-meta-data"
cloud-localds "$W/ws-seed.iso" "$W/ws-user-data" "$W/ws-meta-data"
ACCEL=$([ -w /dev/kvm ] && echo kvm || echo tcg,thread=multi)
qemu-system-x86_64 -name e2e-ws -machine q35 -accel "$ACCEL" -cpu max -m "${E2E_WS_MEM:-4096}" -smp 2 \
  -drive file="$W/ws.qcow2",if=virtio,format=qcow2 \
  -drive file="$W/ws-seed.iso",if=virtio,format=raw,readonly=on \
  -netdev tap,id=n0,ifname=archtap1,script=no,downscript=no \
  -device virtio-net-pci,netdev=n0,mac=52:54:00:12:34:57 \
  -display none -serial file:"$W/ws-console.log" \
  -daemonize -pidfile "$W/ws-qemu.pid"
echo "workstation vm started (accel $ACCEL)"
