/**
 * 040-opt-in: opt-in services and containers. Every server has them; each is
 * off until an operator turns it on, and then on (across applies, reboots,
 * and reinstalls) until an operator turns it off. The decision is the host's
 * own record, this machine's archon.sql<name>.json {enabled, by, at}: model input
 * for every plan (loadHosts), and the switch of the opt-in's unit at apply
 * time (UnitDef.switch). Where an opt-in can use Linux accounts and their
 * credentials, it does; where its protocol needs a secret of its own, the
 * identity is still the Linux account and only that account can read it.
 * Every opt-in that can hold end users' data (spec 044, Article 23) is turned
 * on with a forced choice, --durable or --ephemeral, kept in the same record.
 *
 * @module
 */

import { proc, stdio } from "@intellectual-frontiers/ifc-ts/runtime";
import { getRecord, putRecord } from "../state/store.ts";

import { P } from "../core/paths.ts";
import { currentUser } from "../core/exec.ts";
import { ui } from "../core/ui.ts";
import { journal } from "../core/log.ts";
import { loadFleet, loadHosts } from "../model/load.ts";
import type { DataClass, FleetDef, HostDef, OptInRecord } from "../model/types.ts";
import {
  confirmDestroy,
  dataSources,
  describeData,
  hostData,
  USER_DATA_OPT_INS,
} from "../model/durable.ts";
import { fqdn } from "../web/config.ts";

/** The spec this module implements. */
export const SPEC = "040-opt-in" as const;

/** One opt-in service or container: its switch, unit, commands and how to use it. */
export interface OptInDef {
  /** The switch: this machine's archon.sql<name>.json, and UnitDef.switch. */
  name: string;
  /** A system service, or a container Archon runs. */
  kind: "service" | "container";
  /** Its name for people. */
  title: string;
  /** The unit the switch masks or enables. */
  unit: string;
  /** Commands that turn it on, off, and show it. */
  commands: {
    /** The command that turns it on. */
    on: string;
    /** The command that turns it off. */
    off: string;
    /** The command that shows it. */
    status: string;
  };
  /** What people should know once it is on (addresses, how to connect). */
  howTo(fleet: FleetDef, host: HostDef): string[];
}

/** Every opt-in: SMB, PostgreSQL, S3 and the telemetry web UI. */
export const OPT_INS: OptInDef[] = [
  {
    name: "smb",
    kind: "service",
    title: "SMB file sharing (Samba)",
    unit: "smbd.service",
    commands: { on: "archon fs smb on", off: "archon fs smb off", status: "archon fs smb status" },
    howTo: (fleet: FleetDef, host: HostDef): string[] => {
      const n = fqdn(fleet, host);
      const name = n ? `smb.${n}` : host.name;
      return [
        `Windows: \\\\${name}\\shared · macOS and Linux: smb://${name}/shared`,
        "Sign in with your Linux username and password.",
      ];
    },
  },
  {
    name: "pg",
    kind: "service",
    title: "PostgreSQL",
    unit: "postgresql.service",
    commands: { on: "archon pg on", off: "archon pg off", status: "archon pg list" },
    howTo: () => [
      "psql service=prime: you, as yourself, over the socket (no password).",
      "Apps run as their own service accounts (s-<app>); archon pg who shows who can log in.",
    ],
  },
  {
    name: "s3",
    kind: "container",
    title: "S3 object storage (RustFS)",
    unit: "archon-s3.service",
    commands: { on: "archon fs s3 on", off: "archon fs s3 off", status: "archon fs s3 status" },
    howTo: (fleet: FleetDef, host: HostDef): string[] => {
      const n = fqdn(fleet, host);
      return [
        `S3 API: https://s3.${n ?? host.name} (path-style) · console: https://s3-console.${
          n ?? host.name
        }`,
        "Your S3 user is your Linux username: archon fs s3 key --write puts your key in ~/.aws.",
        "The console signs in with Account: your username and Key: your S3 secret (archon fs s3 key --show), not your Linux password.",
      ];
    },
  },
  {
    name: "otel-ui",
    kind: "container",
    title: "Telemetry web UI (OpenObserve)",
    unit: "archon-otel-ui.service",
    commands: {
      on: "archon otel ui on",
      off: "archon otel ui off",
      status: "archon otel ui status",
    },
    howTo: (fleet: FleetDef, host: HostDef): string[] => {
      const n = fqdn(fleet, host);
      return [
        `Web UI: https://otel.${
          n ?? host.name
        } (local networks) · sign in: archon otel ui password --show`,
        `This server now collects the fleet's telemetry on port 4318: point otel.localdomain (router DNS) or telemetry.collector in fleet.ts at ${host.name}; servers find it within 15 minutes.`,
        "Only telemetry from now on is forwarded; what came before stays where it was (spec 050).",
      ];
    },
  },
];

