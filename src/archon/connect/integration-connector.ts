/**
 * Spec 109-integrations-api FR-003, FR-006: the integration layer as a **family of connectors** (spec 084). {@link integrationConnector}
 * makes a {@link Connector} of integrations, so a router, a DNS provider or an email provider is connected, observed, checked and shown
 * like any account: a read-only credential in the vault, `stolos connect <id>`, an observation in `fleets/<fleet>/estate/<id>.ts`,
 * posture policies with SCF controls, gaps reported rather than failing. {@link withIntegrations} gives a connector that already exists
 * (Cloudflare) the kinds it can also be, without changing a line of it.
 *
 * What an integration reads becomes the one estate graph (spec 085, 090): records with their labels and OCSF classes, and adopted network
 * devices as device entities.
 *
 * ```mermaid
 * flowchart LR
 *   vault["Vault: connectors/&lt;id&gt;/credential.json"] --> observe["observe: guard + backoff"]
 *   observe --> read["readAll: each offered capability (gaps for the rest)"]
 *   read --> parts["entityParts: records, assets, devices"]
 *   parts --> obs["Observation (spec 084)"]
 *   obs --> file["fleets/&lt;fleet&gt;/estate/&lt;id&gt;.ts"] & graph["estate graph: nodes, fixed assets"]
 * ```
 *
 * @module
 */
// Spec: 109-integrations-api FR-003, FR-004, FR-005, FR-006
// Spec: 110-network-assets FR-008

import { http } from "@intellectual-frontiers/net";
import type { PolicyResult } from "../adopt/policy.ts";
import type { Asset, Connector, Observation, ServiceModel } from "./connector.ts";
import type { Device, Entities } from "./entities.ts";
import { entityParts, type Parts, type Reading } from "./integration-entities.ts";
import {
  type AnyIntegration,
  memoGets,
  readAll,
  readContext,
  type ReadContext,
} from "./integration.ts";
import type { ObservedRecord } from "./sdk.ts";

/** What posture is told besides the readings: what could not be read, and when. */
export interface FamilySeen {
  /** The observation's gaps, each `<what>: <why>`. */
  gaps: string[];
  /** When it was read. */
  now: Date;
}

/** What a family of integrations adds to an observation of its account. */
export interface FamilyDef {
  /** The integrations of the account, one for each kind it can be (Cloudflare: `dns` and `email`). */
  integrations: readonly AnyIntegration[];
  /** The headers every request carries, from the credential. */
  headers(cred: Readonly<Record<string, string>>): Record<string, string>;
  /** Posture facts from the readings (what the policies read). */
  posture(
    readings: Reading[],
    cred: Readonly<Record<string, string>>,
    seen: FamilySeen,
  ): Observation["posture"];
}

/** A connector made of integrations: what a connector declares, and the family's own parts. */
export interface IntegrationConnectorDef extends FamilyDef {
  /** Its id (the vault folder and the file name). */
  id: string;
  /** Its name for people. */
  title: string;
  /** The Simple Icons slug for its logo, or "". */
  logo: string;
  /** Its NIST SP 800-145 service models (none for a product the owner runs: `selfHosted`). */
  serviceModels: ServiceModel[];
  /** The owner runs it on their own network: it is not a cloud service (see {@link Connector.selfHosted}). */
  selfHosted?: boolean;
  /** Its market categories (ids in MARKET_CATEGORIES). */
  markets: string[];
  /** How to make a read-only credential, step by step. */
  connectHelp: string[];
  /** The quickest way to one. */
  recipe: Connector["recipe"];
  /** The credential's fields. */
  fields: Connector["fields"];
  /**
   * The transport the reads go through, from the credential and the one given (a live transport that verifies the certificate by pin or
   * CA, say); a recorded transport is passed through as it is. The read-only guard and the backoff are put on it after.
   */
  transport?(cred: Readonly<Record<string, string>>, t: http.Transport): http.Transport;
  /** A read the account cannot be observed without: a failure here fails the observation, saying why (a key the controller refuses). */
  required?: (ctx: ReadContext) => Promise<void>;
  /** The account, for people. */
  account(cred: Readonly<Record<string, string>>, readings: Reading[]): string;
  /** Its posture policies. */
  policies(o: Observation, now: number): PolicyResult[];
  /** How `stolos connect` makes sure the person trusts what it is about to read from (a certificate, say). */
  trust?: Connector["trust"];
  /** Spec 073: how often it is observed, when not daily. */
  cadence?: Connector["cadence"];
}

/** The records, assets and devices of many readings, in one. */
export function mergeParts(readings: readonly Reading[]): Parts {
  const out: Parts = { records: [], assets: [], devices: [] };
  for (const r of readings) {
    const p = entityParts(r);
    out.records.push(...p.records);
    out.assets.push(...p.assets);
    out.devices.push(...p.devices);
  }
  return out;
}

