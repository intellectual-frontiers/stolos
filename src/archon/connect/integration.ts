/**
 * Spec 109-integrations-api: the integration layer, an algebra of kinds and capabilities. An **integration** is an account's API read
 * through one typed interface: it declares its **kind** (`stolos:ApiKind`: a router, a DNS provider, an email provider) and the
 * **capabilities** of that kind it offers (`stolos:ApiCapability`: a router's clients, devices, networks and VLANs, ports, firewall
 * rules; a DNS provider's zones and records; an email provider's domains, sending and routing), and each capability reads typed entities
 * ({@link Results}) that join the estate graph through a connector's observation (`integration-connector.ts`).
 *
 * The point is what the compiler refuses. A function that needs a capability takes {@link Has} of the kind and the capability, so an
 * integration that does not offer it, or one of another kind, is a compile error at the call; and {@link defineIntegration} demands,
 * for every capability of its kind that it does not offer, the reason it does not (`notOffered`), so a capability is either read or
 * explained and never forgotten.
 *
 * ```mermaid
 * flowchart LR
 *   onto["stolos:ApiKind and stolos:ApiCapability<br/>(the ontology: generated unions)"] --> cap["CapabilityOf&lt;kind&gt;"]
 *   cap --> res["Results: the entity each capability reads"]
 *   cap --> has["Has&lt;kind, capability&gt;: a function's need"]
 *   has --> impl["Integration&lt;kind, offered&gt;: what defineIntegration makes<br/>(read for the offered, notOffered for the rest)"]
 *   impl --> run["readAll: Reading[] and gaps"]
 *   run --> obs["integrationConnector: records, entities, posture, policies"]
 * ```
 *
 * @module
 */
// Spec: 109-integrations-api FR-001, FR-002, FR-004, FR-005

import type { Result } from "@intellectual-frontiers/commons/ts/kernel";
import type { http } from "@intellectual-frontiers/commons/ts/runtime";
import { API_CAPABILITIES } from "../ontology.auto.ts";
import { AccessDenied } from "./connector.ts";
import {
  type CapabilityOf,
  type Client,
  type DnsRecord,
  type EmailDomain,
  type Kind,
  type Reading,
  type ResultOf,
  type SwitchPort,
} from "./integration-entities.ts";
import { exchange } from "./sdk.ts";

export type {
  CapabilityOf,
  Complete,
  Kind,
  Reading,
  ResultOf,
  Results,
} from "./integration-entities.ts";

/** The capabilities of a kind, as words: the ontology's `<kind>-<capability>` codes that start with the kind, without it. */
export function capabilitiesOf<K extends Kind>(kind: K): Array<CapabilityOf<K>> {
  const out: string[] = [];
  for (const code of API_CAPABILITIES) {
    if (code.startsWith(`${kind}-`)) out.push(code.slice(kind.length + 1));
  }
  // Each word is the tail of an ontology code that starts with `<kind>-`: exactly what `CapabilityOf<K>` is.
  return out as Array<CapabilityOf<K>>;
}

/** A capability the product does not have on this version of it: a gap, not a failure. */
export class NotAvailable extends AccessDenied {}

/** A JSON body from a GET: 401 and 403 are {@link AccessDenied}, 404 and 5xx are {@link NotAvailable} (gaps), any other status from 400 an Error. */
export async function getJson<T>(
  t: http.Transport,
  url: string,
  headers: Readonly<Record<string, string>> = {},
): Promise<T> {
  const r = await exchange(t, {
    method: "GET",
    url,
    headers: { accept: "application/json", ...headers },
  });
  const where = new URL(url).pathname;
  if (r.status === 401 || r.status === 403) {
    throw new AccessDenied(`${where}: ${r.status} (the credential may not read this)`);
  }
  if (r.status === 404) {
    throw new NotAvailable(`${where}: 404 (this version of the product does not offer it)`);
  }
  if (r.status >= 500) {
    throw new NotAvailable(`${where}: HTTP ${r.status} (the product could not answer this read)`);
  }
  if (r.status >= 400) throw new Error(`${where}: HTTP ${r.status}`);
  try {
    // The caller says what the product documents; the entities are decoded field by field where they are mapped.
    return JSON.parse(r.body) as T;
  } catch {
    throw new Error(`${where}: not JSON`);
  }
}

/** What a reader is given: the credential, a read-only transport, the time, and the helpers every read needs. */
export interface ReadContext {
  /** The credential, as the vault keeps it (never put in an entity). */
  readonly cred: Readonly<Record<string, string>>;
  /** Read-only HTTP: the guard and the backoff are already on it. */
  readonly http: http.Transport;
  /** Now. */
  readonly now: Date;
  /** The headers every request carries (the authentication). */
  readonly headers: Readonly<Record<string, string>>;
  /** A JSON body from a GET (see {@link getJson}). */
  json<T>(url: string, headers?: Readonly<Record<string, string>>): Promise<T>;
  /** Run `f`; a denied or absent endpoint becomes a gap named `what`, and `fallback`. */
  orGap<T>(what: string, fallback: T, f: () => Promise<T>): Promise<T>;
  /** What one observation has read already, by key (the sites of a controller, the zones of an account). */
  memo<T>(key: string, f: () => Promise<T>): Promise<T>;
}

