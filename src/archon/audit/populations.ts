/**
 * Spec 083: populations. A control is tested on a population: every unit the
 * control should have acted on in the period (every leaver, every change,
 * every active account). Each population here is a typed query over one
 * evidence bundle's items (spec 072), never over this PC's live state, so an
 * auditor who has the bundle computes the same population, and the same
 * hash, offline.
 *
 * | Population       | One unit is                                      | From the bundle's items                            |
 * | ---------------- | ------------------------------------------------ | -------------------------------------------------- |
 * | `change`         | a commit to the fleet repository in the period   | each `commit` item                                 |
 * | `leavers`        | a person whose employment ended in the period    | the HR system's observations, and each system's    |
 * | `mfa`            | an active account (not a service account)        | each system's last observation in the period       |
 * | `devices`        | a device or adopted machine                      | the last observations, and adopted machines'       |
 * | `repositories`   | a code repository                                | the code hosts' last observations                  |
 * | `access-reviews` | a manager's quarterly access review              | each `people` item, with its approving commit      |
 * | `verify`         | a managed server's verify or install result      | each `verify` item                                 |
 *
 * A unit's `items` are the SHA-256s of the bundle items that are its
 * evidence. The population's hash covers its id, the bundle's manifest head,
 * and each unit's id and items, in order of id:
 *
 * ```text
 * sha256("stolos-audit-population/1\n<population>\n<manifest head>\n" +
 *        "<unit id>\t<sha256>,<sha256>...\n" for each unit, sorted by id)
 * ```
 *
 * ```mermaid
 * flowchart LR
 *   zip["evidence bundle (072)"] --> view["bundleView: manifest + objects"]
 *   view --> q["a population's query (typed)"]
 *   q --> units["units: id, facts, evidence items by SHA-256"]
 *   units --> hash["population hash"]
 * ```
 *
 * @module
 */

import { exportedLiteral, unzip } from "@intellectual-frontiers/formats";
import { sha256 as sha256Hex } from "@intellectual-frontiers/crypto";
import type { Observation } from "../connect/connector.ts";
import { emailKey, type Entities } from "../connect/entities.ts";
import type { ScfId } from "../compliance/scf.ts";
import { type Manifest, type ManifestItem, parseManifest } from "../evidence/bundle.ts";

/** One item of a bundle, with its place in the manifest and its bytes. */
export interface BundleItem extends ManifestItem {
  /** Its position in the manifest (0 is the first). */
  index: number;
  /** Its bytes (from objects/<sha256>), when the bundle holds them. */
  content?: Uint8Array;
}

/** A bundle, read (not verified: {@link verifyBundle} does that). */
export interface BundleView {
  /** The manifest. */
  manifest: Manifest;
  /** Every item, in manifest order. */
  items: BundleItem[];
}

const dec = new TextDecoder();

/** A bundle's manifest and items, from its ZIP; throws when it has no readable manifest. */
export async function bundleView(zip: Uint8Array): Promise<BundleView> {
  const unzipped = await unzip(zip);
  if (unzipped.kind === "err") throw new Error(`the bundle is not a ZIP (${unzipped.error.kind})`);
  const files = unzipped.value;
  const m = files.get("manifest.json");
  if (!m) throw new Error("the bundle has no manifest.json");
  const parsed = parseManifest(dec.decode(m));
  if (parsed.kind === "err") throw new Error(parsed.error);
  const manifest = parsed.value;
  return {
    manifest,
    items: manifest.items.map((it, index) => {
      const content = files.get(`objects/${it.sha256}`);
      return { ...it, index, ...(content ? { content } : {}) };
    }),
  };
}

/** A unit's facts, for people: short values only. */
export type Facts = Record<string, string | number | boolean | null>;

/** One unit of a population. */
export interface Unit {
  /** Its id, unique in the population (the sample is drawn by it). */
  id: string;
  /** Its name for people. */
  label: string;
  /** When it happened, when it is an event (ISO). */
  at?: string;
  /** What the evidence says about it, in short. */
  facts: Facts;
  /** The SHA-256s of the bundle items that are its evidence, in manifest order. */
  items: string[];
}

