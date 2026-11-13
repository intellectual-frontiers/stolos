// The boot machine's LAN addresses and the Boot URIs built from them (spec 004).

export const BOOT_PORT = 8080;

/** Virtual adapters (WSL, Hyper-V, containers, VPNs) come after real ones. */
const VIRTUAL =
  /vEthernet|WSL|Hyper-V|VirtualBox|VMware|docker|^br-|virbr|veth|tailscale|ZeroTier|utun|wg\d/i;

/** An address given with `boot serve --address`, used first everywhere. */
let preferred: string | undefined;
export function preferAddress(a: string | undefined) {
  preferred = a;
}

/** This machine's LAN IPv4 addresses (no loopback or link-local), real adapters first. */
export function lanAddresses(): string[] {
  let found: string[] = [];
  try {
    found = Deno.networkInterfaces()
      .filter((i) =>
        i.family === "IPv4" && !i.address.startsWith("127.") && !i.address.startsWith("169.254.")
      )
      .sort((a, b) => Number(VIRTUAL.test(a.name)) - Number(VIRTUAL.test(b.name)))
      .map((i) => i.address);
  } catch { /* no interface list */ }
  return preferred ? [preferred, ...found.filter((a) => a !== preferred)] : found;
}

/** The Boot URI for the BIOS: a host's own (recognized without its MAC), or the generic one. */
export function bootUri(address: string, port = BOOT_PORT, host?: string): string {
  return `http://${address}:${port}/boot/${host ? `${host}/` : ""}bootx64.efi`;
}

const toInt = (ip: string) => ip.split(".").reduce((n, o) => (n << 8) + Number(o), 0) >>> 0;

/** This machine's address on the client's subnet (what a PXE client can reach), else the first LAN address. */
export function addressFacing(client: string): string | undefined {
  if (preferred) return preferred;
  try {
    for (const i of Deno.networkInterfaces()) {
      if (i.family !== "IPv4" || !i.netmask) continue;
      const mask = toInt(i.netmask);
      if (mask && (toInt(i.address) & mask) === (toInt(client) & mask)) return i.address;
    }
  } catch { /* no interface list */ }
  return lanAddresses()[0];
}
