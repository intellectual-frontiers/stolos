/**
 * Spec 098 (FR-010): `stolos mesh`, guidance only. Stolos does not install, configure, or depend on
 * any network product. Constitution Article 28 says where the fleet's own plain-HTTP exchanges
 * (PXE, HTTP Boot, pairing) may run: the site's LAN, or a zero trust mesh network for a device that
 * is not on it. This command says what that means in practice: the choices, how to tell which of
 * this PC's addresses are on a mesh, and what to type next.
 *
 * A zero trust mesh network (an overlay) connects each device directly to the others it may reach,
 * encrypted end to end (usually WireGuard), with each device known by an identity rather than by
 * where it is plugged in, and access decided by policy. Nothing listens on the internet.
 *
 * @module
 */

import { proc } from "@intellectual-frontiers/commons/ts/runtime";

/** One mesh network a fleet may use. Stolos recommends none in particular. */
export interface MeshOption {
  /** Its name. */
  name: string;
  /** What it is, and who runs its coordination. */
  what: string;
  /** Where to start. */
  site: string;
}

/** The common choices, open source and hosted. Any network that meets Article 28 will do. */
export const MESH_OPTIONS: readonly MeshOption[] = [
  {
    name: "Tailscale",
    what: "WireGuard mesh with a hosted coordination server and identity from your existing sign-in; access by policy (ACLs). The quickest start.",
    site: "https://tailscale.com",
  },
  {
    name: "Headscale",
    what: "An open source, self-hosted coordination server for the Tailscale clients: the same mesh, with nothing hosted by a vendor.",
    site: "https://headscale.net",
  },
  {
    name: "NetBird",
    what: "An open source WireGuard mesh with identity-based access policies; hosted, or entirely self-hosted.",
    site: "https://netbird.io",
  },
  {
    name: "ZeroTier",
    what: "A mesh with its own protocol; hosted controllers, or a self-hosted one.",
    site: "https://www.zerotier.com",
  },
  {
    name: "Nebula",
    what: "An open source mesh you run yourself, with its own certificate authority for device identities.",
    site: "https://github.com/slackhq/nebula",
  },
  {
    name: "WireGuard",
    what: "The tunnel underneath most of the above, configured by hand: right for a few fixed peers, with no coordination to run.",
    site: "https://www.wireguard.com",
  },
];

/** Interface names the mesh clients above use. */
const MESH_IFACE = /^(tailscale|ts\d|zt|ZeroTier|wt\d|nebula|wg|WireGuard|utun)/i;

/** Whether an IPv4 address is in 100.64.0.0/10 (carrier-grade NAT, used by Tailscale and NetBird). */
export function isCgnat(address: string): boolean {
  const [a, b] = address.split(".").map(Number);
  return a === 100 && b !== undefined && b >= 64 && b <= 127;
}

/** This PC's addresses that look like a mesh network's: by interface name, or 100.64.0.0/10. */
export function meshAddresses(
  ifaces: ReadonlyArray<{
    name: string;
    family: string;
    address: string;
  }> = proc.networkInterfaces(),
): Array<{ name: string; address: string }> {
  return ifaces
    .filter((i) => i.family === "IPv4" && (MESH_IFACE.test(i.name) || isCgnat(i.address)))
    .map((i) => ({ name: i.name, address: i.address }));
}

/** The guidance `stolos mesh` prints. */
export function meshGuide(found: ReadonlyArray<{ name: string; address: string }>): string {
  const lines = [
    "Stolos's network rule (constitution Article 28): the fleet's plain-HTTP exchanges (PXE and",
    "HTTP Boot, stolos pair) run on the site's LAN, or on a zero trust mesh network for a device",
    "that is not on it. Never open their ports to the internet. Stolos installs no network product:",
    "choose one, install it on this PC and on the device, and allow only what each may reach.",
    "",
    "Zero trust mesh networks (any of them will do):",
    ...MESH_OPTIONS.map((o) => `  ${o.name.padEnd(10)} ${o.what}\n  ${"".padEnd(10)} ${o.site}`),
    "",
    "What to look for: devices known by identity (not by address), end-to-end encryption,",
    "access by policy (this PC may reach the device, not the reverse unless needed), and a",
    "coordination server you either trust or run yourself.",
    "",
  ];
  if (found.length) {
    lines.push("This PC's mesh addresses:");
    for (const f of found) lines.push(`  ${f.address.padEnd(16)} ${f.name}`);
    lines.push(
      "",
      "Pair a device on the mesh (it reaches this PC at that address):",
      `  bun run stolos pair --address ${found[0]?.address ?? "<mesh address>"}`,
    );
  } else {
    lines.push(
      "This PC has no mesh address yet. Once it has one, pair a device on the mesh with:",
      "  bun run stolos pair --address <this PC's mesh address>",
    );
  }
  return `${lines.join("\n")}\n`;
}
