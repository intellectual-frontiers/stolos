/**
 * The three ports the controller PC opens for Stolos (constitution Article 29, spec 103-three-ports): UDP 69 and TCP 8080 for the boot
 * server, TCP 443 for the console over TLS. The numbers are facts of the ontology (`stolos:Listener`); this module is the one place the
 * code reads them, so every listener that is not loopback-only takes its default from {@link standardPort} and marks any other port as
 * an explicit choice ({@link choosePort}), with its own firewall rule ({@link firewallRule}). `tests/ports103.test.ts` fails on a socket
 * opened anywhere else.
 *
 * @example
 * ```ts
 * import { choosePort, standardPort } from "./listeners.ts";
 * standardPort("console-https"); // 443
 * choosePort("boot-http", undefined); // { port: 8080, explicit: false }
 * choosePort("boot-http", 9090).explicit; // true
 * ```
 *
 * @module
 */
// Spec: 103-three-ports FR-001, FR-002, FR-011

import { LISTENERS, type ListenerKind } from "../ontology.auto.ts";

export type { ListenerKind } from "../ontology.auto.ts";

/** The standard port of a listener: the ontology's. */
export function standardPort(kind: ListenerKind): number {
  return LISTENERS[kind].port;
}

/** The standard transport of a listener, `tcp` or `udp`. */
export function standardProtocol(kind: ListenerKind): "tcp" | "udp" {
  return LISTENERS[kind].protocol;
}

/** A port a listener will use, and whether a person chose it. */
export interface PortChoice {
  /** The port to bind. */
  port: number;
  /** True where it is not the standard port: an explicit `--port` choice, outside the three. */
  explicit: boolean;
}

/** The port for a listener: the standard one, or the person's explicit choice (which is marked as such when it differs). */
export function choosePort(kind: ListenerKind, explicit?: number): PortChoice {
  const standard = standardPort(kind);
  return explicit === undefined || explicit === standard
    ? { port: standard, explicit: false }
    : { port: explicit, explicit: true };
}

/** Whether a protocol and port are one of the three standard listeners. */
export function isStandard(protocol: "tcp" | "udp", port: number): boolean {
  return Object.values(LISTENERS).some((l) => l.protocol === protocol && l.port === port);
}

/** The three ports as a person reads them: `UDP 69, TCP 8080, TCP 443`. */
export function standardPortsText(): string {
  return (Object.values(LISTENERS) as readonly { protocol: string; port: number }[])
    .map((l) => `${l.protocol.toUpperCase()} ${l.port}`)
    .join(", ");
}

/** The sentence that says a port is outside the three standard ones (Article 29). */
export function outsideStandardNote(protocol: "tcp" | "udp", port: number): string {
  return `${protocol.toUpperCase()} ${port} is outside the three standard ports (${standardPortsText()}): it is your explicit choice, and it needs its own firewall rule`;
}

/**
 * The exact command that allows one inbound port on the networks Stolos trusts (Windows Defender Firewall's Private and Domain
 * profiles, else ufw on the private ranges): never the internet (Article 28).
 */
export function firewallRule(
  os: string,
  protocol: "tcp" | "udp",
  port: number,
  what: string,
): string {
  return os === "windows"
    ? `New-NetFirewallRule -DisplayName "Stolos ${what}" -Direction Inbound -Protocol ${protocol.toUpperCase()} -LocalPort ${port} -Profile Private,Domain -Action Allow (PowerShell as Administrator)`
    : `sudo ufw allow from 10.0.0.0/8 to any port ${port} proto ${protocol} (and 172.16.0.0/12, 192.168.0.0/16: your LAN, never the internet)`;
}
