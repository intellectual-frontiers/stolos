/**
 * Spec 088: the contract a registry connector keeps, and how Stolos reads one
 * without trusting it. A connector module default-exports a
 * {@link defineConnector} result, and names two more things:
 *
 * - `engine`: the range of engine versions it supports (`">=0.112.0 <1.0.0"`);
 * - `fixtures`: its recorded-fixture tests ({@link ConnectorFixture}), which
 *   Stolos runs itself, against recorded responses only, before it adds the
 *   connector and whenever `stolos connector test` asks.
 *
 * {@link declare} reads a loaded module into a {@link Declaration}: its id,
 * labels, OCSF classes, the SCF controls its policies cite, its credential's
 * fields, and its fixtures' results. The registry probe runs it in a Deno
 * process with no network, files, or environment beyond the module's own
 * host, and the engine's checks (`registry.ts`) judge what it reports.
 *
 * @module
 */

import type { PolicyResult } from "../adopt/policy.ts";
import type { Connector, Observation } from "./connector.ts";
import { type ConnectorDef, type FieldDef, recordedHttp } from "./sdk.ts";
import type { ViewDef } from "../schema/define.ts";

/** One recorded-fixture test: a credential, the recorded answers, and what the observation must say. */
export interface ConnectorFixture {
  /** What it shows, for people. */
  name: string;
  /** The credential (made up: never a real one). */
  cred: Record<string, string>;
  /** When it observes (ISO; default 2026-01-01T00:00:00Z), so the results do not drift. */
  now?: string;
  /** Each URL's recorded answer; any other URL is refused. */
  responses: Record<string, { status?: number; body: unknown; link?: string }>;
  /** What the observation must say (each part optional). */
  expect: {
    /** The account it names. */
    account?: string;
    /** How many records (entities included) of each label. */
    records?: Record<string, number>;
    /** How many gaps (parts it could not read). */
    gaps?: number;
    /** Posture facts, each exactly. */
    posture?: Record<string, string | number | boolean>;
    /** Policies' statuses, by id. */
    policies?: Record<string, PolicyResult["status"]>;
  };
}

/** One fixture test's result. */
export interface FixtureResult {
  /** Its name. */
  name: string;
  /** It passed. */
  ok: boolean;
  /** Why not, each in words. */
  problems: string[];
}

/** What a connector module declares, as Stolos reads it (plain data: it crosses a process). */
export interface Declaration {
  /** Made with defineConnector (its default export carries the declaration). */
  sdk: boolean;
  /** Its id. */
  id: string;
  /** Its name for people. */
  title: string;
  /** The engine versions it supports, as it says (a range), or undefined. */
  engine?: string;
  /** Its credential's fields. */
  fields: Array<{ name: string; secret: boolean; hint: string; file?: boolean }>;
  /** How to make a read-only credential. */
  connectHelp: string[];
  /** Its market categories. */
  markets: string[];
  /** Its service models. */
  serviceModels: string[];
  /** Every label its resources fill (each a generated view). */
  labels: ViewDef[];
  /** The OCSF classes its resources emit. */
  ocsf: string[];
  /** The SCF controls its policies cite (on an empty observation and on each fixture's). */
  scf: string[];
  /** Its fixtures' results. */
  fixtures: FixtureResult[];
}

/** How many records of each label an observation holds, its entities included. */
export function labelCounts(o: Observation): Record<string, number> {
  const n: Record<string, number> = {};
  const add = (l: string, k = 1) => (n[l] = (n[l] ?? 0) + k);
  add("user_account", o.entities?.accounts?.length ?? 0);
  add("code_repository", o.entities?.repositories?.length ?? 0);
  add("person", o.entities?.people?.length ?? 0);
  add("hardware_device", o.entities?.devices?.length ?? 0);
  for (const r of o.records ?? []) add(r.label);
  return Object.fromEntries(Object.entries(n).filter(([, v]) => v > 0));
}

