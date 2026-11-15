/**
 * 044-durable (Article 23): data that can come from end users is either
 * durable (it exists nowhere else) or ephemeral (losing it is harmless). The
 * operator chooses, for every source of such data, when turning it on; there
 * is no default. A host is durable when anything on it is durable, and
 * ephemeral otherwise; nothing about the class is stored, it is worked out
 * from the host's records each time. A missing or unreadable choice counts as
 * durable. Home directories on servers are ephemeral by rule: they are
 * archived locally, and the login banner says they are not kept across a
 * reinstall.
 *
 * @module
 */

import type { DataClass, HostDef } from "./types.ts";

/** The spec this module implements. */
export const SPEC = "044-durable" as const;

/** The opt-ins whose data can come from end users (spec 040's names). */
export const USER_DATA_OPT_INS: Record<string, string> = {
  pg: "PostgreSQL",
  s3: "S3",
  smb: "SMB shares",
  // Spec 050: logs can carry what people typed or uploaded; ephemeral is the usual choice.
  "otel-ui": "the telemetry web UI (OpenObserve)",
};

/**
 * Where each opt-in keeps end users' data outside the nightly archive's
 * default paths: durable ones join it (spec 016). PostgreSQL's nightly dumps
 * are already written into the backup target.
 */
export const DATA_PATHS: Record<string, string[]> = {
  pg: [],
  s3: ["/srv/s3"],
  smb: ["/srv/smb"],
  "otel-ui": ["/srv/otel-ui"],
};

/** One source of end users' data on a host: an opt-in or a guest, with its recorded class. */
export interface DataSource {
  /** Whether it is an opt-in (spec 040) or a guest. */
  kind: "opt-in" | "guest";
  /** The opt-in's name (`"pg"`) or the guest's name. */
  name: string;
  /** Its name for people (`"PostgreSQL"`, `"guest db"`). */
  title: string;
  /** "unchosen": the record has no choice; it counts as durable. */
  data: DataClass | "unchosen";
  /** Whether it is on now (a guest always is; an opt-in may be off with its data kept). */
  on: boolean;
}

/** A host's data class, worked out from its sources (Article 23). */
export interface HostData {
  /** The host's name. */
  host: string;
  /** Durable when any source is durable or unchosen; ephemeral otherwise. */
  class: DataClass;
  /** Why it is durable ("PostgreSQL", "guest db"); empty when ephemeral. */
  reasons: string[];
  /** Sources without a recorded choice, and the command that records one. */
  unchosen: Array<{
    /** The source's name. */
    name: string;
    /** What to run or change to record a choice. */
    fix: string;
  }>;
  /** Every source found, as `dataSources` returns them. */
  sources: DataSource[];
}

/**
 * Every source of end users' data on this host: an opt-in that is on, or has
 * a recorded choice (its data is kept when it is turned off), or shows data
 * without one (PostgreSQL instances in its record, or `onDisk`: what the host
 * itself found in the opt-in's data directory); and every guest. Evidence of
 * data without a recorded choice counts as durable (Article 23).
 */
export function dataSources(host: HostDef, onDisk: string[] = []): DataSource[] {
  const out: DataSource[] = [];
  for (const [name, title] of Object.entries(USER_DATA_OPT_INS)) {
    const r = host.optIn?.[name];
    const recorded = !!r && (r.enabled || !!r.data);
    const evidence =
      onDisk.includes(name) ||
      (name === "pg" && Object.keys(host.pgState?.instances ?? {}).length > 0);
    if (!recorded && !evidence) continue;
    out.push({
      kind: "opt-in",
      name,
      title,
      data: r?.data ?? "unchosen",
      on: r?.enabled === true,
    });
  }
  for (const g of host.guests ?? []) {
    out.push({
      kind: "guest",
      name: g.name,
      title: `guest ${g.name}`,
      data: g.data === "durable" || g.data === "ephemeral" ? g.data : "unchosen",
      on: true,
    });
  }
  return out;
}

/**
 * The host's data class with its reasons and the sources still missing a
 * choice (each with the command or model change that records one). `onDisk`
 * is as for `dataSources`.
 */
