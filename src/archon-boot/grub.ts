// GRUB configs served to Ubuntu's network GRUB (spec 004). A machine is
// recognized by its own Boot URI (/boot/<host>/bootx64.efi) or, when the model
// names one, by its MAC. Anything else gets a menu of armed hosts whose
// default boots the local disk, so a stray network boot never reinstalls
// anything.

import type { HostDef } from "../archon/model/types.ts";
import { UBUNTU } from "./pins.ts";

/** The generic menu: hand the machine to its config by MAC address. */
export function mainMenu(): string {
  return `# archon-boot (spec 004): a machine without its own Boot URI is looked up by MAC.
set timeout=5
configfile /boot/hosts/\${net_default_mac}.cfg
menuentry "Not an Archon host (\${net_default_mac}): boot the local disk" {
  exit
}
`;
}

/** The install entry. GRUB fills in the MAC it booted from, so the installed network matches it. */
function installEntry(host: HostDef, base: string, token: string): string {
  // GRUB needs the ';' in the NoCloud URL escaped.
  const ds = `ds=nocloud-net\\;s=${base}install/${host.name}/${token}/\${net_default_mac}/`;
  return `menuentry "Archon: install ${host.name} (Ubuntu ${UBUNTU.point}, erases this machine's disk)" {
  linux /boot/linux ip=dhcp iso-url=${base}iso/${UBUNTU.iso.name} autoinstall ${ds} ---
  initrd /boot/initrd
}
`;
}

export function hostMenu(host: HostDef, base: string, token: string | undefined): string {
  if (!token) {
    return `# ${host.name} is not armed for an install.
set timeout=3
menuentry "${host.name}: not armed for install, booting its own disk (deno task boot arm ${host.name})" {
  exit
}
`;
  }
  return `# ${host.name}: unattended install of Ubuntu ${UBUNTU.point} (spec 004).
set timeout=3
${installEntry(host, base, token)}menuentry "${host.name}: boot the local disk instead" {
  exit
}
`;
}

/**
 * A machine the boot server does not recognize: list the armed hosts, but
 * boot the local disk unless someone at the console picks one.
 */
export function chooserMenu(armed: Array<{ host: HostDef; token: string }>, base: string): string {
  if (!armed.length) {
    return `# Unknown machine and no host is armed: boot the local disk.
set timeout=3
menuentry "Not an Archon host (\${net_default_mac}), nothing armed: boot the local disk" {
  exit
}
`;
  }
  return `# Unknown machine (spec 004): choose which armed host it becomes, or boot its disk.
set default=0
set timeout=60
menuentry "Unknown machine (\${net_default_mac}): boot the local disk" {
  exit
}
${armed.map((a) => installEntry(a.host, base, a.token)).join("")}`;
}
