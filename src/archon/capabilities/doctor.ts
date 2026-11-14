/**
 * 026-doctor: the network tools archon doctor calls. Ubuntu Server already
 * ships each of them (ubuntu-minimal and ubuntu-standard in 26.04); declaring
 * them keeps them there on a host installed with fewer packages.
 *
 * @module
 */

import type { Capability } from "../model/types.ts";

const SPEC = "026-doctor" as const;

export const DOCTOR_PACKAGES = [
  "iproute2", // ip
  "iputils-ping", // ping
  "iputils-tracepath", // tracepath
  "bind9-dnsutils", // dig
  "mtr-tiny", // mtr (archon doctor --trace)
  "ethtool",
  "tcpdump",
  "curl",
];

export const doctor = (): Capability => () => ({
  spec: SPEC,
  packages: DOCTOR_PACKAGES.map((name) => ({ name, spec: SPEC })),
  notes: [
    "archon doctor checks the link, gateway, DNS, IPv6, time, firewall, every endpoint this host uses, and email.",
  ],
});