/** Run a connector's fixtures against their recorded answers: each must hold, and every call read. */
export async function runFixtures(
  c: Connector,
  fixtures: readonly ConnectorFixture[],
): Promise<{ results: FixtureResult[]; observations: Observation[] }> {
  const def = (c as { def?: ConnectorDef<Record<string, FieldDef>> }).def;
  const results: FixtureResult[] = [];
  const observations: Observation[] = [];
  for (const f of fixtures) {
    const problems: string[] = [];
    const calls: Array<{ method: string; url: string }> = [];
    const now = new Date(f.now ?? "2026-01-01T00:00:00Z");
    try {
      const o = await c.observe(f.cred, recordedHttp(f.responses, calls), now);
      observations.push(o);
      const token = def?.tokenEndpoints?.(f.cred) ?? [];
      for (const call of calls) {
        if (call.method !== "GET" && !token.some((t) => call.url.startsWith(t))) {
          problems.push(`${call.method} ${call.url}: a connector only reads`);
        }
      }
      const e = f.expect;
      if (e.account !== undefined && o.account !== e.account) {
        problems.push(`account: "${o.account}", expected "${e.account}"`);
      }
      const counts = labelCounts(o);
      for (const [l, want] of Object.entries(e.records ?? {})) {
        if ((counts[l] ?? 0) !== want) problems.push(`${l}: ${counts[l] ?? 0}, expected ${want}`);
      }
      if (e.gaps !== undefined && o.gaps.length !== e.gaps) {
        problems.push(`gaps: ${o.gaps.length} (${o.gaps.join("; ")}), expected ${e.gaps}`);
      }
      for (const [k, want] of Object.entries(e.posture ?? {})) {
        if (o.posture[k] !== want) {
          problems.push(
            `posture ${k}: ${JSON.stringify(o.posture[k])}, expected ${JSON.stringify(want)}`,
          );
        }
      }
      const by = Object.fromEntries(c.policies(o, now.getTime()).map((p) => [p.id, p.status]));
      for (const [id, want] of Object.entries(e.policies ?? {})) {
        if (by[id] !== want) problems.push(`policy ${id}: ${by[id] ?? "none"}, expected ${want}`);
      }
    } catch (err) {
      problems.push(`the observation failed: ${(err as Error).message}`);
    }
    results.push({ name: f.name, ok: !problems.length, problems });
  }
  return { results, observations };
}

/** Read a loaded connector module into a {@link Declaration} (running its fixtures). */
export async function declare(mod: Record<string, unknown>): Promise<Declaration> {
  const c = mod.default as
    | (Connector & { def?: ConnectorDef<Record<string, FieldDef>> })
    | undefined;
  const engine = typeof mod.engine === "string" ? mod.engine : undefined;
  const fixtures = Array.isArray(mod.fixtures) ? mod.fixtures as ConnectorFixture[] : [];
  if (!c || typeof c.observe !== "function" || typeof c.policies !== "function") {
    return {
      sdk: false,
      id: "",
      title: "",
      ...(engine ? { engine } : {}),
      fields: [],
      connectHelp: [],
      markets: [],
      serviceModels: [],
      labels: [],
      ocsf: [],
      scf: [],
      fixtures: [],
    };
  }
  const resources = Object.values(c.def?.resources ?? {});
  const labels = new Map<string, ViewDef>();
  for (const r of resources) {
    const { label: _decl, ...view } = r.label;
    labels.set(r.label.name, JSON.parse(JSON.stringify(view)) as ViewDef);
  }
  const { results, observations } = await runFixtures(c, fixtures);
  const empty: Observation = {
    at: "2026-01-01T00:00:00Z",
    provider: c.id,
    account: "",
    assets: [],
    posture: {},
    gaps: [],
  };
  const scf = new Set<string>();
  for (const o of [empty, ...observations]) {
    try {
      for (const p of c.policies(o, Date.parse(o.at))) p.scf.forEach((x) => scf.add(x));
    } catch {
      // A policy that cannot read an empty observation shows in its fixtures.
    }
  }
  return {
    sdk: !!c.def,
    id: String(c.id ?? ""),
    title: String(c.title ?? ""),
    ...(engine ? { engine } : {}),
    fields: (c.fields ?? []).map((f) => ({
      name: f.name,
      secret: !!f.secret,
      hint: String(f.hint ?? ""),
      ...(f.file ? { file: true } : {}),
    })),
    connectHelp: [...(c.connectHelp ?? [])].map(String),
    markets: [...(c.markets ?? [])].map(String),
    serviceModels: [...(c.serviceModels ?? [])].map(String),
    labels: [...labels.values()],
    ocsf: [...new Set(resources.map((r) => String(r.ocsf)))],
    scf: [...scf].sort(),
    fixtures: results,
  };
}
