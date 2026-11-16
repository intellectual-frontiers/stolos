/**
 * Spec 089: the connector SDK. A connector is declared once, in typed
 * TypeScript: its credential's fields, the resources it reads (each an async
 * generator over the vendor's public API, mapped to a label in the estate
 * graph and an OCSF class), and its posture policies. `defineConnector`
 * turns it into a {@link Connector} the rest of Stolos already runs.
 *
 * What every connector gets, so none re-implements it (the transport, the
 * read-only guard, backoff and paging are IFC TypeScript's runtime `http`):
 * - a read-only guard: only safe methods, plus the token endpoints it declares
 *   and the POSTs it declares as reads (`readPost`);
 * - paging: `Link: rel="next"`, cursors in the body, page tokens;
 * - backoff on 429 and 503, honoring Retry-After;
 * - a denied call becomes a gap in the observation, not a failure;
 * - the vendor's record kept beside the mapped one (OCSF's `unmapped`).
 *
 * Nothing else: no vendor SDK, no third-party binary. Only the runtime and the
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
// Spec: 089-ocsf-schema-language

import { type Result, unknownValue } from "@intellectual-frontiers/commons/ts/kernel";
import { http } from "@intellectual-frontiers/commons/ts/runtime";
import type { PolicyResult } from "../adopt/policy.ts";
import { OCSF_CLASSES } from "../ocsf/classes.ts";
import type { Column, LabelView, RowOf } from "../schema/define.ts";
import type { Account, Device, Entities, Person, Repository } from "./entities.ts";
import {
  AccessDenied,
  type Asset,
  type Connector,
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
  /** Read-only HTTP (safe methods, plus the declared token endpoints and read POSTs). */
  http: http.Transport;
  /** Now. */
  now: Date;
  /** Headers to send (from `auth`). */
  headers: Record<string, string>;
  /** Run `f`; a denied call becomes a gap named `what`, and `fallback` (a part read, the rest kept). */
  orGap<T>(what: string, fallback: T, f: () => Promise<T>): Promise<T>;
  /** Record a posture fact read beside the records (an organization's setting, say): `posture` may override it. */
  fact(name: string, value: string | number | boolean): void;
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
  /**
   * Spec 088: POSTs that only read, which the guard lets through when this
   * says so (an AWS JSON API's Describe and Get actions, say). Every other
   * POST is refused.
   */
  readPost?: http.ReadPost;
  /** The headers to send, given the credential (may call a token endpoint). */
  auth(cred: CredOf<F>, http: http.Transport, now: Date): Promise<Record<string, string>>;
  /** The account, for people (from the credential, or from what was read). */
  account(cred: CredOf<F>, records: ObservedRecord[]): string;
  /**
   * The resources it reads. Each resource's raw record and label differ, so the map's values are
   * existentially typed: `never` for what `map` reads and `Record<string, Column>` for its label.
   */
  resources: Record<string, AnyResource<F>>;
  /** Posture facts from the records (what the policies read), knowing what could not be read and when. */
  posture(records: ObservedRecord[], cred: CredOf<F>, seen: Seen): Observation["posture"];
  /** Its posture policies. */
  policies(o: Observation, now: number): PolicyResult[];
  /** Spec 073: how often it is observed, when not daily. */
  cadence?: Connector["cadence"];
}

/**
 * A resource of any raw record and label, as a connector's map of resources holds it. A resource's
 * `map` and `asset` are called only with the records its own `list` gives, so they are typed here as
 * taking what `list` gives (`never` from the outside), which every resource is assignable to.
 */
export interface AnyResource<F extends Record<string, FieldDef>> {
  /** The estate graph label its records fill. */
  label: LabelView;
  /** The OCSF class its records are emitted as. */
  ocsf: keyof typeof OCSF_CLASSES;
  /** The vendor's records. */
  list(ctx: Ctx<F>): AsyncIterable<unknown>;
  /** One vendor record, mapped. */
  map: (raw: never) => AnyMapped;
  /** Keep the vendor's record beside the mapped one. */
  keepUnmapped?: boolean;
  /** A denied read fails the observation. */
  required?: boolean;
  /** How it is listed in `estate assets`. */
  asset?: (raw: never, m: never) => AssetExtra;
}

