// Load the active fleet (fleets/<id>/fleet.ts, written by `archon fleet init`)
// and every host (fleets/<id>/hosts/<name>/host.ts, written by `archon host add`).
// Hosts are discovered from the directory, so there is no index to keep in
// sync.

import { P } from "../core/paths.ts";
import { exists } from "../core/fsx.ts";
import { join, toFileUrl } from "../core/path.ts";
import type { FleetDef, HostDef, McpTier, OptInRecord, PgState, UserDef } from "./types.ts";

/** The tier workstations get over MCP (spec 030); never destructive. */
export function mcpTier(fleet: FleetDef): McpTier {
  return fleet.mcp?.maxTier ?? "mutate";
}

/**
 * ops' authorized_keys (spec 030, Article 17): each key may only start
 * `archon mcp` at the fleet's tier. `restrict` turns off the shell, port,
 * agent, and X11 forwarding; the client cannot choose another command.
 */
export function mcpAuthorizedKeys(fleet: FleetDef): string[] {
  const keys = fleet.mcp?.keys ?? fleet.admin.github.sshKeys;
  const command = `env ARCHON_AGENT=mcp /usr/local/bin/archon mcp --max-tier ${mcpTier(fleet)}`;
  return keys.map((k) => `restrict,command="${command}" ${k.trim()}`);
}

export class NoFleetError extends Error {
  constructor() {
    super(
      P.fleetId
        ? `no fleet ${P.fleetId} in ${P.repo}: run \`archon fleet init ${P.fleetId}\` on the boot machine first`
        : `no fleet chosen in ${P.repo}: set ARCHON_FLEET to one of fleets/, or run \`archon fleet init <id>\``,
    );
  }
}

export async function loadFleet(): Promise<FleetDef> {
  if (!(await exists(P.fleet))) throw new NoFleetError();
  const mod = await import(toFileUrl(P.fleet).href);
  const fleet = { ...(mod.fleet as FleetDef) };
  // Spec 047: who may approve this fleet's changes, from fleets/<id>/signers.ts.
  const { loadSigners } = await import("../identity/signers.ts");
  fleet.signers = await loadSigners();
  // Spec 046-engine-instance: a fleet's folder is named after its id.
  if (fleet.id !== P.fleetId) {
    throw new Error(`fleets/${P.fleetId}/fleet.ts says id "${fleet.id}": rename one to match`);
  }
  return fleet;
}

export async function loadHosts(): Promise<HostDef[]> {
  const hosts: HostDef[] = [];
  if (!(await exists(P.hosts))) return hosts;
  // One folder per host (spec 046-engine-instance): hosts/<host>/host.ts.
  const names: string[] = [];
  for await (const e of Deno.readDir(P.hosts)) {
    if (e.isDirectory && !e.name.startsWith("_") && await exists(hostFile(e.name))) {
      names.push(e.name);
    }
  }
  for (const n of names.sort()) {
    const mod = await import(toFileUrl(hostFile(n)).href);
    const host = mod.host as HostDef;
    // Spec 038: what operators recorded on the host is part of its model.
    const pgState = await readPgState(host.name);
    const optIn = await readOptIns(host.name);
    hosts.push({
      ...host,
      ...(pgState ? { pgState } : {}),
      ...(Object.keys(optIn).length ? { optIn } : {}),
    });
  }
  return hosts;
}

/** fleets/<id>/hosts/<host>/host.ts (spec 046-engine-instance). */
export function hostFile(name: string): string {
  return join(P.hosts, name, "host.ts");
}

/** state/hosts/<host>/pg.json, when there is one (spec 038). */
export async function readPgState(host: string, root = P.state): Promise<PgState | undefined> {
  try {
    const s = JSON.parse(await Deno.readTextFile(join(root, "hosts", host, "pg.json"))) as PgState;
    return s && typeof s.instances === "object" ? s : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Every opt-in decision recorded for a host (spec 040): each
 * state/hosts/<host>/<name>.json whose `enabled` is a boolean.
 */
export async function readOptIns(
  host: string,
  root = P.state,
): Promise<Record<string, OptInRecord>> {
  const out: Record<string, OptInRecord> = {};
  const dir = join(root, "hosts", host);
  try {
    for await (const e of Deno.readDir(dir)) {
      if (!e.isFile || !e.name.endsWith(".json")) continue;
      try {
        const r = JSON.parse(await Deno.readTextFile(join(dir, e.name)));
        if (typeof r?.enabled === "boolean") {
          out[e.name.slice(0, -5)] = {
            enabled: r.enabled,
            by: String(r.by ?? ""),
            at: String(r.at ?? ""),
            ...(r.data === "durable" || r.data === "ephemeral" ? { data: r.data } : {}),
          };
        }
      } catch { /* not a record */ }
    }
  } catch { /* no state for this host */ }
  return out;
}

export const isWorkstation = (h: HostDef) => h.kind === "workstation";

/** Hosts the boot server installs (workstations are never installed over the network). */
export async function loadServers(): Promise<HostDef[]> {
  return (await loadHosts()).filter((h) => !isWorkstation(h));
}

/**
 * The accounts every host has: the fleet admin, ops (the operator account that
 * converges the host and serves workstations' agents over MCP), then extras.
 * A workstation has one: its existing user (spec 020).
 */
export function usersFor(fleet: FleetDef, host: HostDef): UserDef[] {
  const gh = fleet.admin.github;
  if (isWorkstation(host)) {
    return [{
      name: host.user ?? fleet.admin.user,
      fullName: gh.name,
      email: gh.email,
      personas: ["operator"],
      admin: true,
      sshKeys: [],
      spec: "020-workstation",
    }];
  }
  return [
    {
      name: fleet.admin.user,
      uid: fleet.admin.uid,
      fullName: gh.name,
      email: gh.email,
      personas: ["operator"],
      admin: true,
      sshKeys: gh.sshKeys,
      spec: "006-accounts",
    },
    {
      // ops converges the host and pushes its state; workstations' agents
      // reach it only through archon mcp (spec 030, Article 17). Its commits
      // carry the admin's noreply address so they are attributed without a
      // GitHub account.
      name: "ops",
      fullName: "Archon Operator",
      email: gh.email,
      personas: ["operator"],
      admin: false,
      sshKeys: mcpAuthorizedKeys(fleet),
      spec: "006-accounts",
    },
    ...(host.users ?? []),
  ];
}

export function homeOf(u: { name: string }): string {
  return u.name === "root" ? "/root" : `/home/${u.name}`;
}
