/**
 * Load the active fleet (fleets/<id>/fleet.ts, written by `stolos fleet init`)
 * and every host (fleets/<id>/hosts/<name>/host.ts, written by `stolos host add`).
 * Hosts are discovered from the directory, so there is no index to keep in
 * sync.
 *
 * @module
 */
// Spec: 108-tags FR-004

import { createRequire } from "node:module";
import { fs, path } from "@intellectual-frontiers/system";
import { getRecord, listRecords } from "../state/store.ts";
import { listFleets, P } from "../core/paths.ts";
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

/** No active fleet: none chosen, or fleets/<id>/fleet.ts is missing. The message says how to make one. */
export class NoFleetError extends Error {
  /** Build the error, naming the fleet ID when one was chosen. */
  constructor() {
    super(
      P.fleetId
        ? `no fleet ${P.fleetId} in ${P.repo}: run \`stolos fleet init ${P.fleetId}\` on the boot machine first`
        : `no fleet chosen in ${P.repo}: bun run stolos fleet use <id> (one of: ${
            listFleets(P.repo).join(", ") || "none yet"
          }), or create one: bun run stolos fleet init <id>`,
    );
  }
}

/** The module cache (Bun keeps a file's module there, by its path). */
const moduleCache: object = createRequire(import.meta.url).cache;
/** Fresh reads so far: two in one millisecond still get two URLs. */
let freshReads = 0;

/**
 * A named export of one of the fleet's own TypeScript files (fleet.ts, host.ts, registration.ts,
 * decisions.ts), which the fleet's type check covers; `fresh` reads it again after a change: a new
 * URL for Node, and the file's entry out of the module cache for Bun, which caches a file by its
 * path whatever its query.
 */
export async function fleetExport<T>(
  file: string,
  name: string,
  fresh = false,
): Promise<T | undefined> {
  if (fresh) {
    // By the path as given and as the runtime resolved it (macOS: /var is /private/var).
    const real = await fs.realPath(file).catch(() => path.resolve(file));
    for (const key of new Set([path.resolve(file), real])) Reflect.deleteProperty(moduleCache, key);
  }
  const mod: unknown = await import(
    path.toFileUrl(file).href + (fresh ? `?t=${Date.now()}.${++freshReads}` : "")
  );
  if (typeof mod !== "object" || mod === null) return undefined;
  const value: unknown = Reflect.get(mod, name);
  return value === undefined ? undefined : (value as T);
}

/**
 * Import the active fleet's fleet.ts, with its signers (spec 047). Throws
 * NoFleetError when there is none, or when its id does not match its folder.
 */
export async function loadFleet(): Promise<FleetDef> {
  if (!(await fs.exists(P.fleet))) throw new NoFleetError();
  const def = await fleetExport<FleetDef>(P.fleet, "fleet");
  if (def === undefined) throw new Error(`${P.fleet} does not export fleet`);
  const fleet = { ...def };
  // Spec 047: who may approve this fleet's changes, from fleets/<id>/signers.ts.
  const { loadSigners } = await import("../identity/signers.ts");
  fleet.signers = await loadSigners();
  // Spec 046-engine-instance: a fleet's folder is named after its id.
  if (fleet.id !== P.fleetId) {
    throw new Error(`fleets/${P.fleetId}/fleet.ts says id "${fleet.id}": rename one to match`);
  }
  return fleet;
}

/**
 * Import every host (servers and workstations) sorted by name, each with what
 * this machine records about it: its registration and MAC (spec 051), its
 * PostgreSQL state (spec 038), and its opt-ins (decisions in Git win, spec 047).
 * Folders starting with `_` are skipped.
 */
export async function loadHosts(): Promise<HostDef[]> {
  const hosts: HostDef[] = [];
  if (!(await fs.exists(P.hosts))) return hosts;
  // One folder per host (spec 046-engine-instance): hosts/<host>/host.ts.
  const names: string[] = [];
  for await (const e of fs.readDir(P.hosts)) {
    if (e.isDirectory && !e.name.startsWith("_") && (await fs.exists(hostFile(e.name)))) {
      names.push(e.name);
    }
  }
  for (const n of names.sort()) {
    const host = await fleetExport<HostDef>(hostFile(n), "host");
    if (host === undefined) throw new Error(`${hostFile(n)} does not export host`);
    // Spec 038: what operators recorded on the host is part of its model.
    const pgState = await readPgState(host.name);
    // Spec 047: a decision in Git (decisions.ts) wins over the host's own record.
    const { loadDecisions } = await import("../fleet/decisions.ts");
    const { loadRegistration } = await import("../fleet/registration.ts");
    const registration = await loadRegistration(host.name);
    const decisions = await loadDecisions(host.name);
    const optIn = {
      ...(await readOptIns(host.name)),
      ...(decisions.optIns ?? {}),
    };
    hosts.push({
      ...host,
      // Spec 051: the MAC is a registered fact (host.ts may still name one).
      ...(!host.mac && registration?.mac ? { mac: registration.mac } : {}),
      ...(registration ? { registration } : {}),
      ...(pgState ? { pgState } : {}),
      ...(Object.keys(optIn).length ? { optIn } : {}),
      // Spec 108-tags: the tags a person gave it (decisions.ts).
      ...(decisions.tags?.length ? { tags: decisions.tags } : {}),
      ...(decisions.customTags?.length ? { customTags: decisions.customTags } : {}),
    });
  }
  return hosts;
}

/** fleets/<id>/hosts/<host>/host.ts (spec 046-engine-instance). */
export function hostFile(name: string): string {
  return path.join(P.hosts, name, "host.ts");
}

/** The PostgreSQL record (the opt-in "pg" and the instances made), when there is one (spec 038). */
export async function readPgState(host: string, root = P.state): Promise<PgState | undefined> {
  const r = await getRecord<PgState>(host, "optin", "pg", root);
  const s = r?.body;
  return s && typeof s.instances === "object" ? s : undefined;
}

/**
 * Every opt-in decision recorded on this machine for a host (spec 040, kept in
 * archon.sql by spec 048): each record whose \`enabled\` is a boolean.
 */
export async function readOptIns(
  host: string,
  root = P.state,
): Promise<Record<string, OptInRecord>> {
  const out: Record<string, OptInRecord> = {};
  for (const { name, body } of await listRecords<Record<string, unknown>>(host, "optin", root)) {
    const enabled = body["enabled"];
    if (typeof enabled === "boolean") {
      const { data, by, at } = body;
      out[name] = {
        enabled,
        by: typeof by === "string" ? by : "",
        at: typeof at === "string" ? at : "",
        ...(data === "durable" || data === "ephemeral" ? { data } : {}),
      };
    }
  }
  return out;
}

/** True for a workstation (spec 020); the boot server never installs one. */
export const isWorkstation = (h: HostDef): boolean => h.kind === "workstation";

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
    return [
      {
        name: host.user ?? fleet.admin.user,
        fullName: gh.name,
        email: gh.email,
        personas: ["operator"],
        admin: true,
        sshKeys: [],
        spec: "020-workstation",
      },
    ];
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

/** An account's home directory: /root for root, /home/<name> otherwise. */
export function homeOf(u: { name: string }): string {
  return u.name === "root" ? "/root" : `/home/${u.name}`;
}