/** The opt-in with this name, or `undefined`. */
export const optInDef = (name: string): OptInDef | undefined =>
  OPT_INS.find((o) => o.name === name);

/** Whether an opt-in is on for this host (the model's view; absent means off). */
export const isOn = (host: HostDef, name: string): boolean => host.optIn?.[name]?.enabled === true;

/** Who asked: the person behind sudo, else the current user. */
export const caller = (): string => proc.env.get("SUDO_USER") || currentUser() || "root";

/**
 * Write the decision, keeping anything else the record holds (pg.json also
 * lists the instances Archon made).
 */
export async function writeOptIn(
  host: string,
  name: string,
  enabled: boolean,
  by = caller(),
  root = P.state,
  data?: DataClass,
): Promise<OptInRecord> {
  const rest: Record<string, unknown> =
    (await getRecord<Record<string, unknown>>(host, "optin", name, root))?.body ?? {};
  const { enabled: _e, by: _b, at: _a, data: kept, ...others } = rest;
  const chosen = data ?? (kept === "durable" || kept === "ephemeral" ? kept : undefined);
  const rec: OptInRecord = {
    enabled,
    by,
    at: new Date().toISOString(),
    ...(chosen ? { data: chosen } : {}),
  };
  await putRecord(host, "optin", name, { ...rec, ...others }, root);
  return rec;
}

/** Whether this opt-in can hold end users' data (and so needs a choice). */
export const holdsUserData = (name: string): boolean => name in USER_DATA_OPT_INS;

/**
 * The rule every change of choice follows: from durable (or no choice) to
 * ephemeral needs the host's name repeated with --confirm-destroy.
 */
export function checkChoice(
  host: HostDef,
  name: string,
  data: DataClass,
  confirm: unknown,
  onDisk: string[] = [],
): void {
  const was = dataSources(host, onDisk).find((s) => s.kind === "opt-in" && s.name === name)?.data;
  if (data === "ephemeral" && was !== undefined && was !== "ephemeral") {
    confirmDestroy(
      confirm,
      host.name,
      `${USER_DATA_OPT_INS[name]} on ${host.name} holds data ${
        was === "durable"
          ? "recorded as durable"
          : "with no recorded choice (so it counts as durable)"
      }; calling it ephemeral removes its protection`,
    );
  }
}

/**
 * archon <opt-in> on | off: record it, apply it now (the same apply every
 * later run does), journal it, tell the mailbox, and say what to do next.
 */
