#!/bin/bash
# A machine from Ubuntu's cloud image of the fleet's release (verified against
# Ubuntu's SHA256SUMS), with a NoCloud seed that creates the admin's account
# with the given SSH key and passwordless sudo, as an Ubuntu installed by hand
# (or a desktop, or WSL) has for its first user.
#
#   cloud-vm.sh <name> <mac> <tap> <user> <public-key-file>
#
# E2E_VM_MEM memory in MiB (default 3072); E2E_VM_BOOT=disk boots the same
# disk again (a reboot) instead of a fresh copy of the image.
set -eu
W=$(cd "$(dirname "$0")" && pwd)/work
NAME=$1 MAC=$2 TAP=$3 U=$4
KEY=$(cut -d' ' -f1,2 "$5")
IMG_DIR=${E2E_CACHE:-/var/cache/archon-e2e}
BASE=https://cloud-images.ubuntu.com/resolute/current
IMG=resolute-server-cloudimg-amd64.img
mkdir -p "$W" "$IMG_DIR"
pkill -f "qemu-system-x86_64 -name e2e-$NAME -machine" || true
if [ "${E2E_VM_BOOT:-new}" != disk ]; then
  want=$(curl -fsSL "$BASE/SHA256SUMS" | grep " \*$IMG\$" | cut -d' ' -f1)
  if [ ! -f "$IMG_DIR/$IMG" ] || [ "$(sha256sum "$IMG_DIR/$IMG" | cut -d' ' -f1)" != "$want" ]; then
    curl -fsSL -o "$IMG_DIR/$IMG.partial" "$BASE/$IMG" && mv "$IMG_DIR/$IMG.partial" "$IMG_DIR/$IMG"
  fi
  [ "$(sha256sum "$IMG_DIR/$IMG" | cut -d' ' -f1)" = "$want" ] || { echo "cloud image checksum mismatch" >&2; exit 1; }
  rm -f "$W/$NAME.qcow2" "$W/$NAME-seed.iso"
  qemu-img create -q -f qcow2 -F qcow2 -b "$IMG_DIR/$IMG" "$W/$NAME.qcow2" 40G
  cat >"$W/$NAME-user-data" <<YAML
#cloud-config
hostname: $NAME
users:
  - name: $U
    shell: /bin/bash
    sudo: "ALL=(ALL) NOPASSWD:ALL"
    ssh_authorized_keys: ["$KEY"]
YAML
  printf 'instance-id: %s\nlocal-hostname: %s\n' "$NAME" "$NAME" >"$W/$NAME-meta-data"
  cloud-localds "$W/$NAME-seed.iso" "$W/$NAME-user-data" "$W/$NAME-meta-data"
fi
ACCEL=$([ -w /dev/kvm ] && echo kvm || echo tcg,thread=multi)
qemu-system-x86_64 -name "e2e-$NAME" -machine q35 -accel "$ACCEL" -cpu max -m "${E2E_VM_MEM:-3072}" -smp 2 \
  -drive file="$W/$NAME.qcow2",if=virtio,format=qcow2 \
  -drive file="$W/$NAME-seed.iso",if=virtio,format=raw,readonly=on \
  -device virtio-balloon-pci,free-page-reporting=on \
  -netdev tap,id=n0,ifname="$TAP",script=no,downscript=no \
  -device virtio-net-pci,netdev=n0,mac="$MAC" \
  -display none -serial file:"$W/$NAME-console.log" \
  -monitor unix:"$W/$NAME-monitor.sock",server,nowait \
  -daemonize -pidfile "$W/$NAME-qemu.pid"
echo "$NAME started from Ubuntu's cloud image (accel $ACCEL, ${E2E_VM_MEM:-3072} MiB, ${E2E_VM_BOOT:-new})"