/** A context for one observation. */
export function readContext(o: {
  cred: Readonly<Record<string, string>>;
  http: http.Transport;
  now: Date;
  headers: Readonly<Record<string, string>>;
  gaps: string[];
}): ReadContext {
  const seen = new Map<string, Promise<unknown>>();
  return {
    cred: o.cred,
    http: o.http,
    now: o.now,
    headers: o.headers,
    json: <T>(url: string, h?: Readonly<Record<string, string>>): Promise<T> =>
      getJson<T>(o.http, url, h ?? o.headers),
    async orGap<T>(what: string, fallback: T, f: () => Promise<T>): Promise<T> {
      try {
        return await f();
      } catch (e) {
        if (e instanceof AccessDenied) {
          o.gaps.push(`${what}: ${e.message}`);
          return fallback;
        }
        throw e;
      }
    },
    memo<T>(key: string, f: () => Promise<T>): Promise<T> {
      let p = seen.get(key);
      if (p === undefined) {
        p = f();
        seen.set(key, p);
      }
      // The first call under a key stored the promise of its own type.
      return p as Promise<T>;
    },
  };
}

/** What reads one capability of a kind. */
export type Reader<K extends Kind, C extends CapabilityOf<K>> = (
  ctx: ReadContext,
) => Promise<ResultOf<K, C>>;

/**
 * What a function needs of an integration: its kind, and a reader for each capability it names. An integration that offers those and more
 * fits; one that lacks any, or is of another kind, does not compile. A function over a capability names no product:
 *
 * @example
 * ```ts
 * import { clientByMac, type Has, type ReadContext } from "./integration.ts";
 *
 * // Any router that offers `clients` fits; a DNS provider, or a router without `clients`, does not compile.
 * export const find = (i: Has<"router", "clients">, ctx: ReadContext, mac: string) =>
 *   clientByMac(i, ctx, mac);
 * ```
 */
export interface Has<K extends Kind, C extends CapabilityOf<K>> {
  /** Its kind. */
  readonly kind: K;
  /** A reader for each capability it needs. */
  readonly read: { readonly [N in C]: Reader<K, N> };
}

/** An integration: its identity, its kind, what it reads, and why it does not read the rest. */
export interface Integration<K extends Kind, C extends CapabilityOf<K>> extends Has<K, C> {
  /** Its id: the connector's (the vault folder and the observation's file name). */
  readonly id: string;
  /** Its name for people. */
  readonly title: string;
  /** The capabilities it offers, as words (the keys of `read`). */
  readonly offers: readonly CapabilityOf<K>[];
  /** For each capability of its kind that it does not offer, the reason. */
  readonly notOffered: { readonly [N in Exclude<CapabilityOf<K>, C>]: string };
}

/** What `defineIntegration` takes. */
export interface IntegrationDef<K extends Kind, C extends CapabilityOf<K>> {
  /** Its id. */
  id: string;
  /** Its name for people. */
  title: string;
  /** Its kind. */
  kind: K;
  /** A reader for each capability it offers. */
  read: { [N in C]: Reader<K, N> };
  /** The reason for each capability of the kind that it does not offer: required, so none is forgotten. */
  notOffered: { [N in Exclude<CapabilityOf<K>, C>]: string };
}

/**
 * Make an integration. The offered capabilities are the keys of `read`; `notOffered` must hold exactly the others, which the compiler
 * checks, and which this function checks again (a JavaScript caller, a stale file).
 */
export function defineIntegration<K extends Kind, const C extends CapabilityOf<K>>(
  def: IntegrationDef<K, C>,
): Integration<K, C> {
  const all: readonly string[] = capabilitiesOf(def.kind);
  const offers = Object.keys(def.read);
  for (const c of offers) {
    if (!all.includes(c)) throw new Error(`${def.id}: ${c} is not a capability of ${def.kind}`);
  }
  const missing = all.filter((c) => !offers.includes(c) && !(c in def.notOffered));
  if (missing.length) {
    throw new Error(`${def.id}: say why it does not offer ${missing.join(", ")} (notOffered)`);
  }
  const both = offers.filter((c) => c in def.notOffered);
  if (both.length) throw new Error(`${def.id}: ${both.join(", ")} is offered and not offered`);
  return {
    id: def.id,
    title: def.title,
    kind: def.kind,
    read: def.read,
    notOffered: def.notOffered,
    // The keys of `read` were just checked to be capabilities of the kind.
    offers: offers as Array<CapabilityOf<K>>,
  };
}

