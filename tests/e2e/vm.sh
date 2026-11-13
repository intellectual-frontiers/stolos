#!/bin/bash
# A blank UEFI machine with Secure Boot that network-boots from archon-boot.
set -eu
W=$(cd "$(dirname "$0")" && pwd)/work
mkdir -p "$W"
pkill -f "qemu-system-x86_64 -name e2e" || true
rm -f "$W/disk.qcow2" "$W/vars.fd"
qemu-img create -q -f qcow2 "$W/disk.qcow2" 40G
cp /usr/share/OVMF/OVMF_VARS_4M.ms.fd "$W/vars.fd"
ACCEL=$([ -w /dev/kvm ] && echo kvm || echo tcg,thread=multi)
qemu-system-x86_64 -name e2e -machine q35,smm=on -accel "$ACCEL" -cpu max -m 8192 -smp 2 \
  -global driver=cfi.pflash01,property=secure,value=on \
  -drive if=pflash,format=raw,unit=0,file=/usr/share/OVMF/OVMF_CODE_4M.secboot.fd,readonly=on \
  -drive if=pflash,format=raw,unit=1,file="$W/vars.fd" \
  -drive file="$W/disk.qcow2",if=virtio,format=qcow2 \
  -netdev tap,id=n0,ifname=archtap0,script=no,downscript=no \
  -device virtio-net-pci,netdev=n0,mac=52:54:00:12:34:56,romfile= \
  -display none -serial file:"$W/console.log" -monitor unix:"$W/monitor.sock",server,nowait \
  -daemonize -pidfile "$W/qemu.pid"
echo "vm started (accel $ACCEL)"