/** The populations Stolos computes. */
export type PopulationId =
  "change" | "leavers" | "mfa" | "devices" | "repositories" | "access-reviews" | "verify";

/** A population: what one unit is, and the query that finds them in a bundle. */
export interface PopulationDef {
  /** Its id. */
  id: PopulationId;
  /** Its name. */
  title: string;
  /** What one unit is. */
  unit: string;
  /** How it is drawn from the bundle, in words (the auditor reads this). */
  doc: string;
  /** The SCF controls it usually tests. */
  scf: ScfId[];
  /** The query. */
  query(b: BundleView, period: { from: string; to: string }): Unit[];
}

/** A population, computed. */
export interface Population {
  /** Its definition's id. */
  id: PopulationId;
  /** Its units, sorted by id. */
  units: Unit[];
  /** Its hash (see the module). */
  hash: string;
  /** Items that could not be read, and why. */
  notes: string[];
}

const pathOf = (it: ManifestItem): string => it.name.split(" @ ")[0] ?? it.name;
const text = (it: BundleItem) => (it.content ? dec.decode(it.content) : "");

/** An estate observation (estate/<connector>.ts), parsed; undefined when it is not one or cannot be read. */
function observationOf(it: BundleItem): Observation | undefined {
  if (it.kind !== "observation" || !/\/estate\/[^/]+\.ts$/.test(pathOf(it))) return undefined;
  const v = exportedLiteral(text(it), "observed");
  // A literal Stolos wrote: an observation, as its connector recorded it.
  return v.kind === "ok" ? (v.value as unknown as Observation) : undefined;
}

/** Each estate source's versions in the bundle, in manifest order. */
function estateVersions(b: BundleView): Map<string, Array<{ it: BundleItem; o: Observation }>> {
  const out = new Map<string, Array<{ it: BundleItem; o: Observation }>>();
  for (const it of b.items) {
    const o = observationOf(it);
    if (!o) continue;
    const p = pathOf(it);
    out.set(p, [...(out.get(p) ?? []), { it, o }]);
  }
  return out;
}