export function hostData(host: HostDef, onDisk: string[] = []): HostData {
  const sources = dataSources(host, onDisk);
  const kept = sources.filter((s) => s.data !== "ephemeral");
  return {
    host: host.name,
    class: kept.length ? "durable" : "ephemeral",
    reasons: kept.map((s) => (s.data === "unchosen" ? `${s.title} (no choice recorded)` : s.title)),
    unchosen: sources
      .filter((s) => s.data === "unchosen")
      .map((s) => ({
        name: s.name,
        fix:
          s.kind === "guest"
            ? `set data: "durable" or "ephemeral" on guest ${s.name} in the model`
            : `archon data set ${s.name} --durable (or --ephemeral --confirm-destroy ${host.name})`,
      })),
    sources,
  };
}

/** The paths the nightly archive adds for this host's durable (or unchosen) data. */
export function durablePaths(host: HostDef): string[] {
  return dataSources(host)
    .filter((s) => s.kind === "opt-in" && s.data !== "ephemeral")
    .flatMap((s) => DATA_PATHS[s.name] ?? []);
}

/** The guests backed up with `lxc export`: durable ones (or unchosen). */
export const durableGuests = (host: HostDef): string[] =>
  (host.guests ?? []).filter((g) => g.data !== "ephemeral").map((g) => g.name);

/** "durable (PostgreSQL, S3)" or "ephemeral". */
export function describeData(d: Pick<HostData, "class" | "reasons">): string {
  return d.class === "durable" ? `durable (${d.reasons.join(", ")})` : "ephemeral";
}

/** What each class means, in one line each (usage errors, docs, the guide). */
export const MEANING: Record<DataClass, string> = {
  durable:
    "its data exists nowhere else: it is backed up, and nothing reinstalls or wipes it without --confirm-destroy",
  ephemeral: "losing its data is harmless: a reinstall or a wipe needs no confirmation",
};

/**
 * The forced choice of a command that turns on a source of end users' data:
 * exactly one of --durable and --ephemeral.
 */
export function chooseData(a: { durable?: unknown; ephemeral?: unknown }, what: string): DataClass {
  if (a.durable && a.ephemeral) {
    throw new Error(`choose one of --durable and --ephemeral for ${what}, not both`);
  }
  if (a.durable) return "durable";
  if (a.ephemeral) return "ephemeral";
  throw new Error(
    `choose --durable or --ephemeral for ${what} (Article 23; there is no default):\n` +
      `  --durable    ${MEANING.durable}\n  --ephemeral  ${MEANING.ephemeral}`,
  );
}

/**
 * Leaving durable (to ephemeral, or a destructive step) needs the host's name
 * repeated with --confirm-destroy, typed by a person.
 */
export function confirmDestroy(confirm: unknown, name: string, what: string): void {
  if (confirm === name) return;
  throw new Error(
    confirm === undefined
      ? `${what}: repeat the name with --confirm-destroy ${name}`
      : `${what}: --confirm-destroy ${typeof confirm === "string" ? confirm : JSON.stringify(confirm)} does not name ${name}`,
  );
}

/** The command-line flags every forced choice uses. */
export const CHOICE_ARGS: Array<{ name: string; type: "boolean"; description: string }> = [
  {
    name: "durable",
    type: "boolean" as const,
    description: `The data exists nowhere else: ${MEANING.durable} (Article 23).`,
  },
  {
    name: "ephemeral",
    type: "boolean" as const,
    description: `Losing the data is harmless: ${MEANING.ephemeral} (Article 23).`,
  },
];

/**
 * The `--confirm-destroy` flag for a command that may lose durable data;
 * `what` names what must be repeated (usually the host's name). Marked
 * `human`: only a person may give it.
 */
export const CONFIRM_DESTROY_ARG = (
  what: string,
): { name: string; type: "string"; human: boolean; description: string } => ({
  name: "confirm-destroy",
  type: "string" as const,
  human: true,
  description: `Repeat ${what} to confirm that durable data may be lost. Typed by a person: never accepted over MCP or from an agent (Article 23).`,
});