/** What a resource says of a record for `estate assets` (undefined: it is not listed). */
type AssetExtra = { kind?: string; facts?: Asset["facts"]; fleetMachine?: string } | undefined;

/** A mapped record, of any label. */
interface AnyMapped {
  native_id: string;
  display_name: string;
  props: object;
  where?: string;
}

/** A request's answer, or an Error that says why there was none (a refusal, the network). */
export async function exchange(t: http.Transport, r: http.OutRequest): Promise<http.Exchange> {
  const x = await t.send(r);
  if (x.kind === "err") throw new Error(x.error.message);
  return x.value;
}

/** A read error thrown: a denial as AccessDenied (a gap), anything else as an Error. */
function thrown(e: http.ReadError): Error {
  return e.kind === "denied"
    ? new AccessDenied(http.formatReadError(e))
    : new Error(http.formatReadError(e));
}

/** The value of a read, or its error thrown (see {@link thrown}). */
function valueOf<T>(r: Result<T, http.ReadError>): T {
  if (r.kind === "err") throw thrown(r.error);
  return r.value;
}

/**
 * The items of one of IFC TypeScript's paging generators, typed as the connector says the vendor's
 * API documents them (the vendor's record is decoded field by field where it is mapped); the
 * generator's failure is thrown (see {@link thrown}).
 */
async function* itemsOf<T>(
  pages: AsyncGenerator<unknown, Result<number, http.ReadError>>,
): AsyncGenerator<T> {
  for (;;) {
    const step = await pages.next();
    if (step.done === true) {
      valueOf(step.value);
      return;
    }
    yield step.value as T;
  }
}

/**
 * A JSON body from any method (a token endpoint's POST, a JSON API that reads by POST), typed as the
 * vendor documents it; 401 and 403 are AccessDenied, any other status from 400 up an Error.
 */
export async function sendJson<T>(
  t: http.Transport,
  url: string,
  headers: Record<string, string>,
  method: http.OutRequest["method"] = "GET",
  body?: string,
): Promise<T> {
  const r = await exchange(t, { method, url, headers, ...(body === undefined ? {} : { body }) });
  const path = new URL(url).pathname;
  if (r.status === 401 || r.status === 403) {
    throw new AccessDenied(`${path}: ${r.status} (the credential may not read this)`);
  }
  if (r.status >= 400) throw new Error(`${path}: HTTP ${r.status}`);
  try {
    return JSON.parse(r.body) as T;
  } catch {
    throw new Error(`${path}: not JSON`);
  }
}

