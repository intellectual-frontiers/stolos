// Spec 049-telemetry (Article 27): events are structured at their source.
// Each event has a declared name (below), a severity, the host and address it
// is about, attributes, and a message; it is recorded as an OpenTelemetry log
// record. Anything a person reads (the boot server's window, boot.log) is a
// rendering of these records, never the source: the window's icons, colors,
// and de-duplication come from the event's name and attributes, not from
// parsing its text.

export type Severity = "debug" | "info" | "warn" | "error";

export interface EventSpec {
  severity: Severity;
  description: string;
}

export const EVENTS = {
  // The boot server (spec 004).
  "boot.file": { severity: "info", description: "A boot file served (TFTP or HTTP)." },
  "boot.file.probe": {
    severity: "debug",
    description: "A file GRUB or the shim looks for and does without (not found is normal).",
  },
  "boot.file.substituted": {
    severity: "warn",
    description: "The router asked for another boot loader; Ubuntu's shim was served instead.",
  },
  "boot.http.missing": {
    severity: "warn",
    description: "A machine loaded the installer over TFTP but never reached HTTP.",
  },
  "boot.uri.unknown": { severity: "warn", description: "A Boot URI names no host." },
  "boot.menu": { severity: "info", description: "A GRUB menu was served." },
  "boot.claimed": { severity: "info", description: "An unknown machine became an armed host." },
  "boot.recognized": {
    severity: "info",
    description: "An armed host was recognized by its address; its MAC was learned.",
  },
  "boot.unknown": { severity: "warn", description: "An unknown machine asked for a menu." },
  "boot.starting": { severity: "info", description: "An armed host starts its install." },
  "boot.own-disk": { severity: "info", description: "A host not armed boots its own disk." },
  "boot.site-ca": { severity: "info", description: "The site's CA certificate was fetched." },
  "boot.image": { severity: "info", description: "The installer image was fetched." },
  "boot.config": { severity: "info", description: "Install configuration was fetched." },
  "boot.refused": { severity: "error", description: "A request without a live install token." },
  "boot.installer.step": { severity: "info", description: "An installer milestone." },
  "boot.installer.failed": { severity: "error", description: "An installer step failed." },
  "boot.firstboot.phase": { severity: "info", description: "A first-boot phase finished." },
  "boot.ready": {
    severity: "info",
    description: "A host finished its install, all checks passed.",
  },
  "boot.done-with-problems": {
    severity: "error",
    description: "A host finished its install with problems.",
  },
  "boot.next": { severity: "info", description: "What to do next with a host just installed." },
  "boot.finished": {
    severity: "info",
    description: "The installer finished; the host is disarmed.",
  },
  "boot.hostkeys": { severity: "info", description: "This PC trusts a host's SSH host keys." },
  "boot.not-found": { severity: "warn", description: "A request for something not served." },
  "boot.error": { severity: "error", description: "A request failed." },
  "boot.firewall": {
    severity: "warn",
    description: "This PC's firewall would block what the boot server needs.",
  },
  "boot.armed": { severity: "info", description: "A host was armed for one install (this PC)." },
  "boot.reboot": {
    severity: "info",
    description: "A host is rebooting from the network for a re-install (this PC).",
  },
  "boot.certificate": {
    severity: "info",
    description: "What happens to a host's certificate across its re-install (this PC).",
  },
} as const satisfies Record<string, EventSpec>;

export type EventName = keyof typeof EVENTS;

export interface ArchonEvent {
  name: EventName;
  message: string;
  host?: string;
  /** The client's address (client.address). */
  address?: string;
  severity?: Severity;
  attrs?: Record<string, string | number | boolean>;
  /** Milliseconds since the epoch (default: now). */
  time?: number;
}

const SEVERITY_NUMBER: Record<Severity, number> = { debug: 5, info: 9, warn: 13, error: 17 };

type AnyValue = { stringValue: string } | { intValue: string } | { boolValue: boolean } | {
  doubleValue: number;
};
const value = (v: string | number | boolean): AnyValue =>
  typeof v === "boolean"
    ? { boolValue: v }
    : typeof v === "number"
    ? (Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v })
    : { stringValue: v };

export const severityOf = (e: ArchonEvent): Severity => e.severity ?? EVENTS[e.name].severity;

/** The event as one OpenTelemetry log record (OTLP JSON). */
export function toLogRecord(e: ArchonEvent): Record<string, unknown> {
  const sev = severityOf(e);
  const attrs: Record<string, string | number | boolean> = {
    "archon.event": e.name,
    ...(e.host ? { "archon.host": e.host } : {}),
    ...(e.address ? { "client.address": e.address } : {}),
    ...(e.attrs ?? {}),
  };
  const ns = BigInt(Math.round(e.time ?? Date.now())) * 1_000_000n;
  return {
    timeUnixNano: String(ns),
    observedTimeUnixNano: String(ns),
    severityNumber: SEVERITY_NUMBER[sev],
    severityText: sev.toUpperCase(),
    body: { stringValue: e.message },
    attributes: Object.entries(attrs).map(([key, v]) => ({ key, value: value(v) })),
  };
}

/** One OTLP logs export request holding these events. */
export function toLogsRequest(
  events: ArchonEvent[],
  resource: Record<string, string>,
  scope = "archon",
): Record<string, unknown> {
  return {
    resourceLogs: [{
      resource: {
        attributes: Object.entries(resource).map(([key, v]) => ({ key, value: value(v) })),
      },
      scopeLogs: [{ scope: { name: scope }, logRecords: events.map(toLogRecord) }],
    }],
  };
}

/** Back from a log record (what a renderer reads), or undefined when it is not an Archon event. */
export function fromLogRecord(r: Record<string, unknown>): ArchonEvent | undefined {
  const attrs: Record<string, string | number | boolean> = {};
  for (const a of (r.attributes ?? []) as Array<{ key: string; value: Record<string, unknown> }>) {
    const v = a.value.stringValue ?? a.value.boolValue ?? a.value.doubleValue ??
      (a.value.intValue !== undefined ? Number(a.value.intValue) : undefined);
    if (v !== undefined) attrs[a.key] = v as string | number | boolean;
  }
  const name = attrs["archon.event"];
  if (typeof name !== "string" || !(name in EVENTS)) return undefined;
  const { "archon.event": _n, "archon.host": host, "client.address": address, ...rest } = attrs;
  const body = (r.body as { stringValue?: string } | undefined)?.stringValue ?? "";
  const sev = String(r.severityText ?? "").toLowerCase() as Severity;
  return {
    name: name as EventName,
    message: body,
    ...(typeof host === "string" ? { host } : {}),
    ...(typeof address === "string" ? { address } : {}),
    ...(sev in SEVERITY_NUMBER ? { severity: sev } : {}),
    ...(Object.keys(rest).length ? { attrs: rest } : {}),
    time: Number(BigInt(String(r.timeUnixNano ?? "0")) / 1_000_000n),
  };
}

/** The plain line (boot.log): address, host, message, as the window's text without decoration. */
export function plainLine(e: ArchonEvent): string {
  return [e.address, e.host ? `${e.host}:` : "", e.message].filter(Boolean).join(" ");
}