export async function setOptIn(
  hostName: string,
  name: string,
  enabled: boolean,
  choice: { data?: DataClass; confirm?: unknown } = {},
): Promise<number> {
  const def = optInDef(name);
  if (!def) throw new Error(`no opt-in named ${name}`);
  const fleet = await loadFleet();
  const host = (await loadHosts()).find((h) => h.name === hostName);
  if (!host) throw new Error(`no host ${hostName} in the model`);
  if (host.kind === "workstation") {
    throw new Error(`${def.title} is an opt-in for servers, not workstations`);
  }
  if (enabled && holdsUserData(name)) {
    if (!choice.data) throw new Error(`${def.commands.on} needs --durable or --ephemeral`);
    const { dataOnDisk } = await import("./data.ts");
    checkChoice(host, name, choice.data, choice.confirm, await dataOnDisk());
  }
  if (!enabled && !host.optIn?.[name]) {
    // Never turned on: nothing to record, so a fresh server keeps no record.
    ui.phase("Turn off").done(`${def.title} is off (it has never been on here)`);
    return 0;
  }
  const p = ui.phase(enabled ? "Turn on" : "Turn off");
  const rec = await writeOptIn(host.name, name, enabled, caller(), P.state, choice.data);
  p.done(
    `${enabled ? "on" : "off"}${
      rec.data ? `, ${rec.data}` : ""
    }; recorded in archon.sql ${host.name}/${name}.json`,
  );
  const { apply } = await import("../apply/apply.ts");
  const fresh = (await loadHosts()).find((h) => h.name === host.name) ?? host;
  const res = await apply(fresh, {
    check: false,
    only: ["packages", "accounts", "files", "units", "databases", "containers"],
  });
  await journal("archon-optin", `${def.title} turned ${enabled ? "on" : "off"} by ${rec.by}`);
  const { notify } = await import("../notify/events.ts");
  await notify({
    event: `${def.title} turned ${enabled ? "on" : "off"}`,
    level: "info",
    what: enabled
      ? `${rec.by} turned on ${def.title} on ${host.name}${
          rec.data ? `, its data ${rec.data}` : ""
        }. It stays on, across reboots and reinstalls, until an operator runs ${def.commands.off}.`
      : `${rec.by} turned off ${def.title} on ${host.name}. It stays off (its data kept) until an operator runs ${def.commands.on}.`,
    todo: "Nothing.",
    key: `optin:${host.name}:${name}:${enabled ? "on" : "off"}`,
  }).catch(() => {});
  if (enabled) ui.next.push(...def.howTo(fleet, fresh));
  if (holdsUserData(name)) {
    ui.next.push(`this server is ${describeData(hostData(fresh))} (archon data)`);
  }
  ui.next.push(
    `${def.commands.status} shows it; the switch is in this machine's archon.sql (archon state).`,
    `to keep it across a re-install, record it in Git from your workstation: stolos decide ${name} ${
      enabled ? "on" : "off"
    }${rec.data ? ` --${rec.data}` : ""} --host ${host.name}, then commit signed and push`,
  );
  return res.failed ? 1 : 0;
}

/** archon opt-in: every opt-in service and container here, on or off, since when, by whom. */
export async function optInList(hostName: string, json: boolean): Promise<number> {
  const host = (await loadHosts()).find((h) => h.name === hostName);
  if (!host) throw new Error(`no host ${hostName} in the model`);
  const rows = OPT_INS.map((o) => {
    const r = host.optIn?.[o.name];
    return {
      name: o.name,
      kind: o.kind,
      title: o.title,
      on: r?.enabled === true,
      data: holdsUserData(o.name) ? (r?.data ?? (r?.enabled ? "unchosen" : null)) : null,
      since: r?.at || null,
      by: r?.by || null,
      status: o.commands.status,
      turnOn: holdsUserData(o.name) ? `${o.commands.on} --durable|--ephemeral` : o.commands.on,
    };
  });
  const d = hostData(host);
  if (json) {
    stdio.stdout.writeSync(
      `${JSON.stringify({ host: host.name, data: d.class, reasons: d.reasons, optIn: rows }, null, 2)}\n`,
    );
    return 0;
  }
  stdio.stdout.writeSync(`${host.name} is ${describeData(d)} (archon data)\n`);
  for (const r of rows) {
    const when = r.since ? ` since ${r.since.slice(0, 16).replace("T", " ")} UTC by ${r.by}` : "";
    stdio.stdout.writeSync(
      `${r.on ? "on " : "off"}  ${r.title.padEnd(30)} ${r.kind.padEnd(9)} ${(r.data ?? "").padEnd(
        9,
      )}${r.on ? when : r.since ? `${when} · ${r.turnOn}` : ` · ${r.turnOn}`}\n`,
    );
  }
  return 0;
}
