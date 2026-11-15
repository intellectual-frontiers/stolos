/**
 * Spec 089: the connector SDK. A connector is declared once, in typed
 * TypeScript: its credential's fields, the resources it reads (each an async
 * generator over the vendor's public API, mapped to a label in the estate
 * graph and an OCSF class), and its posture policies. `defineConnector`
 * turns it into a {@link Connector} the rest of Stolos already runs.
 *
 * What every connector gets, so none re-implements it:
 * - a read-only guard: only GET, plus the token endpoints it declares;
 * - paging: `Link: rel="next"`, cursors in the body, page tokens;
 * - backoff on 429 and 503, honoring Retry-After;
 * - a denied call becomes a gap in the observation, not a failure;
 * - the vendor's record kept beside the mapped one (OCSF's `unmapped`).
 *
 * Nothing else: no vendor SDK, no third-party binary. Only Deno and the
 * vendor's published API.
 *
 * ```mermaid
 * flowchart LR
 *   api["vendor's public API"] -- "read-only HTTP" --> list["resource.list(): async generator"]
 *   list --> map["resource.map(): label props + OCSF class"]
 *   map --> obs["Observation: assets, records, gaps"]
 *   obs --> pol["policies (SCF)"] & graph["estate graph"]
 * ```
 *
 * @module
 */

import type { PolicyResult } from "../adopt/policy.ts";
import { OCSF_CLASSES } from "../ocsf/types.auto.ts";
import type { Column, LabelView, RowOf } from "../schema/define.ts";
import type { Entities } from "./entities.ts";
import {
  AccessDenied,
  type Asset,
  type Connector,
  type Http,
  type Observation,
  type ServiceModel,
} from "./connector.ts";

/** One field of a credential. */
export interface FieldDef {
  /** A secret (a token, a key): asked for without echo, kept only in the vault. */
  secret: boolean;
  /** What to type, for people. */
  hint: string;
  /** A file's path is asked for, and the file's content kept (a key file). */
  file?: boolean;
}

/** A credential: each declared field, as text. */
export type CredOf<F extends Record<string, FieldDef>> = { [K in keyof F]: string };

/** One record a resource read, mapped. */
export interface Mapped<P extends Record<string, Column>> {
  /** Its id in the vendor's system. */
  native_id: string;
  /** Its name for people. */
  display_name: string;
  /** Its label's properties. */
  props: RowOf<P>;
  /** Where it is (a region), when that means something. */
  where?: string;
}

/** A record in an observation: a node of the estate graph, with its OCSF class and the vendor's own record. */
export interface ObservedRecord {
  /** The label (an estate graph view). */
  label: string;
  /** The OCSF class it is emitted as. */
  ocsf_class_uid: number;
  /** Its id in the vendor's system. */
  native_id: string;
  /** Its name for people. */
  display_name: string;
  /** Its properties. */
  props: Record<string, unknown>;
  /** The vendor's record as read (OCSF's unmapped), when the connector keeps it. */
  unmapped?: unknown;
}

/** What a resource's code is given. */
export interface Ctx<F extends Record<string, FieldDef>> {
  /** The credential. */
  cred: CredOf<F>;
  /** Read-only HTTP (GET, plus the declared token endpoints). */
  http: Http;
  /** Now. */
  now: Date;
  /** Headers to send (from `auth`). */
  headers: Record<string, string>;
  /** Run `f`; a denied call becomes a gap named `what`, and `fallback` (a part read, the rest kept). */
  orGap<T>(what: string, fallback: T, f: () => Promise<T>): Promise<T>;
  /** A JSON body from a GET, or AccessDenied on 401 and 403. */
  json<T>(url: string, headers?: Record<string, string>): Promise<T>;
  /** Every item of a list that pages with `Link: rel="next"`. */
  linkPages<T>(url: string, headers?: Record<string, string>): AsyncGenerator<T>;
  /** Every item of a list whose body says where the next page is. */
  cursorPages<B, T>(
    first: string,
    items: (body: B) => T[] | undefined,
    next: (body: B, url: string) => string | undefined,
    headers?: Record<string, string>,
  ): AsyncGenerator<T>;
}

/** One resource a connector reads. */
export interface ResourceDef<
  F extends Record<string, FieldDef>,
  Raw,
  P extends Record<string, Column>,