/** A reader of any capability, as the runtime holds it. */
type ErasedReader = (ctx: ReadContext) => Promise<unknown>;

/**
 * An integration of any kind, with the capabilities it offers (the runtime's view of an {@link Integration}, for the code that reads
 * every capability whatever the product).
 */
export interface AnyIntegration {
  /** Its id. */
  readonly id: string;
  /** Its name for people. */
  readonly title: string;
  /** Its kind. */
  readonly kind: Kind;
  /** The capabilities it offers, as words. */
  readonly offers: readonly string[];
  /** A reader for each capability it offers. */
  readonly read: Readonly<Record<string, ErasedReader | undefined>>;
  /** The reason for each capability it does not offer. */
  readonly notOffered: Readonly<Record<string, string | undefined>>;
}

/** One capability of an integration, read: a function that names the capability gets a typed answer, and an integration that lacks it does not compile. */
export function readCapability<K extends Kind, N extends CapabilityOf<K>>(
  i: Has<K, N>,
  capability: N,
  ctx: ReadContext,
): Promise<ResultOf<K, N>> {
  return i.read[capability](ctx);
}

/**
 * Every capability an integration offers, read in turn: its readings, and a gap (in `gaps`) for each capability it does not offer
 * (with its reason) and for each it offers that the account would not let it read (a denied or absent endpoint). Any other failure
 * (the network, a certificate, a body that is not JSON) is thrown: the account was not reached.
 */
export async function readAll(
  i: AnyIntegration,
  ctx: ReadContext,
  gaps: string[],
): Promise<Reading[]> {
  const out: Reading[] = [];
  for (const capability of capabilitiesOf(i.kind)) {
    const reader = i.read[capability];
    if (reader === undefined) {
      gaps.push(`${capability}: ${i.notOffered[capability] ?? "not offered"}`);
      continue;
    }
    const before = gaps.length;
    const items = await ctx.orGap<unknown>(capability, undefined, () => reader(ctx));
    if (items === undefined) {
      if (gaps.length === before) gaps.push(`${capability}: not read`);
      continue;
    }
    // The reader of `capability` of this kind returns its entity list (defineIntegration typed it so).
    out.push({ kind: i.kind, capability, items } as Reading);
  }
  return out;
}

/** A MAC address as one comparable word: lower case, no separators. */
export function macKey(mac: string): string {
  return mac.toLowerCase().replace(/[^0-9a-f]/g, "");
}

/** The client with a MAC address, from any router that offers `clients`. */
export async function clientByMac(
  i: Has<"router", "clients">,
  ctx: ReadContext,
  mac: string,
): Promise<Client | undefined> {
  const want = macKey(mac);
  return (await i.read.clients(ctx)).find((c) => c.mac !== undefined && macKey(c.mac) === want);
}

/** The ports that are down, from any router that offers `ports`. */
export async function portsDown(
  i: Has<"router", "ports">,
  ctx: ReadContext,
): Promise<SwitchPort[]> {
  return (await i.read.ports(ctx)).filter((p) => p.state === "DOWN");
}

/** The records of a name, from any DNS provider that offers `records`. */
export async function recordsNamed(
  i: Has<"dns", "records">,
  ctx: ReadContext,
  name: string,
): Promise<DnsRecord[]> {
  const want = name.toLowerCase();
  return (await i.read.records(ctx)).filter((r) => r.name.toLowerCase() === want);
}

/** The domains that do not publish a record of email's trust (SPF, DKIM or DMARC), from any email provider that offers `domains`. */
export async function domainsLacking(
  i: Has<"email", "domains">,
  ctx: ReadContext,
  what: "spf" | "dkim" | "dmarc",
): Promise<EmailDomain[]> {
  return (await i.read.domains(ctx)).filter((d) =>
    what === "dkim" ? !d.dkim : d[what] === undefined,
  );
}

/**
 * A transport that answers a GET it has answered before, within one observation, from the first answer, and sends everything else on.
 * Only an answer that will not change on a retry is kept (not a 429 or a 5xx), so the backoff above it still works. Two readers of one
 * account (a connector and an integration) then send each request once.
 */
export function memoGets(t: http.Transport): http.Transport {
  const kept = new Map<string, Result<http.Exchange, http.TransportError>>();
  return {
    kind: t.kind,
    async send(r) {
      if (r.method !== "GET") return await t.send(r);
      const key = r.url;
      const hit = kept.get(key);
      if (hit !== undefined) return hit;
      const x = await t.send(r);
      if (
        x.kind === "ok" &&
        (x.value.status < 400 || x.value.status === 403 || x.value.status === 404)
      ) {
        kept.set(key, x);
      }
      return x;
    },
  };
}
