#!/bin/bash
# A UEFI machine with Secure Boot on the lab bridge.
#   (default)        a blank disk that network-boots from archon-boot;
#   E2E_VM_BOOT=disk the same disk again, as installed (a reboot);
#   E2E_VM_MEM       memory in MiB (default 8192: Ubuntu's live installer runs from memory).
set -eu
W=$(cd "$(dirname "$0")" && pwd)/work
mkdir -p "$W"
pkill -f "qemu-system-x86_64 -name e2e-server" || true
if [ "${E2E_VM_BOOT:-net}" != disk ]; then
  rm -f "$W/disk.qcow2" "$W/vars.fd"
  qemu-img create -q -f qcow2 "$W/disk.qcow2" 40G
  cp /usr/share/OVMF/OVMF_VARS_4M.ms.fd "$W/vars.fd"
fi
ACCEL=$([ -w /dev/kvm ] && echo kvm || echo tcg,thread=multi)
qemu-system-x86_64 -name e2e-server -machine q35,smm=on -accel "$ACCEL" -cpu max -m "${E2E_VM_MEM:-8192}" -smp 2 \
  -global driver=cfi.pflash01,property=secure,value=on \
  -drive if=pflash,format=raw,unit=0,file=/usr/share/OVMF/OVMF_CODE_4M.secboot.fd,readonly=on \
  -drive if=pflash,format=raw,unit=1,file="$W/vars.fd" \
  -drive file="$W/disk.qcow2",if=virtio,format=qcow2 \
  -device virtio-balloon-pci,free-page-reporting=on \
  -netdev tap,id=n0,ifname=archtap0,script=no,downscript=no \
  -device virtio-net-pci,netdev=n0,mac=52:54:00:12:34:56,romfile= \
  -display none -serial file:"$W/console.log" -monitor unix:"$W/monitor.sock",server,nowait \
  -daemonize -pidfile "$W/qemu.pid"
echo "vm started (accel $ACCEL, ${E2E_VM_MEM:-8192} MiB, ${E2E_VM_BOOT:-net} boot)"