function ctxFor<F extends Record<string, FieldDef>>(
  cred: CredOf<F>,
  t: http.Transport,
  now: Date,
  headers: Record<string, string>,
  gaps: string[],
  facts: Observation["posture"] = {},
): Ctx<F> {
  return {
    cred,
    http: t,
    now,
    headers,
    async orGap<T>(what: string, fallback: T, f: () => Promise<T>): Promise<T> {
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
    fact(name: string, value: string | number | boolean): void {
      facts[name] = value;
    },
    async json<T>(url: string, h?: Record<string, string>): Promise<T> {
      return valueOf(await http.getJson(t, url, unknownValue, h ?? headers)) as T;
    },
    linkPages<T>(url: string, h?: Record<string, string>): AsyncGenerator<T> {
      return itemsOf<T>(http.linkPages(t, url, unknownValue, { headers: h ?? headers }));
    },
    cursorPages<B, T>(
      first: string,
      items: (b: B) => T[] | undefined,
      next: (b: B, url: string) => string | undefined,
      h?: Record<string, string>,
    ): AsyncGenerator<T> {
      return itemsOf<T>(
        http.cursorPages(
          t,
          first,
          unknownValue,
          (b) => items(b as B) ?? [],
          (b, url) => next(b as B, url),
          { headers: h ?? headers },
        ),
      );
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
    ...(def.cadence ? { cadence: def.cadence } : {}),
    def,
    async observe(raw, t, now): Promise<Observation> {
      const cred = credOf(def.fields, raw);
      const guarded = http.withBackoff(
        http.readOnly(t, def.tokenEndpoints?.(cred) ?? [], def.readPost),
      );
      const headers = await def.auth(cred, guarded, now);
      const gaps: string[] = [];
      const facts: Observation["posture"] = {};
      const ctx = ctxFor(cred, guarded, now, headers, gaps, facts);
      const records: ObservedRecord[] = [];
      const assets: Asset[] = [];
      for (const [name, r] of Object.entries(def.resources)) {
        // A resource's map and asset take what its own list gives (see AnyResource).
        const map = r.map as (x: unknown) => AnyMapped;
        const asset = r.asset as ((x: unknown, m: AnyMapped) => AssetExtra) | undefined;
        try {
          for await (const x of r.list(ctx)) {
            const m = map(x);
            records.push({
              label: r.label.name,
              ocsf_class_uid: OCSF_CLASSES[r.ocsf].uid,
              native_id: m.native_id,
              display_name: m.display_name,
              props: { ...m.props },
              ...(r.keepUnmapped === true ? { unmapped: x } : {}),
            });
            const extra = asset?.(x, m);
            if (extra !== undefined || asset === undefined) {
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
          if (e instanceof AccessDenied && r.required !== true) gaps.push(`${name}: ${e.message}`);
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
        posture: { ...facts, ...def.posture(records, cred, seen) },
        gaps: seen.gaps,
        ...(Object.keys(entities).length ? { entities } : {}),
        ...(rest.length ? { records: rest } : {}),
      };
    },
    policies: (o, now) => def.policies(o, now),
  };
}

/** The credential's declared fields, from the vault's record (a missing field is empty). */
function credOf<F extends Record<string, FieldDef>>(
  fields: F,
  raw: Record<string, string>,
): CredOf<F> {
  const cred: Record<string, string> = { ...raw };
  for (const name of Object.keys(fields)) cred[name] = raw[name] ?? "";
  // Every declared field is set above, so the record is the credential the connector declared.
  return cred as CredOf<F>;
}

const text = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const flag = (v: unknown): boolean | undefined => (typeof v === "boolean" ? v : undefined);
const count = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);
const STATUSES: readonly Person["status"][] = ["active", "terminated", "leave", "unknown"];
const statusOf = (v: unknown): Person["status"] => STATUSES.find((s) => s === v) ?? "unknown";

/** The optional fields of an entity, left out where the record has no value of the right type. */
function present<T extends object>(o: T): { [K in keyof T]?: Exclude<T[K], undefined> } {
  // Only the entries with a value are kept, so each kept one has its field's defined type.
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as {
    [K in keyof T]?: Exclude<T[K], undefined>;
  };
}

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
  const people: Person[] = [];
  const accounts: Account[] = [];
  const devices: Device[] = [];
  const repositories: Repository[] = [];
  const rest: ObservedRecord[] = [];
  for (const r of records) {
    const p = r.props;
    if (r.label === "user_account") {
      accounts.push({
        system,
        id: r.native_id,
        name: r.display_name,
        active: Boolean(p["active"]),
        ...present({
          email: text(p["email"]),
          admin: flag(p["admin"]),
          mfa: flag(p["mfa"]),
          lastLogin: text(p["last_login"]),
          service: flag(p["service"]),
        }),
      });
    } else if (r.label === "code_repository") {
      repositories.push({
        system,
        name: r.native_id,
        private: Boolean(p["private"]),
        ...present({
          protected: flag(p["protected"]),
          reviews: count(p["reviews"]),
          secretScanning: flag(p["secret_scanning"]),
          dependencyAlerts: flag(p["dependency_alerts"]),
        }),
      });
    } else if (r.label === "person") {
      people.push({
        email: text(p["email"]) ?? "",
        status: statusOf(p["status"]),
        ...present({
          name: text(p["name"]),
          start: text(p["start_date"]),
          end: text(p["end_date"]),
          manager: text(p["manager"]),
          type: text(p["role_type"]),
        }),
      });
    } else if (r.label === "hardware_device") {
      devices.push({
        source: system,
        id: r.native_id,
        name: r.display_name,
        managed: false,
        ...present({
          owner: text(p["owner"]),
          os: text(p["os_name"]),
          serial: text(p["serial_number"]),
          encrypted: flag(p["encrypted"]),
          seen: text(p["last_seen"]),
        }),
      });
    } else rest.push(r);
  }
  const entities: Entities = {
    ...(people.length ? { people } : {}),
    ...(accounts.length ? { accounts } : {}),
    ...(devices.length ? { devices } : {}),
    ...(repositories.length ? { repositories } : {}),
  };
  return { entities, rest };
}

/** One recorded response: its status (200 by default), its body (JSON, or text as it is), its Link header. */
export interface Recorded {
  /** The status. */
  status?: number;
  /** The body: a string is sent as it is, anything else as JSON. */
  body: unknown;
  /** The `Link` header. */
  link?: string;
}

/**
 * Recorded responses, for tests: each URL to its status, body, and Link header, whatever the method
 * (a token endpoint's POST is recorded by its URL); anything else is refused. Every request is
 * appended to `calls`.
 */
export function recordedHttp(
  fixtures: Record<string, Recorded>,
  calls: Array<{ method: string; url: string }> = [],
): http.Transport {
  return {
    kind: "recorded",
    send(r): Promise<Result<http.Exchange, http.TransportError>> {
      calls.push({ method: r.method, url: r.url });
      const f = fixtures[r.url];
      if (f === undefined) {
        return Promise.resolve({
          kind: "err",
          error: { kind: "refused", message: `no recorded response for ${r.url}` },
        });
      }
      return Promise.resolve({
        kind: "ok",
        value: {
          method: r.method,
          url: r.url,
          status: f.status ?? 200,
          headers: f.link === undefined ? {} : { link: f.link },
          body: typeof f.body === "string" ? f.body : JSON.stringify(f.body),
        },
      });
    },
  };
}

/**
 * Headers that give a bearer token: IFC TypeScript's `http.bearer`, offered here because a registry
 * connector imports only the engine (spec 088).
 */
export const bearer: typeof http.bearer = http.bearer;

/** An OAuth 2.0 client-credentials token (RFC 6749 section 4.4), as a bearer header. */
export async function clientCredentials(
  t: http.Transport,
  tokenUrl: string,
  clientId: string,
  clientSecret: string,
  scope?: string,
): Promise<Record<string, string>> {
  const r = await exchange(t, {
    method: "POST",
    url: tokenUrl,
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
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
  return { ...http.bearer(accessToken(r.body, tokenUrl)) };
}

/** The `access_token` of a token endpoint's JSON answer (RFC 6749 section 5.1), or an Error. */
export function accessToken(body: string, tokenUrl: string): string {
  let v: unknown;
  try {
    v = JSON.parse(body);
  } catch {
    v = undefined;
  }
  const token =
    typeof v === "object" && v !== null && "access_token" in v ? v.access_token : undefined;
  if (typeof token !== "string") throw new Error(`${new URL(tokenUrl).pathname}: no access_token`);
  return token;
}

/**
 * A read the observation cannot do without: a denial fails the observation
 * (an Error with the same message) instead of becoming the resource's gap.
 */
export async function mustRead<T>(f: () => Promise<T>): Promise<T> {
  try {
    return await f();
  } catch (e) {
    if (e instanceof AccessDenied) throw new Error(e.message, { cause: e });
    throw e;
  }
}
