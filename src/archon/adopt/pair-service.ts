/**
 * Spec 103-three-ports: what a door mounts to serve the pairing on this PC. The doors (the boot server's HTTP on 8080, the console's
 * TLS on 443, and the pair-only server `stolos pair` runs when boot serve is not) are different processes from `stolos pair`; each
 * answers `/device/pair` from the pairing's file in the secrets folder ({@link SECRETS.pairing}) with {@link devicePairHandler}, so
 * all of them serve one pairing and count its wrong tries together. The machine is named here (the record's `--name`, else its
 * hostname's first label; a managed server's name or a bad name is refused) and its probe key made here, in whichever process the
 * machine reached.
 *
 * @module
 */
// Spec: 098-pair FR-007
// Spec: 103-three-ports FR-003, FR-004, FR-005, FR-006
// Spec: 107-pairing-and-query FR-005, FR-006

import { SECRETS } from "../core/secrets.ts";
import { P } from "../core/paths.ts";
import { VERSION } from "../version.ts";
import { ensureProbeKey, MACHINE_NAME } from "./adopt.ts";
import { nameFor as hostnameToName } from "./checkin.ts";
import { isPairPath, type PairOptions, PairSession } from "./pair.ts";
import { FilePairStore, type PairRecord, type PairStore } from "./pair-store.ts";

/** The pairing's file as a store. */
export function pairingStore(): PairStore {
  return new FilePairStore(SECRETS.pairing);
}

/**
 * The name for a machine and its probe key (made now, kept in the secrets folder), or why it cannot have one: the record's `--name`
 * wins over the hostname for the first machine; a managed server's name and anything that is not a DNS label are refused with what to type on the PC.
 */
export async function pairNameFor(
  hostname: string,
  record: Pick<PairRecord, "name" | "nameUsed" | "fleet">,
  managed: () => Promise<ReadonlySet<string>>,
  keyFor: (name: string, fleet: string) => Promise<string> = ensureProbeKey,
): Promise<{ name: string; key: string } | { refuse: string }> {
  // `--name` is for the first machine of the session; the rest are named by their hostnames (spec 107 FR-006).
  const name = (record.nameUsed ? undefined : record.name) ?? hostnameToName(hostname);
  if ((await managed()).has(name)) {
    return {
      refuse: `${name} is a managed server in this fleet: on the PC, pair again with --name <another>`,
    };
  }
  if (!MACHINE_NAME.test(name)) {
    return { refuse: `${name} is not a name: on the PC, pair again with --name <name>` };
  }
  return { name, key: await keyFor(name, record.fleet) };
}

/** The names of this fleet's managed servers, as the model has them. */
async function managedNames(): Promise<ReadonlySet<string>> {
  const { loadHosts } = await import("../model/load.ts");
  return new Set((await loadHosts()).map((h) => h.name));
}

/**
 * A request handler for pairing's routes over a store (the pairing's file by default): the answer for a `/device/pair` request, or
 * undefined for any other path, so a door can try it first and serve the rest itself. With no pairing waiting it answers 404.
 */
export function devicePairHandler(
  store: PairStore = pairingStore(),
  o: { nameFor?: PairOptions["nameFor"]; pollMs?: number; now?: () => number } = {},
): (req: Request, from?: string) => Promise<Response | undefined> {
  const session = new PairSession({
    store,
    nameFor: o.nameFor ?? ((hostname, record) => pairNameFor(hostname, record, managedNames)),
    ...(o.pollMs ? { pollMs: o.pollMs } : {}),
    ...(o.now ? { now: o.now } : {}),
  });
  return (req, from) =>
    isPairPath(new URL(req.url).pathname) ? session.handle(req, from) : Promise.resolve(undefined);
}

/** The engine tag the pairing's scripts say (`v1.2.3`). */
export const pairEngine = (): string => `v${VERSION}`;

/** The active fleet's id (the pairing's record names it). */
export const pairFleet = (): string => P.fleetId;
