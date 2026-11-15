/**
 * Spec 082: the provider's registry of client checkouts. A provider (a managed
 * service provider or a virtual CISO) keeps one file on its own PC,
 * `clients.json` in its Stolos config folder (`P.provider`): each client's id,
 * title, the path to that client's checkout, and the fleet within it. The file
 * is the provider's, never in any client's repository; it holds no secret.
 *
 * One checkout belongs to one client: two clients never share a repository
 * (or one inside the other), so nothing rendered or recorded for one lands
 * in the other's.
 *
 * @module
 */

import { CLIENT_ID, listFleets, P } from "../core/paths.ts";
import { join, resolve, sep } from "../core/path.ts";
import { readTextOr } from "../core/fsx.ts";

/** The registry file's format. */
export const CLIENTS_FORMAT = "stolos-clients/1";

/** One client: a fleet in a checkout of that client's own repository. */
export interface Client {
  /** Its id (lowercase letters, digits, hyphens): `--client <id>`, and its folders on this PC. */
  id: string;
  /** Its name, for the provider's eyes. */
  title: string;
  /** The absolute path of the client's checkout (the folder holding `fleets/`). */
  path: string;
  /** The fleet within it (`fleets/<fleet>/`). */
  fleet: string;
  /** When it was added (ISO date). */
  added: string;
}

/** The registry file's contents. */
export interface ClientRegistry {
  /** Always `CLIENTS_FORMAT`. */
  format: string;
  /** The clients, by id. */
  clients: Client[];
}

/** The registry file (`clients.json` in the provider's folder). */
export function registryFile(): string {
  return join(P.provider, "clients.json");
}

/** Where `stolos clients use <id>` remembers the chosen client. */
export function choiceFile(): string {
  return join(P.provider, "client");
}

/** Read the registry (empty when there is none); a file in another form is refused. */
export async function loadClients(file: string = registryFile()): Promise<Client[]> {
  const text = await readTextOr(file);
  if (text === undefined) return [];
  const r = JSON.parse(text) as ClientRegistry;
  if (r.format !== CLIENTS_FORMAT || !Array.isArray(r.clients)) {
    throw new Error(`${file} is not a client registry (${CLIENTS_FORMAT})`);
  }
  for (const c of r.clients) {
    if (!CLIENT_ID.test(c.id) || !c.path || !c.fleet) {
      throw new Error(`${file}: a client entry is malformed (${JSON.stringify(c.id)})`);
    }
  }
  return r.clients;
}

/** Write the registry (sorted by id), readable by its owner only. */
export async function saveClients(list: Client[], file: string = registryFile()): Promise<void> {
  await Deno.mkdir(join(file, ".."), { recursive: true });
  const body: ClientRegistry = {
    format: CLIENTS_FORMAT,
    clients: [...list].sort((a, b) => a.id.localeCompare(b.id)),
  };
  await Deno.writeTextFile(file, JSON.stringify(body, null, 2) + "\n", { mode: 0o600 });
}

/** The client with this id, or undefined. */
export async function findClient(
  id: string,
  file: string = registryFile(),
): Promise<Client | undefined> {
  return (await loadClients(file)).find((c) => c.id === id);
}

/** The chosen client's id (`clients use`), or "". */
export async function chosenClient(file: string = choiceFile()): Promise<string> {
  return (await readTextOr(file))?.trim() ?? "";
}

/** Whether `a` and `b` are the same folder or one is inside the other. */
export function overlaps(a: string, b: string): boolean {
  const low = Deno.build.os === "windows" ? (s: string) => s.toLowerCase() : (s: string) => s;
  const p = low(resolve(a)), q = low(resolve(b));
  return p === q || p.startsWith(q + sep) || q.startsWith(p + sep);
}

/** A client to add to `existing`: the new entry, or why it cannot be added (and the fix). */
export function planAdd(
  existing: Client[],
  o: { path: string; fleet?: string; id?: string; title?: string; today?: string },
): { client: Client } | { error: string; fix?: string } {
  const path = resolve(o.path);
  const fleets = listFleets(path);
  if (!fleets.length) {
    return {
      error: `${path} holds no fleet (no fleets/<id>/fleet.ts)`,
      fix: "the path of a checkout of the client's fleet repository",
    };
  }
  const fleet = o.fleet ?? (fleets.length === 1 ? fleets[0] : "");
  if (!fleet) {
    return {
      error: `${path} holds more than one fleet (${fleets.join(", ")})`,
      fix: "choose one with --fleet <id>",
    };
  }
  if (!fleets.includes(fleet)) {
    return { error: `no fleet ${fleet} in ${path} (here: ${fleets.join(", ")})` };
  }
  const id = o.id ?? fleet;
  if (!CLIENT_ID.test(id)) {
    return {
      error: `${id} is not a client id`,
      fix: "--id with lowercase letters, digits, and hyphens",
    };
  }
  if (existing.some((c) => c.id === id)) {
    return { error: `there is already a client ${id}`, fix: "choose another with --id <id>" };
  }
  const shared = existing.find((c) => overlaps(c.path, path));
  if (shared) {
    return {
      error: `${path} is client ${shared.id}'s checkout (or inside it, or holds it)`,
      fix: "each client is its own repository, in its own checkout",
    };
  }
  return {
    client: {
      id,
      title: o.title?.trim() || id,
      path,
      fleet,
      added: o.today ?? new Date().toISOString().slice(0, 10),
    },
  };
}