> {
  /** The estate graph label its records fill (from defineLabel). */
  label: LabelView<P>;
  /** The OCSF class its records are emitted as. */
  ocsf: keyof typeof OCSF_CLASSES;
  /** The vendor's records. */
  list(ctx: Ctx<F>): AsyncIterable<Raw>;
  /** One vendor record, mapped. */
  map(raw: Raw): Mapped<P>;
  /** Keep the vendor's record beside the mapped one (default: no; least data). */
  keepUnmapped?: boolean;
  /** A denied read fails the observation instead of becoming a gap (the connector cannot work without it). */
  required?: boolean;
  /** How it is listed in `estate assets`: its kind (default: the label) and a few facts. */
  asset?: (
    raw: Raw,
    m: Mapped<P>,
  ) => { kind?: string; facts?: Asset["facts"]; fleetMachine?: string } | undefined;
}

/** What posture is told besides the records: what could not be read, and when it was read. */
export interface Seen {
  /** The observation's gaps, each `<what>: <why>`. */
  gaps: string[];
  /** When it was read. */
  now: Date;
}

/** A connector, as declared. */
export interface ConnectorDef<F extends Record<string, FieldDef>> {
  /** Its id (the vault folder and the observation's file name). */
  id: string;
  /** Its name for people. */
  title: string;
  /** The Simple Icons slug for its logo, or "". */
  logo: string;
  /** Its NIST SP 800-145 service models. */
  serviceModels: ServiceModel[];
  /** Its market categories (ids in MARKET_CATEGORIES). */
  markets: string[];
  /** How to make a read-only credential, step by step. */
  connectHelp: string[];
  /** The quickest way to one. */
  recipe: Connector["recipe"];
  /** The credential's fields. */
  fields: F;
  /** URL prefixes the guard lets POST to (OAuth token endpoints only). */
  tokenEndpoints?: (cred: CredOf<F>) => string[];
  /** The headers to send, given the credential (may call a token endpoint). */
  auth(cred: CredOf<F>, http: Http, now: Date): Promise<Record<string, string>>;
  /** The account, for people (from the credential, or from what was read). */
  account(cred: CredOf<F>, records: ObservedRecord[]): string;
  /** The resources it reads. */
  // deno-lint-ignore no-explicit-any
  resources: Record<string, ResourceDef<F, any, any>>;
  /** Posture facts from the records (what the policies read), knowing what could not be read and when. */
  posture(records: ObservedRecord[], cred: CredOf<F>, seen: Seen): Observation["posture"];
  /** Its posture policies. */
  policies(o: Observation, now: number): PolicyResult[];
}

/** HTTP that refuses anything but GET, except POSTs to the given URL prefixes. */
export function readOnly(http: Http, tokenEndpoints: string[] = []): Http {
  return (url, init) => {
    const method = (init?.method ?? "GET").toUpperCase();
    if (method !== "GET" && !(method === "POST" && tokenEndpoints.some((t) => url.startsWith(t)))) {
      return Promise.reject(new Error(`read-only: ${method} ${new URL(url).origin} is refused`));
    }
    return http(url, init);
  };
}

/** HTTP that waits and tries again on 429 and 503 (Retry-After, else 1, 2, 4 s), up to `tries` times. */
export function withBackoff(
  http: Http,
  tries = 3,
  sleep = (ms: number) => new Promise((r) => setTimeout(r, ms)),
): Http {
  return async (url, init) => {
    for (let i = 0;; i++) {
      const r = await http(url, init);
      if ((r.status !== 429 && r.status !== 503) || i >= tries) return r;
      const after = Number(r.retryAfter);
      await sleep(Number.isFinite(after) && after > 0 ? after * 1000 : 1000 * 2 ** i);
    }
  };
}

