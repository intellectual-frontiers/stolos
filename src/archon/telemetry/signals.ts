/**
 * Spec 049-telemetry (Article 27): every signal Archon emits, declared once.
 * `core/telemetry.ts` makes IFC TypeScript's signal registry from these lists.
 * The telemetry module accepts only these names (TypeScript checks every call),
 * `man 7 archon-telemetry` is rendered from this list, and the tests read it.
 *
 * @module
 */

/** What a metric is about: the machine's health, its security, or its state. */
export type Group = "health" | "security" | "state";

/** What a metric measures. */
export interface MetricSpec {
  /** Its kind. */
  kind: "counter" | "histogram" | "gauge";
  /** Its unit. */
  unit?: string;
  /** Its group. */
  group: Group;
  /** What it counts or measures. */
  description: string;
  /** Attributes beyond the run's own (archon.command, archon.fleet, host). */
  attributes: string[];
}

/** Every metric Archon records (spec 049). */
export const METRICS = {
  "archon.run.duration": {
    kind: "histogram",
    unit: "s",
    group: "health",
    description: "How long an archon command took.",
    attributes: ["archon.outcome"],
  },
  "archon.run.problems": {
    kind: "counter",
    group: "health",
    description: "Problems an archon command reported, by level.",
    attributes: ["archon.level"],
  },
  "archon.verify.checks": {
    kind: "counter",
    group: "health",
    description: "Verification checks run, by result.",
    attributes: ["archon.result"],
  },
  "archon.apply.changes": {
    kind: "counter",
    group: "health",
    description: "Changes archon apply made (or planned, with --check).",
    attributes: ["archon.check"],
  },
  "archon.update.outcome": {
    kind: "counter",
    group: "security",
    description:
      "What a host did with the tip of main: applied, current, blocked, or refused (unsigned, untrusted, rollback, no-signers).",
    attributes: ["archon.outcome"],
  },
  "archon.query.requests": {
    kind: "counter",
    group: "security",
    description: "archon query requests, served or refused, by table.",
    attributes: ["archon.result", "archon.table"],
  },
  "archon.mcp.calls": {
    kind: "counter",
    group: "security",
    description: "MCP tool calls this server received, served or refused.",
    attributes: ["archon.tool", "archon.result"],
  },
  "archon.signers.trusted": {
    kind: "counter",
    group: "security",
    description: "Signing keys a person trusted on this host by hand (emergency).",
    attributes: [],
  },
  "archon.confirm_destroy.used": {
    kind: "counter",
    group: "security",
    description: "Runs where a person typed --confirm-destroy.",
    attributes: [],
  },
  "archon.state.writes": {
    kind: "counter",
    group: "state",
    description: "Records written to this machine's archon.sql, by kind.",
    attributes: ["archon.kind"],
  },
  "archon.engine.info": {
    kind: "gauge",
    group: "state",
    description: "Always 1; its attribute names the engine version that ran.",
    attributes: ["archon.engine.version"],
  },
} as const satisfies Record<string, MetricSpec>;

/** A metric's name (from {@link METRICS}). */
export type MetricName = keyof typeof METRICS;

/**
 * Span names (spec 096: each a kind of IFC TypeScript's signal registry, built from this list in
 * core/telemetry.ts). A run of a command is one `archon.run` (its command in `archon.command`);
 * each phase is a child `archon.phase` (its name in `archon.phase`).
 */
export const SPANS = {
  "archon.run": "One run of an archon or stolos command: the root of its trace.",
  "archon.phase": "One phase of a run (as printed: Model, Packages, Units, ...).",
  "archon.query": "One archon query through osqueryi.",
  "archon.remote": "One call to a server's MCP server (fleet status, fleet query).",
} as const;

/** Attributes, on the run's span and every metric. */
export const ATTRIBUTES = {
  "archon.command": "The command (apply, verify, query, ...).",
  "archon.tier": "Its tier: read, repo, mutate, destructive.",
  "archon.fleet": "The fleet's id.",
  "archon.host": "The host the run is about.",
  "archon.engine.version": "The engine's version (src/archon/version.ts).",
  "archon.outcome": "ok or failed (runs); applied, current, blocked, refused-* (updates).",
  "archon.level": "fail or warn.",
  "archon.result": "passed, failed, served, refused.",
  "archon.check": "Whether apply only planned (--check).",
  "archon.table": "A table a query named.",
  "archon.tool": "An MCP tool's name.",
  "archon.kind": "A record's kind in archon.sql.",
  "archon.phase": "The phase a log record is about (archon.phase and archon.problem events).",
  "archon.fix": "The fix a problem's record suggests.",
  "archon.code": "A problem's stable code (archon explain <code>, spec 052).",
  "archon.event": "A log record's event name (telemetry/events.ts).",
  "archon.phase.result": "A phase's summary line.",
  "archon.phase.level": "A phase's worst level (ok, warn, fail).",
} as const;

/** Resource attributes the launcher sets (OTEL_RESOURCE_ATTRIBUTES), on every signal. */
export const RESOURCE = {
  "service.name": "archon, or archon-boot.",
  "service.namespace": "The fleet's id (/etc/archon/fleet).",
  "service.version": "The engine's tag pinned by the fleet repository (v0.5.0, ...).",
  "host.name": "The host (/etc/archon/host).",
  "vcs.ref.head.revision": "The fleet repository's commit the host is at.",
} as const;