/** The guard of spec 089 on a transport: safe methods only, with backoff on 429 and 503. */
export function guarded(t: http.Transport): http.Transport {
  return http.withBackoff(http.readOnly(t));
}

/** What reading a family gives. */
interface Read {
  readings: Reading[];
  parts: Parts;
  gaps: string[];
}

/** Read every integration of a family on a guarded transport. */
async function readFamily(
  def: FamilyDef,
  cred: Readonly<Record<string, string>>,
  t: http.Transport,
  now: Date,
  required?: IntegrationConnectorDef["required"],
): Promise<Read> {
  const gaps: string[] = [];
  const ctx = readContext({ cred, http: t, now, headers: def.headers(cred), gaps });
  if (required !== undefined) await required(ctx);
  const readings: Reading[] = [];
  for (const i of def.integrations) readings.push(...(await readAll(i, ctx, gaps)));
  return { readings, parts: mergeParts(readings), gaps };
}

/** The entities an observation carries: the devices that join the fleet's machines. */
function entitiesOf(devices: Device[]): { entities?: Entities } {
  return devices.length ? { entities: { devices } } : {};
}

/** Make a connector of integrations (spec 109 FR-006). */
export function integrationConnector(def: IntegrationConnectorDef): Connector {
  return {
    id: def.id,
    title: def.title,
    logo: def.logo,
    serviceModels: def.serviceModels,
    ...(def.selfHosted ? { selfHosted: true } : {}),
    integrationKinds: [...new Set(def.integrations.map((i) => i.kind))],
    markets: def.markets,
    connectHelp: def.connectHelp,
    recipe: def.recipe,
    fields: def.fields,
    ...(def.trust ? { trust: def.trust } : {}),
    ...(def.cadence ? { cadence: def.cadence } : {}),
    async observe(cred, t, now): Promise<Observation> {
      const transport = guarded(def.transport ? def.transport(cred, t) : t);
      const read = await readFamily(def, cred, transport, now, def.required);
      const gaps = [...new Set(read.gaps)];
      return {
        at: now.toISOString().replace(/\.\d+Z$/, "Z"),
        provider: def.id,
        account: def.account(cred, read.readings),
        assets: read.parts.assets,
        posture: def.posture(read.readings, cred, { gaps, now }),
        gaps,
        ...entitiesOf(read.parts.devices),
        ...(read.parts.records.length ? { records: read.parts.records } : {}),
      };
    },
    policies: (o, now) => def.policies(o, now),
  };
}

/** What a connector that exists is given: the integrations it also is, and the policies they bring. */
export interface Extension extends FamilyDef {
  /** The policies of the integrations (added to the connector's own, and only for the facts that were read). */
  policies(o: Observation, now: number): PolicyResult[];
}

/** A record's key, to leave out what the connector has already written. */
const keyOf = (r: ObservedRecord): string => `${r.label}\n${r.native_id}`;

/**
 * Give a connector the kinds it can also be (spec 109 FR-007): its own observation first, unchanged, then the integrations' reads on the
 * same transport (a GET the connector sent is not sent again), adding what the connector did not write (records of a new label, assets,
 * posture facts, gaps) and nothing it did. A failure of the integrations' reads is a gap: the connector's own observation stands.
 */
export function withIntegrations(base: Connector, ext: Extension): Connector {
  return {
    ...base,
    integrationKinds: [...new Set(ext.integrations.map((i) => i.kind))],
    async observe(cred, t, now): Promise<Observation> {
      const shared = memoGets(t);
      const o = await base.observe(cred, shared, now);
      let read: Read;
      try {
        read = await readFamily(ext, cred, guarded(shared), now);
      } catch (e) {
        const why = e instanceof Error ? e.message : String(e);
        return { ...o, gaps: [...o.gaps, `integrations: ${why}`] };
      }
      const known = new Set((o.records ?? []).map(keyOf));
      const knownAssets = new Set(o.assets.map((a: Asset) => `${a.kind}\n${a.id}`));
      const records = read.parts.records.filter((r) => !known.has(keyOf(r)));
      const assets = read.parts.assets.filter((a) => !knownAssets.has(`${a.kind}\n${a.id}`));
      const gaps = [...new Set([...o.gaps, ...read.gaps])];
      const devices = [...(o.entities?.devices ?? []), ...read.parts.devices];
      return {
        ...o,
        assets: [...o.assets, ...assets],
        posture: { ...o.posture, ...ext.posture(read.readings, cred, { gaps, now }) },
        gaps,
        ...(devices.length ? { entities: { ...o.entities, devices } } : {}),
        ...(records.length || o.records ? { records: [...(o.records ?? []), ...records] } : {}),
      };
    },
    policies(o, now): PolicyResult[] {
      return [...base.policies(o, now), ...ext.policies(o, now)];
    },
  };
}