function ctxFor<F extends Record<string, FieldDef>>(
  cred: CredOf<F>,
  http: Http,
  now: Date,
  headers: Record<string, string>,
  gaps: string[],
): Ctx<F> {
  const get = async <T>(url: string, h = headers): Promise<{ body: T; link?: string }> => {
    const r = await http(url, { headers: h });
    const path = new URL(url).pathname;
    if (r.status === 401 || r.status === 403) {
      throw new AccessDenied(`${path}: ${r.status} (the credential may not read this)`);
    }
    if (r.status >= 400) throw new Error(`${path}: HTTP ${r.status}`);
    try {
      return { body: JSON.parse(r.text) as T, ...(r.link ? { link: r.link } : {}) };
    } catch {
      throw new Error(`${path}: not JSON`);
    }
  };
  return {
    cred,
    http,
    now,
    headers,
    async orGap<T>(what: string, fallback: T, f: () => Promise<T>) {
      try {
        return await f();
      } catch (e) {
        if (e instanceof AccessDenied) {
          gaps.push(`${what}: ${e.message}`);
          return fallback;
        }
        throw e;
      }
    },
    async json<T>(url: string, h?: Record<string, string>) {
      return (await get<T>(url, h ?? headers)).body;
    },
    async *linkPages<T>(url: string, h?: Record<string, string>) {
      let next: string | undefined = url;
      for (let i = 0; next && i < 200; i++) {
        const r: { body: T[]; link?: string } = await get<T[]>(next, h ?? headers);
        yield* r.body;
        next = r.link?.match(/<([^>]+)>;\s*rel="next"/)?.[1];
      }
    },
    async *cursorPages<B, T>(
      first: string,
      items: (b: B) => T[] | undefined,
      next: (b: B, url: string) => string | undefined,
      h?: Record<string, string>,
    ) {
      let url: string | undefined = first;
      for (let i = 0; url && i < 200; i++) {
        const b: B = (await get<B>(url, h ?? headers)).body;
        yield* items(b) ?? [];
        url = next(b, url);
      }
    },
  };
}

/** Make a connector from its declaration. */
export function defineConnector<F extends Record<string, FieldDef>>(
  def: ConnectorDef<F>,
): Connector & { def: ConnectorDef<F> } {
  return {
    id: def.id,
    title: def.title,
    logo: def.logo,
    serviceModels: def.serviceModels,
    markets: def.markets,
    connectHelp: def.connectHelp,
    recipe: def.recipe,
    fields: Object.entries(def.fields).map(([name, f]) => ({ name, ...f })),
    def,
    async observe(raw, http, now) {
      const cred = raw as CredOf<F>;
      const guarded = withBackoff(readOnly(http, def.tokenEndpoints?.(cred) ?? []));
      const headers = await def.auth(cred, guarded, now);
      const gaps: string[] = [];
      const ctx = ctxFor(cred, guarded, now, headers, gaps);
      const records: ObservedRecord[] = [];
      const assets: Asset[] = [];
      for (const [name, r] of Object.entries(def.resources)) {
        try {
          for await (const x of r.list(ctx)) {
            const m = r.map(x);
            records.push({
              label: r.label.name,
              ocsf_class_uid: OCSF_UID[r.ocsf],
              native_id: m.native_id,
              display_name: m.display_name,
              props: m.props as Record<string, unknown>,
              ...(r.keepUnmapped ? { unmapped: x } : {}),
            });
            const extra = r.asset?.(x, m);
            if (extra !== undefined || !r.asset) {
              assets.push({
                kind: extra?.kind ?? r.label.name,
                id: m.native_id,
                name: m.display_name,
                ...(m.where ? { where: m.where } : {}),
                ...(extra?.facts ? { facts: extra.facts } : {}),
                ...(extra?.fleetMachine ? { fleetMachine: extra.fleetMachine } : {}),
              });
            }
          }
        } catch (e) {
          if (e instanceof AccessDenied && !r.required) gaps.push(`${name}: ${e.message}`);
          else throw e;
        }
      }
      const { entities, rest } = toEntities(def.id, records);
      const seen = { gaps: [...new Set(gaps)], now };
      return {
        at: now.toISOString().replace(/\.\d+Z$/, "Z"),
        provider: def.id,
        account: def.account(cred, records),
        assets,
        posture: def.posture(records, cred, seen),
        gaps: seen.gaps,
        ...(Object.keys(entities).length ? { entities } : {}),
        ...(rest.length ? { records: rest } : {}),
      };
    },
    policies: (o, now) => def.policies(o, now),
  };
}

const OCSF_UID = Object.fromEntries(
  Object.entries(OCSF_CLASSES).map(([k, v]) => [k, v.uid]),
) as Record<keyof typeof OCSF_CLASSES, number>;

/**
 * The estate's entities from a connector's records: `user_account` records
 * are accounts, `code_repository` records repositories, `person` records
 * (an HR roster) people, and `hardware_device` records devices. Other labels
 * stay records (nodes of the estate graph as they are).
 */
