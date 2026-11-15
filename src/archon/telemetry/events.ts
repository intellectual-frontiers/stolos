/**
 * Spec 049-telemetry (Article 27): events are structured at their source.
 * Each event has a declared name (below), a severity, the host and address it
 * is about, attributes, and a message; it is recorded as an OpenTelemetry log
 * record. Anything a person reads (the boot server's window, boot.log) is a
 * rendering of these records, never the source: the window's icons, colors,
 * and de-duplication come from the event's name and attributes, not from
 * parsing its text.
 *
 * @module
 */

/** An event's usual severity, as OpenTelemetry's severity ranges name them. */
export type Severity = "debug" | "info" | "warn" | "error";

/** What an event means. */
export interface EventSpec {
  /** Its usual severity. */
  severity: Severity;
  /** What it says happened. */
  description: string;
}

/** Every event Archon emits (spec 049): its name, severity, and meaning. */
export const EVENTS = {
  // An archon run (spec 049): what it printed, as records in its trace.
  "archon.phase": {
    severity: "info",
    description: "A phase of an archon run finished, with its result.",
  },
  "archon.problem": {
    severity: "warn",
    description: "A problem an archon run reported, with its fix.",
  },
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
  "boot.machine": {
    severity: "info",
    description: "A machine reported its own facts before its install (spec 051).",
  },
  "boot.guard": { severity: "info", description: "The blank-disk guard let an install go on." },
  "boot.guarded": {
    severity: "warn",
    description: "The blank-disk guard stopped an install before it wrote anything.",
  },
  "boot.mismatch": {
    severity: "warn",
    description: "An unknown machine booted while a host waits for another network card.",
  },
  "boot.stalled": {
    severity: "warn",
    description: "A machine took the installer image and went quiet (likely too little RAM).",
  },
  "boot.learned": {
    severity: "info",
    description: "A host's MAC, as its machine reported it, was recorded in registration.ts.",
  },
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

/** An event's name (from {@link EVENTS}). */
export type EventName = keyof typeof EVENTS;

/** One event: what happened, where, and in which trace (an OpenTelemetry log record). */
export interface ArchonEvent {
  /** Its name. */
  name: EventName;
  /** What happened, in plain words. */
  message: string;
  /** The host it is about. */
  host?: string | undefined;
  /** The client's address (client.address). */
  address?: string | undefined;
  /** Its severity, when not the usual one. */
  severity?: Severity | undefined;
  /** Structured details. */
  attrs?: Record<string, string | number | boolean> | undefined;
  /** Milliseconds since the epoch (default: now). */
  time?: number | undefined;
  /** The trace and span it belongs to (W3C ids, hex). */
  traceId?: string | undefined;
  /** The span it belongs to. */
  spanId?: string | undefined;
}

const SEVERITY_NUMBER: Record<Severity, number> = { debug: 5, info: 9, warn: 13, error: 17 };

/**
 * An OTLP AnyValue in the OTLP/HTTP JSON encoding: a 64-bit integer is a
 * decimal string, a map is a list of key-values, and an empty object is a
 * null (spec 092 adds arrays and maps, for structured log bodies).
 */
export type OtlpAnyValue =
  | { stringValue: string }
  | { intValue: string }
  | { boolValue: boolean }
  | { doubleValue: number }
  | { arrayValue: { values: OtlpAnyValue[] } }
  | { kvlistValue: { values: OtlpKeyValue[] } }
  | Record<never, never>;

/** One OTLP attribute: a key and its value. */
export interface OtlpKeyValue {
  /** The attribute's name. */
  key: string;
  /** Its value. */
  value: OtlpAnyValue;
}

/** A JavaScript value as an OTLP AnyValue (null and undefined: the empty value). */
export function otlpValue(v: unknown): OtlpAnyValue {
  if (v === null || v === undefined) return {};
  if (typeof v === "boolean") return { boolValue: v };
  if (typeof v === "bigint") return { intValue: String(v) };
  if (typeof v === "number") {
    return Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v };
  }
  if (typeof v === "string") return { stringValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(otlpValue) } };
  if (typeof v === "object") return { kvlistValue: { values: otlpAttributes(v) } };
  return { stringValue: typeof v === "symbol" ? v.toString() : typeof v };
}

/** An object's entries as OTLP attributes (undefined entries left out). */
export function otlpAttributes(o: object): OtlpKeyValue[] {
  return Object.entries(o)
    .filter(([, v]) => v !== undefined)
    .map(([key, v]) => ({
      key,
      value: otlpValue(v),
    }));
}

const value = (v: string | number | boolean): OtlpAnyValue => otlpValue(v);

/** An event's severity: its own, else its kind's. */
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
    ...(e.traceId ? { traceId: e.traceId } : {}),
    ...(e.spanId ? { spanId: e.spanId } : {}),
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
    resourceLogs: [
      {
        resource: {
          attributes: Object.entries(resource).map(([key, v]) => ({ key, value: value(v) })),
        },
        scopeLogs: [{ scope: { name: scope }, logRecords: events.map(toLogRecord) }],
      },
    ],
  };
}

/** Back from a log record (what a renderer reads), or undefined when it is not an Archon event. */
export function fromLogRecord(r: Record<string, unknown>): ArchonEvent | undefined {
  const attrs: Record<string, string | number | boolean> = {};
  const list = Array.isArray(r["attributes"]) ? (r["attributes"] as unknown[]) : [];
  for (const a of list) {
    if (!isRecord(a) || typeof a["key"] !== "string" || !isRecord(a["value"])) continue;
    const v = attributeValue(a["value"]);
    if (v !== undefined) attrs[a["key"]] = v;
  }
  const name = attrs["archon.event"];
  if (typeof name !== "string" || !isEventName(name)) return undefined;
  const { "archon.event": _n, "archon.host": host, "client.address": address, ...rest } = attrs;
  const bodyValue = r["body"];
  const body =
    isRecord(bodyValue) && typeof bodyValue["stringValue"] === "string"
      ? bodyValue["stringValue"]
      : "";
  const sevText = r["severityText"];
  const sev = (typeof sevText === "string" ? sevText : "").toLowerCase();
  const time = r["timeUnixNano"];
  return {
    name,
    message: body,
    ...(typeof host === "string" ? { host } : {}),
    ...(typeof address === "string" ? { address } : {}),
    ...(isSeverity(sev) ? { severity: sev } : {}),
    ...(Object.keys(rest).length ? { attrs: rest } : {}),
    time: Number(
      BigInt(typeof time === "string" || typeof time === "number" ? time : "0") / 1_000_000n,
    ),
  };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isEventName(name: string): name is EventName {
  return name in EVENTS;
}

function isSeverity(s: string): s is Severity {
  return s in SEVERITY_NUMBER;
}

/** An OTLP attribute's value, as the scalar it carries. */
function attributeValue(v: Record<string, unknown>): string | number | boolean | undefined {
  const s = v["stringValue"];
  if (typeof s === "string") return s;
  const b = v["boolValue"];
  if (typeof b === "boolean") return b;
  const d = v["doubleValue"];
  if (typeof d === "number") return d;
  const i = v["intValue"];
  return typeof i === "string" || typeof i === "number" ? Number(i) : undefined;
}

/** The plain line (boot.log): address, host, message, as the window's text without decoration. */
export function plainLine(e: ArchonEvent): string {
  return [e.address, e.host ? `${e.host}:` : "", e.message].filter(Boolean).join(" ");
}
