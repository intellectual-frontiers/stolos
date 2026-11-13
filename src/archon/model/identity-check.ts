// Spec 051: a check that ties a host to the machine it installed on.

/** The verify check (spec 051): the network card registered for the host is in this machine. */
export function registeredCardCheck(mac: string) {
  return {
    name: "identity:registered-network-card",
    command: `sh -c 'cat /sys/class/net/*/address | grep -qix ${mac}'`,
    level: "warn" as const,
    fix:
      `the network card registered for this host (${mac}, registration.ts) is not in this machine: a replaced card or board? Record the new one from the boot machine: deno task boot arm <host> --mac-address <new mac> (or reinstall it with --claim)`,
    spec: "051-machine-identity" as const,
  };
}