export function toEntities(
  system: string,
  records: ObservedRecord[],
): { entities: Entities; rest: ObservedRecord[] } {
  const e: Required<Entities> = { people: [], accounts: [], devices: [], repositories: [] };
  const rest: ObservedRecord[] = [];
  const opt = <T>(k: string, v: T | undefined) => (v === undefined || v === null ? {} : { [k]: v });
  for (const r of records) {
    const p = r.props as Record<string, unknown>;
    if (r.label === "user_account") {
      e.accounts.push({
        system,
        id: r.native_id,
        name: r.display_name,
        active: !!p.active,
        ...opt("email", p.email as string | undefined),
        ...opt("admin", p.admin as boolean | undefined),
        ...opt("mfa", p.mfa as boolean | undefined),
        ...opt("lastLogin", p.last_login as string | undefined),
        ...opt("service", p.service as boolean | undefined),
      });
    } else if (r.label === "code_repository") {
      e.repositories.push({
        system,
        name: r.native_id,
        private: !!p.private,
        ...opt("protected", p.protected as boolean | undefined),
        ...opt("reviews", p.reviews as number | undefined),
        ...opt("secretScanning", p.secret_scanning as boolean | undefined),
        ...opt("dependencyAlerts", p.dependency_alerts as boolean | undefined),
      });
    } else if (r.label === "person") {
      e.people.push({
        email: String(p.email ?? ""),
        status: (p.status as "active" | "terminated" | "leave" | "unknown") ?? "unknown",
        ...opt("name", p.name as string | undefined),
        ...opt("start", p.start_date as string | undefined),
        ...opt("end", p.end_date as string | undefined),
        ...opt("manager", p.manager as string | undefined),
        ...opt("type", p.role_type as string | undefined),
      });
    } else if (r.label === "hardware_device") {
      e.devices.push({
        source: system,
        id: r.native_id,
        name: r.display_name,
        managed: false,
        ...opt("owner", p.owner as string | undefined),
        ...opt("os", p.os_name as string | undefined),
        ...opt("serial", p.serial_number as string | undefined),
        ...opt("encrypted", p.encrypted as boolean | undefined),
        ...opt("seen", p.last_seen as string | undefined),
      });
    } else rest.push(r);
  }
  const entities = Object.fromEntries(
    Object.entries(e).filter(([, v]) => v.length),
  ) as Entities;
  return { entities, rest };
}

/** Recorded responses, for tests: each URL to its status, body, and Link header; anything else is refused. */
export function recordedHttp(
  fixtures: Record<string, { status?: number; body: unknown; link?: string }>,
  calls: Array<{ method: string; url: string }> = [],
): Http {
  return (url, init) => {
    calls.push({ method: init?.method ?? "GET", url });
    const f = fixtures[url];
    if (!f) return Promise.reject(new Error(`no recorded response for ${url}`));
    return Promise.resolve({
      status: f.status ?? 200,
      text: typeof f.body === "string" ? f.body : JSON.stringify(f.body),
      ...(f.link ? { link: f.link } : {}),
    });
  };
}

/** A bearer token header. */
export function bearer(token: string, scheme = "Bearer"): Record<string, string> {
  return { Authorization: `${scheme} ${token}`, Accept: "application/json" };
}

/** An OAuth 2.0 client-credentials token (RFC 6749 section 4.4), as a bearer header. */
export async function clientCredentials(
  http: Http,
  tokenUrl: string,
  clientId: string,
  clientSecret: string,
  scope?: string,
): Promise<Record<string, string>> {
  const r = await http(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: clientId,
      client_secret: clientSecret,
      ...(scope ? { scope } : {}),
    }).toString(),
  });
  if (r.status === 400 || r.status === 401 || r.status === 403) {
    throw new AccessDenied(
      `${new URL(tokenUrl).pathname}: ${r.status} (check the client id and secret)`,
    );
  }
  if (r.status >= 400) throw new Error(`${new URL(tokenUrl).pathname}: HTTP ${r.status}`);
  return bearer((JSON.parse(r.text) as { access_token: string }).access_token);
}

/**
 * A read the observation cannot do without: a denial fails the observation
 * (an Error with the same message) instead of becoming the resource's gap.
 */
export async function mustRead<T>(f: () => Promise<T>): Promise<T> {
  try {
    return await f();
  } catch (e) {
    if (e instanceof AccessDenied) throw new Error(e.message);
    throw e;
  }
}