const sourceName = (path: string) => path.replace(/^.*\/estate\//, "").replace(/\.ts$/, "");
const ent = (o: Observation): Entities => o.entities ?? {};

/** Unit ids made unique (a repeated id gets #2, #3, ...). */
function unique(units: Unit[]): Unit[] {
  const n = new Map<string, number>();
  return units
    .map((u) => {
      const k = (n.get(u.id) ?? 0) + 1;
      n.set(u.id, k);
      return k === 1 ? u : { ...u, id: `${u.id}#${k}` };
    })
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

const inPeriod = (day: string | undefined, p: { from: string; to: string }) =>
  !!day && day.slice(0, 10) >= p.from && day.slice(0, 10) <= p.to;

/** A raw commit's subject, author, and whether it carries a signature. */
export function commitFacts(raw: string): Facts {
  const [head = "", ...body] = raw.split("\n\n");
  const author = /^author (.*?) <[^>]*> /m.exec(head)?.[1] ?? null;
  return {
    subject: (body.join("\n\n").split("\n")[0] ?? "").slice(0, 200),
    author,
    signed: /^gpgsig /m.test(head),
  };
}

/** Every population, by id, in the order they are listed. */
export const POPULATIONS: readonly PopulationDef[] = [
  {
    id: "change",
    title: "Changes to the fleet",
    unit: "a commit to the fleet repository in the period",
    doc: "Every `commit` item in the bundle: the bundle holds each commit of the period, raw, with its signature. Facts: its subject, its author, whether it is signed.",
    scf: ["CHG-03"],
    query: (b) =>
      unique(
        b.items
          .filter((i) => i.kind === "commit")
          .map((i) => ({
            id: `commit:${i.name.replace(/^commit /, "")}`,
            label: i.name,
            at: i.at,
            facts: commitFacts(text(i)),
            items: [i.sha256],
          })),
      ),
  },
  {
    id: "leavers",
    title: "Leavers",
    unit: "a person whose employment ended in the period",
    doc: "Every person an HR system's observation shows as terminated with an end date in the period. Their evidence: the first observation that shows them terminated, and the period's last observation of each system that ever listed an account with their email (where the auditor checks the account is gone or cannot sign in).",
    scf: ["HRS-12", "IAC-04"],
    query(b: BundleView, period: { from: string; to: string }): Unit[] {
      const versions = estateVersions(b);
      const leavers = new Map<string, { name?: string; end?: string; first: BundleItem }>();
      for (const vs of versions.values()) {
        for (const { it, o } of vs) {
          for (const p of ent(o).people ?? []) {
            const e = emailKey(p.email);
            if (!e || p.status !== "terminated" || !inPeriod(p.end, period)) continue;
            if (!leavers.has(e)) {
              leavers.set(e, {
                ...(p.name ? { name: p.name } : {}),
                ...(p.end ? { end: p.end } : {}),
                first: it,
              });
            }
          }
        }
      }
      const units: Unit[] = [];
      for (const [email, l] of leavers) {
        const items = new Set<string>([l.first.sha256]);
        const accounts: string[] = [];
        for (const [path, vs] of versions) {
          const had = vs.some(({ o }) =>
            (ent(o).accounts ?? []).some((a) => emailKey(a.email) === email),
          );
          if (!had) continue;
          const last = vs.at(-1);
          if (!last) continue;
          items.add(last.it.sha256);
          const a = (ent(last.o).accounts ?? []).filter((x) => emailKey(x.email) === email);
          accounts.push(
            `${sourceName(path)}: ${
              a.length
                ? a.map((x) => (x.active ? "can sign in" : "cannot sign in")).join(", ")
                : "gone"
            }`,
          );
        }
        units.push({
          id: `person:${email}`,
          label: l.name ? `${l.name} <${email}>` : email,
          ...(l.end ? { at: l.end } : {}),
          facts: {
            email,
            end: l.end ?? null,
            accounts: accounts.sort().join("; ") || "none listed",
          },
          items: b.items.filter((i) => items.has(i.sha256)).map((i) => i.sha256),
        });
      }
      return unique(units);
    },
  },
  {
    id: "mfa",
    title: "Active accounts",
    unit: "an account that can sign in (not a service account)",
    doc: "Every active, non-service account in each system's last observation in the period. Facts: its email, whether it is an administrator, and whether the system reports a second factor.",
    scf: ["IAC-37"],
    query(b: BundleView): Unit[] {
      const units: Unit[] = [];
      for (const vs of estateVersions(b).values()) {
        const last = vs.at(-1);
        if (!last) continue;
        const { it, o } = last;
        for (const a of ent(o).accounts ?? []) {
          if (!a.active || a.service) continue;
          units.push({
            id: `account:${a.system}:${a.id}`,
            label: `${a.system} ${a.name}`,
            facts: {
              email: a.email ?? null,
              admin: a.admin ?? null,
              mfa: a.mfa ?? null,
              lastLogin: a.lastLogin ?? null,
            },
            items: [it.sha256],
          });
        }
      }
      return unique(units);
    },
  },
  {
    id: "devices",
    title: "Devices",
    unit: "a device a connector lists, or a machine Stolos adopted",
    doc: "Every device in each system's last observation in the period, and every adopted machine's last observation (adopted/<name>/observed.ts) in the period. Facts: its owner, operating system, and whether its disk is encrypted, when known.",
    scf: ["AST-04", "CRY-07"],
    query(b: BundleView): Unit[] {
      const units: Unit[] = [];
      for (const vs of estateVersions(b).values()) {
        const last = vs.at(-1);
        if (!last) continue;
        const { it, o } = last;
        for (const d of ent(o).devices ?? []) {
          units.push({
            id: `device:${d.source}:${d.id}`,
            label: d.name,
            facts: {
              owner: d.owner ?? null,
              os: d.os ?? null,
              encrypted: d.encrypted ?? null,
              managed: d.managed,
            },
            items: [it.sha256],
          });
        }
      }
      const adopted = new Map<string, BundleItem>();
      for (const it of b.items) {
        const m = /\/adopted\/([^/]+)\/observed\.ts$/.exec(pathOf(it));
        if (it.kind === "observation" && m?.[1]) adopted.set(m[1], it);
      }
      for (const [name, it] of adopted) {
        units.push({
          id: `adopted:${name}`,
          label: name,
          at: it.at,
          facts: { observed: it.at },
          items: [it.sha256],
        });
      }
      return unique(units);
    },
  },
  {
    id: "repositories",
    title: "Code repositories",
    unit: "a code repository a code host lists",
    doc: "Every repository in each code host's last observation in the period. Facts: whether it is private, whether its default branch is protected, and how many approving reviews a change needs.",
    scf: ["CHG-03"],
    query(b: BundleView): Unit[] {
      const units: Unit[] = [];
      for (const vs of estateVersions(b).values()) {
        const last = vs.at(-1);
        if (!last) continue;
        const { it, o } = last;
        for (const r of ent(o).repositories ?? []) {
          units.push({
            id: `repo:${r.system}:${r.name}`,
            label: r.name,
            facts: {
              private: r.private,
              protected: r.protected ?? null,
              reviews: r.reviews ?? null,
            },
            items: [it.sha256],
          });
        }
      }
      return unique(units);
    },
  },
  {
    id: "access-reviews",
    title: "Access reviews",
    unit: "a manager's access review for a quarter",
    doc: "Every `people` item (an access review as committed, spec 077), with the commit that approved it when the bundle holds it.",
    scf: ["IAC-12"],
    query(b: BundleView): Unit[] {
      return unique(
        b.items
          .filter((i) => i.kind === "people")
          .map((i) => {
            const ref = /@ ([0-9a-f]{7,40})/.exec(i.name)?.[1];
            const commit = ref
              ? b.items.find((c) => c.kind === "commit" && c.name.startsWith(`commit ${ref}`))
              : undefined;
            return {
              id: `review:${pathOf(i)}`,
              label: i.name,
              at: i.at,
              facts: {
                approved: !i.name.endsWith("(not approved)"),
                by: /approved by (.+)$/.exec(i.name)?.[1] ?? null,
              },
              items: [i.sha256, ...(commit ? [commit.sha256] : [])],
            };
          }),
      );
    },
  },
  {
    id: "verify",
    title: "Server verifications",
    unit: "a managed server's verify or install result",
    doc: "Every `verify` item: each verify and install result this PC recorded in the period. Facts: whether it passed, when known.",
    scf: ["MON-02"],
    query: (b) =>
      unique(
        b.items
          .filter((i) => i.kind === "verify")
          .map((i) => {
            let ok: boolean | null = null;
            try {
              const r = JSON.parse(text(i)) as { ok?: boolean; status?: string };
              ok = typeof r.ok === "boolean" ? r.ok : r.status ? r.status === "pass" : null;
            } catch {
              /* not JSON: no facts */
            }
            return {
              id: `verify:${i.name}@${i.at}`,
              label: i.name,
              at: i.at,
              facts: { ok },
              items: [i.sha256],
            };
          }),
      ),
  },
];

/** Every population's id. */
export const POPULATION_IDS: readonly PopulationId[] = POPULATIONS.map((p) => p.id);

/** A population's definition by id. */
export function populationDef(id: string): PopulationDef | undefined {
  return POPULATIONS.find((p) => p.id === id);
}

/** Each population's title by id (for `audit open`'s defaults). */
export const POPULATION_TITLES: Record<string, string> = Object.fromEntries(
  POPULATIONS.map((p) => [p.id, p.title]),
);

/** A population's hash (see the module). */
export function populationHash(id: string, head: string, units: readonly Unit[]): Promise<string> {
  const sorted = [...units].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return sha256Hex(
    `stolos-audit-population/1\n${id}\n${head}\n` +
      sorted.map((u) => `${u.id}\t${u.items.join(",")}\n`).join(""),
  );
}

/** A population, computed from a bundle for a period. */
export async function population(
  id: PopulationId,
  b: BundleView,
  period: { from: string; to: string },
): Promise<Population> {
  const def = populationDef(id);
  if (!def) throw new Error(`no population ${id}`);
  const notes: string[] = [];
  for (const it of b.items) {
    if (!it.content) notes.push(`${it.kind} ${it.name}: not in the bundle (objects/${it.sha256})`);
  }
  const units = def.query(b, period);
  return { id, units, hash: await populationHash(id, b.manifest.head, units), notes };
}
